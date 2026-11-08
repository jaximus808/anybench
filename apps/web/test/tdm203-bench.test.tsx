import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RequirementCharts, TaskCharts } from "../components/bench/Charts";
import { formatMetric, requirementViews, taskViews, wilson95 } from "../components/bench/model";
import { PublicReport } from "../components/publish/PublicReport";
import { ResultsView } from "../components/report/ResultsPanel";
import { deliveredPublication, deliveredReport } from "./fixtures/publication-delivered";
import { tdm103Report } from "./fixtures/tdm103-report";
import { benchReport, benchReportWithFailedGate } from "./fixtures/tdm204-published";

// TDM-203 chart kit, now on /r/<slug> and the owner's Results panel. Honest by construction:
// every setup shown, each setup's interval and every difference with its CI, colour only when the
// report's verdict decided it, a failed-gate setup hatched and never ranked, no composite score.

afterEach(cleanup);

describe("chart model", () => {
  it("one view per requirement: values with n, differences with their CI and verdict", () => {
    const views = requirementViews(tdm103Report());
    expect(views.map((v) => v.id)).toEqual(["tests-pass", "wall", "cost"]);
    const wall = views.find((v) => v.id === "wall")!;
    expect(wall.lowerIsBetter).toBe(true);
    expect(wall.intervals).toBeNull(); // no per-setup ci95 in the report: bars, not invented intervals
    expect(wall.bars.map((b) => [b.name, b.label, b.n])).toEqual([
      ["claude-code-solo", "182 s", 10],
      ["tandem", "141 s", 10],
    ]);
    expect(wall.diffs[0]).toMatchObject({ verdict: "better", lo: -58, hi: -22, point: -41 });
    expect(wall.diffDomain[0]).toBeLessThan(-58);
    expect(wall.diffDomain[1]).toBeGreaterThan(0);
    const tests = views.find((v) => v.id === "tests-pass")!;
    expect(tests.lowerIsBetter).toBe(false);
    expect(tests.intervals).toBe("wilson");
    expect(tests.diffs[0]!.verdict).toBe("indistinguishable");
    expect(views.find((v) => v.id === "cost")!.diffs[0]).toMatchObject({
      verdict: "worse",
      attained: false,
    });
  });

  it("pass rates get 95% Wilson intervals from the rate and n (the delivered run: 7/7 vs 2/4)", () => {
    const tests = requirementViews(deliveredReport()).find((v) => v.id === "tests-pass")!;
    const [solo, tandem] = tests.bars;
    expect(solo!.count).toBe("7/7");
    expect(tandem!.count).toBe("2/4");
    expect(solo!.ci![0]).toBeCloseTo(0.6457, 4); // @anybench/bench wilsonCi(7, 7)
    expect(solo!.ci![1]).toBe(1);
    expect(tandem!.ci![0]).toBeCloseTo(0.15, 3);
    expect(tandem!.ci![1]).toBeCloseTo(0.85, 3);
    // The two intervals overlap, and the verdict is "no detectable difference".
    expect(tandem!.ci![1]).toBeGreaterThan(solo!.ci![0]);
    expect(tests.diffs[0]!.verdict).toBe("indistinguishable");
    expect(tests.diffs[0]!.mde).toBe("73.3 pp");
    expect(wilson95(0, 5)[0]).toBe(0);
  });

  it("a setup whose gate never passed has no value and no difference: hatched, never ranked", () => {
    for (const v of requirementViews(benchReportWithFailedGate())) {
      const bar = v.bars.find((b) => b.name === "Claude Code + subagents")!;
      expect(bar.value).toBeNull();
      expect(bar.label).toBe("no gated value");
      expect(v.diffs.some((d) => d.name === "Claude Code + subagents")).toBe(false);
    }
  });

  it("per task: one view per requirement with per-task results, a row per task", () => {
    expect(taskViews(tdm103Report())).toEqual([]);
    const views = taskViews(benchReport());
    expect(views.map((v) => v.id)).toEqual(["wall", "cost"]);
    expect(views[0]!.diffs.map((d) => [d.name, d.verdict])).toEqual([
      ["todo-api", "better"],
      ["auth-refactor", "better"],
      ["bug-hunt", "better"],
    ]);
    const delivered = taskViews(deliveredReport());
    expect(delivered.map((v) => [v.id, v.diffs.length])).toEqual([
      ["tests-pass", 3],
      ["wall", 2],
    ]);
  });

  it("formats rates, seconds and money", () => {
    expect(formatMetric(0.9, "ratio")).toBe("90%");
    expect(formatMetric(-41, "s", true)).toBe("−41 s");
    expect(formatMetric(1_250_000, "micro-USD")).toBe("$1.25");
  });
});

