// Trial trace parser (pure): the trial's frozen bundle → a core TrialTrace.
//
// What a bundle holds (docs/findings/trial-traces.md has the full layout):
//   events.jsonl                   the runner's trial events (phase edges give t = 0 and the end)
//   versions.json                  {setup?, claude_code, model, tandem?, ...}
//   stream.jsonl                   solo: the Claude Code `--output-format stream-json` transcript
//   tandem/streams/<actor>.jsonl   Tandem: one stream-json per session (planner, worker-1..N)
//   tandem/actions.json            Tandem: the board dump (epics and tasks, claims, contention)
//   tandem/approvals.jsonl         Tandem: the approver's decisions
//   workspace/**                   the agent's final workspace (names only are used here)
//
// Timing model (stream-json lines carry a `timestamp` when they are written):
//   - a model turn runs from the previous line of its lane (the last tool result, or the session
//     start) to the last block of that assistant message (blocks of one message share message.id);
//   - a tool call runs from its tool_use block to the user line carrying its tool_result;
//   - the session starts at (last timestamp − result.duration_ms), else at its first timestamp.
// Subagent messages (parent_tool_use_id set) get their own lane.
//
// Everything in the bundle came from the eval computer, where the agent under test can write: it
// is parsed defensively (bad lines are skipped), every excerpt is redacted and clipped, and board
// session tokens are dropped from tool inputs.
import {
  createRedactor,
  TRACE_VERSION,
  TrialTraceSchema,
  type Redactor,
  type TraceActor,
  type TraceCoordEvent,
  type TraceFailure,
  type TraceGap,
  type TracePhase,
  type TraceStep,
  type TraceStepKind,
  type TraceTokens,
  type TrialTrace,
} from "@anybench/core";
import { readTarGz, type TarEntry } from "./tar.js";

/** Resolution of the wall-time split. */
export const TRACE_BUCKET_MS = 10;
/** Steps kept per actor (totals still count the rest). */
export const TRACE_MAX_STEPS_PER_ACTOR = 1500;
/** Most bytes of one transcript that are parsed. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const EXCERPT = 300;
/** An idle stretch inside a session shorter than this is not drawn as a gap. */
const MIN_IDLE_GAP_MS = 1000;

const decoder = new TextDecoder("utf-8");

// ---------------------------------------------------------------------------------------------
// Small helpers

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const int = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

/** ISO timestamp → epoch ms; tolerates nanosecond fractions (Go's RFC 3339). */
export function parseTs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(t) ? t : null;
}

function parseJsonl(bytes: Uint8Array | undefined): Json[] {
  if (!bytes) return [];
  const text = decoder.decode(bytes.subarray(0, MAX_STREAM_BYTES));
  const out: Json[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(l);
      if (isObj(v)) out.push(v);
    } catch {
      // a torn or foreign line: skip it
    }
  }
  return out;
}

function parseJson(bytes: Uint8Array | undefined): unknown {
  if (!bytes) return null;
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}

/** Board session tokens and other bearer-ish blobs that the core patterns don't know. */
const TOKENISH = /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)*/g;

function makeScrub(redactor: Redactor) {
  return (text: string, max = EXCERPT): string => {
    const clipped = text.length > max * 4 ? text.slice(0, max * 4) : text;
    const clean = redactor(clipped.replace(TOKENISH, "[REDACTED:TOKEN]"));
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  };
}

/** Workspace-relative path: drops everything up to the workspace root (`.../ws/`). */
export function relPath(p: string): string {
  const i = p.lastIndexOf("/ws/");
  if (i >= 0) return p.slice(i + 4);
  return p.replace(/^\.\//, "");
}

/** Lower-case words, camelCase split: "dataFile" → "data file". */
function words(text: string): string {
  return text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** USD as a JS number (Claude Code's total_cost_usd) → integer micro-USD, via its decimal text. */
export function usdNumberToMicro(v: unknown): bigint | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const [whole = "0", frac = ""] = v.toFixed(7).split(".");
  const six = (frac + "0000000").slice(0, 7);
  let micro = BigInt(whole) * 1_000_000n + BigInt(six.slice(0, 6));
  if (Number(six[6]) >= 5) micro += 1n;
  return micro;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) ? (str(c.text) ?? (c.type === "image" ? "[image]" : "")) : ""))
      .join("\n");
  }
  return "";
}

