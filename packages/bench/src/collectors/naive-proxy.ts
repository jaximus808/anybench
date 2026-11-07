// Naïve `client.proxy.calls()` traces (GET /v1/proxy/calls) -> Metric rows: calls, tokens,
// billed cost, latency, errors. Shape: docs/reference/naive-sdk-proxy.md and the SDK's
// ProxyCallTrace type. The fixture is synthetic: reading traces needs a live `audit:read` key.
// Kit collector name: `proxy-calls`.
import { z } from "zod";
import { addMicro, type MicroUsd } from "@anybench/core";
import { metric, NumberTextSchema, parseJsonKeepingNumberText, type Metric } from "../metric.js";

const MONEY_KEYS: ReadonlySet<string> = new Set(["billed_micro_usd", "vendor_cost_micro_usd"]);
const Count = z.int().nonnegative();

/** micro-USD as the API sends it: a JSON integer. Kept exact via its source text when we can. */
const MicroUsdField = z
  .union([
    NumberTextSchema.transform((n, ctx) => {
      if (!/^-?\d+$/.test(n.$number)) {
        ctx.addIssue({ code: "custom", message: `micro-USD must be an integer, got ${n.$number}` });
        return z.NEVER;
      }
      return BigInt(n.$number);
    }),
    z
      .int()
      .refine(Number.isSafeInteger)
      .transform((n) => BigInt(n)),
    z.bigint(),
  ])
  .nullable();

export const ProxyCallTraceSchema = z.looseObject({
  id: z.string(),
  object: z.literal("proxy_call_trace").optional(),
  model: z.string(),
  resolved_model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  stop: z.string().nullable().optional(),
  usage: z.looseObject({
    input: Count,
    cache_write: Count.default(0),
    cache_read: Count.default(0),
    output: Count,
    reasoning: Count.default(0),
  }),
  billed_micro_usd: MicroUsdField,
  vendor_cost_micro_usd: MicroUsdField.optional(),
  duration_ms: Count.nullable().optional(),
  source: z.string().optional(),
  session_id: z.string().nullable().optional(),
  tool_call_ids: z.array(z.string()).default([]),
  response: z
    .looseObject({
      tool_calls: z.array(z.unknown()).default([]),
      is_error: z.literal(true).optional(),
      error_class: z.string().optional(),
      partial: z.literal(true).optional(),
    })
    .nullable()
    .optional(),
  truncated: z.boolean().default(false),
  created_at: z.string(),
});
export type ProxyCallTrace = z.infer<typeof ProxyCallTraceSchema>;

/** `proxy.calls()` returns a Page; accept the page, its `data` array, or JSONL of traces. */
const PageSchema = z.looseObject({ data: z.array(z.unknown()) });

export interface NaiveProxyOptions {
  /** Keep only traces from this Naïve session (a trial's agent session). */
  sessionId?: string;
  /** Keep only traces with `created_at` in [since, until). ISO timestamps. */
  since?: string;
  until?: string;
}

function toRawList(input: string | unknown): unknown[] {
  if (typeof input !== "string") {
    const page = PageSchema.safeParse(input);
    if (page.success) return page.data.data;
    return z.array(z.unknown()).parse(input);
  }
  let whole: unknown;
  try {
    whole = parseJsonKeepingNumberText(input, MONEY_KEYS);
  } catch {
    whole = undefined; // not one JSON document: read it as JSONL
  }
  if (whole !== undefined) {
    if (Array.isArray(whole) || PageSchema.safeParse(whole).success) return toRawList(whole);
    return [whole];
  }
  return input
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => parseJsonKeepingNumberText(l, MONEY_KEYS));
}