describe("charts", () => {
  it("'no detectable difference' is drawn in plain ink: no tinted better half, the MDE shown", () => {
    render(<RequirementCharts report={deliveredReport()} />);
    for (const id of ["tests-pass", "wall", "cost"]) {
      const diff = screen.getByTestId(`diff-${id}`);
      const row = diff.querySelector("[data-verdict]")!;
      expect(row.getAttribute("data-verdict")).toBe("indistinguishable");
      expect(row.textContent).toContain("no detectable difference");
      expect(row.textContent).toContain("smallest detectable difference:");
      expect(row.querySelector('[class*="diffBetter"]')).toBeNull();
    }
    const wall = screen.getByTestId("diff-wall").textContent!;
    expect(wall).toContain("+193 s");
    expect(wall).toContain("[+123 s, +262 s] at 94% (asked 95%; small n)");
    const rates = screen.getByTestId("intervals-tests-pass");
    const rows = within(rates).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("100% 7/7[64.6%, 100%]");
    expect(rows[1]!.textContent).toContain("50% 2/4[15%, 85%]");
    expect(rows[0]!.getAttribute("data-role")).toBe("baseline");
    // Solved-only medians are flagged.
    expect(screen.getByTestId("values-wall").textContent).toContain("†");
    expect(document.body.textContent).not.toMatch(/#1 |\/100|rank(ed)? first|winner/i);
  });

  it("a decided verdict tints the better half and colours its row", () => {
    render(<RequirementCharts report={tdm103Report()} />);
    const row = screen.getByTestId("diff-wall").querySelector("[data-verdict]")!;
    expect(row.getAttribute("data-verdict")).toBe("better");
    expect(row.querySelector('[class*="diffBetter"]')).not.toBeNull();
    expect(row.textContent).not.toContain("smallest detectable difference");
  });

  it("per-task charts render a row per task", () => {
    render(<TaskCharts report={deliveredReport()} />);
    const tp = screen.getByTestId("task-diff-tests-pass");
    expect(tp.querySelectorAll("[data-verdict]").length).toBeGreaterThanOrEqual(3);
    expect(tp.textContent).toContain("bug-hunt");
  });
});

describe("/r/<slug> and the Results panel use the charts, with the exact numbers kept", () => {
  it("the public page draws each requirement and each task, the table under each chart", () => {
    render(<PublicReport data={deliveredPublication()} origin="https://anybench.jaxonp.com" />);
    expect(screen.getByTestId("intervals-tests-pass")).toBeTruthy();
    expect(screen.getByTestId("values-wall")).toBeTruthy();
    expect(screen.getByTestId("diff-cost")).toBeTruthy();
    expect(screen.getByTestId("public-task-diff-tests-pass")).toBeTruthy();
    expect(screen.getAllByText("Exact numbers").length).toBeGreaterThanOrEqual(5);
    expect(screen.getByTestId("public-verdict").textContent).toBe(
      "No detectable difference between Tandem and Claude Code solo.",
    );
    expect(screen.queryByTestId("public-metrics-note")).toBeNull();
  });

  it("the owner's Results panel shows the same charts above its table", () => {
    render(
      <ResultsView
        runId={deliveredReport().run_id}
        state={{ kind: "report", report: deliveredReport() }}
        runState="delivered"
      />,
    );
    expect(screen.getByTestId("requirement-charts")).toBeTruthy();
    expect(screen.getByTestId("task-charts")).toBeTruthy();
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
  });
});
