// TDM-225 [20.3]: the New run flow sizes the first run to the starter limits and says "Free"; the
// Go screen's estimate shows "Free" with what the same run would normally cost, line by line,
// switches to the paid price (and says a card is needed, and which limit) past the limits, and
// says honestly when free runs are paused. A starter run's report states its sample size next to
// the verdict. Against a mocked API (fake fetch through the real typed client). The limits in these
// fixtures are NOT the defaults on purpose: the web app must read them from the API.
import type { Report, RunEstimate } from "@anybench/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewRunForm } from "../app/runs/new/NewRunForm";
import {
  starterFit,
  starterOffer,
  starterPreference,
  starterPrice,
  starterRunsPerSetup,
} from "../app/runs/new/starter";
import { estimateCopy, passedLimits } from "../components/live/estimate-copy";
import { EstimateBreakdown, loadEstimate } from "../components/live/RunEstimate";
import { ResultsView } from "../components/report/ResultsPanel";
import { sampleSizeNote } from "../components/report/model";
import { createWebApiClient } from "../lib/api";

const nav = { push: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const BASE = "https://api.test";
const NOW = "2026-11-09T12:00:00.000Z";
const RUN_ID = "0192f5d0-0000-7000-8000-000000000225";
// Not the defaults (2 / 24 / $10): proves the screen reads them from the API.
const LIMITS = { max_setups: 2, max_trials: 16, compute_cap_micro_usd: 8_000_000n };
const LIMITS_JSON = { max_setups: 2, max_trials: 16, compute_cap_micro_usd: "8000000" };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ME = {
  user: {
    id: "0192f5d0-0000-7000-8000-0000000000ff",
    github_login: "jaxon",
    email: null,
    avatar_url: null,
    is_admin: false,
    created_at: NOW,
  },
  via: { kind: "session" },
};

type FreeStatus = "available" | "paused" | "used";

function summary(free: FreeStatus | null, hasKey = true) {
  return {
    account: {
      payment_status: "none",
      has_payment_method: false,
      unbilled_micro_usd: "0",
      granted_remaining_micro_usd: "0",
      spend_limit_micro_usd: "100000000",
      daily_cap_micro_usd: null,
      invoice_threshold_micro_usd: "50000000",
    },
    period: { start: NOW, end: NOW, usage_micro_usd: "0" },
    grants: [],
    invoices: [],
    mode: "test",
    ...(free
      ? {
          free_run: {
            status: free,
            reason:
              free === "available" ? null : free === "paused" ? "pool_exhausted" : "already_used",
            message: "x",
            run_id: null,
            has_model_key: hasKey,
            limits: LIMITS_JSON,
          },
        }
      : {}),
  };
}

type Call = { method: string; path: string; body: unknown };

function mockApi(free: FreeStatus | null, hasKey = true) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.slice(BASE.length).split("?")[0]!;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path, body });
    if (path === "/auth/me") return json(200, ME);
    if (path === "/billing/summary") return json(200, summary(free, hasKey));
    if (method === "POST" && path === "/runs")
      return json(201, {
        run: {
          id: RUN_ID,
          project_id: null,
          question: "q",
          state: "intake",
          budget_micro_usd: "100000000",
          spent_micro_usd: "0",
          estimate_micro_usd: null,
          kit_id: null,
          paused_reason: null,
          cancel_requested_at: null,
          comped: false,
          created_at: NOW,
          updated_at: NOW,
        },
      });
    return json(404, { error: { code: "not_found", message: "no mock" } });
  };
  return { calls, client: createWebApiClient(BASE, { fetch }) };
}

const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
function toReview() {
  fireEvent.change(screen.getByLabelText("GitHub repo URL"), {
    target: { value: "https://github.com/jaximus808/tandem" },
  });
  next();
  fireEvent.change(screen.getByRole("textbox", { name: "What do you want to find out?" }), {
    target: { value: "Is it faster than plain Claude Code?" },
  });
  next();
  next();
}
const priceLine = () => document.querySelector('[data-slot="new-run-price"]');

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
});
afterEach(cleanup);

