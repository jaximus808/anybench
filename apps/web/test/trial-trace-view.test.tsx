// Trace view and "where the time went", rendered from the real traces of run 01a1bae4 (as the
// backfill stored them): the failed Tandem trial and the run summary.
import { readFileSync } from "node:fs";
import path from "node:path";
import { RunTraceSummarySchema, TrialTraceSchema } from "@anybench/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TimeBreakdown } from "../components/trace/TimeBreakdown";
import { TraceView } from "../components/trace/TraceView";
import { differenceSentence, setupRows, traceSentences } from "../components/trace/model";

afterEach(cleanup);

const load = (name: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), "test/fixtures/trace", name), "utf8"));
const trace = () => TrialTraceSchema.parse(load("tandem-todo-api-failed.trace.json"));
const summary = () => RunTraceSummarySchema.parse(load("run-01a1bae4.summary.json"));

describe("trace view", () => {
  it("leads with where the wall time went and what the sessions did", () => {
    const lead = traceSentences(trace());
    expect(lead[0]).toMatch(/^4m 12s from start to finish\. A model call was in flight for 94%/);
    expect(lead[1]).toMatch(/4 sessions made 52 model turns\. 71% of their model time/);
    expect(lead[1]).toMatch(/5 claims were lost/);
    expect(lead[2]).toMatch(/Workers started 39s in, after the planner's 36s of planning/);
  });

  it("draws a lane per session and explains the failure", () => {
    render(<TraceView trace={trace()} />);
    const why = screen.getByTestId("trace-why");
    expect(
      within(why).getByText("the data file stores a password hash, never the password"),
    ).toBeTruthy();
    expect(within(why).getByText(/ENOENT/)).toBeTruthy();
    expect(within(why).getAllByText(/15\/16/).length).toBeGreaterThan(0);
    // Every step is a focusable block with a label naming its session.
    for (const lane of ["planner", "worker-1", "worker-2", "worker-3"]) {
      expect(
        screen.getAllByRole("button", { name: new RegExp(`^${lane}: `) }).length,
      ).toBeGreaterThan(3);
    }
    // Picking a related step pins its details.
    fireEvent.click(within(why).getAllByRole("button")[0]!);
    expect(
      within(screen.getByTestId("trace-selected")).getAllByText(/src\/store\.ts/).length,
    ).toBeGreaterThan(0);
  });

  it("hover shows the step's details", () => {
    render(<TraceView trace={trace()} />);
    const wait = screen.getAllByRole("button", {
      name: /^worker-2: Waiting on the board queue_wait/,
    })[0]!;
    fireEvent.mouseEnter(wait);
    expect(
      within(screen.getByTestId("trace-tip")).getByText(/Waiting on the board: queue_wait/),
    ).toBeTruthy();
  });
});

describe("where the time went", () => {
  const names = {
    "27e77fea-3fb1-497d-8c1b-8f2306cfa7ac": "claude-code-solo",
    "af031210-9606-493d-8567-54c54bf690b2": "tandem",
  };

  it("states the difference bucket by bucket, with n", () => {
    const s = differenceSentence(setupRows(summary(), names))!;
    expect(s).toMatch(
      /^tandem took 3\.3× as long per trial as claude-code-solo \(3m 57s vs 1m 11s, n=18 and n=18\)/,
    );
    expect(s).toMatch(/model calls in flight/);
  });

  it("renders a bar per setup with its n", () => {
    render(<TimeBreakdown summary={summary()} names={names} />);
    const box = screen.getByTestId("time-breakdown");
    expect(within(box).getAllByText(/n=18, 17 passed/).length).toBe(1);
    expect(within(box).getAllByText(/n=18, 16 passed/).length).toBe(1);
    expect(within(box).getByText("todo-api")).toBeTruthy();
  });
});