const TEST_CMD =
  /\b(npm\s+(run\s+)?test|npm\s+t\b|pnpm\s+(run\s+)?test|yarn\s+test|node\s+--test|vitest|jest|pytest|go\s+test|cargo\s+test)\b/;

/** "pass 6 · fail 0" from node:test / vitest / jest / pytest output. */
export function testSummary(out: string): string | undefined {
  const pass = /^# pass (\d+)/m.exec(out);
  const fail = /^# fail (\d+)/m.exec(out);
  if (pass || fail) return `pass ${pass?.[1] ?? "?"} · fail ${fail?.[1] ?? "?"}`;
  const vit = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/.exec(out);
  if (vit) return `pass ${vit[2]} · fail ${vit[1] ?? "0"}`;
  const py = /(\d+) passed(?:, (\d+) failed)?/.exec(out);
  if (py) return `pass ${py[1]} · fail ${py[2] ?? "0"}`;
  return undefined;
}

function stepKind(tool: string): TraceStepKind {
  if (/^mcp__tandem__/.test(tool)) return /queue_wait$/.test(tool) ? "wait" : "board";
  return "tool";
}

function shortToolName(tool: string): string {
  return tool.replace(/^mcp__tandem__/, "").slice(0, 120);
}

/** A short input line for a tool call (never the board session token). */
function describeInput(tool: string, input: unknown): string {
  if (!isObj(input)) return "";
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (tool) {
    case "Bash":
      return str(input.command) ?? "";
    case "Write": {
      const lines = (str(input.content) ?? "").split("\n").length;
      return `${path ? relPath(path) : "?"} (${lines} lines)`;
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "Read":
      return path ? relPath(path) : "";
    case "Glob":
    case "Grep":
      return `${str(input.pattern) ?? ""}${path ? ` in ${relPath(path)}` : ""}`;
    case "Task":
    case "Agent":
      return str(input.description) ?? str(input.prompt) ?? "";
    default: {
      const { session: _s, ...rest } = input;
      void _s;
      return JSON.stringify(rest);
    }
  }
}

function filesWritten(tool: string, input: unknown, toolUseResult: unknown): string[] {
  const out = new Set<string>();
  if (isObj(input)) {
    if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
      const p = str(input.file_path) ?? str(input.notebook_path);
      if (p) out.add(relPath(p));
    }
    if (tool === "Bash") {
      const cmd = str(input.command) ?? "";
      for (const m of cmd.matchAll(/(?:\bcat\s*>>?\s*|\btee\s+(?:-a\s+)?)([^\s<>;&|'"]+)/g)) {
        out.add(relPath(m[1]!));
      }
    }
  }
  // Claude Code reports the files a Bash call changed.
  const diff = isObj(toolUseResult) ? toolUseResult.bashEditDiff : undefined;
  if (isObj(diff) && Array.isArray(diff.files)) {
    for (const f of diff.files) {
      const p = isObj(f) ? str(f.filePath) : undefined;
      if (p) out.add(relPath(p));
    }
  }
  return [...out].filter((p) => p && !p.startsWith("/tmp/") && !p.startsWith("/dev/")).slice(0, 50);
}

// ---------------------------------------------------------------------------------------------
// Transcript → lanes

interface StepBuild extends TraceStep {
  /** Full text for failure matching (lower-cased words), never stored. */
  haystack: string;
  /** tool_use id, while open. */
  toolId?: string;
}

interface Lane {
  id: string;
  role: TraceActor["role"];
  cursor: number | null;
  turn: {
    id: string;
    start: number;
    end: number;
    text: string[];
    tools: string[];
    kinds: TraceStepKind[];
    thinking: boolean;
    usage: TraceTokens | null;
  } | null;
  steps: StepBuild[];
  open: Map<string, StepBuild>;
  firstTs: number | null;
  lastTs: number | null;
}

interface SessionResult {
  durationMs: number | null;
  tokens: TraceTokens | null;
  costMicro: bigint | null;
  outcome: string | null;
}

interface ParsedSession {
  lanes: Lane[];
  result: SessionResult | null;
  sawUsage: boolean;
}

function newLane(id: string, role: TraceActor["role"], cursor: number | null): Lane {
  return {
    id,
    role,
    cursor,
    turn: null,
    steps: [],
    open: new Map(),
    firstTs: null,
    lastTs: null,
  };
}

function usageOf(u: unknown): TraceTokens | null {
  if (!isObj(u)) return null;
  const t = {
    input: int(u.input_tokens),
    output: int(u.output_tokens),
    cache_read: int(u.cache_read_input_tokens),
    cache_write: int(u.cache_creation_input_tokens),
  };
  return t.input + t.output + t.cache_read + t.cache_write > 0 ? t : null;
}

function parseSession(
  lines: Json[],
  actorId: string,
  role: TraceActor["role"],
  scrub: (t: string, max?: number) => string,
): ParsedSession {
  const main = newLane(actorId, role, null);
  const subs = new Map<string, Lane>();
  const toolLane = new Map<string, Lane>();
  let result: SessionResult | null = null;
  let sawUsage = false;

  const laneFor = (parent: unknown): Lane => {
    if (typeof parent !== "string" || parent === "") return main;
    let l = subs.get(parent);
    if (!l) {
      const parentStep = toolLane.get(parent)?.open.get(parent);
      l = newLane(
        `${actorId} · subagent ${subs.size + 1}`,
        "subagent",
        parentStep?.start_ms ?? null,
      );
      subs.set(parent, l);
    }
    return l;
  };

  const touch = (lane: Lane, ts: number) => {
    lane.firstTs = lane.firstTs === null ? ts : Math.min(lane.firstTs, ts);
    lane.lastTs = lane.lastTs === null ? ts : Math.max(lane.lastTs, ts);
    lane.cursor = lane.cursor === null ? ts : Math.max(lane.cursor, ts);
  };

  const closeTurn = (lane: Lane) => {
    const t = lane.turn;
    if (!t) return;
    lane.turn = null;
    const text = t.text.join("\n").trim();
    const calls = t.tools.length
      ? `calls ${[...new Set(t.tools)].map((x) => `${x}${t.tools.filter((y) => y === x).length > 1 ? ` ×${t.tools.filter((y) => y === x).length}` : ""}`).join(", ")}`
      : "";
    const step: StepBuild = {
      kind: "model",
      start_ms: t.start,
      end_ms: Math.max(t.start, t.end),
      name: "model turn",
      haystack: words(t.text.join("\n")),
    };
    const output = text ? scrub(text) : calls || (t.thinking ? "(thinking)" : "");
    if (output) step.output = output;
    if (text && calls) step.input = scrub(calls, 200);
    if (t.usage) step.tokens = t.usage;
    if (t.kinds.length && t.kinds.every((k) => k === "board" || k === "wait"))
      step.board_turn = true;
    lane.steps.push(step);
  };

  for (const line of lines) {
    const type = str(line.type);
    if (type === "result") {
      result = {
        durationMs: num(line.duration_ms) ?? null,
        tokens: usageOf(line.usage),
        costMicro: usdNumberToMicro(line.total_cost_usd),
        outcome:
          (str(line.subtype) ?? (line.is_error === true ? "error" : null))?.slice(0, 60) ?? null,
      };
      continue;
    }
    const ts = parseTs(line.timestamp);
    if (ts === null) continue;
    const msg = isObj(line.message) ? line.message : null;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    const lane = laneFor(line.parent_tool_use_id);

    if (type === "assistant") {
      const msgId = str(msg?.id) ?? str(line.uuid) ?? String(ts);
      if (lane.turn && lane.turn.id !== msgId) closeTurn(lane);
      if (!lane.turn) {
        lane.turn = {
          id: msgId,
          start: lane.cursor ?? ts,
          end: ts,
          text: [],
          tools: [],
          kinds: [],
          thinking: false,
          usage: null,
        };
      }
      lane.turn.end = Math.max(lane.turn.end, ts);
      const u = usageOf(msg?.usage);
      if (u) {
        sawUsage = true;
        lane.turn.usage = u; // a message's usage is cumulative over its blocks: keep the last
      }
      for (const block of content) {
        if (!isObj(block)) continue;
        if (block.type === "text" && typeof block.text === "string")
          lane.turn.text.push(block.text);
        else if (block.type === "thinking") lane.turn.thinking = true;
        else if (block.type === "tool_use") {
          const tool = str(block.name) ?? "tool";
          const id = str(block.id) ?? `${msgId}:${lane.turn.tools.length}`;
          lane.turn.tools.push(shortToolName(tool));
          lane.turn.kinds.push(stepKind(tool));
          const desc = describeInput(tool, block.input);
          const step: StepBuild = {
            kind: stepKind(tool),
            start_ms: ts,
            end_ms: ts,
            name: shortToolName(tool),
            haystack: words(
              typeof block.input === "object" ? JSON.stringify(block.input ?? {}) : "",
            ).replace(TOKENISH, ""),
            toolId: id,
            open: true,
          };
          if (desc) step.input = scrub(desc);
          if (tool === "Bash" && TEST_CMD.test(desc)) step.test = true;
          const files = filesWritten(tool, block.input, undefined);
          if (files.length) step.files = files;
          lane.steps.push(step);
          lane.open.set(id, step);
          toolLane.set(id, lane);
        }
      }
      touch(lane, ts);
      continue;
    }

    if (type === "user") {
      closeTurn(lane);
      for (const block of content) {
        if (!isObj(block) || block.type !== "tool_result") continue;
        const id = str(block.tool_use_id);
        const owner = id ? (toolLane.get(id) ?? lane) : lane;
        const step = id ? owner.open.get(id) : undefined;
        if (!step) continue;
        owner.open.delete(id!);
        delete step.open;
        step.end_ms = Math.max(step.start_ms, ts);
        step.ok = block.is_error !== true;
        const out = toolResultText(block.content);
        if (out) step.output = scrub(out);
        step.haystack += ` ${words(out.slice(0, 20_000))}`;
        if (step.test) {
          const s = testSummary(out);
          if (s) step.test_summary = s;
        }
        const files = filesWritten(step.name, null, line.tool_use_result);
        if (files.length) step.files = [...new Set([...(step.files ?? []), ...files])].slice(0, 50);
      }
      touch(lane, ts);
    }
  }
  const lanes = [main, ...subs.values()];
  for (const lane of lanes) {
    closeTurn(lane);
    for (const step of lane.open.values()) step.end_ms = Math.max(step.start_ms, lane.lastTs ?? 0);
    lane.open.clear();
  }
  return { lanes, result, sawUsage };
}

// ---------------------------------------------------------------------------------------------
// Time accounting

const PRIORITY: Record<TraceStepKind, number> = { model: 4, tool: 3, board: 2, wait: 1 };

function paint(buckets: Uint8Array, start: number, end: number, code: number): void {
  const a = Math.max(0, Math.floor(start / TRACE_BUCKET_MS));
  const b = Math.min(buckets.length, Math.ceil(end / TRACE_BUCKET_MS));
  for (let i = a; i < b; i++) if (buckets[i]! < code) buckets[i] = code;
}

function count(buckets: Uint8Array, a: number, b: number, codes: number[]): number {
  let n = 0;
  for (let i = Math.max(0, a); i < Math.min(b, buckets.length); i++)
    if (codes.includes(buckets[i]!)) n++;
  return n * TRACE_BUCKET_MS;
}

// ---------------------------------------------------------------------------------------------
// Board (Tandem) events

function agentName(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return s.replace(/^agent:/, "").slice(0, 80);
}

function boardEvents(
  actions: unknown,
  approvals: Json[],
  rel: (t: number) => number,
): TraceCoordEvent[] {
  const out: TraceCoordEvent[] = [];
  const list = isObj(actions) && Array.isArray(actions.actions) ? actions.actions : [];
  const push = (
    at: number | null,
    kind: TraceCoordEvent["kind"],
    actor: string | null,
    ticket: string | null,
    title: string | null,
  ) => {
    if (at === null) return;
    out.push({
      at_ms: rel(at),
      kind,
      actor: actor?.slice(0, 80) ?? null,
      ticket: ticket?.slice(0, 40) ?? null,
      title: title?.slice(0, 200) ?? null,
    });
  };
  for (const a of list) {
    if (!isObj(a)) continue;
    const payload = isObj(a.payload) ? a.payload : {};
    const title = str(payload.title) ?? null;
    const ticket = str(a.ticketId) ?? null;
    if (a.type === "epic") {
      push(parseTs(a.createdAt), "epic_proposed", agentName(a.authoredBy), null, title);
    } else if (a.type === "task") {
      push(parseTs(a.createdAt), "task_created", agentName(a.authoredBy), ticket, title);
      push(parseTs(a.claimedAt), "claimed", agentName(a.claimedBy), ticket, title);
      if (Array.isArray(payload.contention)) {
        for (const c of payload.contention) {
          if (isObj(c) && c.kind === "lost_claim")
            push(parseTs(c.at), "lost_claim", agentName(c.agent), ticket, title);
        }
      }
      if (a.state === "done")
        push(parseTs(a.updatedAt), "task_done", agentName(a.claimedBy), ticket, title);
    }
  }
  for (const ap of approvals) {
    if (ap.decision !== "approve" && ap.decision !== "approved") continue;
    const target = isObj(ap.target) ? ap.target : {};
    push(
      parseTs(ap.at),
      "approved",
      str(ap.decided_by) ?? "approver",
      null,
      str(target.type) ?? null,
    );
  }
  return out.sort((x, y) => x.at_ms - y.at_ms);
}

// ---------------------------------------------------------------------------------------------
// Failure detail

const STOP = new Set(
  (
    "the and never should with from that this file files directory such open test tests when then than have does into only each " +
    "returns return true false error errors expected actual equal equals assert undefined null node work runhome hidden anybench " +
    "score var lib tmp work json passed failed first failure must not are was were but for its it's after before same also"
  ).split(" "),
);

function stem(w: string): string {
  for (const suf of ["ence", "ance", "ing", "ed", "s"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  }
  return w;
}

export function failureTerms(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const raw of words(t).split(/[^a-z0-9]+/)) {
      if (raw.length < 4 || /\d/.test(raw) || STOP.has(raw)) continue;
      const s = stem(raw);
      if (!STOP.has(s)) out.add(s);
    }
  }
  return [...out].slice(0, 12);
}

interface GateLike {
  gate: string;
  pass: boolean;
  applicable: boolean;
  reason: string;
}

function gatesOf(record: unknown): GateLike[] {
  if (!isObj(record) || !isObj(record.gates)) return [];
  const out: GateLike[] = [];
  for (const [gate, o] of Object.entries(record.gates)) {
    const r = isObj(o) && isObj(o.result) ? o.result : null;
    if (!r) continue;
    out.push({
      gate,
      pass: r.pass === true,
      applicable: r.applicable !== false,
      reason: str(r.reason) ?? "",
    });
  }
  return out;
}

/** Every applicable gate of a gate record passed (and there was at least one). */
export function gatePassed(record: unknown): boolean {
  const applicable = gatesOf(record).filter((g) => g.applicable);
  return applicable.length > 0 && applicable.every((g) => g.pass);
}

const FIRST_FAILURE =
  /(\d+)\/(\d+) hidden tests passed; first failure: ([^›]+?) › ([\s\S]+?): ([\s\S]*)$/;

function buildFailure(
  record: unknown,
  actors: { id: string; steps: StepBuild[] }[],
  scrub: (t: string, max?: number) => string,
): TraceFailure | null {
  const gates = gatesOf(record);
  const failed = gates.filter((g) => g.applicable && !g.pass);
  if (failed.length === 0) return null;
  let passed: number | null = null;
  let total: number | null = null;
  const tests: TraceFailure["tests"] = [];
  for (const g of failed) {
    const m = FIRST_FAILURE.exec(g.reason);
    if (!m) continue;
    passed = Number(m[1]);
    total = Number(m[2]);
    tests.push({
      gate: g.gate.slice(0, 80),
      file: scrub(m[3]!.trim(), 200),
      name: scrub(m[4]!.trim(), 300),
      message: scrub(m[5]!.trim(), 600),
    });
  }
  // Terms from the failing tests (or, without a parsed test, from the failed gates' reasons).
  const texts = tests.length
    ? tests.flatMap((t) => [t.file ?? "", t.name, t.message.replace(/\/[^\s'"]*\//g, " ")])
    : failed.map((g) => g.reason);
  const terms = failureTerms(texts);
  const related: TraceFailure["related"] = [];
  const files = new Set<string>();
  if (terms.length) {
    const scored: { actor: string; step: number; score: number; why: string; at: number }[] = [];
    for (const a of actors) {
      a.steps.forEach((s, i) => {
        const hits = terms.filter((t) => s.haystack.includes(t));
        const pathHits = (s.files ?? []).filter((f) => terms.some((t) => words(f).includes(t)));
        const writes = (s.files?.length ?? 0) > 0;
        const score = hits.length + pathHits.length * 2 + (writes ? 1 : 0);
        // A step that wrote code, or one that wrote the instructions others followed (the plan, a
        // ticket); reads and board lookups that merely mention the terms are not leads.
        const authored = s.kind === "board" && /propose|amend|create|plan/.test(s.name);
        const enough = writes ? hits.length + pathHits.length >= 2 : authored && hits.length >= 3;
        if (!enough) return;
        for (const f of pathHits) files.add(f);
        const why = [
          writes ? `writes ${s.files!.slice(0, 3).join(", ")}` : `${s.name}`,
          hits.length ? `mentions ${hits.slice(0, 5).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; ");
        scored.push({ actor: a.id, step: i, score, why: why.slice(0, 200), at: s.start_ms });
      });
    }
    scored.sort((x, y) => y.score - x.score || x.at - y.at);
    for (const s of scored.slice(0, 6)) related.push({ actor: s.actor, step: s.step, why: s.why });
  }
  return {
    gates: gates.map((g) => ({
      gate: g.gate.slice(0, 80),
      reason: scrub(g.reason, 1000),
      applicable: g.applicable,
    })),
    passed,
    total,
    tests,
    files: [...files].slice(0, 20),
    related,
    terms,
  };
}

// ---------------------------------------------------------------------------------------------
// Bundle → trace

/** Files of the bundle the parser reads (everything else is only listed). */
export function isTraceSource(name: string): boolean {
  return (
    name === "events.jsonl" ||
    name === "versions.json" ||
    name === "stream.jsonl" ||
    /^(?:[\w.-]+\/)*streams\/[\w.-]+\.jsonl$/.test(name) ||
    /(^|\/)actions\.json$/.test(name) ||
    /(^|\/)approvals\.jsonl$/.test(name)
  );
}

export interface TraceBuildInput {
  trialId: string;
  /** Bundle entries (isTraceSource files with their bytes). */
  entries: TarEntry[];
  /** trials.gate (the gate record), or null. */
  gate?: unknown;
  redactor?: Redactor;
  now?: () => Date;
}

function roleOf(name: string): TraceActor["role"] {
  if (/planner/i.test(name)) return "planner";
  if (/worker/i.test(name)) return "worker";
  return "solo";
}

export function buildTrialTrace(input: TraceBuildInput): TrialTrace {
  const scrub = makeScrub(input.redactor ?? createRedactor());
  const files = new Map<string, Uint8Array>();
  for (const e of input.entries) if (e.data) files.set(e.name, e.data);
  const notes: string[] = [];

  // Sessions.
  const sessions: { id: string; role: TraceActor["role"]; lines: Json[] }[] = [];
  const solo = files.get("stream.jsonl");
  if (solo) sessions.push({ id: "agent", role: "solo", lines: parseJsonl(solo) });
  const streamNames = [...files.keys()]
    .filter((n) => /(^|\/)streams\/[\w.-]+\.jsonl$/.test(n))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  // The planner first, then workers in number order.
  streamNames.sort((a, b) => Number(!/planner/.test(a)) - Number(!/planner/.test(b)));
  for (const n of streamNames) {
    const id = n
      .replace(/^.*\//, "")
      .replace(/\.jsonl$/, "")
      .slice(0, 60);
    sessions.push({ id, role: roleOf(id), lines: parseJsonl(files.get(n)) });
  }
  if (sessions.length === 0) notes.push("No agent transcript in the bundle.");

  // t = 0 and the end: the runner's own phase edges, else the transcripts' span.
  const events = parseJsonl(files.get("events.jsonl"));
  let t0: number | null = null;
  let tEnd: number | null = null;
  for (const e of events) {
    if (e.type !== "trial.phase" || !isObj(e.payload)) continue;
    const at = parseTs(e.at);
    if (at === null) continue;
    if (e.payload.to === "running") t0 = t0 === null ? at : Math.min(t0, at);
    if (e.payload.to === "collecting" || e.payload.to === "failed_subject")
      tEnd = tEnd === null ? at : Math.max(tEnd, at);
  }
  const parsed = sessions.map((s) => ({ s, p: parseSession(s.lines, s.id, s.role, scrub) }));
  const allTs: number[] = [];
  for (const { p } of parsed) {
    for (const l of p.lanes) {
      if (l.firstTs !== null) allTs.push(l.firstTs);
      if (l.lastTs !== null) allTs.push(l.lastTs);
    }
  }
  if (t0 === null) {
    t0 = allTs.length ? Math.min(...allTs) : 0;
    notes.push("No runner phase events: time 0 is the first transcript line.");
  }
  if (tEnd === null) tEnd = allTs.length ? Math.max(...allTs) : t0;
  const lastSeen = allTs.length ? Math.max(...allTs) : t0;
  tEnd = Math.max(tEnd, lastSeen);
  const duration = Math.max(0, Math.round(tEnd - t0));
  const rel = (t: number) => Math.min(duration, Math.max(0, Math.round(t - t0!)));

  // Lanes → actors.
  const wallBuckets = new Uint8Array(Math.ceil(duration / TRACE_BUCKET_MS) + 1);
  const actors: TraceActor[] = [];
  const builds: { id: string; steps: StepBuild[] }[] = [];
  let sawUsage = false;
  for (const { p } of parsed) {
    sawUsage ||= p.sawUsage;
    p.lanes.forEach((lane, li) => {
      if (lane.firstTs === null) return;
      // Session bounds: the result line's duration, back from the last line.
      let start = lane.firstTs;
      if (li === 0 && p.result?.durationMs && lane.lastTs !== null) {
        const back = lane.lastTs - p.result.durationMs;
        if (back <= lane.firstTs && lane.firstTs - back < 10 * 60_000) start = back;
      } else if (li > 0 && lane.cursor !== null) {
        start = Math.min(start, lane.steps[0]?.start_ms ?? start);
      }
      const end = lane.lastTs ?? start;
      // The first model turn starts at the session start (it includes the CLI's own startup).
      const firstModel = lane.steps.find((s) => s.kind === "model");
      if (firstModel && firstModel.start_ms > start) {
        if (!lane.steps.some((s) => s !== firstModel && s.start_ms < firstModel.start_ms))
          firstModel.start_ms = start;
      }
      const steps: StepBuild[] = lane.steps
        .map((s) => ({
          ...s,
          start_ms: rel(s.start_ms),
          end_ms: Math.max(rel(s.start_ms), rel(s.end_ms)),
        }))
        .sort((x, y) => x.start_ms - y.start_ms || PRIORITY[y.kind] - PRIORITY[x.kind]);
      const a = rel(start);
      const b = Math.max(a, rel(end));
      const buckets = new Uint8Array(wallBuckets.length);
      for (const s of steps) paint(buckets, s.start_ms, s.end_ms, PRIORITY[s.kind]);
      for (let i = 0; i < buckets.length; i++)
        if (buckets[i]! > wallBuckets[i]!) wallBuckets[i] = buckets[i]!;
      const ba = Math.floor(a / TRACE_BUCKET_MS);
      const bb = Math.ceil(b / TRACE_BUCKET_MS);
      const gaps: TraceGap[] = [];
      if (a > 0) gaps.push({ kind: "not_started", start_ms: 0, end_ms: a });
      let runStart: number | null = null;
      for (let i = ba; i <= bb; i++) {
        const idle = i < bb && buckets[i] === 0;
        if (idle && runStart === null) runStart = i;
        if (!idle && runStart !== null) {
          const gs = runStart * TRACE_BUCKET_MS;
          const ge = Math.min(b, i * TRACE_BUCKET_MS);
          if (ge - gs >= MIN_IDLE_GAP_MS) gaps.push({ kind: "idle", start_ms: gs, end_ms: ge });
          runStart = null;
        }
      }
      if (b < duration) gaps.push({ kind: "finished", start_ms: b, end_ms: duration });
      const res = li === 0 ? p.result : null;
      const toolSteps = steps.filter((s) => s.kind === "tool");
      const kept = steps.slice(0, TRACE_MAX_STEPS_PER_ACTOR);
      actors.push({
        id: lane.id.slice(0, 80),
        role: lane.role,
        start_ms: a,
        end_ms: b,
        steps: kept.map(({ haystack: _h, toolId: _t, ...s }) => s),
        gaps,
        totals: {
          model_ms: count(buckets, ba, bb, [4]),
          tool_ms: count(buckets, ba, bb, [3]),
          board_ms: count(buckets, ba, bb, [2]),
          wait_ms: count(buckets, ba, bb, [1]),
          model_board_ms: steps
            .filter((s) => s.board_turn)
            .reduce((n, s) => n + (s.end_ms - s.start_ms), 0),
          idle_ms: count(buckets, ba, bb, [0]),
          session_ms: b - a,
          turns: steps.filter((s) => s.kind === "model").length,
          tool_calls: toolSteps.length,
          tool_errors: steps.filter((s) => s.kind !== "model" && s.ok === false).length,
          board_calls: steps.filter((s) => s.kind === "board" || s.kind === "wait").length,
          test_runs: steps.filter((s) => s.test).length,
          tokens: res?.tokens ?? null,
          cost_micro_usd: res?.costMicro ?? null,
        },
        outcome: res?.outcome ?? (li === 0 ? null : "subagent"),
        truncated_steps: steps.length - kept.length,
      });
      builds.push({ id: lane.id.slice(0, 80), steps: kept });
    });
  }
  if (sessions.length && !sawUsage) {
    notes.push(
      "Per-turn token usage isn't in these transcripts (the model proxy streams it as zeros), so tokens and cost are per session, from each session's result line.",
    );
  }
  if (actors.some((a) => a.totals.tokens === null && a.role !== "subagent")) {
    notes.push(
      "A session ended without a result line (stopped or timed out): its tokens and cost are unknown.",
    );
  }

  // Wall split and phases.
  const nb = wallBuckets.length - 1;
  const wall = {
    model_ms: count(wallBuckets, 0, nb, [4]),
    tool_ms: count(wallBuckets, 0, nb, [3]),
    coordination_ms: count(wallBuckets, 0, nb, [2, 1]),
    idle_ms: count(wallBuckets, 0, nb, [0]),
  };
  const main = actors.filter((a) => a.role !== "subagent");
  const phases: TracePhase[] = [];
  if (main.length) {
    const firstStart = Math.min(...main.map((a) => a.start_ms));
    const lastEnd = Math.max(...main.map((a) => a.end_ms));
    if (firstStart > 0) phases.push({ name: "setup", start_ms: 0, end_ms: firstStart });
    const planner = main.find((a) => a.role === "planner");
    const workers = main.filter((a) => a.role === "worker");
    let workStart = firstStart;
    if (planner && workers.length) {
      workStart = Math.max(firstStart, Math.min(...workers.map((w) => w.start_ms)));
      if (workStart > firstStart)
        phases.push({ name: "planning", start_ms: firstStart, end_ms: workStart });
    }
    phases.push({ name: "work", start_ms: workStart, end_ms: Math.max(workStart, lastEnd) });
    if (lastEnd < duration) phases.push({ name: "teardown", start_ms: lastEnd, end_ms: duration });
  }

  // Board events (Tandem).
  const actionsName = [...files.keys()].find((n) => /(^|\/)actions\.json$/.test(n));
  const approvalsName = [...files.keys()].find((n) => /(^|\/)approvals\.jsonl$/.test(n));
  const coordination = boardEvents(
    parseJson(actionsName ? files.get(actionsName) : undefined),
    parseJsonl(approvalsName ? files.get(approvalsName) : undefined),
    rel,
  );

  const versions = parseJson(files.get("versions.json"));
  const setup = isObj(versions)
    ? (str(versions.setup) ?? (versions.tandem ? "tandem" : null))
    : streamNames.length
      ? "tandem"
      : null;

  const failure = buildFailure(input.gate ?? null, builds, scrub);
  if (failure) {
    notes.push(
      "Only the first failing hidden test is recorded (the gate's evidence files stay on the scoring computer, which is destroyed). Related steps are leads by keyword and file match, not a proven cause.",
    );
  }

  const trace: TrialTrace = {
    version: TRACE_VERSION,
    trial_id: input.trialId as TrialTrace["trial_id"],
    setup: setup?.slice(0, 80) ?? null,
    started_at: new Date(t0).toISOString(),
    duration_ms: duration,
    actors,
    coordination,
    phases,
    wall,
    failure,
    sources: input.entries.filter((e) => e.data).map((e) => e.name.slice(0, 200)),
    notes,
    built_at: (input.now?.() ?? new Date()).toISOString(),
  };
  // The contract is the check: a trace that doesn't validate is a bug here, never stored.
  return TrialTraceSchema.parse(trace);
}

/** out.tar.gz bytes → trace. */
export function traceFromBundle(
  bundle: Uint8Array,
  input: Omit<TraceBuildInput, "entries">,
): TrialTrace {
  const entries = readTarGz(bundle, { want: (name) => isTraceSource(name) });
  return buildTrialTrace({ ...input, entries });
}
