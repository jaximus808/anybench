// E18: the Results section's per-task block (report.per_task + requirement.by_task), and that a
// report without them (TDM-103's) renders as before.
import { cleanup, render, screen, within } from "@testing-library/react";
import { ReportSchema, type Report } from "@anybench/core";
import { afterEach, describe, expect, it } from "vitest";
import { perTaskRows } from "../components/report/model";
import { ResultsView } from "../components/report/ResultsPanel";
import { TDM103_RUN_ID, tdm103Report } from "./fixtures/tdm103-report";

afterEach(cleanup);

const SCOPE_E18 =
  "3 tasks: this doesn't generalise to other tasks; ≥8 tasks needed for a general claim.";

function taskCmpE18(verdict: "better" | "indistinguishable", task: string) {
  return {
    workload_id: task,
    comparison: {
      baseline_id: "019a5f3e-7c00-7000-8000-0000000000b1",
      verdict,
      test: "mann_whitney_exact",
      p: verdict === "better" ? 0.0002 : 0.4,
      p_adjusted: verdict === "better" ? 0.002 : 1,
      alpha: 0.05,
      family: 13,
      effect: {
        measure: "cliffs_delta",
        value: verdict === "better" ? 1 : 0.2,
        hodges_lehmann: -400,
      },
      diff_ci: {
        lo: -620,
        hi: -210,
        level: 0.96,
        requested_level: 0.95,
        attained: true,
        unit: "metric",
      },
      n: { candidate: 6, baseline: 6, tasks: 1 },
      mde: { value: 0.9, unit: "cliffs_delta", metric_shift: 380 },
      claim: "these_tasks",
      downgraded: null,
      statement:
        verdict === "better"
          ? "better: Cliff's δ +1.00, shift −400 s, Holm p=0.002, n=6 vs 6"
          : "no detectable difference at n=6 vs 6, smallest detectable difference=|δ| 0.90",
    },
  };
}

function perTaskReportE18(): Report {
  const base = tdm103Report();
  return ReportSchema.parse({
    ...base,
    per_task: {
      tasks: ["todo-api", "auth-refactor", "bug-hunt"],
      family: 13,
      alpha: 0.05,
      scope: SCOPE_E18,
      headline: ["tandem was faster on all 3 tasks tested"],
    },
    contenders: base.contenders.map((c) =>
      c.role === "baseline"
        ? c
        : {
            ...c,
            requirements: c.requirements.map((r) =>
              r.requirement_id === "wall"
                ? {
                    ...r,
                    by_task: [
                      taskCmpE18("better", "todo-api"),
                      taskCmpE18("better", "auth-refactor"),
                      taskCmpE18("better", "bug-hunt"),
                    ],
                  }
                : r.requirement_id === "cost"
                  ? { ...r, by_task: [taskCmpE18("indistinguishable", "todo-api")] }
                  : r,
            ),
          },
    ),
  });
}

describe("per-task results (E18)", () => {
  it("the report schema refuses a per-task result that claims to be general", () => {
    const r = perTaskReportE18();
    const bad = structuredClone(r) as unknown as {
      contenders: { requirements: { by_task?: { comparison: { claim: string } }[] }[] }[];
    };
    bad.contenders[1]!.requirements[1]!.by_task![0]!.comparison.claim = "general";
    expect(ReportSchema.safeParse(bad).success).toBe(false);
  });

  it("perTaskRows: one row per requirement, one cell per task", () => {
    const rows = perTaskRows(perTaskReportE18());
    expect(
      rows.map((r) => [r.requirementId, r.cells.map((c) => `${c.workloadId}:${c.word}`)]),
    ).toEqual([
      ["wall", ["todo-api:better", "auth-refactor:better", "bug-hunt:better"]],
      ["cost", ["todo-api:no detectable difference"]],
    ]);
    expect(perTaskRows(tdm103Report())).toEqual([]);
  });

  it("renders the per-task headline, the scope line and 'on <task>: …' rows", () => {
    render(
      <ResultsView
        runId={TDM103_RUN_ID}
        state={{ kind: "report", report: perTaskReportE18() }}
        runState="delivered"
      />,
    );
    const block = screen.getByTestId("results-per-task");
    expect(within(block).getByTestId("results-per-task-headline").textContent).toBe(
      "tandem was faster on all 3 tasks tested",
    );
    expect(within(block).getByTestId("results-per-task-scope").textContent).toContain(SCOPE_E18);
    expect(block.textContent).toContain("on todo-api: better");
    expect(block.textContent).toContain("on bug-hunt: better");
    expect(block.textContent).toContain("on todo-api: no detectable difference");
  });

  it("a report without per-task results has no per-task block", () => {
    render(
      <ResultsView
        runId={TDM103_RUN_ID}
        state={{ kind: "report", report: tdm103Report() }}
        runState="delivered"
      />,
    );
    expect(screen.queryByTestId("results-per-task")).toBeNull();
  });
});
