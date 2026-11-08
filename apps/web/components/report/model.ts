// The run's report (GET /runs/:id/report, core ReportSchema) shaped for the Results section.
// Verdicts come from the decision rule (TDM-175): better / worse / "no detectable difference",
// each with the CI of the difference and the smallest detectable difference. Nothing here makes
// a composite score, and a measured value only shows when its gate passed (the schema enforces it).
import {
  formatUsd,
  PROOF_CHECKS,
  type ContenderResult,
  type Report,
  type RequirementComparison,
  type Verdict,
} from "@anybench/core";

type RequirementResult = ContenderResult["requirements"][number];

/**
 * The summary analyst writes `answer` as "<headline sentence> proof: … tokens: …; simulated
 * approvals" (apps/server/src/orchestrator/proof-score.ts). Split it so each part has its line.
 * An answer without the markers is all headline.
 */
export function splitAnswer(answer: string): {
  headline: string;
  proofLabel: string | null;
  disclosure: string | null;
} {
  const text = answer.trim();
  const at = (marker: string) => {
    if (text.startsWith(marker)) return 0;
    const i = text.indexOf(` ${marker}`);
    return i < 0 ? -1 : i + 1;
  };
  const p = at("proof: ");
  const t = at("tokens: ");
  const cuts = [p, t].filter((i) => i > 0).sort((a, b) => a - b);
  const headline = (cuts.length ? text.slice(0, cuts[0]) : text).trim();
  const part = (start: number) => {
    if (start < 0) return null;
    const end = [p, t].filter((i) => i > start).sort((a, b) => a - b)[0] ?? text.length;
    return text.slice(start, end).trim() || null;
  };
  return { headline: headline || text, proofLabel: part(p), disclosure: part(t) };
}

export type ProofBasis = {
  basis: "proven" | "curated" | "unproven";
  passed: number;
  total: number;
  label: string;
};

/** Proven = all six proof checks passed; curated = accepted on a signed-off offline proof. */
export function proofBasis(report: Report, proofLabel: string | null): ProofBasis {
  const total = PROOF_CHECKS.length;
  const passed = PROOF_CHECKS.filter((c) =>
    report.proof.some((p) => p.check === c && p.pass),
  ).length;
  if (passed === total) return { basis: "proven", passed, total, label: "all six checks passed" };
  const fromChecks = report.proof
    .filter((p) => p.pass)
    .map((p) => /^proof: curated(?: \([^)]*\))?/.exec(p.reason)?.[0])
    .find(Boolean);
  const curated = (proofLabel && /\bcurated\b/.test(proofLabel) ? proofLabel : null) ?? fromChecks;
  if (curated) return { basis: "curated", passed, total, label: curated.replace(/^proof:\s*/, "") };
  return { basis: "unproven", passed, total, label: `${passed} of ${total} checks passed` };
}

export const VERDICT_WORD: Record<Verdict, string> = {
  better: "better",
  worse: "worse",
  indistinguishable: "no detectable difference",
};

function num(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  const abs = Math.abs(v);
  return Number(v.toPrecision(abs >= 100 ? 4 : 3)).toLocaleString("en-US", {
    maximumFractionDigits: 6,
  });
}

function signed(v: number, text: string): string {
  return v > 0 ? `+${text}` : text;
}

/** A requirement's value in its unit: micro-USD as dollars, ratios as percentages. */
export function formatValue(r: RequirementResult): string {
  if (r.value === null) return r.type === "measured" ? "no gated value" : "not reviewed";
  const v = r.value;
  if (r.unit === "micro-USD" && Number.isSafeInteger(Math.round(v)))
    return formatUsd(BigInt(Math.round(v)), { decimals: Math.abs(v) < 10_000 ? 4 : 2 });
  if (r.unit === "ratio" || r.unit === "rate") return `${num(v * 100)}%`;
  return r.unit ? `${num(v)} ${r.unit}` : num(v);
}

/** The difference CI: percentage points for rates, Cliff's δ, or the metric's own unit. */
export function formatCi(c: RequirementComparison, unit: string | null): string {
  const { lo, hi, level, attained, requested_level } = c.diff_ci;
  const pct = `${num(level * 100)}%`;
  const short = attained ? "" : ` (asked ${num(requested_level * 100)}%; small n)`;
  const one = (v: number) => {
    if (c.diff_ci.unit === "rate") return signed(v, `${num(v * 100)} pp`);
    if (c.diff_ci.unit === "cliffs_delta") return signed(v, num(v));
    if (unit === "micro-USD" && Number.isSafeInteger(Math.round(v)))
      return signed(
        v,
        formatUsd(BigInt(Math.round(v)), { decimals: Math.abs(v) < 10_000 ? 4 : 2 }),
      );
    return signed(v, unit && unit !== "ratio" ? `${num(v)} ${unit}` : num(v));
  };
  const measure = c.diff_ci.unit === "cliffs_delta" ? "δ " : "";
  return `${measure}[${one(lo)}, ${one(hi)}] at ${pct}${short}`;
}

