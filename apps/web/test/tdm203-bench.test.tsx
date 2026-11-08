import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BenchmarkPage } from "../components/bench/BenchmarkPage";
import {
  failureRows,
  formatMetric,
  passRates,
  requirementViews,
  taskGrid,
} from "../components/bench/model";
import { tdm103Report } from "./fixtures/tdm103-report";
import { benchPage, benchReport, benchReportWithFailedGate } from "./fixtures/tdm204-published";

// TDM-203/204: the benchmark chart kit and the public benchmark page. Honest by construction:
// every setup and task shown, every difference with its CI, a failed-gate setup hatched and never
// ranked, the per-task scope line always present, no composite score.

afterEach(cleanup);

describe("chart model (TDM-203)", () => {
  it("one view per requirement: values with n, differences with their CI and verdict", () => {
    const views = requirementViews(tdm103Report());
    expect(views.map((v) => v.id)).toEqual(["tests-pass", "wall", "cost"]);
    const wall = views.find((v) => v.id === "wall")!;
    expect(wall.lowerIsBetter).toBe(true);
    expect(wall.bars.map((b) => [b.name, b.label, b.n])).toEqual([
      ["claude-code-solo", "182 s", 10],
      ["tandem", "141 s", 10],
    ]);
    expect(wall.diffs).toHaveLength(1);
    expect(wall.diffs[0]).toMatchObject({ verdict: "better", lo: -58, hi: -22, point: -41 });
    expect(wall.diffDomain[0]).toBeLessThan(-58);
    expect(wall.diffDomain[1]).toBeGreaterThan(0);
    const tests = views.find((v) => v.id === "tests-pass")!;
    expect(tests.lowerIsBetter).toBe(false);
    expect(tests.diffs[0]!.verdict).toBe("indistinguishable");
    const cost = views.find((v) => v.id === "cost")!;
    expect(cost.diffs[0]).toMatchObject({ verdict: "worse", attained: false });
  });

  it("a setup whose gate never passed has no value and no difference: hatched, never ranked", () => {
    const views = requirementViews(benchReportWithFailedGate());
    for (const v of views) {
      const bar = v.bars.find((b) => b.name === "Claude Code + subagents")!;
      expect(bar.value).toBeNull();
      expect(bar.label).toBe("no gated value");
      expect(v.diffs.some((d) => d.name === "Claude Code + subagents")).toBe(false);
    }
    expect(passRates(benchReportWithFailedGate()).map((r) => r.rate)).toEqual([0.9, 0.9, 0]);
  });

  it("per-task grid with its scope line; none for reports without per-task results", () => {
    expect(taskGrid(tdm103Report())).toBeNull();
    const g = taskGrid(benchReport())!;
    expect(g.tasks).toEqual(["todo-api", "auth-refactor", "bug-hunt"]);
    expect(
      g.cells.filter((c) => c.requirementId === "wall").every((c) => c.verdict === "better"),
    ).toBe(true);
    expect(g.scope).toMatch(/these tasks only/);
  });

  it("formats rates, seconds and money; lists only failures that happened", () => {
    expect(formatMetric(0.9, "ratio")).toBe("90%");
    expect(formatMetric(-41, "s", true)).toBe("−41 s");
    expect(formatMetric(1_250_000, "micro-USD")).toBe("$1.25");
    expect(failureRows(tdm103Report()).map((f) => f.kind)).toEqual(["subject", "gate"]);
  });
});

describe("public benchmark page (TDM-204)", () => {
  it("leads with the verdict; shows every setup, the gate, results with CIs, tasks and scope", () => {
    render(<BenchmarkPage data={benchPage()} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Tandem ×3 vs Claude Code solo",
    );
    expect(screen.getByTestId("headline").textContent).toMatch(/^Tandem ×3 finished faster/);
    expect(screen.getByTestId("headline").textContent).not.toMatch(/proof:|tokens:/);
    const verdicts = screen.getByRole("list", { name: "Verdicts vs the baseline" });
    expect(verdicts.textContent).toContain("Tandem ×3: better on these 3 tasks");
    expect(verdicts.textContent).toContain("no detectable difference");
    expect(screen.getByTestId("pass-rates").textContent).toContain("90%");
    expect(screen.getByTestId("diff-wall").textContent).toMatch(/\[−58 s, −22 s\] at 95%/);
    expect(screen.getByTestId("task-scope").textContent).toMatch(/these tasks only/);
    expect(screen.getByTestId("where-it-breaks").textContent).toContain("planted bug");
    expect(screen.getByTestId("proof").textContent).toContain("curated");
    // No composite score anywhere: nothing ranked "#1" or scored "/100".
    expect(document.body.textContent).not.toMatch(/#1 |\/100|rank(ed)? first/i);
  });

  it("the failed-gate setup is listed and hatched, never ranked", () => {
    render(<BenchmarkPage data={benchPage(benchReportWithFailedGate())} />);
    const wallBars = screen.getByTestId("values-wall");
    const row = within(wallBars)
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("subagents"))!;
    expect(row.getAttribute("data-gated")).toBeNull();
    expect(row.textContent).toContain("no gated value");
  });

  it("withdrawn says so instead of disappearing", () => {
    render(<BenchmarkPage data={benchPage(benchReport(), { visibility: "withdrawn" })} />);
    expect(screen.getByTestId("withdrawn").textContent).toMatch(/Withdrawn/);
    expect(screen.getByTestId("headline")).toBeTruthy();
  });

  it("versions link to ?version=, the signed attestation is shown", () => {
    render(<BenchmarkPage data={benchPage()} />);
    const versions = screen.getByTestId("versions");
    const links = within(versions).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/b/jaximus808/tandem-vs-claude-code?version=1",
      "/b/jaximus808/tandem-vs-claude-code?version=2",
    ]);
    expect(links[1]!.getAttribute("aria-current")).toBe("page");
    const att = screen.getByTestId("attestation");
    expect(att.textContent).toContain("b".repeat(64));
    expect(att.textContent).toContain("anybench-2026-11");
    expect(document.body.textContent).toContain("anybench verify https://anybench.vercel.app/b/");
  });

  it("the share bar gives the link, the embed and the badge", async () => {
    render(<BenchmarkPage data={benchPage()} />);
    const bar = screen.getByTestId("share-bar");
    const text = () => (within(bar).getByTestId("share-text") as HTMLTextAreaElement).value;
    expect(text()).toBe("https://anybench.vercel.app/b/jaximus808/tandem-vs-claude-code");
    await act(async () => {
      fireEvent.click(within(bar).getByRole("tab", { name: "Embed" }));
    });
    expect(text()).toContain(
      '<iframe src="https://anybench.vercel.app/embed/tandem-vs-claude-code',
    );
    await act(async () => {
      fireEvent.click(within(bar).getByRole("tab", { name: "Badge (Markdown)" }));
    });
    expect(text()).toBe(
      "[![Anybench](https://api.anybench.jaxonp.com/badge/tandem-vs-claude-code.svg)](https://anybench.vercel.app/b/jaximus808/tandem-vs-claude-code)",
    );
  });
});