/** Parse traces from a `proxy.calls()` page, a JSON array, or JSONL; filter to the trial. */
export function parseProxyCalls(
  input: string | unknown,
  opts: NaiveProxyOptions = {},
): ProxyCallTrace[] {
  const sinceMs = opts.since === undefined ? null : Date.parse(opts.since);
  const untilMs = opts.until === undefined ? null : Date.parse(opts.until);
  return z
    .array(ProxyCallTraceSchema)
    .parse(toRawList(input))
    .filter((c) => opts.sessionId === undefined || c.session_id === opts.sessionId)
    .filter((c) => {
      const at = Date.parse(c.created_at);
      return (sinceMs === null || at >= sinceMs) && (untilMs === null || at < untilMs);
    })
    .sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id),
    );
}

/** Proxy call traces -> Metric rows. Trial totals, per-model splits, and one latency sample per call. */
export function collectNaiveProxy(input: string | unknown, opts: NaiveProxyOptions = {}): Metric[] {
  const calls = parseProxyCalls(input, opts);
  const trial = (
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
      collector: "proxy-calls",
      ...(labels ? { labels } : {}),
    });

  let input_t = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    reasoning = 0,
    errors = 0,
    toolCalls = 0,
    truncated = 0,
    unbilled = 0;
  const billed: MicroUsd[] = [];
  const vendor: MicroUsd[] = [];
  const byModel = new Map<string, { calls: number; billed: MicroUsd[] }>();
  const byErrorClass = new Map<string, number>();

  for (const c of calls) {
    input_t += c.usage.input;
    output += c.usage.output;
    cacheRead += c.usage.cache_read;
    cacheWrite += c.usage.cache_write;
    reasoning += c.usage.reasoning;
    toolCalls += Math.max(c.tool_call_ids.length, c.response?.tool_calls.length ?? 0);
    if (c.truncated) truncated++;
    if (c.response?.is_error) {
      errors++;
      const cls = c.response.error_class ?? "unknown";
      byErrorClass.set(cls, (byErrorClass.get(cls) ?? 0) + 1);
    }
    if (c.billed_micro_usd === null) unbilled++;
    else billed.push(c.billed_micro_usd);
    if (c.vendor_cost_micro_usd != null) vendor.push(c.vendor_cost_micro_usd);
    const model = c.resolved_model ?? c.model;
    const m = byModel.get(model) ?? { calls: 0, billed: [] };
    m.calls++;
    if (c.billed_micro_usd !== null) m.billed.push(c.billed_micro_usd);
    byModel.set(model, m);
  }

  const rows: Metric[] = [
    trial("proxy_calls", calls.length, "count"),
    trial("proxy_input_tokens", input_t, "tokens"),
    trial("proxy_output_tokens", output, "tokens"),
    trial("proxy_cache_read_tokens", cacheRead, "tokens"),
    trial("proxy_cache_write_tokens", cacheWrite, "tokens"),
    trial("proxy_reasoning_tokens", reasoning, "tokens"),
    trial("proxy_tool_calls", toolCalls, "count"),
    trial("proxy_errors", errors, "count"),
    trial("proxy_truncated", truncated, "count"),
    trial("proxy_unbilled_calls", unbilled, "count"),
    trial("proxy_billed_micro_usd", addMicro(...billed), "micro_usd"),
  ];
  if (vendor.length > 0)
    rows.push(trial("proxy_vendor_cost_micro_usd", addMicro(...vendor), "micro_usd"));
  for (const [model, m] of byModel) {
    rows.push(trial("proxy_calls_by_model", m.calls, "count", { model }));
    rows.push(
      trial("proxy_billed_micro_usd_by_model", addMicro(...m.billed), "micro_usd", { model }),
    );
  }
  for (const [cls, n] of byErrorClass)
    rows.push(trial("proxy_errors_by_class", n, "count", { error_class: cls }));
  calls.forEach((c, i) => {
    if (c.duration_ms == null) return;
    rows.push(
      metric({
        name: "proxy_call_ms",
        value: c.duration_ms,
        unit: "ms",
        level: "sample",
        sample: i,
        collector: "proxy-calls",
        labels: { model: c.resolved_model ?? c.model, request_id: c.id },
      }),
    );
  });
  return rows;
}
