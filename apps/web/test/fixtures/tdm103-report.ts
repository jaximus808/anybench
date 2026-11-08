// A report as GET /runs/:id/report returns it (core ReportSchema), in the shape the summary
// analyst writes (apps/server/src/orchestrator/proof-score.ts, TDM-175 verdicts): the answer is
// "<headline> proof: … tokens: …; simulated approvals", values per requirement with n, and a
// comparison vs the baseline on every non-baseline setup. Parsed here so it stays valid.
import { PROOF_CHECKS, ReportSchema, type Report } from "@anybench/core";

export const TDM103_RUN_ID = "019a5f3e-7c00-7000-8000-000000000103";
const BASELINE = "019a5f3e-7c00-7000-8000-0000000000b1";
const TANDEM = "019a5f3e-7c00-7000-8000-0000000000c1";

const HEADLINE =
  "Result on wall (the primary requirement): tandem vs claude-code-solo: better on these 3 tasks: median -41 s, Holm p=0.012, n=10. (2 setups; 20 measured trials; Holm-corrected across 3 comparisons.) No setup is ranked by a composite score.";
const PROOF_LABEL = "proof: curated (verified offline at bebb77e)";
const DISCLOSURE = "tokens: naive-proxy, effort: naive-min, thinking: off; simulated approvals";

const cmp = (over: Record<string, unknown>) => ({
  baseline_id: BASELINE,
  test: "task_paired",
  p: 0.004,
  p_adjusted: 0.012,
  alpha: 0.05,
  family: 3,
  effect: { measure: "cliffs_delta", value: 0.62, hodges_lehmann: -41 },
  diff_ci: {
    lo: -58,
    hi: -22,
    level: 0.95,
    requested_level: 0.95,
    attained: true,
    unit: "metric",
  },
  n: { candidate: 10, baseline: 10, tasks: 3 },
  mde: { value: 0.33, unit: "cliffs_delta", metric_shift: 18 },
  claim: "these_tasks",
  downgraded: null,
  ...over,
});

export function tdm103Report(over: Partial<Record<keyof Report, unknown>> = {}): Report {
  const req = (
    id: string,
    title: string,
    unit: string | null,
    value: number | null,
    extra = {},
  ) => ({
    requirement_id: id,
    type: "measured" as const,
    title,
    value,
    unit,
    ci95: null,
    gate_id: "hidden-tests",
    gate_pass_rate: 0.9,
    score: null,
    n: 10,
    survivorship: false,
    ...extra,
  });
  return ReportSchema.parse({
    run_id: TDM103_RUN_ID,
    kit_id: null,
    answer: `${HEADLINE} ${PROOF_LABEL} ${DISCLOSURE}`,
    comped: true,
    contenders: [
      {
        contender_id: BASELINE,
        name: "claude-code-solo",
        role: "baseline",
        score: null,
        ci95: null,
        delta_vs_baseline: null,
        requirements: [
          req("tests-pass", "Hidden tests pass", "ratio", 0.9, { comparison: null }),
          req("wall", "Wall-clock time to finish", "s", 182, { comparison: null }),
          req("cost", "Cost per task", "micro-USD", 1_250_000, { comparison: null }),
        ],
        wins: [],
        losses: [],
      },
      {
        contender_id: TANDEM,
        name: "tandem",
        role: "subject",
        score: null,
        ci95: null,
        delta_vs_baseline: null,
        requirements: [
          req("tests-pass", "Hidden tests pass", "ratio", 0.9, {
            comparison: cmp({
              verdict: "indistinguishable",
              test: "newcombe",
              p: 1,
              p_adjusted: 1,
              effect: { measure: "rate_diff", value: 0, hodges_lehmann: null },
              diff_ci: {
                lo: -0.28,
                hi: 0.28,
                level: 0.95,
                requested_level: 0.95,
                attained: true,
                unit: "rate",
              },
              mde: { value: 0.45, unit: "rate", metric_shift: null },
              claim: "general",
              statement: "no detectable difference at n=10, smallest detectable difference=45 pp",
            }),
          }),
          req("wall", "Wall-clock time to finish", "s", 141, {
            comparison: cmp({
              verdict: "better",
              statement: "better on these 3 tasks: median -41 s, Holm p=0.012, n=10",
            }),
          }),
          req("cost", "Cost per task", "micro-USD", 2_500_000, {
            comparison: cmp({
              verdict: "worse",
              effect: { measure: "cliffs_delta", value: -0.7, hodges_lehmann: 1_250_000 },
              diff_ci: {
                lo: 900_000,
                hi: 1_600_000,
                level: 0.89,
                requested_level: 0.95,
                attained: false,
                unit: "metric",
              },
              mde: { value: null, unit: "cliffs_delta", metric_shift: null },
              statement: "worse on these 3 tasks: median +$1.25, Holm p=0.012, n=10",
            }),
          }),
        ],
        wins: ["wall"],
        losses: ["cost"],
      },
    ],
    where_it_breaks: [],
    bottlenecks: [],
    proof: PROOF_CHECKS.map((check) =>
      check === "oracle_passes" || check === "do_less_fails"
        ? { check, pass: true, reason: `${PROOF_LABEL}: oracle 42/42`, evidence: [] }
        : { check, pass: false, reason: "not run: proof suite not available yet", evidence: [] },
    ),
    failures: { infra: 0, subject: 1, gate: 2, kit: 0, budget: 0, timeout: 0 },
    postmortem: null,
    generated_at: "2026-11-07T23:00:00.000Z",
    ...over,
  });
}
