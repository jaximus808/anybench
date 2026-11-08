// Collectors for driver.type `harness` (TDM-41 [4.9]): what a Tandem trial left in EVAL_OUT -> metric
// rows. Reads, in order of trust:
//
//   tandem/tandem.db       the trial's own board (the server is fresh per trial): every epic and
//                          ticket with its state, who approved it, who claimed it, the claim record
//                          (generation) and the contention trail (`lost_claim`, `fenced_write`);
//                          `tandem/actions.json` (the API dump) when the db can't be opened
//   tandem/metrics.json    GET /api/metrics: the server's own counters (claims, claim_conflicts,
//                          ttl_expiries, fenced_writes), trial-scoped because the server is
//   tandem/streams/*.jsonl one stream-json transcript per planner/worker session: tokens, turns,
//                          tool calls, and Claude Code's reported cost
//   tandem/run.json        run.sh's outcome and wall time
//   tandem/approvals.jsonl the approver's own log (@anybench/approver or run.sh's built-in one):
//                          the board can't tell a simulated approval from a real one, so the
//                          `simulated_approvals` count and latency come from here (rule 10)
//
// Rows use the bench MetricSchema shape (mirrored as HttpAgentMetricRowSchema, see http-agent
// collect.ts for why it is mirrored and not imported). Board numbers are collector `tandem-board`,
// session numbers `stream-json`. None of them is scored unless its gate passed (bench linkGates /
// scoreKit). Money is bigint micro-USD from the JSON source text; no float touches it.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { addMicro, type MicroUsd } from "@anybench/core";
import { z } from "zod";
import {
  HttpAgentMetricRowSchema,
  nearestRankPercentile,
  type HttpAgentMetricRow,
} from "../http-agent/collect.js";

export const HarnessMetricRowSchema = HttpAgentMetricRowSchema;
export type HarnessMetricRow = HttpAgentMetricRow;

/** Paths under EVAL_OUT written by adapters/<harness>/run.sh, relative to it. */
export const HARNESS_OUTPUT_PATHS = {
  dir: "tandem",
  db: "tandem/tandem.db",
  actions: "tandem/actions.json",
  metrics: "tandem/metrics.json",
  run: "tandem/run.json",
  approvals: "tandem/approvals.jsonl",
  streams: "tandem/streams",
  /** The scrubbed workspace the scoring computer grades. */
  workspace: "workspace",
  versions: "versions.json",
  /** What `collectHarness` writes back (bench `parseMetricsJsonl` reads it as is). */
  metricsJsonl: "harness.metrics.jsonl",
} as const;

// ---------------------------------------------------------------------------------------------
// The board.

/** One row of Tandem's `actions` table (epics and tickets), the fields the collector reads. */
export interface TandemAction {
  type: string;
  state: string;
  ticket: number | null;
  approved_by: string | null;
  claimed_by: string | null;
  payload: Record<string, unknown>;
}

const ContentionEventSchema = z.looseObject({
  kind: z.string(),
  agent: z.string().optional(),
  holder: z.string().optional(),
  count: z.int().positive().optional(),
});
const ClaimRecordSchema = z.looseObject({ generation: z.int().nonnegative(), holder: z.string() });

export interface TandemBoardSummary {
  epics: number;
  tickets: number;
  tickets_by_state: Record<string, number>;
  /** Successful claims: the sum of every ticket's claim generation (a takeover is a new one). */
  claims: number;
  /** Claims that replaced an earlier holder's (generation > 1). */
  claim_takeovers: number;
  /** `lost_claim` events: an agent asked for a ticket someone else held. */
  claim_conflicts: number;
  /** `fenced_write` events: a write under a claim the agent no longer held. */
  fenced_writes: number;
  /** Tickets with at least one contention event. */
  contended_tickets: number;
  /** Distinct agents that held a claim. */
  claimants: number;
  /** Approved epics and tickets by who approved them (`human`, `policy:epic`, `agent:<n>`, …). */
  approvals_by: Record<string, number>;
}

const inc = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};

