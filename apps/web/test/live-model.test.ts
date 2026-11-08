import { AnybenchEventSchema, encodeAnybenchEvent } from "@anybench/core";
import { describe, expect, it } from "vitest";
import {
  applyEvents,
  countTrials,
  filterFeed,
  initLive,
  searchRun,
  stageIndex,
  tallyByContender,
} from "../lib/live/model";
import { createDemoRun } from "./fixtures/simulator";

describe("demo run simulator", () => {
  const demo = createDemoRun();

  it("emits only events the API contract accepts, with legal transitions and rising seqs", () => {
    expect(demo.timeline.length).toBeGreaterThan(300);
    let prev = 0;
    for (const { event } of demo.timeline) {
      const parsed = AnybenchEventSchema.safeParse(encodeAnybenchEvent(event));
      expect(parsed.success, `${event.seq} ${event.type}: ${parsed.error?.message}`).toBe(true);
      expect(event.seq).toBe(prev + 1);
      prev = event.seq;
    }
  });

  it("is deterministic", () => {
    const again = createDemoRun();
    expect(again.timeline.map((e) => e.event.type)).toEqual(demo.timeline.map((e) => e.event.type));
  });

  it("plays to delivered with every trial final and spend under the budget", () => {
    const live = applyEvents(
      initLive(demo.snapshot),
      demo.timeline.map((e) => e.event),
    );
    expect(live.state).toBe("delivered");
    const c = countTrials(live);
    expect(c.total).toBe(60);
    expect(c.running + c.queued).toBe(0);
    expect(c.passed + c.failed).toBe(60);
    expect(live.spentMicroUsd).toBeGreaterThan(0n);
    expect(live.spentMicroUsd).toBeLessThan(live.budgetMicroUsd);
    expect(live.alerts.every((a) => a.status === "acked")).toBe(true);
    expect(stageIndex(live.state, live.stateHistory)).toBe(10);
  });
});

describe("live model", () => {
  const demo = createDemoRun();
  const half = demo.timeline.filter((e) => e.atMs < demo.durationMs * 0.45).map((e) => e.event);
  const live = applyEvents(initLive(demo.snapshot), half);

  it("ignores replayed events (Last-Event-ID overlap)", () => {
    const again = applyEvents(live, half.slice(-50));
    expect(again).toBe(live);
  });

  it("counts gate passes per contender, never a speed number", () => {
    const tally = tallyByContender(live);
    expect(tally).toHaveLength(4);
    for (const t of tally) {
      expect(t.total).toBe(15);
      expect(Object.keys(t).sort()).toEqual(
        ["contender", "failed", "finished", "passed", "running", "total"].sort(),
      );
    }
  });

  it("tracks agents from their events and keeps their spend", () => {
    const roles = live.agentOrder.map((id) => live.agents[id]!.role);
    expect(roles).toContain("understander");
    const u = Object.values(live.agents).find((a) => a.role === "understander")!;
    expect(u.toolCalls).toBeGreaterThan(0);
    expect(u.costMicroUsd).toBeGreaterThan(0n);
  });

  it("filters the feed and searches trials, agents and events", () => {
    const gates = filterFeed(live.feed, { query: "gate", sources: ["trial"], minSeverity: "info" });
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((f) => f.source === "trial")).toBe(true);
    const warn = filterFeed(live.feed, { query: "", sources: [], minSeverity: "warn" });
    expect(warn.every((f) => ["warn", "error", "critical"].includes(f.severity))).toBe(true);
    const hits = searchRun(live, "tandem ×5");
    expect(hits.some((h) => h.kind === "trial")).toBe(true);
    expect(searchRun(live, "researcher").some((h) => h.kind === "agent")).toBe(true);
  });
});
