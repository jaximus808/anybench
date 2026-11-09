// Claude Code `claude -p --output-format stream-json --verbose` transcript -> Metric rows:
// tokens, turns, tool calls, cost and 429s. Event shapes are the ones Claude Code 2.1.x declares
// (docs/findings/collectors.md); the fixtures are synthetic because a real run costs money.
//
// Money: `total_cost_usd` and `modelUsage.*.costUSD` are read from their JSON source text and
// converted to micro-USD with bigint math. No float ever touches a cost.
//
// Resumed sessions (TDM-228): a driver may run several `claude -p` processes into one transcript,
// each starting with its own `system/init` (kits/harness-league's headless policy resumes a session
// that stopped to ask the user). A resumed process's `result` carries the whole session's cost and
// `modelUsage` (Claude Code 2.1.319: docs/findings/headless-policy.md) but only its own
// `num_turns` and `duration_ms`. So per session the last result is the bill, sessions add up, and
// turns and durations add up over processes. The policy's own events (`system/anybench_*`) give
// `questions_auto_answered`.
import { z } from "zod";
import type { MicroUsd } from "@anybench/core";
import {
  metric,
  NumberTextSchema,
  parseJsonKeepingNumberText,
  usdTextToMicro,
  type Metric,
} from "../metric.js";

const MONEY_KEYS: ReadonlySet<string> = new Set(["total_cost_usd", "costUSD"]);
const Count = z.int().nonnegative();
const UsdText = NumberTextSchema.transform((n) => usdTextToMicro(n.$number));

const ApiUsageSchema = z.looseObject({
  input_tokens: Count.default(0),
  output_tokens: Count.default(0),
  cache_creation_input_tokens: Count.nullish().transform((v) => v ?? 0),
  cache_read_input_tokens: Count.nullish().transform((v) => v ?? 0),
});

const ModelUsageSchema = z.looseObject({
  inputTokens: Count,
  outputTokens: Count,
  cacheReadInputTokens: Count.default(0),
  cacheCreationInputTokens: Count.default(0),
  costUSD: UsdText.optional(),
});

const ContentBlockSchema = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  is_error: z.boolean().optional(),
});

const InitEventSchema = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  model: z.string().optional(),
  claude_code_version: z.string().optional(),
  session_id: z.string().optional(),
});

const ApiRetryEventSchema = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  attempt: z.int().optional(),
  error_status: z.int().nullable().optional(),
  error: z.string().optional(),
});

const AssistantEventSchema = z.looseObject({
  type: z.literal("assistant"),
  parent_tool_use_id: z.string().nullable().optional(),
  error: z.string().optional(),
  message: z.looseObject({
    id: z.string().optional(),
    model: z.string().optional(),
    content: z.array(ContentBlockSchema).default([]),
    usage: ApiUsageSchema.optional(),
  }),
});

const UserEventSchema = z.looseObject({
  type: z.literal("user"),
  message: z.looseObject({
    content: z.union([z.string(), z.array(ContentBlockSchema)]).default([]),
  }),
});

const RateLimitEventSchema = z.looseObject({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({ status: z.string() }),
});

const ResultEventSchema = z.looseObject({
  type: z.literal("result"),
  session_id: z.string().optional(),
  subtype: z.string(),
  is_error: z.boolean().default(false),
  duration_ms: Count.optional(),
  duration_api_ms: Count.optional(),
  num_turns: Count.optional(),
  total_cost_usd: UsdText.optional(),
  usage: ApiUsageSchema.optional(),
  modelUsage: z.record(z.string(), ModelUsageSchema).optional(),
  permission_denials: z.array(z.unknown()).default([]),
});

