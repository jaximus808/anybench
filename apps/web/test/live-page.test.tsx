import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunPage from "../app/runs/[id]/page";
import { LiveRunView } from "../components/live/LiveRunPage";
import { applyEvents, initLive } from "../lib/live/model";
import { createDemoRun } from "./fixtures/simulator";

// The page for a loaded run, fed a test-only simulated run (test/fixtures/simulator.ts) folded
// to 42% of the way through, so the first render already has trials, agents and events.
// The site itself never shows a simulated run.
const sim = createDemoRun();
const live = applyEvents(
  initLive(sim.snapshot),
  sim.timeline.filter((e) => e.atMs <= sim.durationMs * 0.42).map((e) => e.event),
);

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  // Drawers fetch trial detail and logs; no network in tests.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  window.history.replaceState(null, "", `/runs/${live.runId}`);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderRun() {
  await act(async () => {
    render(<LiveRunView live={live} status="live" />);
  });
}

describe("live run page", () => {
  it("shows the phase the run is in now as the hero, finished phases as ✓ lines", async () => {
    await renderRun();
    const hero = screen.getByTestId("phase-hero");
    expect(within(hero).getAllByRole("heading", { level: 2 })[0]!.textContent).toBe("Running");
    const rail = screen.getByRole("list", { name: "Run phases" });
    expect(rail.querySelectorAll('li[data-state="done"]')).toHaveLength(7);
    expect(rail.querySelector('[aria-current="step"]')?.textContent).toContain("Running");
    expect(screen.queryByRole("list", { name: "Run stages" })).toBeNull();
  });

  it("renders one button per trial in the matrix (4 setups × 3 tasks × 5 runs)", async () => {
    await renderRun();
    const trials = screen.getByRole("region", { name: "Trials" });
    const cells = trials.querySelectorAll("button[data-key]");
    expect(cells).toHaveLength(60);
    expect(cells[0]!.getAttribute("aria-label")).toMatch(/^claude code solo · todo-api #1: /);
  });

  it("lists every agent session by role", async () => {
    await renderRun();
    const agents = screen.getByRole("region", { name: "Agents" });
    for (const role of ["understander", "researcher", "kit designer", "reviewer"])
      expect(within(agents).getByText(role)).toBeTruthy();
  });

  it("filters the activity feed by text", async () => {
    await renderRun();
    const feed = screen.getByRole("region", { name: "Activity" });
    const rows = () => feed.querySelectorAll("li[data-seq]");
    const before = rows().length;
    expect(before).toBeGreaterThan(10);
    fireEvent.change(within(feed).getByRole("searchbox", { name: "Filter activity" }), {
      target: { value: "gate" },
    });
    const after = rows();
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(before);
    for (const r of after) expect(r.textContent?.toLowerCase()).toContain("gate");
  });

  it("opens a finished trial in a drawer with its gate result, deep-linked in the URL", async () => {
    await renderRun();
    const trials = screen.getByRole("region", { name: "Trials" });
    const done = [...trials.querySelectorAll<HTMLButtonElement>("button[data-key]")].find((b) =>
      /: (passed gate|failed)$/.test(b.getAttribute("aria-label") ?? ""),
    );
    expect(done).toBeTruthy();
    fireEvent.click(done!);
    const name = done!.getAttribute("aria-label")!.split(": ")[0]!;
    const drawer = screen.getByRole("dialog", { name });
    const gate = within(drawer).getByRole("region", { name: "Correctness gate" });
    expect(gate.getAttribute("data-pass")).toMatch(/^(true|false)$/);
    expect(gate.textContent).toMatch(/(Passed|Failed) tests-pass/);
    expect(window.location.search).toMatch(/^\?trial=/);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name })).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("searches trials, agents and events from the palette", async () => {
    await renderRun();
    fireEvent.keyDown(window, { key: "/" });
    const palette = screen.getByRole("dialog", { name: "Search this run" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "researcher" } });
    const hits = within(palette).getAllByRole("option");
    expect(hits[0]!.textContent).toContain("researcher");
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "researcher" })).toBeTruthy();
  });

  it("shows counts only: no speed or quality number before the report", async () => {
    await renderRun();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/% faster|faster than|points above|score:/i);
  });

  it("404s an id that isn't a run id, including the old /runs/demo", async () => {
    await expect(RunPage({ params: Promise.resolve({ id: "demo" }) })).rejects.toThrow();
  });
});