// ---- The New run screen ------------------------------------------------------------------------

describe("starter helpers (TDM-225)", () => {
  it("sizes the starter from the API's limits, never from constants", () => {
    expect(starterRunsPerSetup(LIMITS)).toBe(2); // 16 / (2 setups x 4 tasks)
    expect(starterRunsPerSetup({ ...LIMITS, max_trials: 24 })).toBe(3);
    expect(starterRunsPerSetup({ ...LIMITS, max_trials: 4 })).toBe(1);
    expect(starterFit(LIMITS, { setups: 2, runsPerSetup: 2 })).toEqual({ fits: true });
    expect(starterFit(LIMITS, { setups: 3, runsPerSetup: 9 })).toEqual({
      fits: false,
      passed: [
        "3 setups; a free run compares at most 2",
        "9 runs per setup is more than a free run's 16 trials allow",
      ],
    });
    expect(starterPreference(LIMITS)).toBe(
      "Free starter run: compare against at most 1 alternative (2 setups in all) and keep the plan to at most 16 trials in all, warm-ups included",
    );
  });

  it("only an available or paused free run is in play", () => {
    expect(starterOffer(null)).toBeNull();
    const used = { ...summary("used"), mode: "test" } as never;
    expect(starterOffer(used)).toBeNull();
    const off = { ...summary("available"), mode: "off" } as never;
    expect(starterOffer(off)).toBeNull();
    const paused = starterPrice({ kind: "paused", limits: LIMITS }, { setups: 2, runsPerSetup: 2 });
    expect(paused?.kind).toBe("paid_paused");
  });
});

