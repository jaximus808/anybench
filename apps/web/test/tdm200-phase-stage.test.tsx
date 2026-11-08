import type { AnybenchEvent, RunState } from "@anybench/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRunView } from "../components/live/LiveRunPage";
import { createWebApiClient } from "../lib/api";
import { LiveApiContext } from "../lib/live/client";
import { applyEvent, applyEvents, countTrials, initLive, type LiveRun } from "../lib/live/model";
import { createDemoRun } from "./fixtures/simulator";
import { tdm103Report } from "./fixtures/tdm103-report";

// TDM-200/201: the live page shows one phase at a time as the hero, finished phases as "✓"
// lines, the next phase as a hint, and a hero per phase. Fed by the simulator's tandem profile
// (the real curated run's shape and wording). Counts only, never a speed or quality number.

const demo = createDemoRun({ profile: "tandem" });
const T0 = Date.parse(demo.snapshot.run.created_at);

function at(state: RunState, extraMs = 0): { live: LiveRun; nowMs: number } {
  const i = demo.timeline.findIndex(
    (e) => e.event.type === "run.state_changed" && e.event.payload.to === state,
  );
  const until = demo.timeline[i]!.atMs + extraMs;
  const live = applyEvents(
    initLive(demo.snapshot),
    demo.timeline.filter((e) => e.atMs <= until).map((e) => e.event),
  );
  return { live, nowMs: T0 + Math.round(demo.timeline[i]!.atMs) + extraMs };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: string[] = [];
function client() {
  return createWebApiClient("https://api.test", {
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`);
      if (path.endsWith("/report")) return json(200, { report: tdm103Report() });
      if (path.endsWith("/go"))
        return json(402, {
          reason: "no_payment_method",
          link_card_url: "https://anybench.test/billing",
        });
      return json(404, { error: { code: "not_found", message: "nope" } });
    },
  });
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function show(live: LiveRun, nowMs: number, status: "live" | "ended" = "live") {
  await act(async () => {
    render(
      <LiveApiContext.Provider value={client()}>
        <LiveRunView live={live} status={status} clockMs={nowMs} />
      </LiveApiContext.Provider>,
    );
  });
  return screen.getByTestId("phase-hero");
}

describe("phase stage (TDM-200)", () => {
  it("shows only the current phase as the hero, with its own clock and a next hint", async () => {
    const { live, nowMs } = at("understand", 1_500);
    const hero = await show(live, nowMs);
    expect(within(hero).getByRole("heading", { level: 2 }).textContent).toBe("Understand");
    expect(within(hero).getByText("§ 02")).toBeTruthy();
    expect(screen.getByTestId("phase-clock").textContent).toBe("0:01");
    const rail = screen.getByTestId("phase-rail");
    expect(rail.querySelector('[aria-current="step"]')?.textContent).toContain("Understand");
    expect(rail.querySelector('li[data-state="todo"]')?.textContent).toContain("03Research");
    // The old stage rail and the 0/0 counter grid are gone from the top of the page.
    expect(screen.queryByRole("list", { name: "Run stages" })).toBeNull();
    expect(hero.textContent).not.toMatch(/0\/0/);
  });

  it("the rail: finished phases as ✓ lines with duration and summary, then now, then later", async () => {
    const { live, nowMs } = at("proof", 500);
    await show(live, nowMs);
    const rail = screen.getByRole("list", { name: "Run phases" });
    // Finished and current phases are buttons (click to look back); every phase is a row.
    expect(rail.querySelectorAll("li")).toHaveLength(11);
    const rows = [...rail.querySelectorAll('li[data-state="done"]')];
    expect(rows.map((r) => r.querySelector("span:nth-child(3)")?.textContent)).toEqual([
      "Intake",
      "Understand",
      "Research",
      "Kit",
      "Computers",
    ]);
    expect(rows[3]!.textContent).toContain("head-to-head profile: 36 trials");
    expect(rows[4]!.textContent).toContain("2 of 2 images ready, 1 capacity retry");
  });

  it("agent phases stream the phase's own lines; with none yet, it says who it waits on", async () => {
    let { live, nowMs } = at("kit_draft", 100);
    let hero = await show(live, nowMs);
    expect(within(hero).getByTestId("phase-waiting").textContent).toContain("the kit designer");
    cleanup();
    ({ live, nowMs } = at("kit_draft", 2_500));
    hero = await show(live, nowMs);
    const lines = within(hero).getByTestId("phase-lines");
    expect(lines.textContent).toContain("using the curated Tandem kit (tandem)");
    expect(lines.textContent).toContain("head-to-head profile: 36 trials");
    expect(lines.textContent).not.toContain("trial image");
  });

  it("env_build: two image tracks with step ticks and the capacity retry", async () => {
    const { live, nowMs } = at("env_build", 3_000);
    const hero = await show(live, nowMs);
    const trial = within(hero).getByTestId("env-trial");
    const scoring = within(hero).getByTestId("env-scoring");
    expect(trial.textContent).toContain("booted a Naïve computer");
    expect(trial.querySelectorAll('li[data-state="done"]')).toHaveLength(1);
    expect(trial.querySelector('li[data-state="now"]')?.textContent).toBe("toolchain");
    expect(scoring.getAttribute("data-retrying")).toBe("true");
    expect(within(scoring).getByRole("status").textContent).toContain("Naïve is at capacity");
  });

  it("proof: the proof line", async () => {
    const { live, nowMs } = at("proof", 2_000);
    const hero = await show(live, nowMs);
    expect(hero.textContent).toContain("proof: curated (verified offline at bebb77e)");
  });

  it("awaiting_go: the plan, big, and a Go that goes through the billing gate", async () => {
    const { live, nowMs } = at("awaiting_go", 1_000);
    const hero = await show(live, nowMs);
    const text = hero.textContent!;
    expect(text).toContain("36");
    expect(text).toContain("Claude Code solo vs Tandem ×3");
    expect(text).toContain("todo-api · auth-refactor · bug-hunt");
    expect(text).toContain("$11.00");
    await act(async () => {
      fireEvent.click(within(hero).getByTestId("go-button"));
    });
    expect(calls).toContain(`POST /runs/${live.runId}/go`);
    expect(hero.textContent).toContain("Add a card to start this run");
  });

  it("scoring and analyzing: their own heroes", async () => {
    let { live, nowMs } = at("scoring", 500);
    let hero = await show(live, nowMs);
    expect(within(hero).getByRole("heading", { level: 2 }).textContent).toBe("Scoring");
    cleanup();
    ({ live, nowMs } = at("analyzing", 2_000));
    hero = await show(live, nowMs);
    expect(within(hero).getByRole("heading", { level: 2 }).textContent).toBe("Analyzing");
    expect(hero.textContent).toContain("summary (no LLM)");
  });

  it("delivered: the Results panel is the hero", async () => {
    const live = applyEvents(
      initLive(demo.snapshot),
      demo.timeline.map((e) => e.event),
    );
    const hero = await show(live, T0 + demo.durationMs, "ended");
    expect(within(hero).getAllByRole("heading", { level: 2 })[0]!.textContent).toBe("Delivered");
    expect(await within(hero).findByTestId("results")).toBeTruthy();
    // Sharing on a delivered run goes through the publish SharePanel.
    expect(await within(hero).findByTestId("share-panel")).toBeTruthy();
    expect(screen.getByTestId("phase-rail").querySelectorAll('li[data-state="done"]')).toHaveLength(
      11,
    );
  });

  it.each([
    ["needs_human", "Needs you"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ] as const)("%s: the reason, prominent, and where it stopped", async (to, word) => {
    const { live, nowMs } = at("env_build", 4_000);
    const ev = {
      type: "run.state_changed",
      source: "run",
      source_id: live.runId,
      severity: "warn",
      actor: { kind: "system" },
      cost_delta_micro_usd: 0n,
      run_id: live.runId,
      seq: live.lastSeq + 1,
      at: new Date(nowMs).toISOString(),
      payload: { from: live.state, to, reason: `because ${to}` },
    } as AnybenchEvent;
    const hero = await show(applyEvent(live, ev), nowMs + 30_000);
    expect(within(hero).getByRole("heading", { level: 2 }).textContent).toBe(word);
    expect(within(hero).getByTestId("phase-hold").textContent).toContain(`because ${to}`);
    expect(hero.textContent).toContain("Stopped at 05 Computers.");
    // The clock stopped when the run did.
    expect(screen.getByTestId("phase-clock").textContent).toBe("0:04");
  });
});

describe("running hero (TDM-201)", () => {
  it("shows at most 5 live trial cards with setup, task, timer and stage; queued is one number", async () => {
    const { live, nowMs } = at("running", 40_000);
    const hero = await show(live, nowMs);
    const cards = within(hero).getAllByTestId("trial-card");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(5);
    for (const c of cards) {
      expect(c.textContent).toMatch(/Claude Code solo|Tandem ×3/);
      expect(c.textContent).toMatch(/todo-api|auth-refactor|bug-hunt/);
      expect(within(c).getByTestId("trial-clock").textContent).toMatch(/^\d+:\d\d$/);
      expect(c.querySelector('[data-now="true"]')).not.toBeNull();
    }
    const c = countTrials(live);
    expect(within(hero).getByTestId("queued-count").textContent).toBe(String(c.queued));
  });

  it("counts only: no speed or quality number, no ranking", async () => {
    const { live, nowMs } = at("running", 80_000);
    const hero = await show(live, nowMs);
    expect(hero.textContent).not.toMatch(/faster|slower|median|p=|score|rank|%/i);
  });

  it("the pipeline: every trial is a block at the station its real state puts it", async () => {
    const { live, nowMs } = at("running", 80_000);
    await show(live, nowMs);
    const fig = screen.getByTestId("phase-figure");
    const blocks = [...fig.querySelectorAll('[data-testid="trial-token"]')];
    expect(blocks).toHaveLength(36);
    const c = countTrials(live);
    const where = (at: string) => blocks.filter((b) => b.getAttribute("data-at") === at);
    expect(where("queue")).toHaveLength(c.queued);
    expect(where("bin").filter((b) => b.getAttribute("data-tone") === "pass")).toHaveLength(
      c.passed,
    );
    expect(where("bin").filter((b) => b.getAttribute("data-tone") === "fail")).toHaveLength(
      c.failed,
    );
    expect(where("bay").length + where("grader").length).toBe(c.running);
    expect(where("bay").length).toBeLessThanOrEqual(5);
    // The pillars, named: a sealed wall, a grader on its own computer, named VMs.
    expect(fig.textContent).toContain("SEALED");
    expect(fig.textContent).toContain("the agent never sees the hidden tests");
    expect(fig.textContent).toContain("GRADER · SEPARATE COMPUTER");
    // Each computer carries its bay number; the matching card names its VM.
    expect(fig.textContent).toMatch(/12345/);
    expect(
      screen.getAllByTestId("trial-card").some((c) => /VM [0-9a-f]{6}/.test(c.textContent ?? "")),
    ).toBe(true);
  });

  it("clicking a computer opens the inspector for what it is running", async () => {
    const { live, nowMs } = at("running", 80_000);
    await show(live, nowMs);
    const block = screen
      .getByTestId("phase-figure")
      .querySelector('[data-testid="trial-token"][data-at="bay"]')!;
    await act(async () => {
      fireEvent.click(block, { clientX: 100, clientY: 100 });
    });
    const insp = screen.getByTestId("inspector");
    expect(insp.textContent).toMatch(/VM [0-9a-f]{6}|VM starting/);
    expect(insp.textContent).toMatch(/Claude Code solo|Tandem ×3/);
    expect(insp.textContent).toContain("Full trial details");
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("inspector")).toBeNull();
  });
});

describe("monitor layout", () => {
  it("rail, hero and the details pane (log, trials, agents) are all on one screen", async () => {
    const { live, nowMs } = at("env_build", 3_000);
    await show(live, nowMs);
    expect(screen.getByTestId("phase-rail")).toBeTruthy();
    expect(screen.getByTestId("phase-hero")).toBeTruthy();
    const side = screen.getByRole("complementary", { name: "Run details" });
    expect(within(side).getByRole("region", { name: "Trials" })).toBeTruthy();
    expect(within(side).getByRole("region", { name: "Agents" })).toBeTruthy();
    expect(within(side).getByText("Activity")).toBeTruthy();
  });
});

describe("run settings menu", () => {
  it("cancel lives behind ⋯ with a confirm, not as a bar on the page", async () => {
    const { live, nowMs } = at("running", 10_000);
    await show(live, nowMs);
    expect(screen.queryByText("Want to stop this run?")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run settings" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Cancel run…" }));
    });
    expect(screen.getByText(/Cancel this run\?/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, cancel" }));
    });
    expect(calls).toContain(`POST /runs/${live.runId}/cancel`);
  });
});

describe("looking back at a finished phase", () => {
  it("clicking a done phase in the rail shows it; Back to live (or the current phase) resumes", async () => {
    const { live, nowMs } = at("running", 20_000);
    await show(live, nowMs);
    const rail = screen.getByTestId("phase-rail");
    const kit = [...rail.querySelectorAll("li")].find((l) => l.textContent?.includes("Kit"))!;
    await act(async () => {
      fireEvent.click(kit);
    });
    let hero = screen.getByTestId("phase-hero");
    expect(within(hero).getAllByRole("heading", { level: 2 })[0]!.textContent).toBe("Kit");
    expect(hero.textContent).toContain("looking back");
    expect(screen.getByTestId("phase-clock").textContent).toBe("0:03");
    await act(async () => {
      fireEvent.click(within(hero).getByRole("button", { name: /Back to live/ }));
    });
    hero = screen.getByTestId("phase-hero");
    expect(within(hero).getAllByRole("heading", { level: 2 })[0]!.textContent).toBe("Running");
    // The current phase in the rail also returns to live.
    const go = [...rail.querySelectorAll("li")].find((l) => l.textContent?.includes("Go"))!;
    await act(async () => {
      fireEvent.click(go);
    });
    const running = [...screen.getByTestId("phase-rail").querySelectorAll("li")].find(
      (l) => l.getAttribute("aria-current") === "step",
    )!;
    await act(async () => {
      fireEvent.click(running);
    });
    expect(
      within(screen.getByTestId("phase-hero")).getAllByRole("heading", { level: 2 })[0]!
        .textContent,
    ).toBe("Running");
  });
});