export function summarizeBoard(actions: readonly TandemAction[]): TandemBoardSummary {
  const s: TandemBoardSummary = {
    epics: 0,
    tickets: 0,
    tickets_by_state: {},
    claims: 0,
    claim_takeovers: 0,
    claim_conflicts: 0,
    fenced_writes: 0,
    contended_tickets: 0,
    claimants: 0,
    approvals_by: {},
  };
  const holders = new Set<string>();
  for (const a of actions) {
    if (a.approved_by) inc(s.approvals_by, a.approved_by);
    if (a.type === "epic") {
      s.epics++;
      continue;
    }
    if (a.type !== "task") continue;
    s.tickets++;
    inc(s.tickets_by_state, a.state);
    const claim = ClaimRecordSchema.safeParse(a.payload.claim);
    if (claim.success && claim.data.generation > 0) {
      s.claims += claim.data.generation;
      s.claim_takeovers += claim.data.generation - 1;
      holders.add(claim.data.holder);
    } else if (a.claimed_by) {
      s.claims++;
      holders.add(a.claimed_by);
    }
    const trail = z.array(ContentionEventSchema).safeParse(a.payload.contention ?? []);
    if (trail.success && trail.data.length > 0) {
      s.contended_tickets++;
      for (const e of trail.data) {
        if (e.kind === "lost_claim") s.claim_conflicts += e.count ?? 1;
        else if (e.kind === "fenced_write") s.fenced_writes += e.count ?? 1;
      }
    }
  }
  s.claimants = holders.size;
  return s;
}

const parsePayload = (p: unknown): Record<string, unknown> => {
  if (typeof p === "object" && p !== null && !Array.isArray(p)) return p as Record<string, unknown>;
  if (typeof p !== "string") return {};
  try {
    const v = JSON.parse(p) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};
const strOrNull = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

/** Read every action from a copy of tandem.db (read-only). Needs `node:sqlite` (Node >= 22.13). */
export async function readTandemDb(file: string): Promise<TandemAction[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT type, state, ticket, approved_by, claimed_by, payload FROM actions")
      .all();
    return rows.map((r) => ({
      type: String(r.type),
      state: String(r.state),
      ticket: typeof r.ticket === "number" ? r.ticket : null,
      approved_by: strOrNull(r.approved_by),
      claimed_by: strOrNull(r.claimed_by),
      payload: parsePayload(r.payload),
    }));
  } finally {
    db.close();
  }
}

/** The same rows from the API dump (`GET /api/canvas/actions`, camelCase). */
export function tandemActionsFromApi(json: unknown): TandemAction[] {
  const list = Array.isArray(json)
    ? json
    : typeof json === "object" &&
        json !== null &&
        Array.isArray((json as { actions?: unknown }).actions)
      ? (json as { actions: unknown[] }).actions
      : [];
  return list
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .map((a) => ({
      type: String(a.type ?? ""),
      state: String(a.state ?? ""),
      ticket: typeof a.ticket === "number" ? a.ticket : null,
      approved_by: strOrNull(a.approvedBy),
      claimed_by: strOrNull(a.claimedBy),
      payload: parsePayload(a.payload),
    }));
}

/** `GET /api/metrics` counters (process-wide; the server is fresh per trial). */
export const TandemMetricsSchema = z.looseObject({
  counters: z.looseObject({
    claims: z.int().nonnegative(),
    claim_conflicts: z.int().nonnegative(),
    ttl_expiries: z.int().nonnegative(),
    fenced_writes: z.int().nonnegative(),
  }),
});

// ---------------------------------------------------------------------------------------------
// Sessions.

/** `-?d+(.d+)?(e±d+)?` USD text -> micro-USD, half up (the same rule as bench usdTextToMicro). */
export function usdTextToMicroUsd(text: string): MicroUsd {
  const m = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(text.trim());
  if (!m) throw new RangeError(`not a USD decimal: ${JSON.stringify(text)}`);
  const [, sign, whole = "0", frac = "", exp = "0"] = m;
  const digits = BigInt((whole + frac).replace(/^0+(?=\d)/, ""));
  const shift = Number(exp) - frac.length + 6;
  if (Math.abs(shift) > 60) throw new RangeError(`USD amount out of range: ${text}`);
  let micro: bigint;
  if (shift >= 0) micro = digits * 10n ** BigInt(shift);
  else {
    const div = 10n ** BigInt(-shift);
    micro = digits / div;
    if ((digits % div) * 2n >= div) micro += 1n;
  }
  return sign && micro !== 0n ? -micro : micro;
}

export interface SessionSummary {
  name: string;
  /** The session ended with a `result` line (a session stopped by the harness may not). */
  has_result: boolean;
  cost_micro_usd: MicroUsd | null;
  turns: number;
  tool_calls: number;
  tokens: { input: number; output: number; cache_read: number; cache_creation: number };
}

const COST_TEXT = /"total_cost_usd"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/;

/**
 * One stream-json transcript. Tokens are summed per assistant message id (Claude Code repeats a
 * message's usage on each content block, so each id counts once, field-wise max), which works for
 * a session the harness stopped before its `result`; cost and turns come from the last `result`.
 */
