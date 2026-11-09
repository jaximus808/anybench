// The benchmark chart kit's model (TDM-203): pure functions from a Report (core ReportSchema) to
// what each chart draws. No React. Honest by construction:
// - every setup and every task is shown; a setup whose gate never passed has no value and is
//   hatched, never ranked;
// - every difference is drawn with its CI, and its verdict comes from the report (Holm-corrected);
// - nothing here combines requirements into a composite score.
import type { ContenderResult, Report, RequirementComparison } from "@anybench/core";
import { formatUsd } from "@anybench/core";
import { formatMde } from "../report/model";

type RequirementResult = ContenderResult["requirements"][number];

export type Verdict = RequirementComparison["verdict"];

export const VERDICT_WORD: Record<Verdict, string> = {
  better: "better",
  worse: "worse",
  indistinguishable: "no detectable difference",
};

/** "s", "ratio" (a rate), "micro-USD" (money), tokens… → a short suffix and a formatter. */
export function formatMetric(v: number, unit: string | null, signed = false): string {
  const sign = signed && v > 0 ? "+" : signed && v < 0 ? "−" : "";
  const a = signed ? Math.abs(v) : v;
  if (unit === "ratio" || unit === "rate")
    return `${sign}${round(a * 100)}${unit === "rate" && signed ? " pp" : "%"}`;
  if (unit === "micro-USD")
    return `${sign}${formatUsd(BigInt(Math.round(Math.abs(a))), { decimals: Math.abs(a) < 100_000 ? 4 : 2 })}`;
  if (unit === "s") return `${sign}${a >= 600 ? `${round(a / 60)} min` : `${round(a)} s`}`;
  return `${sign}${round(a)}${unit ? ` ${unit}` : ""}`;
}

function round(n: number): string {
  const a = Math.abs(n);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return n
    .toFixed(d)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
}

/**
 * Which way is better for a requirement. The comparison's effect is oriented (positive = better)
 * while its Hodges–Lehmann shift is raw (candidate − baseline), so opposite signs mean lower is
 * better. Rates are higher-is-better; time, money and tokens default to lower-is-better.
 */
export function lowerIsBetter(r: RequirementResult): boolean {
  const c = r.comparison;
  if (c?.effect.hodges_lehmann != null && c.effect.value !== 0 && c.effect.hodges_lehmann !== 0)
    return Math.sign(c.effect.hodges_lehmann) !== Math.sign(c.effect.value);
  if (r.unit === "ratio" || r.unit === "rate" || c?.diff_ci.unit === "rate") return false;
  return true;
}

// ---- per requirement: the values and the differences ------------------------------------------

export interface ValueBar {
  contenderId: string;
  name: string;
  role: string;
  /** null: no gated value (its gate never passed). Hatched, never ranked. */
  value: number | null;
  label: string;
  n: number | null;
  survivorship: boolean;
  /** 0..1 of the axis. */
  frac: number;
  /**
   * This setup's own 95% interval, in the requirement's unit: a Wilson interval for a pass rate
   * (from the rate and n), or the report's ci95 for a metric. Null when there is none.
   */
  ci: [number, number] | null;
  /** The interval's point: the value, or for a pass rate with no gated value its gate pass rate. */
  estimate: number | null;
  /** "7/7" for a pass rate. */
  count: string | null;
}

/** Wilson score 95% interval for x/n (the formula of @anybench/bench stats.wilsonCi). */
export function wilson95(x: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const z = 1.959963984540054;
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [x === 0 ? 0 : Math.max(0, center - half), x === n ? 1 : Math.min(1, center + half)];
}

const isRate = (unit: string | null) => unit === "ratio" || unit === "rate";

export interface DiffItem {
  /** Unique per row (a setup, or a setup on one task). */
  key: string;
  contenderId: string;
  name: string;
  baselineName: string;
  verdict: Verdict;
  /** CI of the difference (candidate − baseline), in the requirement's unit (or rate / delta). */
  lo: number;
  hi: number;
  /** The point estimate when the report has one (Hodges–Lehmann or the CI midpoint). */
  point: number;
  level: number;
  attained: boolean;
  ciUnit: RequirementComparison["diff_ci"]["unit"];
  statement: string;
  claim: RequirementComparison["claim"];
  tasks: number;
  downgraded: RequirementComparison["downgraded"];
  /** The smallest detectable difference, or why there is none. */
  mde: string;
}

export interface RequirementView {
  id: string;
  title: string;
  type: RequirementResult["type"];
  unit: string | null;
  lowerIsBetter: boolean;
  bars: ValueBar[];
  /** "wilson" for pass rates, "report" when every gated setup has the report's ci95, else null. */
  intervals: "wilson" | "report" | null;
  /** The per-setup axis, [0, max]. */
  axis: [number, number];
  diffs: DiffItem[];
  /** Symmetric-ish domain for the difference chart, always containing 0. */
  diffDomain: [number, number];
}

