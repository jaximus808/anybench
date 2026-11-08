import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReportPage } from "../components/report/ReportPage";
import { formatCi, proofBasis, resultRows, splitAnswer } from "../components/report/model";
import { ResultsPanel, ResultsView } from "../components/report/ResultsPanel";
import { createWebApiClient } from "../lib/api";
import { LiveApiContext } from "../lib/live/client";
import { TDM103_RUN_ID, tdm103Report } from "./fixtures/tdm103-report";

// TDM-103 [11.6]: the Results section renders the report (GET /runs/:id/report) — headline
// verdict, per-requirement table with n, verdict word + CI, smallest detectable difference,
// disclosure and proof basis — plus its three non-report states. No composite score.

afterEach(cleanup);

function clientFor(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const client = createWebApiClient("https://api.test", {
    fetch: async (url) => {
      calls.push(url);
      return handler(url);
    },
  });
  return { client, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("report model", () => {
  it("splits the answer into headline, proof label and disclosure", () => {
    const parts = splitAnswer(tdm103Report().answer);
    expect(parts.headline).toMatch(/^Result on wall \(the primary requirement\): tandem vs /);
    expect(parts.headline).not.toContain("proof:");
    expect(parts.proofLabel).toBe("proof: curated (verified offline at bebb77e)");
    expect(parts.disclosure).toBe(
      "tokens: naive-proxy, effort: naive-min, thinking: off; simulated approvals",
    );
    expect(splitAnswer("Plain answer.")).toEqual({
      headline: "Plain answer.",
      proofLabel: null,
      disclosure: null,
    });
  });

  it("names the proof basis: curated, or proven when all six checks pass", () => {
    const r = tdm103Report();
    expect(proofBasis(r, splitAnswer(r.answer).proofLabel)).toMatchObject({
      basis: "curated",
      passed: 2,
      total: 6,
    });
    const proven = tdm103Report({ proof: r.proof.map((p) => ({ ...p, pass: true })) });
    expect(proofBasis(proven, null).basis).toBe("proven");
  });

  it("formats values, the CI and the MDE per unit", () => {
    const rows = resultRows(tdm103Report());
    expect(rows.map((r) => r.requirementId)).toEqual(["tests-pass", "wall", "cost"]);
    const [tests, wall, cost] = rows;
    expect(tests!.cells.map((c) => c.value)).toEqual(["90%", "90%"]);
    expect(tests!.verdicts[0]).toMatchObject({ word: "no detectable difference", mde: "45 pp" });
    expect(tests!.verdicts[0]!.ci).toBe("[-28 pp, +28 pp] at 95%");
    expect(wall!.cells.map((c) => [c.value, c.n])).toEqual([
      ["182 s", 10],
      ["141 s", 10],
    ]);
    expect(wall!.verdicts[0]).toMatchObject({ word: "better", mde: "δ 0.33 (≈ 18 s)" });
    expect(cost!.cells[1]!.value).toBe("$2.50");
    expect(cost!.verdicts[0]!.ci).toBe("[+$0.90, +$1.60] at 89% (asked 95%; small n)");
    expect(cost!.verdicts[0]!.mde).toBe("none detectable at this n");
    const cmp = tdm103Report().contenders[1]!.requirements[1]!.comparison!;
    expect(formatCi(cmp, "s")).toBe("[-58 s, -22 s] at 95%");
  });
});

describe("Results section", () => {
  it("shows the headline first, the table with verdicts, disclosure and proof", () => {
    render(
      <ResultsView
        runId={TDM103_RUN_ID}
        state={{ kind: "report", report: tdm103Report() }}
        runState="delivered"
      />,
    );
    const section = screen.getByRole("region", { name: "Results" });
    const headline = screen.getByTestId("results-headline");
    expect(headline.textContent).toMatch(/^Result on wall/);
    // Headline comes before the table.
    const table = within(section).getByRole("table");
    expect(headline.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const head = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(head).toEqual([
      "Requirement",
      "claude-code-solo baseline",
      "tandem",
      "Verdict vs baseline (CI of the difference)",
      "Smallest detectable difference",
    ]);
    const wall = table.querySelector('tr[data-requirement="wall"]')!;
    expect(wall.textContent).toContain("182 s");
    expect(wall.textContent).toContain("n=10");
    const verdict = wall.querySelector("[data-verdict]")!;
    expect(verdict.getAttribute("data-verdict")).toBe("better");
    expect(verdict.textContent).toBe("better");
    expect(wall.textContent).toContain("[-58 s, -22 s] at 95%");
    expect(wall.textContent).toContain("on these 3 tasks only");
    const tests = table.querySelector('tr[data-requirement="tests-pass"]')!;
    expect(tests.querySelector("[data-verdict]")!.textContent).toBe("no detectable difference");
    expect(tests.textContent).toContain("45 pp");
    const cost = table.querySelector('tr[data-requirement="cost"]')!;
    expect(cost.querySelector("[data-verdict]")!.textContent).toBe("worse");

    expect(screen.getByTestId("results-disclosure").textContent).toBe(
      "tokens: naive-proxy, effort: naive-min, thinking: off; simulated approvals",
    );
    expect(screen.getByTestId("results-proof").textContent).toMatch(
      /^curated curated \(verified offline at bebb77e\) · 2\/6 checks$/,
    );
    expect(within(section).getByText("comped")).toBeTruthy();
    // No composite score anywhere.
    expect(head.join(" ")).not.toMatch(/score/i);
    expect(section.textContent).not.toMatch(/score\W{0,3}\d/i);
  });

  it("renders untrusted report text as escaped text", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const report = tdm103Report({ answer: `${evil} proof: curated` });
    report.contenders[1]!.name = `<b>${evil}</b>`;
    const { container } = render(
      <ResultsView runId={TDM103_RUN_ID} state={{ kind: "report", report }} runState="delivered" />,
    );
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(screen.getByTestId("results-headline").textContent).toBe(evil);
    expect(container.textContent).toContain(`<b>${evil}</b>`);
  });

  it("no report yet: says results appear when the run finishes", () => {
    render(<ResultsView runId={TDM103_RUN_ID} state={{ kind: "none" }} runState="delivered" />);
    expect(screen.getByTestId("results-empty").textContent).toBe(
      "Results appear when the run finishes.",
    );
  });

  it("needs_human: shows the reason", () => {
    render(
      <ResultsView
        runId={TDM103_RUN_ID}
        state={{ kind: "none" }}
        runState="needs_human"
        holdReason="proof suite not available yet"
      />,
    );
    expect(screen.getByTestId("results-needs-human").textContent).toBe(
      "needs youproof suite not available yet",
    );
    expect(screen.queryByTestId("results-empty")).toBeNull();
  });

  it("error: says the results couldn't load", () => {
    render(
      <ResultsView
        runId={TDM103_RUN_ID}
        state={{ kind: "error", message: "The Anybench API had a problem (500)." }}
        runState="delivered"
      />,
    );
    expect(screen.getByTestId("results-error").textContent).toBe(
      "Couldn’t load the results. The Anybench API had a problem (500).",
    );
  });
});

describe("Results fetch (through the API client)", () => {
  it("fetches GET /runs/:id/report and renders it on a delivered run", async () => {
    const { client, calls } = clientFor(() => json(200, { report: tdm103Report() }));
    await act(async () => {
      render(
        <LiveApiContext.Provider value={client}>
          <ResultsPanel runId={TDM103_RUN_ID} runState="delivered" />
        </LiveApiContext.Provider>,
      );
    });
    // The report first, then (once it renders) the scoreboard's trials and the trace summary.
    expect(calls[0]).toBe(`https://api.test/runs/${TDM103_RUN_ID}/report`);
    expect(new Set(calls.slice(1))).toEqual(
      new Set([
        `https://api.test/runs/${TDM103_RUN_ID}/trials?limit=200`,
        `https://api.test/runs/${TDM103_RUN_ID}/trace-summary`,
      ]),
    );
    expect((await screen.findByTestId("results-headline")).textContent).toMatch(/^Result on wall/);
  });

  it("a 404 is 'no report yet'; a 500 is an error", async () => {
    const notFound = clientFor(() =>
      json(404, { error: { code: "not_found", message: "no report for this run yet" } }),
    );
    await act(async () => {
      render(
        <LiveApiContext.Provider value={notFound.client}>
          <ResultsPanel runId={TDM103_RUN_ID} runState="delivered" />
        </LiveApiContext.Provider>,
      );
    });
    expect(await screen.findByTestId("results-empty")).toBeTruthy();
    cleanup();

    const broken = clientFor(() => json(500, { error: { code: "internal", message: "boom" } }));
    await act(async () => {
      render(
        <LiveApiContext.Provider value={broken.client}>
          <ResultsPanel runId={TDM103_RUN_ID} runState="delivered" />
        </LiveApiContext.Provider>,
      );
    });
    expect((await screen.findByTestId("results-error")).textContent).toMatch(
      /^Couldn’t load the results\./,
    );
  });

  it("stays hidden while the run is still going and has no report", async () => {
    const { client } = clientFor(() =>
      json(404, { error: { code: "not_found", message: "no report for this run yet" } }),
    );
    await act(async () => {
      render(
        <LiveApiContext.Provider value={client}>
          <ResultsPanel runId={TDM103_RUN_ID} runState="running" />
        </LiveApiContext.Provider>,
      );
    });
    expect(screen.queryByRole("region", { name: "Results" })).toBeNull();
  });

  it("/runs/[id]/report reads the run, then shows a needs_human reason", async () => {
    const { client } = clientFor((url) =>
      url.endsWith("/report")
        ? json(404, { error: { code: "not_found", message: "no report for this run yet" } })
        : json(200, runDetail("needs_human", "proof suite not available yet")),
    );
    await act(async () => {
      render(<ReportPage runId={TDM103_RUN_ID} client={client} />);
    });
    expect((await screen.findByTestId("results-needs-human")).textContent).toContain(
      "proof suite not available yet",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Is tandem faster?");
  });
});

function runDetail(state: string, paused_reason: string | null) {
  return {
    run: {
      id: TDM103_RUN_ID,
      project_id: null,
      question: "Is tandem faster?",
      state,
      budget_micro_usd: "50000000",
      spent_micro_usd: "1000000",
      estimate_micro_usd: null,
      kit_id: null,
      paused_reason,
      cancel_requested_at: null,
      comped: false,
      created_at: "2026-11-07T22:00:00.000Z",
      updated_at: "2026-11-07T23:00:00.000Z",
    },
    counters: {
      trials_total: 0,
      trials_done: 0,
      trials_running: 0,
      trials_failed: 0,
      spent_micro_usd: "1000000",
      projected_micro_usd: null,
      elapsed_s: 0,
      eta_s: null,
      last_seq: 0,
    },
    open_alerts: [],
    agents: [],
  };
}