export function summarizeSession(name: string, text: string): SessionSummary {
  const perMessage = new Map<string, SessionSummary["tokens"]>();
  let anon = 0;
  let toolCalls = 0;
  let result: { cost: MicroUsd | null; turns: number | null } | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type === "assistant") {
      const msg = (e.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
      toolCalls += content.filter((b) => b?.type === "tool_use").length;
      const u = (msg.usage ?? null) as Record<string, unknown> | null;
      if (!u) continue;
      const id = typeof msg.id === "string" ? msg.id : `anon-${anon++}`;
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      const prev = perMessage.get(id);
      perMessage.set(id, {
        input: Math.max(prev?.input ?? 0, n("input_tokens")),
        output: Math.max(prev?.output ?? 0, n("output_tokens")),
        cache_read: Math.max(prev?.cache_read ?? 0, n("cache_read_input_tokens")),
        cache_creation: Math.max(prev?.cache_creation ?? 0, n("cache_creation_input_tokens")),
      });
    } else if (e.type === "result") {
      const cost = COST_TEXT.exec(line)?.[1];
      result = {
        cost: cost === undefined ? null : usdTextToMicroUsd(cost),
        turns: typeof e.num_turns === "number" ? e.num_turns : null,
      };
    }
  }
  const tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  for (const t of perMessage.values()) {
    tokens.input += t.input;
    tokens.output += t.output;
    tokens.cache_read += t.cache_read;
    tokens.cache_creation += t.cache_creation;
  }
  return {
    name,
    has_result: result !== null,
    cost_micro_usd: result?.cost ?? null,
    turns: result?.turns ?? perMessage.size,
    tool_calls: toolCalls,
    tokens,
  };
}

// ---------------------------------------------------------------------------------------------

export const HarnessRunSchema = z.looseObject({
  outcome: z.string(),
  reason: z.string().optional(),
  workers: z.int().positive(),
  wall_ms: z.int().nonnegative(),
});
export type HarnessRun = z.infer<typeof HarnessRunSchema>;

export interface HarnessCollection {
  rows: HarnessMetricRow[];
  board: TandemBoardSummary | null;
  /** Where the board came from. */
  board_source: "tandem.db" | "actions.json" | null;
  sessions: SessionSummary[];
  run: HarnessRun | null;
  /** Inputs that were missing or unreadable: their rows are absent, never guessed. */
  missing: string[];
}

async function readText(file: string): Promise<string | undefined> {
  const st = await stat(file).catch(() => undefined);
  return st?.isFile() ? readFile(file, "utf8") : undefined;
}