export function requirementViews(report: Report): RequirementView[] {
  const ids: string[] = [];
  for (const c of report.contenders)
    for (const r of c.requirements) if (!ids.includes(r.requirement_id)) ids.push(r.requirement_id);
  const nameOf = (id: string) =>
    report.contenders.find((c) => (c.contender_id as string) === id)?.name ??
    report.contenders.find((c) => c.role === "baseline")?.name ??
    "baseline";
  return ids.map((id) => {
    const rows = report.contenders
      .map((c) => ({ c, r: c.requirements.find((x) => x.requirement_id === id) }))
      .filter((x): x is { c: (typeof report.contenders)[number]; r: RequirementResult } => !!x.r);
    const first = rows[0]!.r;
    const lib = lowerIsBetter(rows.find((x) => x.r.comparison)?.r ?? first);
    // A pass rate (solved/n, Wilson). A mean hidden-test fraction (TDM-210 `all_trials`) is a
    // ratio too, but not a count of successes: no Wilson interval and no "k/n" for it.
    const rate = isRate(first.unit) && first.aggregate !== "all_trials";
    const cis = rows.map(({ r }): [number, number] | null => {
      if (rate && r.n) {
        const v = r.value ?? r.gate_pass_rate;
        return v === null ? null : wilson95(Math.round(v * r.n), r.n);
      }
      return r.value !== null && r.ci95 ? [r.ci95[0], r.ci95[1]] : null;
    });
    const gated = rows.filter(({ r }) => r.value !== null);
    const intervals: RequirementView["intervals"] = rate
      ? cis.some(Boolean)
        ? "wilson"
        : null
      : gated.length && rows.every(({ r }, i) => r.value === null || cis[i])
        ? "report"
        : null;
    const max = Math.max(
      0,
      ...rows.map((x) => x.r.value ?? 0),
      ...(intervals ? cis.map((c) => c?.[1] ?? 0) : []),
    );
    const axisMax = rate ? 1 : max > 0 ? max * 1.08 : 1;
    const bars: ValueBar[] = rows.map(({ c, r }, i) => ({
      contenderId: c.contender_id,
      name: c.name,
      role: c.role,
      value: r.value,
      label: r.value === null ? "no gated value" : formatMetric(r.value, r.unit),
      n: r.n ?? null,
      survivorship: r.survivorship === true,
      frac: r.value === null ? 0 : Math.max(0, Math.min(1, r.value / axisMax)),
      ci: intervals ? cis[i]! : null,
      estimate: rate ? (r.value ?? r.gate_pass_rate) : r.value,
      count:
        rate && r.n && (r.value ?? r.gate_pass_rate) !== null
          ? `${Math.round((r.value ?? r.gate_pass_rate)! * r.n)}/${r.n}`
          : null,
    }));
    const diffs: DiffItem[] = rows
      .filter(({ r }) => r.comparison)
      .map(({ c, r }) => diffItem(c, r.comparison!, r.unit, nameOf, c.contender_id));
    const ext = Math.max(1e-9, ...diffs.flatMap((d) => [Math.abs(d.lo), Math.abs(d.hi)]));
    return {
      id,
      title: first.title || id,
      type: first.type,
      unit: first.unit,
      lowerIsBetter: lib,
      bars,
      intervals,
      axis: [0, axisMax],
      diffs,
      diffDomain: [-ext * 1.15, ext * 1.15],
    };
  });
}

function diffItem(
  c: Report["contenders"][number],
  k: RequirementComparison,
  unit: string | null,
  nameOf: (id: string) => string,
  key: string,
): DiffItem {
  const lo = Math.min(k.diff_ci.lo, k.diff_ci.hi);
  const hi = Math.max(k.diff_ci.lo, k.diff_ci.hi);
  // Rates: the observed difference (oriented = raw, since higher is better); metrics: the
  // Hodges–Lehmann shift; otherwise the CI midpoint.
  const point =
    k.diff_ci.unit === "rate" &&
    (k.effect.measure === "rate_diff" || k.effect.measure === "mean_diff")
      ? k.effect.value
      : k.diff_ci.unit === "metric" && k.effect.hodges_lehmann !== null
        ? k.effect.hodges_lehmann
        : (lo + hi) / 2;
  return {
    key,
    contenderId: c.contender_id,
    name: c.name,
    baselineName: nameOf(k.baseline_id),
    verdict: k.verdict,
    lo,
    hi,
    point,
    level: k.diff_ci.level,
    attained: k.diff_ci.attained,
    ciUnit: k.diff_ci.unit,
    statement: k.statement,
    claim: k.claim,
    tasks: k.n.tasks,
    downgraded: k.downgraded,
    mde: formatMde(k, unit),
  };
}

/**
 * E18 per task: one view per requirement that has per-task results, each row one task (and the
 * setup, when more than one is compared), all on one shared difference axis. Each row speaks for
 * its task only; the report's scope line goes next to it.
 */
export function taskViews(report: Report): RequirementView[] {
  if (!report.per_task) return [];
  const order = report.per_task.tasks;
  const compared = report.contenders.filter((c) =>
    c.requirements.some((r) => r.by_task?.length),
  ).length;
  const nameOf = (id: string) =>
    report.contenders.find((c) => (c.contender_id as string) === id)?.name ?? "baseline";
  return requirementViews(report).flatMap((view) => {
    const diffs: DiffItem[] = [];
    for (const t of order)
      for (const c of report.contenders) {
        const r = c.requirements.find((x) => x.requirement_id === view.id);
        const bt = r?.by_task?.find((x) => x.workload_id === t);
        if (!r || !bt) continue;
        const d = diffItem(c, bt.comparison, r.unit, nameOf, `${c.contender_id}:${t}`);
        diffs.push({ ...d, name: compared > 1 ? `${t} · ${c.name}` : t });
      }
    if (!diffs.length) return [];
    const ext = Math.max(1e-9, ...diffs.flatMap((d) => [Math.abs(d.lo), Math.abs(d.hi)]));
    return [
      { ...view, bars: [], diffs, diffDomain: [-ext * 1.15, ext * 1.15] as [number, number] },
    ];
  });
}

/** Format a value on a difference axis (rates are percentage points). */
export function formatDiff(v: number, d: Pick<DiffItem, "ciUnit">, unit: string | null): string {
  if (d.ciUnit === "rate") return formatMetric(v, "rate", true);
  if (d.ciUnit === "cliffs_delta")
    return `${v > 0 ? "+" : v < 0 ? "−" : ""}${round(Math.abs(v))} δ`;
  return formatMetric(v, unit, true);
}
