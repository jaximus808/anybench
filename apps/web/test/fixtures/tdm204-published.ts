// A published benchmark as GET /public/benchmarks/:owner/:slug returns it (core publishRoutes.page
// response), built on the TDM-103 report with E18 per-task results. Parsed with the route's own
// response schema so it stays valid. Shared by the bench tests and the dev-only /dev/bench page.
import { apiRoutes, PROOF_CHECKS, ReportSchema, type Report } from "@anybench/core";
import { tdm103Report } from "./tdm103-report";

export const BENCH_OWNER = "jaximus808";
export const BENCH_SLUG = "tandem-vs-claude-code";
const BENCHMARK_ID = "019a5f3e-7c00-7000-8000-0000000000e1";
const BASELINE = "019a5f3e-7c00-7000-8000-0000000000b1";
const TANDEM = "019a5f3e-7c00-7000-8000-0000000000c1";
const SUBAGENTS = "019a5f3e-7c00-7000-8000-0000000000c2";

export type BenchPage = ReturnType<typeof apiRoutes.publish.page.response.parse>;

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

export function benchPage(
  report: Report = benchReport(),
  over: { visibility?: "public" | "unlisted" | "withdrawn"; version?: number } = {},
): BenchPage {
  const version = over.version ?? 2;
  return apiRoutes.publish.page.response.parse({
    benchmark: {
      id: BENCHMARK_ID,
      owner: BENCH_OWNER,
      slug: BENCH_SLUG,
      run_id: report.run_id,
      title: "Tandem ×3 vs Claude Code solo",
      kind: "agent",
      visibility: over.visibility ?? "public",
      latest_version: 2,
      pinned_version: null,
      auto_publish: false,
      page_url: `https://anybench.vercel.app/b/${BENCH_OWNER}/${BENCH_SLUG}`,
      badge_url: `https://api.anybench.jaxonp.com/badge/${BENCH_SLUG}.svg`,
      embed_url: `https://anybench.vercel.app/embed/${BENCH_SLUG}`,
      created_at: "2026-11-07T23:10:00.000Z",
    },
    version: {
      version,
      status: "live",
      report,
      attestation: {
        v: 1,
        benchmark_id: BENCHMARK_ID,
        slug: BENCH_SLUG,
        version,
        run_id: report.run_id,
        kit_hash: "b".repeat(64),
        contenders: report.contenders.map((c) => ({
          contender_id: c.contender_id,
          name: c.name,
          version: c.role === "baseline" ? "claude-code 2.1.319" : "tandem 0.2.0",
          snapshot_hash: "c".repeat(64),
          score: c.score,
          ci95: c.ci95,
        })),
        trial_count: 36,
        proof: PROOF_CHECKS.map((check) => ({
          check,
          pass: report.proof.some((p) => p.check === check && p.pass),
        })),
        comped: report.comped,
        created_at: "2026-11-08T01:00:00.000Z",
      },
      signature: "Zm9vYmFyYmF6cXV4c2lnbmF0dXJlLWJhc2U2NHVybC1lZDI1NTE5LXNpZ25hdHVyZQ",
      key_id: "anybench-2026-11",
      created_at: "2026-11-08T01:00:00.000Z",
    },
    versions: [
      { version: 1, created_at: "2026-11-07T23:10:00.000Z" },
      { version: 2, created_at: "2026-11-08T01:00:00.000Z" },
    ],
  });
}