/** The smallest detectable difference at 80% power, or why there is none. */
export function formatMde(c: RequirementComparison, unit: string | null): string {
  if (c.mde.value === null) return "none detectable at this n";
  const base = c.mde.unit === "rate" ? `${num(c.mde.value * 100)} pp` : `δ ${num(c.mde.value)}`;
  if (c.mde.metric_shift === null) return base;
  const shift =
    unit === "micro-USD" && Number.isSafeInteger(Math.round(c.mde.metric_shift))
      ? formatUsd(BigInt(Math.round(Math.abs(c.mde.metric_shift))), { decimals: 4 })
      : `${num(Math.abs(c.mde.metric_shift))}${unit && unit !== "ratio" ? ` ${unit}` : ""}`;
  return `${base} (≈ ${shift})`;
}

export type ResultCell = {
  contenderId: string;
  name: string;
  value: string;
  n: number | null;
  survivorship: boolean;
  gated: boolean;
};

export type VerdictCell = {
  contenderId: string;
  name: string;
  baselineName: string;
  verdict: Verdict;
  word: string;
  ci: string;
  mde: string;
  claim: RequirementComparison["claim"];
  tasks: number;
  downgraded: RequirementComparison["downgraded"];
};

export type ResultRow = {
  requirementId: string;
  title: string;
  type: RequirementResult["type"];
  cells: ResultCell[];
  verdicts: VerdictCell[];
};

/** One row per requirement: every setup's value with n, then each setup's verdict vs baseline. */
export function resultRows(report: Report): ResultRow[] {
  const ids: string[] = [];
  for (const c of report.contenders)
    for (const r of c.requirements) if (!ids.includes(r.requirement_id)) ids.push(r.requirement_id);
  const byId = new Map(report.contenders.map((c) => [c.contender_id as string, c]));
  const nameOf = (baselineId: string) =>
    report.contenders.find(
      (c) => c.role === "baseline" && (c.contender_id as string) === baselineId,
    )?.name ??
    report.contenders.find((c) => c.role === "baseline")?.name ??
    baselineId;
  return ids.map((id) => {
    const cells: ResultCell[] = [];
    const verdicts: VerdictCell[] = [];
    let title = id;
    let type: RequirementResult["type"] = "measured";
    for (const c of report.contenders) {
      const r = c.requirements.find((x) => x.requirement_id === id);
      if (!r) continue;
      title = r.title || id;
      type = r.type;
      cells.push({
        contenderId: c.contender_id,
        name: c.name,
        value: formatValue(r),
        n: r.n ?? null,
        survivorship: r.survivorship === true,
        gated: r.value !== null,
      });
      const cmp = r.comparison;
      if (cmp) {
        verdicts.push({
          contenderId: c.contender_id,
          name: c.name,
          baselineName: byId.get(cmp.baseline_id)?.name ?? nameOf(cmp.baseline_id),
          verdict: cmp.verdict,
          word: VERDICT_WORD[cmp.verdict],
          ci: formatCi(cmp, r.unit),
          mde: formatMde(cmp, r.unit),
          claim: cmp.claim,
          tasks: cmp.n.tasks,
          downgraded: cmp.downgraded,
        });
      }
    }
    return { requirementId: id, title, type, cells, verdicts };
  });
}

export type PerTaskCell = {
  workloadId: string;
  contenderId: string;
  name: string;
  verdict: Verdict;
  word: string;
  ci: string;
  mde: string;
  downgraded: RequirementComparison["downgraded"];
};

export type PerTaskRow = {
  requirementId: string;
  title: string;
  cells: PerTaskCell[];
};

/**
 * E18: one row per requirement with each compared setup's per-task results ("on todo-api:
 * better"). Each speaks for its task only; `report.per_task.scope` says what that leaves out.
 * Empty for reports without per-task results.
 */
export function perTaskRows(report: Report): PerTaskRow[] {
  if (!report.per_task) return [];
  const rows = new Map<string, PerTaskRow>();
  for (const c of report.contenders) {
    for (const r of c.requirements) {
      for (const t of r.by_task ?? []) {
        let row = rows.get(r.requirement_id);
        if (!row) {
          row = { requirementId: r.requirement_id, title: r.title || r.requirement_id, cells: [] };
          rows.set(r.requirement_id, row);
        }
        row.cells.push({
          workloadId: t.workload_id,
          contenderId: c.contender_id,
          name: c.name,
          verdict: t.comparison.verdict,
          word: VERDICT_WORD[t.comparison.verdict],
          ci: formatCi(t.comparison, r.unit),
          mde: formatMde(t.comparison, r.unit),
          downgraded: t.comparison.downgraded,
        });
      }
    }
  }
  return [...rows.values()];
}