/** Collect a frozen (or live) harness EVAL_OUT into metric rows. */
export async function collectHarness(outDir: string): Promise<HarnessCollection> {
  const P = HARNESS_OUTPUT_PATHS;
  const missing: string[] = [];
  const rows: HarnessMetricRow[] = [];
  const trial = (
    name: string,
    value: number | bigint,
    unit: HarnessMetricRow["unit"],
    collector: "tandem-board" | "stream-json" | "time",
    labels?: Record<string, string>,
  ) =>
    rows.push(
      HarnessMetricRowSchema.parse({
        name,
        value,
        unit,
        level: "trial",
        collector,
        ...(labels ? { labels } : {}),
      }),
    );

  // Board.
  let actions: TandemAction[] | null = null;
  let board_source: HarnessCollection["board_source"] = null;
  const dbFile = join(outDir, P.db);
  if ((await stat(dbFile).catch(() => undefined))?.isFile()) {
    try {
      actions = await readTandemDb(dbFile);
      board_source = "tandem.db";
    } catch (e) {
      missing.push(`${P.db}: ${(e as Error).message}`);
    }
  } else missing.push(`${P.db}: missing`);
  if (actions === null) {
    const text = await readText(join(outDir, P.actions));
    if (text !== undefined) {
      actions = tandemActionsFromApi(JSON.parse(text));
      board_source = "actions.json";
    } else missing.push(`${P.actions}: missing`);
  }
  const board = actions === null ? null : summarizeBoard(actions);
  if (board) {
    trial("tandem_epics", board.epics, "count", "tandem-board");
    trial("tandem_tickets", board.tickets, "count", "tandem-board");
    for (const [state, n] of Object.entries(board.tickets_by_state).sort())
      trial("tandem_tickets_by_state", n, "count", "tandem-board", { state });
    trial("tandem_claims", board.claims, "count", "tandem-board");
    trial("tandem_claim_takeovers", board.claim_takeovers, "count", "tandem-board");
    trial("tandem_claim_conflicts", board.claim_conflicts, "count", "tandem-board");
    trial("tandem_fenced_writes", board.fenced_writes, "count", "tandem-board");
    trial("tandem_contended_tickets", board.contended_tickets, "count", "tandem-board");
    trial("tandem_claimants", board.claimants, "count", "tandem-board");
    let approvals = 0;
    for (const [by, n] of Object.entries(board.approvals_by).sort()) {
      approvals += n;
      trial("tandem_approvals_by", n, "count", "tandem-board", { by });
    }
    trial("tandem_approvals", approvals, "count", "tandem-board");
  }

  // Server counters.
  const metricsText = await readText(join(outDir, P.metrics));
  if (metricsText === undefined) missing.push(`${P.metrics}: missing`);
  else {
    const m = TandemMetricsSchema.safeParse(JSON.parse(metricsText));
    if (!m.success) missing.push(`${P.metrics}: not a /api/metrics snapshot`);
    else
      for (const k of ["claims", "claim_conflicts", "ttl_expiries", "fenced_writes"] as const)
        trial(`tandem_api_${k}`, m.data.counters[k], "count", "tandem-board");
  }

  // Sessions.
  const streamsDir = join(outDir, P.streams);
  const names = (await readdir(streamsDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  if (names.length === 0) missing.push(`${P.streams}/*.jsonl: none`);
  const sessions: SessionSummary[] = [];
  for (const f of names)
    sessions.push(
      summarizeSession(f.replace(/\.jsonl$/, ""), await readFile(join(streamsDir, f), "utf8")),
    );
  if (sessions.length > 0) {
    const sum = (k: keyof SessionSummary["tokens"]) =>
      sessions.reduce((a, s) => a + s.tokens[k], 0);
    trial("sessions", sessions.length, "count", "stream-json");
    const unreported = sessions.filter((s) => s.cost_micro_usd === null);
    trial("sessions_without_cost", unreported.length, "count", "stream-json");
    // The trial's cost only when every session reported its own: a missing number is not a zero.
    if (unreported.length === 0)
      trial(
        "cost_micro_usd",
        addMicro(...sessions.map((s) => s.cost_micro_usd as MicroUsd)),
        "micro_usd",
        "stream-json",
      );
    trial(
      "turns",
      sessions.reduce((a, s) => a + s.turns, 0),
      "count",
      "stream-json",
    );
    trial(
      "tool_calls",
      sessions.reduce((a, s) => a + s.tool_calls, 0),
      "count",
      "stream-json",
    );
    trial("input_tokens", sum("input"), "tokens", "stream-json");
    trial("output_tokens", sum("output"), "tokens", "stream-json");
    trial("cache_read_tokens", sum("cache_read"), "tokens", "stream-json");
    trial("cache_creation_tokens", sum("cache_creation"), "tokens", "stream-json");
    for (const s of sessions) {
      if (s.cost_micro_usd !== null)
        trial("session_cost_micro_usd", s.cost_micro_usd, "micro_usd", "stream-json", {
          session: s.name,
        });
      trial("session_turns", s.turns, "count", "stream-json", { session: s.name });
    }
  }

  // Simulated approvals (every one Anybench records is simulated: plan.md 17.2 rule 10).
  const approvalsText = await readText(join(outDir, P.approvals));
  if (approvalsText === undefined) missing.push(`${P.approvals}: missing`);
  else {
    const latencies: number[] = [];
    let approvals = 0;
    for (const line of approvalsText.split("\n")) {
      if (line.trim() === "") continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (e.simulated !== true || !["approve", "allow", "answer"].includes(String(e.decision)))
        continue;
      approvals++;
      if (typeof e.latency_ms === "number" && Number.isFinite(e.latency_ms))
        latencies.push(e.latency_ms);
    }
    trial("simulated_approvals", approvals, "count", "tandem-board");
    if (latencies.length > 0) {
      trial(
        "simulated_approval_latency_p50_ms",
        nearestRankPercentile(latencies, 50),
        "ms",
        "tandem-board",
      );
      trial(
        "simulated_approval_latency_p95_ms",
        nearestRankPercentile(latencies, 95),
        "ms",
        "tandem-board",
      );
    }
  }

  // run.sh's own record.
  let run: HarnessRun | null = null;
  const runText = await readText(join(outDir, P.run));
  if (runText === undefined) missing.push(`${P.run}: missing`);
  else {
    const r = HarnessRunSchema.safeParse(JSON.parse(runText));
    if (r.success) {
      run = r.data;
      trial("harness_wall_ms", run.wall_ms, "ms", "time");
      trial("harness_workers", run.workers, "count", "time");
      trial("harness_outcome", 1, "count", "time", { outcome: run.outcome });
    } else missing.push(`${P.run}: invalid`);
  }

  return { rows, board, board_source, sessions, run, missing };
}
