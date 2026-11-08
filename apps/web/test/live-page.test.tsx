import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRunPage } from "../components/live/LiveRunPage";

// The demo run starts part-way through (startAt), so the first render already has trials,
// agents and events; nothing here waits on the playback clock.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  window.history.replaceState(null, "", "/runs/demo");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderDemo() {
  await act(async () => {
    render(<LiveRunPage runId="demo" />);
  });
}

describe("live run page (demo)", () => {
  it("labels the demo as simulated and shows the stage rail", async () => {
    await renderDemo();
    expect(screen.getByText("Simulated run · demo")).toBeTruthy();
    const stages = screen.getByRole("list", { name: "Run stages" });
    expect(within(stages).getAllByRole("listitem")).toHaveLength(11);
    expect(within(stages).getByText("Running").closest("li")?.getAttribute("aria-current")).toBe(
      "step",
    );
  });

  it("renders one button per trial in the matrix (4 setups × 3 tasks × 5 runs)", async () => {
    await renderDemo();
    const trials = screen.getByRole("region", { name: "Trials" });
    const cells = trials.querySelectorAll("button[data-key]");
    expect(cells).toHaveLength(60);
    expect(cells[0]!.getAttribute("aria-label")).toMatch(/^claude code solo · todo-api #1: /);
  });

  it("lists every agent session by role", async () => {
    await renderDemo();
    const agents = screen.getByRole("region", { name: "Agents" });
    for (const role of ["understander", "researcher", "kit designer", "reviewer"])
      expect(within(agents).getByText(role)).toBeTruthy();
  });

  it("filters the activity feed by text", async () => {
    await renderDemo();
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
    await renderDemo();
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
    await renderDemo();
    fireEvent.keyDown(window, { key: "/" });
    const palette = screen.getByRole("dialog", { name: "Search this run" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "researcher" } });
    const hits = within(palette).getAllByRole("option");
    expect(hits[0]!.textContent).toContain("researcher");
    fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "researcher" })).toBeTruthy();
  });

  it("shows counts only: no speed or quality number before the report", async () => {
    await renderDemo();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/% faster|faster than|points above|score:/i);
  });
});