export interface TokenCounts {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface StreamJsonSummary {
  session_id: string | null;
  model: string | null;
  claude_code_version: string | null;
  /** `result.num_turns`, or distinct top-level assistant message ids when there is no result. */
  turns: number;
  /** Where the token counts came from: `modelUsage` (all models, subagents included) is preferred. */
  token_source: "modelUsage" | "result.usage" | "assistant.usage" | "none";
  tokens: TokenCounts;
  tokens_by_model: Record<string, TokenCounts & { cost_micro_usd: MicroUsd | null }>;
  tool_calls: number;
  tool_calls_by_name: Record<string, number>;
  tool_errors: number;
  /** `api_retry` events with `error_status: 429` plus assistant messages with `error: "rate_limit"`. */
  http_429: number;
  api_retries: number;
  rate_limit_rejections: number;
  cost_micro_usd: MicroUsd | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  permission_denials: number;
  result_subtype: string | null;
  is_error: boolean;
  has_result: boolean;
  /** Lines that were not JSON, or not a shape this parser knows (counted, not fatal). */
  unparsed_lines: number;
  /** `claude` processes in the transcript (`system/init` events); more than 1 when resumed. */
  processes: number;
  /** The headless policy the driver ran under (`system/anybench_headless_policy`), or null. */
  headless_policy: string | null;
  /** `system/anybench_auto_answer` events: sessions the policy resumed with its fixed reply. */
  questions_auto_answered: number;
  /** A session still waited on the user when the policy's cap was reached. */
  auto_answer_cap_reached: boolean;
}

const zero = (): TokenCounts => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });

function addUsage(t: TokenCounts, u: z.infer<typeof ApiUsageSchema>): void {
  t.input += u.input_tokens;
  t.output += u.output_tokens;
  t.cache_read += u.cache_read_input_tokens;
  t.cache_creation += u.cache_creation_input_tokens;
}

