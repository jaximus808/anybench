// TDM-242: the run page's budget copy and the live model's `run.budget` event.
import { AnybenchEventSchema } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { budgetCopy } from "../components/live/budget-copy";
import { applyEvents, initLive } from "../lib/live/model";
import { createDemoRun } from "./fixtures/simulator";

describe("budget copy (TDM-242)", () => {
  it("says what a $20 budget limits, what is held for running trials, and keeps BYOK apart", () => {
    const copy = budgetCopy({
      spentMicroUsd: 3_100_000n,
      committedMicroUsd: 1_400_000n,
      limitMicroUsd: 20_000_000n,
      budgetBasis: "billed",
      byokTokenMicroUsd: 850_000n,
    });
    expect(copy.line).toBe("$3.10 spent · $1.40 held for running trials · of your $20 budget");
    expect(copy.note).toBe(
      "Your budget is the most Anybench will charge for this run: the run fee, computer time and any model tokens we provide. A trial starts only if its worst case still fits; when the next one can't, the run pauses and asks you.",
    );
    expect(copy.byok).toBe(
      "$0.85 so far on your own API key (billed by your provider, not counted in the budget)",
    );
  });

  it("a free run is limited by the computer time we cover", () => {
    const copy = budgetCopy({
      spentMicroUsd: 55_200n,
      committedMicroUsd: 0n,
      limitMicroUsd: 10_000_000n,
      budgetBasis: "free_run",
      byokTokenMicroUsd: 0n,
    });
    expect(copy.line).toBe("$0.06 spent · of the $10 of computer time your free run covers");
    expect(copy.note).toMatch(/^Free run: we pay for the computers, up to the cap\./);
    expect(copy.byok).toBeNull();
  });

  it("run.budget sets the absolute numbers and stays out of the feed", () => {
    const demo = createDemoRun();
    const live = initLive(demo.snapshot);
    const ev = AnybenchEventSchema.parse({
      run_id: live.runId,
      seq: live.lastSeq + 1,
      type: "run.budget",
      source: "run",
      source_id: live.runId,
      severity: "debug",
      actor: { kind: "worker", id: "w" },
      cost_delta_micro_usd: "2082800",
      at: "2026-11-09T12:00:00.000Z",
      payload: {
        basis: "billed",
        limit_micro_usd: "20000000",
        spent_micro_usd: "2082800",
        committed_micro_usd: "372600",
        byok_token_micro_usd: "50000",
      },
    });
    const next = applyEvents(live, [ev]);
    expect(next).toMatchObject({
      spentMicroUsd: 2_082_800n,
      committedMicroUsd: 372_600n,
      limitMicroUsd: 20_000_000n,
      budgetBasis: "billed",
      byokTokenMicroUsd: 50_000n,
    });
    expect(next.feed.length).toBe(live.feed.length);
  });
});
