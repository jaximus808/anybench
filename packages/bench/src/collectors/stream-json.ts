// Claude Code `claude -p --output-format stream-json --verbose` transcript -> Metric rows:
// tokens, turns, tool calls, cost and 429s. Event shapes are the ones Claude Code 2.1.x declares
// (docs/findings/collectors.md); the fixtures are synthetic because a real run costs money.
//
// Money: `total_cost_usd` and `modelUsage.*.costUSD` are read from their JSON source text and
// converted to micro-USD with bigint math. No float ever touches a cost.
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
  };
  // Claude Code streams one assistant event per content block, all sharing message.id and
  // repeating the same usage: count usage and turns once per id, tool_use blocks every time.
  const assistantUsage = new Map<string, z.infer<typeof ApiUsageSchema>>();
  const topLevelIds = new Set<string>();
  const seenToolUseIds = new Set<string>();
  let result: z.infer<typeof ResultEventSchema> | null = null;

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
      if (!e.success) s.unparsed_lines++;
      else {
        s.session_id = e.data.session_id ?? s.session_id;
        s.model = e.data.model ?? s.model;
        s.claude_code_version = e.data.claude_code_version ?? s.claude_code_version;
      }
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
      else result = e.data; // the last result wins (streaming-input sessions emit one per turn)
    }
    // Other event types (stream_event, tool_progress, system/status, ...) carry no metric.
  }

  if (result) {
    s.has_result = true;
    s.result_subtype = result.subtype;
    s.is_error = result.is_error;
    s.duration_ms = result.duration_ms ?? null;
    s.duration_api_ms = result.duration_api_ms ?? null;
    s.cost_micro_usd = result.total_cost_usd ?? null;
    s.permission_denials = result.permission_denials.length;
  }

  const models = result?.modelUsage;
  if (models && Object.keys(models).length > 0) {
    s.token_source = "modelUsage";
    for (const [model, mu] of Object.entries(models)) {
      const t: TokenCounts = {
        input: mu.inputTokens,
        output: mu.outputTokens,
        cache_read: mu.cacheReadInputTokens,
        cache_creation: mu.cacheCreationInputTokens,
      };
      s.tokens_by_model[model] = { ...t, cost_micro_usd: mu.costUSD ?? null };
      s.tokens.input += t.input;
      s.tokens.output += t.output;
      s.tokens.cache_read += t.cache_read;
      s.tokens.cache_creation += t.cache_creation;
    }
  } else if (result?.usage) {
    s.token_source = "result.usage";
    addUsage(s.tokens, result.usage);
  } else if (assistantUsage.size > 0) {
    s.token_source = "assistant.usage";
    for (const u of assistantUsage.values()) addUsage(s.tokens, u);
  }

  s.turns = result?.num_turns ?? topLevelIds.size;
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