/** Parse a stream-json transcript (one JSON event per line). */
export function parseStreamJson(text: string): StreamJsonSummary {
  const s: StreamJsonSummary = {
    session_id: null,
    model: null,
    claude_code_version: null,
    turns: 0,
    token_source: "none",
    tokens: zero(),
    tokens_by_model: {},
    tool_calls: 0,
    tool_calls_by_name: {},
    tool_errors: 0,
    http_429: 0,
    api_retries: 0,
    rate_limit_rejections: 0,
    cost_micro_usd: null,
    duration_ms: null,
    duration_api_ms: null,
    permission_denials: 0,
    result_subtype: null,
    is_error: false,
    has_result: false,
    unparsed_lines: 0,
    processes: 0,
    headless_policy: null,
    questions_auto_answered: 0,
    auto_answer_cap_reached: false,
  };
  // Claude Code streams one assistant event per content block, all sharing message.id and
  // repeating the same usage: count usage and turns once per id, tool_use blocks every time.
  const assistantUsage = new Map<string, z.infer<typeof ApiUsageSchema>>();
  const topLevelIds = new Set<string>();
  const seenToolUseIds = new Set<string>();
  type Result = z.infer<typeof ResultEventSchema>;
  let result: Result | null = null;
  // The last result of each `claude` process (between two `system/init` events).
  const perProcess: Result[] = [];
  let processResult: Result | null = null;

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = parseJsonKeepingNumberText(line, MONEY_KEYS);
    } catch {
      s.unparsed_lines++;
      continue;
    }
    const type = (raw as { type?: unknown } | null)?.type;
    const subtype = (raw as { subtype?: unknown } | null)?.subtype;

    if (type === "system" && subtype === "init") {
      const e = InitEventSchema.safeParse(raw);
      s.processes++;
      if (processResult) perProcess.push(processResult);
      processResult = null;
      if (!e.success) s.unparsed_lines++;
      else {
        s.session_id = e.data.session_id ?? s.session_id;
        s.model = e.data.model ?? s.model;
        s.claude_code_version = e.data.claude_code_version ?? s.claude_code_version;
      }
    } else if (type === "system" && subtype === "anybench_headless_policy") {
      const policy = (raw as { policy?: unknown }).policy;
      s.headless_policy = typeof policy === "string" ? policy : "unknown";
    } else if (type === "system" && subtype === "anybench_auto_answer") {
      s.questions_auto_answered++;
    } else if (type === "system" && subtype === "anybench_auto_answer_cap") {
      s.auto_answer_cap_reached = true;
    } else if (type === "system" && subtype === "api_retry") {
      const e = ApiRetryEventSchema.safeParse(raw);
      if (!e.success) s.unparsed_lines++;
      else {
        s.api_retries++;
        if (e.data.error_status === 429) s.http_429++;
      }
    } else if (type === "assistant") {
      const e = AssistantEventSchema.safeParse(raw);
      if (!e.success) {
        s.unparsed_lines++;
        continue;
      }
      const a = e.data;
      if (a.error === "rate_limit") s.http_429++;
      const id = a.message.id;
      if (id !== undefined && a.message.usage) assistantUsage.set(id, a.message.usage);
      if (id !== undefined && !a.parent_tool_use_id && a.message.model !== "<synthetic>")
        topLevelIds.add(id);
      for (const block of a.message.content) {
        if (block.type !== "tool_use") continue;
        const toolId = typeof block.id === "string" ? block.id : null;
        if (toolId !== null) {
          if (seenToolUseIds.has(toolId)) continue;
          seenToolUseIds.add(toolId);
        }
        const name = block.name ?? "unknown";
        s.tool_calls++;
        s.tool_calls_by_name[name] = (s.tool_calls_by_name[name] ?? 0) + 1;
      }
    } else if (type === "user") {
      const e = UserEventSchema.safeParse(raw);
      if (!e.success) {
        s.unparsed_lines++;
        continue;
      }
      const content = e.data.message.content;
      if (Array.isArray(content)) {
        for (const block of content)
          if (block.type === "tool_result" && block.is_error === true) s.tool_errors++;
      }
    } else if (type === "rate_limit_event") {
      const e = RateLimitEventSchema.safeParse(raw);
      if (!e.success) s.unparsed_lines++;
      else if (e.data.rate_limit_info.status === "rejected") s.rate_limit_rejections++;
    } else if (type === "result") {
      const e = ResultEventSchema.safeParse(raw);
      if (!e.success) s.unparsed_lines++;
      else {
        result = e.data; // the last result wins (streaming-input sessions emit one per turn)
        processResult = e.data;
      }
    }
    // Other event types (stream_event, tool_progress, system/status, ...) carry no metric.
  }

  if (processResult) perProcess.push(processResult);
  // Per session, its last result is the bill (a resumed process reports the whole session).
  const bySession = new Map<string, Result>();
  for (const [i, r] of perProcess.entries()) bySession.set(r.session_id ?? `process-${i}`, r);
  const bills = perProcess.length > 1 ? [...bySession.values()] : result ? [result] : [];
  const sumOf = (pick: (r: Result) => number | undefined): number | null =>
    perProcess.length > 1
      ? perProcess.reduce<number | null>((acc, r) => {
          const v = pick(r);
          return v === undefined ? acc : (acc ?? 0) + v;
        }, null)
      : result
        ? (pick(result) ?? null)
        : null;

  if (result) {
    s.has_result = true;
    s.result_subtype = result.subtype;
    s.is_error = result.is_error;
    s.duration_ms = sumOf((r) => r.duration_ms);
    s.duration_api_ms = sumOf((r) => r.duration_api_ms);
    s.cost_micro_usd = bills.some((r) => r.total_cost_usd !== undefined)
      ? (bills.reduce((acc, r) => acc + (r.total_cost_usd ?? 0n), 0n) as MicroUsd)
      : null;
    s.permission_denials = bills.reduce((acc, r) => acc + r.permission_denials.length, 0);
  }

  const withModels = bills.filter((r) => r.modelUsage && Object.keys(r.modelUsage).length > 0);
  if (withModels.length > 0) {
    s.token_source = "modelUsage";
    for (const r of withModels) {
      for (const [model, mu] of Object.entries(r.modelUsage!)) {
        const t: TokenCounts = {
          input: mu.inputTokens,
          output: mu.outputTokens,
          cache_read: mu.cacheReadInputTokens,
          cache_creation: mu.cacheCreationInputTokens,
        };
        const prev = s.tokens_by_model[model];
        const cost =
          prev === undefined
            ? (mu.costUSD ?? null)
            : prev.cost_micro_usd === null && mu.costUSD === undefined
              ? null
              : (((prev.cost_micro_usd ?? 0n) + (mu.costUSD ?? 0n)) as MicroUsd);
        s.tokens_by_model[model] = {
          input: (prev?.input ?? 0) + t.input,
          output: (prev?.output ?? 0) + t.output,
          cache_read: (prev?.cache_read ?? 0) + t.cache_read,
          cache_creation: (prev?.cache_creation ?? 0) + t.cache_creation,
          cost_micro_usd: cost,
        };
        s.tokens.input += t.input;
        s.tokens.output += t.output;
        s.tokens.cache_read += t.cache_read;
        s.tokens.cache_creation += t.cache_creation;
      }
    }
  } else if (result?.usage) {
    s.token_source = "result.usage";
    addUsage(s.tokens, result.usage);
  } else if (assistantUsage.size > 0) {
    s.token_source = "assistant.usage";
    for (const u of assistantUsage.values()) addUsage(s.tokens, u);
  }

  s.turns = sumOf((r) => r.num_turns) ?? topLevelIds.size;
  return s;
}

