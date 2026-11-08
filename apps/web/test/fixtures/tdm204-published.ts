// The TDM-103 report with E18 per-task results (Tandem ×3 decided better on wall time), and a
// variant with a setup whose gate never passed. Parsed with core ReportSchema so it stays valid.
// Used by the chart-kit tests.
import { ReportSchema, type Report } from "@anybench/core";
import { tdm103Report } from "./tdm103-report";

const BASELINE = "019a5f3e-7c00-7000-8000-0000000000b1";
const TANDEM = "019a5f3e-7c00-7000-8000-0000000000c1";
const SUBAGENTS = "019a5f3e-7c00-7000-8000-0000000000c2";

function taskCmp(
  verdict: "better" | "indistinguishable" | "worse",
  task: string,
  lo: number,
  hi: number,
) {
  const better = verdict === "better";
  const worse = verdict === "worse";
  return {
    workload_id: task,
    comparison: {
      baseline_id: BASELINE,
      verdict,
      test: "mann_whitney_exact",
      p: better || worse ? 0.0002 : 0.4,
      p_adjusted: better || worse ? 0.002 : 1,
      alpha: 0.05,
      family: 13,
      effect: {
        measure: "cliffs_delta",
        value: better ? 0.9 : worse ? -0.8 : 0.2,
        hodges_lehmann: (lo + hi) / 2,
      },
      diff_ci: { lo, hi, level: 0.96, requested_level: 0.95, attained: true, unit: "metric" },
      n: { candidate: 6, baseline: 6, tasks: 1 },
      mde: { value: 0.9, unit: "cliffs_delta", metric_shift: 380 },
      claim: "these_tasks",
      downgraded: null,
      statement: better
        ? `better on ${task}: median ${Math.round((lo + hi) / 2)} s, Holm p=0.002, n=6 vs 6`
        : worse
          ? `worse on ${task}: Holm p=0.002, n=6 vs 6`
          : "no detectable difference at n=6 vs 6, smallest detectable difference=|δ| 0.90",
    },
  };
}

/** The headline report: Tandem ×3 vs Claude Code solo on 3 tasks, per-task results included. */
export function benchReport(): Report {
  const base = tdm103Report();
  return ReportSchema.parse({
    ...base,
    answer:
      "Tandem ×3 finished faster than Claude Code solo on all 3 tasks tested (median −41 s), with no detectable difference in hidden tests passed, at about twice the cost per task. proof: curated (verified offline at bebb77e) tokens: naive-proxy, effort: naive-min, thinking: off; simulated approvals",
    per_task: {
      tasks: ["todo-api", "auth-refactor", "bug-hunt"],
      family: 13,
      alpha: 0.05,
      scope:
        "3 tasks: this speaks for these tasks only; at least 8 tasks are needed for a general claim.",
      headline: ["Tandem ×3 was faster on all 3 tasks tested"],
    },
    where_it_breaks: [
      {
        workload_id: "bug-hunt",
        contender_id: TANDEM,
        summary: "3 of 6 runs fixed the symptom but not the planted bug; the gate caught it.",
      },
    ],
    contenders: base.contenders.map((c) =>
      c.role === "baseline"
        ? { ...c, name: "Claude Code solo" }
        : {
            ...c,
            name: "Tandem ×3",
            requirements: c.requirements.map((r) =>
              r.requirement_id === "wall"
                ? {
                    ...r,
                    by_task: [
                      taskCmp("better", "todo-api", -62, -28),
                      taskCmp("better", "auth-refactor", -55, -19),
                      taskCmp("better", "bug-hunt", -48, -9),
                    ],
                  }
                : r.requirement_id === "cost"
                  ? {
                      ...r,
                      by_task: [
                        taskCmp("indistinguishable", "todo-api", -200_000, 900_000),
                        taskCmp("indistinguishable", "auth-refactor", -100_000, 1_200_000),
                        taskCmp("indistinguishable", "bug-hunt", -300_000, 1_400_000),
                      ],
                    }
                  : r,
            ),
          },
    ),
  });
}

/** The same run with a third setup whose gate never passed: no values, hatched, never ranked. */
export function benchReportWithFailedGate(): Report {
  const r = benchReport();
  const failed = {
    contender_id: SUBAGENTS,
    name: "Claude Code + subagents",
    role: "competitor" as const,
    score: null,
    ci95: null,
    delta_vs_baseline: null,
    requirements: r.contenders[0]!.requirements.map((q) => ({
      ...q,
      value: null,
      gate_pass_rate: 0,
      n: 6,
      comparison: null,
      by_task: undefined,
    })),
    wins: [],
    losses: [],
  };
  return ReportSchema.parse({ ...r, contenders: [...r.contenders, failed] });
}
