// `hyperfine --export-json` -> Metric rows. One trial-level summary per command plus one
// sample-level row per timed run. Fixture: fixtures/collectors/hyperfine/ (hyperfine 1.19.0).
import { z } from "zod";
import { metric, type Metric } from "../metric.js";

const Finite = z.number().refine(Number.isFinite, { error: "must be a finite number" });

export const HyperfineResultSchema = z.looseObject({
  command: z.string(),
  mean: Finite,
  stddev: Finite.nullable(),
  median: Finite,
  user: Finite,
  system: Finite,
  min: Finite,
  max: Finite,
  times: z.array(Finite),
  exit_codes: z.array(z.int().nullable()),
  /** Present with `-P` / `-L`: the parameter values for this command. */
  parameters: z.record(z.string(), z.string()).optional(),
});
export type HyperfineResult = z.infer<typeof HyperfineResultSchema>;

export const HyperfineExportSchema = z.looseObject({
  results: z.array(HyperfineResultSchema).min(1),
});
export type HyperfineExport = z.infer<typeof HyperfineExportSchema>;

export function parseHyperfine(json: string | unknown): HyperfineExport {
  return HyperfineExportSchema.parse(typeof json === "string" ? JSON.parse(json) : json);
}

/** hyperfine JSON -> Metric rows, labelled by `command` (and any `-P`/`-L` parameters). */
export function collectHyperfine(json: string | unknown): Metric[] {
  const out: Metric[] = [];
  for (const r of parseHyperfine(json).results) {
    const labels: Record<string, string> = { command: r.command };
    for (const [k, v] of Object.entries(r.parameters ?? {})) labels[`param.${k}`] = v;
    const t = (name: string, value: number, unit: Metric["unit"]): Metric =>
      metric({ name, value, unit, level: "trial", collector: "hyperfine", labels });
    out.push(
      t("hyperfine_mean_s", r.mean, "s"),
      t("hyperfine_median_s", r.median, "s"),
      t("hyperfine_min_s", r.min, "s"),
      t("hyperfine_max_s", r.max, "s"),
      t("hyperfine_user_s", r.user, "s"),
      t("hyperfine_system_s", r.system, "s"),
      t("hyperfine_runs", r.times.length, "count"),
      t("hyperfine_failed_runs", r.exit_codes.filter((c) => c !== 0).length, "count"),
    );
    if (r.stddev !== null) out.push(t("hyperfine_stddev_s", r.stddev, "s"));
    r.times.forEach((time, i) =>
      out.push(
        metric({
          name: "hyperfine_time_s",
          value: time,
          unit: "s",
          level: "sample",
          sample: i,
          collector: "hyperfine",
          labels: { ...labels, exit_code: String(r.exit_codes[i] ?? "null") },
        }),
      ),
    );
  }
  return out;
}