/** stream-json transcript -> Metric rows (trial-level; per-model and per-tool rows are labelled). */
export function collectStreamJson(text: string): Metric[] {
  const s = parseStreamJson(text);
  const t = (
    name: string,
    value: number | bigint,
    unit: Metric["unit"],
    labels?: Record<string, string>,
  ) =>
    metric({
      name,
      value,
      unit,
      level: "trial",
      collector: "stream-json",
      ...(labels ? { labels } : {}),
    });
  const total = s.tokens.input + s.tokens.output + s.tokens.cache_read + s.tokens.cache_creation;
  const rows: Metric[] = [
    t("input_tokens", s.tokens.input, "tokens"),
    t("output_tokens", s.tokens.output, "tokens"),
    t("cache_read_input_tokens", s.tokens.cache_read, "tokens"),
    t("cache_creation_input_tokens", s.tokens.cache_creation, "tokens"),
    t("total_tokens", total, "tokens"),
    t("turns", s.turns, "count"),
    t("tool_calls", s.tool_calls, "count"),
    t("tool_errors", s.tool_errors, "count"),
    t("http_429", s.http_429, "count"),
    t("api_retries", s.api_retries, "count"),
    t("rate_limit_rejections", s.rate_limit_rejections, "count"),
    t("permission_denials", s.permission_denials, "count"),
    t("agent_error", s.is_error || !s.has_result ? 1 : 0, "count"),
    t("result_missing", s.has_result ? 0 : 1, "count"),
  ];
  if (s.cost_micro_usd !== null) rows.push(t("cost_micro_usd", s.cost_micro_usd, "micro_usd"));
  // Only under a headless policy (its start event), so 0 means "ran under it, never fired".
  if (s.headless_policy !== null || s.questions_auto_answered > 0) {
    rows.push(t("questions_auto_answered", s.questions_auto_answered, "count"));
    rows.push(t("auto_answer_cap_reached", s.auto_answer_cap_reached ? 1 : 0, "count"));
  }
  if (s.duration_ms !== null) rows.push(t("agent_duration_ms", s.duration_ms, "ms"));
  if (s.duration_api_ms !== null) rows.push(t("agent_api_duration_ms", s.duration_api_ms, "ms"));
  for (const [name, n] of Object.entries(s.tool_calls_by_name)) {
    rows.push(t("tool_calls_by_name", n, "count", { tool: name }));
  }
  for (const [model, m] of Object.entries(s.tokens_by_model)) {
    rows.push(t("model_input_tokens", m.input, "tokens", { model }));
    rows.push(t("model_output_tokens", m.output, "tokens", { model }));
    if (m.cost_micro_usd !== null)
      rows.push(t("model_cost_micro_usd", m.cost_micro_usd, "micro_usd", { model }));
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// TDM-250: a trial's model-token bill from Claude Code's own session totals.
//
// Every `result` line carries `total_cost_usd`, the session's RUNNING total (a session with
// background subagents writes one result per lead turn, Tandem workers 2 to 4, a resumed process
// the whole session's). So a session's bill is its latest (largest) total, and a trial's is the sum
// over its sessions (Tandem: the planner and each worker, one transcript each). Summing the result
// lines instead is what made run 01a1c202 record $184.80 against a real $87.71
// (docs/findings/harness-league-run-1.md). A session with no total yet is "open": its spend is not
// in the transcript (the runner's live meter estimates it).

/** One Claude Code session in a transcript. */
export interface SessionBill {
  /** `session_id`, or `<transcript>#<n>` for a process that never said its id. */
  session: string;
  /** The session's latest (largest) `total_cost_usd`, micro-USD; null while it has none. */
  cost_micro_usd: MicroUsd | null;
  /** `result` lines of the session. */
  results: number;
}

const TotalCostSchema = z.looseObject({ total_cost_usd: UsdText.optional() });

/** The sessions of one stream-json transcript and each one's latest total. */
export function sessionBills(text: string, transcript = "transcript"): SessionBill[] {
  const bills = new Map<string, SessionBill>();
  let current: string | null = null;
  let processes = 0;
  const open = (key: string): SessionBill => {
    let b = bills.get(key);
    if (!b) {
      b = { session: key, cost_micro_usd: null, results: 0 };
      bills.set(key, b);
    }
    return b;
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = parseJsonKeepingNumberText(line, MONEY_KEYS);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { type?: unknown; subtype?: unknown; session_id?: unknown };
    const sid = typeof e.session_id === "string" && e.session_id !== "" ? e.session_id : null;
    if (e.type === "system" && e.subtype === "init") {
      processes++;
      current = sid ?? `${transcript}#${processes}`;
      open(current);
    } else if (e.type === "assistant") {
      open(sid ?? current ?? `${transcript}#${processes}`);
    } else if (e.type === "result") {
      const b = open(sid ?? current ?? `${transcript}#${processes}`);
      b.results++;
      const r = TotalCostSchema.safeParse(raw);
      const total = r.success ? r.data.total_cost_usd : undefined;
      if (total !== undefined && (b.cost_micro_usd === null || total > b.cost_micro_usd)) {
        b.cost_micro_usd = total as MicroUsd;
      }
    }
  }
  return [...bills.values()];
}

/** A trial's spend by Claude Code's own totals, over all its transcripts. */
export interface ClaudeCodeSpend {
  /** Σ over sessions of each one's latest total (the open sessions add nothing). */
  total_micro_usd: MicroUsd;
  sessions: number;
  /** Sessions with no total yet (stopped mid-turn): their spend is not in the transcript. */
  open_sessions: number;
  results: number;
  per_session: (SessionBill & { transcript: string })[];
}

/**
 * Claude Code's bill for a set of transcripts (solo: `stream.jsonl`; Tandem: one per session).
 * A session seen in two transcripts counts once, at its larger total.
 */
export function claudeCodeSpend(
  transcripts: readonly { name: string; text: string }[],
): ClaudeCodeSpend {
  const seen = new Map<string, SessionBill & { transcript: string }>();
  for (const t of transcripts) {
    for (const b of sessionBills(t.text, t.name)) {
      const prev = seen.get(b.session);
      if (!prev) {
        seen.set(b.session, { ...b, transcript: t.name });
        continue;
      }
      prev.results += b.results;
      if (
        b.cost_micro_usd !== null &&
        (prev.cost_micro_usd === null || b.cost_micro_usd > prev.cost_micro_usd)
      ) {
        prev.cost_micro_usd = b.cost_micro_usd;
      }
    }
  }
  const per = [...seen.values()];
  return {
    total_micro_usd: per.reduce((acc, b) => acc + (b.cost_micro_usd ?? 0n), 0n) as MicroUsd,
    sessions: per.length,
    open_sessions: per.filter((b) => b.cost_micro_usd === null).length,
    results: per.reduce((acc, b) => acc + b.results, 0),
    per_session: per,
  };
}
