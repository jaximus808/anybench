// `k6 run --summary-export=summary.json` (legacy summary format, still written by k6 1.x) ->
// Metric rows. Trend values are in ms. Fixture: fixtures/collectors/k6/ (grafana/k6:1.3.0).
//
// Rate metrics read backwards: for `http_req_failed`, `passes` counts requests that FAILED
// (the rate's value was true), `fails` counts the ones that did not. For `checks`, `passes`
// is checks that passed. Threshold booleans are true when the threshold was crossed.
import { z } from "zod";
import { metric, type Metric } from "../metric.js";
import { loadMetrics } from "./hey.js";

const Finite = z.number().refine(Number.isFinite, { error: "must be a finite number" });

const TrendSchema = z.looseObject({
  avg: Finite,
  min: Finite,
  med: Finite,
  max: Finite,
  thresholds: z.record(z.string(), z.boolean()).optional(),
});
const CounterSchema = z.looseObject({ count: Finite, rate: Finite });
const RateSchema = z.looseObject({
  passes: z.int().nonnegative(),
  fails: z.int().nonnegative(),
  value: Finite,
});

export const K6SummarySchema = z.looseObject({
  metrics: z.looseObject({
    http_req_duration: TrendSchema,
    http_reqs: CounterSchema,
    http_req_failed: RateSchema.optional(),
    checks: RateSchema.optional(),
    iterations: CounterSchema.optional(),
    data_received: CounterSchema.optional(),
    data_sent: CounterSchema.optional(),
    vus_max: z.looseObject({ value: Finite }).optional(),
  }),
});
export type K6Summary = z.infer<typeof K6SummarySchema>;

export function parseK6Summary(json: string | unknown): K6Summary {
  return K6SummarySchema.parse(typeof json === "string" ? JSON.parse(json) : json);
}

/** "p(95)" -> 95, "p(99.9)" -> 99.9, anything else -> null. */
function percentileKey(key: string): number | null {
  const m = /^p\((\d+(?:\.\d+)?)\)$/.exec(key);
  return m ? Number(m[1]) : null;
}

const roundUs = (ms: number): number => Math.round(ms * 1e3) / 1e3;

/** k6 summary export -> Metric rows (load metrics shared with hey, plus checks and thresholds). */
export function collectK6(json: string | unknown): Metric[] {
  const s = parseK6Summary(json);
  const d = s.metrics.http_req_duration;
  const percentiles = new Map<number, number>();
  percentiles.set(50, roundUs(d.med));
  for (const [k, v] of Object.entries(d)) {
    const p = percentileKey(k);
    if (p !== null && typeof v === "number") percentiles.set(p, roundUs(v));
  }
  const failed = s.metrics.http_req_failed?.passes ?? 0;
  const requests = s.metrics.http_reqs.count;
  const rows = loadMetrics("k6", {
    rps: s.metrics.http_reqs.rate,
    requests,
    failed,
    mean_ms: roundUs(d.avg),
    min_ms: roundUs(d.min),
    max_ms: roundUs(d.max),
    percentiles_ms: percentiles,
  });
  const t = (
    name: string,
    value: number,
    unit: Metric["unit"],
    labels?: Record<string, string>,
  ): Metric =>
    metric({ name, value, unit, level: "trial", collector: "k6", ...(labels ? { labels } : {}) });
  const { checks, iterations, data_received, data_sent, vus_max } = s.metrics;
  if (checks) {
    rows.push(
      t("checks_passed", checks.passes, "count"),
      t("checks_failed", checks.fails, "count"),
    );
    rows.push(t("checks_pass_rate", checks.value, "ratio"));
  }
  if (iterations) rows.push(t("iterations", iterations.count, "count"));
  if (data_received) rows.push(t("http_data_bytes", data_received.count, "bytes"));
  if (data_sent) rows.push(t("http_data_sent_bytes", data_sent.count, "bytes"));
  if (vus_max) rows.push(t("vus_max", vus_max.value, "count"));
  // Thresholds on any metric: 1 when crossed (failed), 0 when held.
  for (const [metricName, m] of Object.entries(s.metrics)) {
    const th = (m as { thresholds?: unknown } | null)?.thresholds;
    if (th === undefined) continue;
    for (const [expr, crossed] of Object.entries(z.record(z.string(), z.boolean()).parse(th))) {
      rows.push(
        t("k6_threshold_failed", crossed ? 1 : 0, "count", { metric: metricName, threshold: expr }),
      );
    }
  }
  return rows;
}