describe("New run: the first run is sized to the starter limits and shows 'Free' (TDM-225)", () => {
  it("free: proposes the starter size, says Free, and tells the kit designer the limits", async () => {
    const { calls, client } = mockApi("available");
    render(<NewRunForm client={client} />);
    toReview();
    await waitFor(() => expect(priceLine()?.getAttribute("data-price")).toBe("free"));
    expect(priceLine()?.textContent).toContain(
      "Free: your first benchmark, sized as a starter run (2 setups, up to 16 trials, on your own model key). No card needed.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Design the test" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/runs/${RUN_ID}`));
    const body = calls.find((c) => c.method === "POST" && c.path === "/runs")?.body as {
      question: string;
    };
    expect(body.question).toContain("- Runs per setup and task: 2");
    expect(body.question).toContain(`- ${starterPreference(LIMITS)}`);
  });

  it("no model key yet: still free, and asks for the key before Go", async () => {
    const { client } = mockApi("available", false);
    render(<NewRunForm client={client} />);
    toReview();
    await waitFor(() => expect(priceLine()?.getAttribute("data-price")).toBe("free"));
    expect(screen.getByRole("link", { name: "add your Anthropic or OpenAI key" })).toBeTruthy();
  });

  it("past the limits: switches to paid, says which limit and that a card is needed; one click back", async () => {
    const { calls, client } = mockApi("available");
    render(<NewRunForm client={client} />);
    fireEvent.change(screen.getByLabelText("GitHub repo URL"), {
      target: { value: "https://github.com/jaximus808/tandem" },
    });
    next();
    fireEvent.change(screen.getByRole("textbox", { name: "What do you want to find out?" }), {
      target: { value: "Is it faster than ripgrep and grep?" },
    });
    next();
    await screen.findByText(/Your free run compares 2 setups: yours and one alternative/);
    for (const [i, name] of ["ripgrep", "grep"].entries()) {
      fireEvent.click(screen.getByRole("button", { name: "+ Add a setup" }));
      fireEvent.change(screen.getByLabelText(`Other setup ${i + 1}`), { target: { value: name } });
    }
    next();
    await waitFor(() => expect(priceLine()?.getAttribute("data-price")).toBe("paid_past_limits"));
    expect(priceLine()?.textContent).toContain(
      "Paid: past the free run's limits (3 setups; a free run compares at most 2). A card will be needed before Go",
    );

    fireEvent.click(screen.getByRole("button", { name: "Make it a free starter run" }));
    await waitFor(() => expect(priceLine()?.getAttribute("data-price")).toBe("free"));
    fireEvent.click(screen.getByRole("button", { name: "Design the test" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const body = calls.find((c) => c.method === "POST" && c.path === "/runs")?.body as {
      question: string;
    };
    expect(body.question).toContain("- Compare against: ripgrep\n");
    expect(body.question).not.toContain("grep;");
  });

  it("more runs per setup than the trials allow: paid, and the designer is not held to the starter", async () => {
    const { calls, client } = mockApi("available");
    render(<NewRunForm client={client} />);
    toReview();
    await waitFor(() => expect(priceLine()?.getAttribute("data-price")).toBe("free"));
    fireEvent.click(screen.getByRole("button", { name: "Options (defaults are fine)" }));
    fireEvent.change(screen.getByLabelText("Runs per setup"), { target: { value: "10" } });
    await waitFor(() => expect(priceLine()?.getAttribute("data-price")).toBe("paid_past_limits"));
    expect(priceLine()?.textContent).toContain(
      "10 runs per setup is more than a free run's 16 trials allow",
    );
    fireEvent.click(screen.getByRole("button", { name: "Design the test" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const body = calls.find((c) => c.method === "POST" && c.path === "/runs")?.body as {
      question: string;
    };
    expect(body.question).not.toContain("Free starter run");
  });

  it("pool paused: says free runs are paused and the run is billed at the normal price", async () => {
    const { client } = mockApi("paused");
    render(<NewRunForm client={client} />);
    toReview();
    await waitFor(() => expect(priceLine()?.getAttribute("data-price")).toBe("paid_paused"));
    expect(priceLine()?.textContent).toContain(
      "Free runs are paused right now, so this run is billed at the normal price.",
    );
    expect(screen.getByRole("link", { name: "See pricing" }).getAttribute("href")).toBe(
      "/#pricing",
    );
  });

  it("no free run in play (used, or an older server): no price line, the flow as before", async () => {
    const { client } = mockApi(null);
    render(<NewRunForm client={client} />);
    toReview();
    await screen.findByText("Free to create. Nothing is billed until you press Go.");
    expect(priceLine()).toBeNull();
  });
});

// ---- The estimate before Go --------------------------------------------------------------------

function estimate(over: Partial<RunEstimate> = {}): RunEstimate {
  return {
    run_id: RUN_ID as RunEstimate["run_id"],
    kit_origin: "generated",
    price: "free",
    total_micro_usd: 0n,
    normal: {
      run_fee_micro_usd: 2_000_000n,
      compute: {
        computers: 12,
        trials: 12,
        blocks: 12,
        block_seconds: 600,
        charge_micro_usd: 496_800n,
      },
      total_micro_usd: 2_496_800n,
    },
    tokens: {
      byok_providers: ["anthropic"],
      byok_ceiling_micro_usd: 6_000_000n,
      managed_contenders: [],
    },
    free_run: {
      status: "available",
      applies: true,
      refusal: null,
      limits: LIMITS,
      setups: 2,
    },
    card_needed: false,
    ...over,
  };
}

const pastLimits = estimate({
  price: "paid",
  total_micro_usd: 4_100_000n,
  normal: {
    run_fee_micro_usd: 2_000_000n,
    compute: {
      computers: 40,
      trials: 40,
      blocks: 40,
      block_seconds: 600,
      charge_micro_usd: 2_100_000n,
    },
    total_micro_usd: 4_100_000n,
  },
  free_run: {
    status: "available",
    applies: false,
    refusal: {
      reason: "too_many_trials",
      reasons: [
        {
          code: "too_many_trials",
          message: "A free run has at most 16 trials, and this test plan has more.",
        },
      ],
      message: "A free run has at most 16 trials, and this test plan has more.",
    },
    limits: LIMITS,
    setups: 2,
  },
  card_needed: true,
});

const paused = estimate({
  price: "paid",
  total_micro_usd: 2_496_800n,
  free_run: {
    status: "paused",
    applies: false,
    refusal: {
      reason: "pool_exhausted",
      reasons: [{ code: "pool_exhausted", message: "Free runs are paused right now." }],
      message: "Free runs are paused right now.",
    },
    limits: LIMITS,
    setups: 2,
  },
  card_needed: true,
});

describe("estimate before Go (TDM-225)", () => {
  it("free: 'Free', and what the same run would normally cost, line by line", () => {
    const c = estimateCopy(estimate());
    expect(c.headline).toBe("Free");
    expect(c.summary).toBe("Your free run covers this run: no card needed.");
    expect(c.linesTitle).toBe("What the same run would normally cost");
    expect(c.lines.map((l) => [l.label, l.amount])).toEqual([
      ["Run fee", "$2.00"],
      ["Computer time", "$0.50"],
      ["Normally", "$2.50"],
    ]);
    expect(c.lines[1]?.detail).toBe("12 computers · 12 blocks of 10 min · 12 trials");
    expect(c.tokens).toBe(
      "Model tokens run on your own Anthropic key: billed by your provider, not by Anybench. At most $6.00 for this run (every trial at its spend cap).",
    );
    expect(c.card).toBeNull();
  });

  it("renders the free estimate, with no markup line on tokens anywhere", () => {
    render(<EstimateBreakdown estimate={estimate()} />);
    const box = document.querySelector('[data-slot="run-estimate"]')!;
    expect(box.getAttribute("data-price")).toBe("free");
    expect(screen.getByText("What the same run would normally cost")).toBeTruthy();
    expect(screen.getByTestId("estimate-tokens").textContent).toContain("billed by your provider");
    expect(box.textContent).not.toMatch(/20\s*%|markup/i);
    expect(screen.queryByTestId("estimate-card")).toBeNull();
  });

  it("past the limits: the paid price, which limit, and a card is needed", () => {
    expect(passedLimits(pastLimits)).toEqual(["40 trials; a free run has at most 16"]);
    const c = estimateCopy(pastLimits);
    expect(c.headline).toBe("$4.10");
    expect(c.summary).toBe(
      "Past the free run's limits (40 trials; a free run has at most 16), so this run is billed at the normal price.",
    );
    render(<EstimateBreakdown estimate={pastLimits} />);
    expect(document.querySelector('[data-slot="run-estimate"]')?.getAttribute("data-price")).toBe(
      "paid",
    );
    expect(screen.getByText("What this run costs")).toBeTruthy();
    expect(screen.getByTestId("estimate-card").textContent).toBe("A card is needed to start it.");
    expect(screen.getByRole("link", { name: "Add a card" }).getAttribute("href")).toBe(
      `/billing?run=${RUN_ID}`,
    );
  });

  it("pool paused: says so honestly and shows the paid price", () => {
    const c = estimateCopy(paused);
    expect(c.headline).toBe("$2.50");
    render(<EstimateBreakdown estimate={paused} />);
    expect(screen.getByTestId("estimate-summary").textContent).toContain(
      "Free runs are paused right now (the pool that pays for them is used up), so this run is billed at the normal price.",
    );
    expect(screen.getByText("$2.50", { selector: '[data-line="total"] dd' })).toBeTruthy();
  });

  it("a starter limit that is not size (no model key) passes the server's own words through", () => {
    const c = estimateCopy(
      estimate({
        price: "paid",
        total_micro_usd: 2_496_800n,
        free_run: {
          status: "available",
          applies: false,
          refusal: {
            reason: "no_byok_key",
            reasons: [
              {
                code: "no_byok_key",
                message:
                  "A free run uses your own model key. Add your Anthropic or OpenAI key in Settings, or add a card.",
              },
            ],
            message: "x",
          },
          limits: LIMITS,
          setups: 2,
        },
      }),
    );
    expect(c.summary).toBe(
      "Not free yet: A free run uses your own model key. Add your Anthropic or OpenAI key in Settings, or add a card.",
    );
  });

  it("loadEstimate reads GET /runs/:id/estimate, and is null on any error", async () => {
    const wire = JSON.parse(
      JSON.stringify(estimate(), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    ) as unknown;
    const ok = createWebApiClient(BASE, {
      fetch: async (url: string) =>
        url.endsWith(`/runs/${RUN_ID}/estimate`)
          ? json(200, { estimate: wire })
          : json(404, { error: { code: "not_found", message: "x" } }),
    });
    expect((await loadEstimate(ok, RUN_ID))?.price).toBe("free");
    const bad = createWebApiClient(BASE, {
      fetch: async () => json(409, { error: { code: "conflict", message: "no kit" } }),
    });
    expect(await loadEstimate(bad, RUN_ID)).toBeNull();
  });
});

// ---- The report ------------------------------------------------------------------------------

function comparison(nC: number, nB: number, tasks: number) {
  return {
    baseline_id: "base",
    verdict: "indistinguishable" as const,
    test: "task_paired" as const,
    p: 0.25,
    p_adjusted: 0.25,
    alpha: 0.05,
    family: 1,
    effect: { measure: "cliffs_delta" as const, value: 0.2, hodges_lehmann: null },
    diff_ci: {
      lo: -0.5,
      hi: 0.8,
      level: 0.95,
      requested_level: 0.95,
      attained: true,
      unit: "cliffs_delta" as const,
    },
    n: { candidate: nC, baseline: nB, tasks },
    mde: { value: null, unit: "cliffs_delta" as const, metric_shift: null },
    claim: "these_tasks" as const,
    downgraded: null,
    statement: `no detectable difference at n=${nC} vs ${nB}`,
  };
}

function report(): Report {
  const req = (cmp: ReturnType<typeof comparison> | null) => ({
    requirement_id: "wall",
    type: "measured" as const,
    title: "Wall time",
    value: 12,
    unit: "s",
    ci95: null,
    gate_id: "gate",
    gate_pass_rate: 1,
    score: 50,
    n: 6,
    comparison: cmp,
  });
  return {
    run_id: RUN_ID as Report["run_id"],
    kit_id: null,
    answer: "No detectable difference in wall time between Tandem and Claude Code.",
    comped: false,
    contenders: [
      {
        contender_id: "base" as Report["contenders"][number]["contender_id"],
        name: "Claude Code",
        role: "baseline",
        score: 50,
        ci95: null,
        delta_vs_baseline: null,
        requirements: [req(null)],
        wins: [],
        losses: [],
      },
      {
        contender_id: "tandem" as Report["contenders"][number]["contender_id"],
        name: "Tandem",
        role: "subject",
        score: 52,
        ci95: null,
        delta_vs_baseline: 2,
        requirements: [req(comparison(6, 6, 2))],
        wins: [],
        losses: [],
      },
    ],
    where_it_breaks: [],
    bottlenecks: [],
    proof: [],
    failures: {},
    postmortem: null,
    generated_at: NOW,
  } as unknown as Report;
}

describe("a starter run's report states its sample size next to the verdict (TDM-225)", () => {
  it("sampleSizeNote: the fewest trials per setup, the tasks, and the honest caveat", () => {
    expect(sampleSizeNote(report())).toBe(
      'n = 6 trials per setup over 2 tasks (3 per task): small; a "not significant" result is expected unless the gap is large.',
    );
  });

  it("renders under the headline for a starter run only", () => {
    const { unmount } = render(
      <ResultsView
        runId={RUN_ID}
        state={{ kind: "report", report: report() }}
        runState="delivered"
        standalone
        starterRun
      />,
    );
    const note = screen.getByTestId("results-sample-size");
    expect(note.textContent).toContain("n = 6 trials per setup over 2 tasks");
    // Right after the verdict headline.
    expect(screen.getByTestId("results-headline").nextElementSibling).toBe(note);
    unmount();
    render(
      <ResultsView
        runId={RUN_ID}
        state={{ kind: "report", report: report() }}
        runState="delivered"
        standalone
      />,
    );
    expect(screen.queryByTestId("results-sample-size")).toBeNull();
  });
});
