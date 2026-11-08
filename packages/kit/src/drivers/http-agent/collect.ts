// Collectors for driver.type `http-agent` (TDM-40 [4.8]): transcripts -> metric rows.
//
//   latency  `turn_latency_ms` per turn (samples), `latency_p50_ms` / `latency_p95_ms` /
//            `latency_max_ms` / `latency_mean_ms` over every answered turn (trial), and per
//            conversation (labeled drill-down rows).
//   cost     `cost_micro_usd` summed from what the agent reported per turn (response usage or the
//            cost header), bigint micro-USD; `cost_unreported_turns` says how many turns gave
//            none. Token totals when reported. `simulated_user_micro_usd` is our Naïve spend.
//   outcome  turn / conversation counts, errors, and `conversation_outcome` / `conversation_ended_by`
//            counts labeled by value.
//
// Rows use the exact shape of `@anybench/bench` MetricSchema (TDM-50) so bench's
// `parseMetricsJsonl` reads `http-agent.metrics.jsonl` as is. The schema is mirrored here, not
// imported: `@anybench/bench` depends on `@anybench/kit`, so the reverse import would be a cycle.
// Collector names follow DRIVER_DEFAULT_COLLECTORS["http-agent"]: timings and counts under
// `time`, money and tokens under `proxy-calls`. None of these numbers is scored unless its gate passed.
import { addMicro, CollectorNameSchema, KitSlugSchema, MicroUsdSchema } from "@anybench/core";
import { z } from "zod";
import type { Transcript } from "./transcript.js";

const FiniteNumber = z.number().refine(Number.isFinite, { error: "must be a finite number" });

/** Mirror of `@anybench/bench` MetricSchema (TDM-50), restricted to the units this driver writes. */
export const HttpAgentMetricRowSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/),
    value: z.union([FiniteNumber, MicroUsdSchema]),
    unit: z.enum(["ms", "count", "tokens", "micro_usd"]),
    level: z.enum(["trial", "sample"]),
    sample: z.int().nonnegative().optional(),
    collector: CollectorNameSchema,
    gate_id: KitSlugSchema.optional(),
    labels: z.record(z.string().min(1), z.string()).optional(),
  })
  .superRefine((m, ctx) => {
    if ((m.unit === "micro_usd") !== (typeof m.value === "bigint"))
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "micro_usd rows hold bigint micro-USD; every other unit holds a number",
      });
    if ((m.level === "sample") !== (m.sample !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["sample"],
        message: "sample rows need a sample index; trial rows have none",
      });
  });
export type HttpAgentMetricRow = z.infer<typeof HttpAgentMetricRowSchema>;

/** Nearest-rank percentile (p in (0, 100]) of a non-empty list. */
export function nearestRankPercentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError("percentile of an empty list");
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function collectHttpAgent(transcripts: readonly Transcript[]): HttpAgentMetricRow[] {
  const rows: HttpAgentMetricRow[] = [];
  const row = (r: z.input<typeof HttpAgentMetricRowSchema>) =>
    rows.push(HttpAgentMetricRowSchema.parse(r));
  const trial = (
    name: string,
    value: number | bigint,
    unit: HttpAgentMetricRow["unit"],
    labels?: Record<string, string>,
  ) =>
    row({
      name,
      value,
      unit,
      level: "trial",
      collector: unit === "micro_usd" || unit === "tokens" ? "proxy-calls" : "time",
      ...(labels ? { labels } : {}),
    });
  const latencyRows = (lat: number[], labels?: Record<string, string>) => {
    if (lat.length === 0) return; // no answered turn: no latency number at all
    trial("latency_p50_ms", round3(nearestRankPercentile(lat, 50)), "ms", labels);
    trial("latency_p95_ms", round3(nearestRankPercentile(lat, 95)), "ms", labels);
    trial("latency_max_ms", round3(Math.max(...lat)), "ms", labels);
    trial("latency_mean_ms", round3(lat.reduce((a, b) => a + b, 0) / lat.length), "ms", labels);
  };

  const all: number[] = [];
  let sample = 0,
    turns = 0,
    errors = 0,
    unreported = 0,
    inTok = 0,
    outTok = 0,
    tokTurns = 0,
    toolCalls = 0;
  const costs: bigint[] = [];
  const simCosts: bigint[] = [];
  const outcomes = new Map<string, number>();
  const endedBy = new Map<string, number>();

  for (const t of transcripts) {
    if (t.simulated_user_micro_usd !== undefined) simCosts.push(t.simulated_user_micro_usd);
    const lat: number[] = [];
    for (const turn of t.turns) {
      turns++;
      if (turn.status !== "ok") {
        errors++;
        continue;
      }
      lat.push(turn.latency_ms);
      row({
        name: "turn_latency_ms",
        value: turn.latency_ms,
        unit: "ms",
        level: "sample",
        sample: sample++,
        collector: "time",
        labels: { conversation: t.conversation_id, turn: String(turn.index) },
      });
      if (turn.cost_micro_usd !== undefined) costs.push(turn.cost_micro_usd);
      else unreported++;
      if (turn.input_tokens !== undefined || turn.output_tokens !== undefined) tokTurns++;
      inTok += turn.input_tokens ?? 0;
      outTok += turn.output_tokens ?? 0;
      toolCalls += turn.tool_calls.length;
    }
    all.push(...lat);
    latencyRows(lat, { conversation: t.conversation_id });
    const outcome = [...t.turns].reverse().find((x) => x.outcome !== undefined)?.outcome;
    const o = outcome ?? "none";
    outcomes.set(o, (outcomes.get(o) ?? 0) + 1);
    endedBy.set(t.ended_by, (endedBy.get(t.ended_by) ?? 0) + 1);
  }

  latencyRows(all);
  trial("conversations", transcripts.length, "count");
  trial(
    "conversations_completed",
    transcripts.filter((t) => t.status === "completed").length,
    "count",
  );
  trial("conversations_errored", transcripts.filter((t) => t.status === "error").length, "count");
  trial("turns", turns, "count");
  trial("turn_errors", errors, "count");
  trial("tool_calls", toolCalls, "count");
  // Cost only when the agent reported some: a missing number is not a zero.
  if (costs.length > 0) trial("cost_micro_usd", addMicro(...costs), "micro_usd");
  trial("cost_unreported_turns", unreported, "count");
  if (tokTurns > 0) {
    trial("input_tokens", inTok, "tokens");
    trial("output_tokens", outTok, "tokens");
  }
  if (simCosts.length > 0) trial("simulated_user_micro_usd", addMicro(...simCosts), "micro_usd");
  for (const [outcome, n] of [...outcomes].sort())
    trial("conversation_outcome", n, "count", { outcome });
  for (const [by, n] of [...endedBy].sort())
    trial("conversation_ended_by", n, "count", { ended_by: by });
  return rows;
}

/** One JSONL line per row; micro-USD as a decimal string (bench `encodeMetric` format). */
export function encodeHttpAgentMetricsJsonl(rows: readonly HttpAgentMetricRow[]): string {
  return rows
    .map(
      (r) =>
        JSON.stringify(HttpAgentMetricRowSchema.parse(r), (_k, v: unknown) =>
          typeof v === "bigint" ? v.toString() : v,
        ) + "\n",
    )
    .join("");
}
