// The benchmark chart kit's model (TDM-203): pure functions from a Report (core ReportSchema) to
// what each chart draws. No React. Honest by construction:
// - every setup and every task is shown; a setup whose gate never passed has no value and is
//   hatched, never ranked;
// - every difference is drawn with its CI, and its verdict comes from the report (Holm-corrected);
// - nothing here combines requirements into a composite score.
import type { ContenderResult, Report, RequirementComparison } from "@anybench/core";
import { formatUsd } from "@anybench/core";

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
}

export interface DiffItem {
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
}

export interface RequirementView {
  id: string;
  title: string;
  type: RequirementResult["type"];
  unit: string | null;
  lowerIsBetter: boolean;
  bars: ValueBar[];
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
    const max = Math.max(0, ...rows.map((x) => x.r.value ?? 0));
    const axisMax = first.unit === "ratio" ? 1 : max > 0 ? max * 1.08 : 1;
    const bars: ValueBar[] = rows.map(({ c, r }) => ({
      contenderId: c.contender_id,
      name: c.name,
      role: c.role,
      value: r.value,
      label: r.value === null ? "no gated value" : formatMetric(r.value, r.unit),
      n: r.n ?? null,
      survivorship: r.survivorship === true,
      frac: r.value === null ? 0 : Math.max(0, Math.min(1, r.value / axisMax)),
    }));
    const diffs: DiffItem[] = rows
      .filter(({ r }) => r.comparison)
      .map(({ c, r }) => {
        const k = r.comparison!;
        const lo = Math.min(k.diff_ci.lo, k.diff_ci.hi);
        const hi = Math.max(k.diff_ci.lo, k.diff_ci.hi);
        const point =
          k.diff_ci.unit === "metric" && k.effect.hodges_lehmann !== null
            ? k.effect.hodges_lehmann
            : (lo + hi) / 2;
        return {
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
        };
      });
    const ext = Math.max(1e-9, ...diffs.flatMap((d) => [Math.abs(d.lo), Math.abs(d.hi)]));
    return {
      id,
      title: first.title || id,
      type: first.type,
      unit: first.unit,
      lowerIsBetter: lib,
      bars,
      diffs,
      diffDomain: [-ext * 1.15, ext * 1.15],
    };
  });
}

/** Format a value on a difference axis (rates are percentage points). */
export function formatDiff(v: number, d: Pick<DiffItem, "ciUnit">, unit: string | null): string {
  if (d.ciUnit === "rate") return formatMetric(v, "rate", true);
  if (d.ciUnit === "cliffs_delta")
    return `${v > 0 ? "+" : v < 0 ? "−" : ""}${round(Math.abs(v))} δ`;
  return formatMetric(v, unit, true);
}

// ---- gate pass rate per setup -----------------------------------------------------------------

export interface PassRate {
  contenderId: string;
  name: string;
  role: string;
  /** 0..1, or null when the report has no gated requirement for it. */
  rate: number | null;
  n: number | null;
  gate: string | null;
}

/** Each setup's correctness-gate pass rate (from its first measured requirement). */
export function passRates(report: Report): PassRate[] {
  return report.contenders.map((c) => {
    const r = c.requirements.find((x) => x.type === "measured" && x.gate_pass_rate !== null);
    return {
      contenderId: c.contender_id,
      name: c.name,
      role: c.role,
      rate: r?.gate_pass_rate ?? null,
      n: r?.n ?? null,
      gate: r?.gate_id ?? null,
    };
  });
}

// ---- per task: small multiples ----------------------------------------------------------------

export interface TaskCell {
  task: string;
  requirementId: string;
  title: string;
  name: string;
  verdict: Verdict;
  lo: number;
  hi: number;
  ciUnit: RequirementComparison["diff_ci"]["unit"];
  unit: string | null;
  statement: string;
}

export interface TaskGrid {
  tasks: string[];
  requirements: { id: string; title: string }[];
  cells: TaskCell[];
  scope: string;
  headline: string[];
}

/** E18 per-task results. Null when the report has none (older reports, non-agent kits). */
export function taskGrid(report: Report): TaskGrid | null {
  if (!report.per_task) return null;
  const cells: TaskCell[] = [];
  const reqs: { id: string; title: string }[] = [];
  for (const c of report.contenders)
    for (const r of c.requirements)
      for (const t of r.by_task ?? []) {
        if (!reqs.some((x) => x.id === r.requirement_id))
          reqs.push({ id: r.requirement_id, title: r.title || r.requirement_id });
        cells.push({
          task: t.workload_id,
          requirementId: r.requirement_id,
          title: r.title || r.requirement_id,
          name: c.name,
          verdict: t.comparison.verdict,
          lo: Math.min(t.comparison.diff_ci.lo, t.comparison.diff_ci.hi),
          hi: Math.max(t.comparison.diff_ci.lo, t.comparison.diff_ci.hi),
          ciUnit: t.comparison.diff_ci.unit,
          unit: r.unit,
          statement: t.comparison.statement,
        });
      }
  return {
    tasks: report.per_task.tasks,
    requirements: reqs,
    cells,
    scope: report.per_task.scope,
    headline: report.per_task.headline,
  };
}

// ---- failures: what didn't count, and why -----------------------------------------------------

export const FAILURE_WORD: Record<string, string> = {
  infra: "our infrastructure (not billed)",
  subject: "the setup crashed or gave up",
  gate: "failed the correctness gate",
  kit: "the kit (our test)",
  budget: "hit its budget",
  timeout: "timed out",
};

export function failureRows(report: Report): { kind: string; word: string; count: number }[] {
  return Object.entries(report.failures)
    .filter(([, n]) => n > 0)
    .map(([kind, count]) => ({ kind, word: FAILURE_WORD[kind] ?? kind, count }));
}
