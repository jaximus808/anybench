import type { AnybenchEvent, RunState } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { applyEvent, applyEvents, initLive, seedHistory, type LiveRun } from "../lib/live/model";
import {
  classifyEnvLine,
  envBuildSteps,
  phaseLog,
  phaseView,
  runningView,
} from "../lib/live/phase";
import { createDemoRun } from "./fixtures/simulator";

// TDM-199: the "one phase at a time" selectors, driven by the simulator's tandem profile (the
// real curated run's shape and wording).

const demo = createDemoRun({ profile: "tandem" });
const events = demo.timeline.map((e) => e.event);
const T0 = Date.parse(demo.snapshot.run.created_at);

/** The run just after it entered `state`, plus `extraMs` of its events. */
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

const runEvent = (live: LiveRun, to: RunState, reason: string, atMs: number): AnybenchEvent =>
  ({
    type: "run.state_changed",
    source: "run",
    source_id: live.runId,
    severity: "warn",
    actor: { kind: "system" },
    cost_delta_micro_usd: 0n,
    run_id: live.runId,
    seq: live.lastSeq + 1,
    at: new Date(atMs).toISOString(),
    payload: { from: live.state, to, reason },
  }) as AnybenchEvent;

describe("phaseView (TDM-199)", () => {
  it("starts at intake with a live clock and hints the next phase", () => {
    const live = initLive(demo.snapshot);
    const v = phaseView(live, T0 + 400);
    expect(v.current).toMatchObject({ state: "intake", n: 1, startedAt: T0, elapsedMs: 400 });
    expect(v.done).toEqual([]);
    expect(v.next?.state).toBe("understand");
    expect(v.hold).toBeNull();
  });

  it("walks every phase: current, done lines with durations, and one-line summaries", () => {
    const order: RunState[] = [
      "understand",
      "research",
      "kit_draft",
      "env_build",
      "proof",
      "awaiting_go",
      "running",
      "scoring",
      "analyzing",
    ];
    for (const [i, s] of order.entries()) {
      const { live, nowMs } = at(s, 500);
      const v = phaseView(live, nowMs);
      expect(v.current.state).toBe(s);
      expect(v.current.elapsedMs).toBe(500);
      expect(v.done.map((d) => d.state)).toEqual(["intake", ...order.slice(0, i)]);
      for (const d of v.done) expect(d.durationMs).toBeGreaterThanOrEqual(0);
    }
    const { live, nowMs } = at("analyzing", 0);
    const done = Object.fromEntries(phaseView(live, nowMs).done.map((d) => [d.state, d.summary]));
    expect(done.understand).toBe("using the curated Tandem kit");
    expect(done.kit_draft).toBe("head-to-head profile: 36 trials");
    expect(done.env_build).toBe("2 of 2 images ready, 1 capacity retry");
    expect(done.proof).toMatch(/^proof: curated/);
    expect(done.running).toMatch(/^36 trials: \d+ passed, \d+ failed/);
  });

  it("delivered: every phase is done and nothing is next", () => {
    const live = applyEvents(initLive(demo.snapshot), events);
    const v = phaseView(live, T0 + demo.durationMs + 5_000);
    expect(v.delivered).toBe(true);
    expect(v.current.state).toBe("delivered");
    expect(v.done).toHaveLength(11);
    expect(v.next).toBeNull();
  });

  it.each([
    ["needs_human", "the curated Tandem kit failed its proof (oracle-passes)"],
    ["failed", "Naïve never gave us a computer"],
    ["cancelled", "cancelled by you"],
  ] as const)("holds on %s with the reason, and the phase clock stops", (to, reason) => {
    const { live, nowMs } = at("env_build", 4_000);
    const held = applyEvent(live, runEvent(live, to, reason, nowMs));
    const v = phaseView(held, nowMs + 60_000);
    expect(v.hold).toEqual({ state: to, reason, at: nowMs });
    expect(v.current.state).toBe("env_build");
    expect(v.current.elapsedMs).toBe(4_000);
    expect(v.next).toBeNull();
  });

  it("opened mid-run without history: the phase start is unknown, not the run start", () => {
    const { live } = at("running", 5_000);
    const fresh = initLive({
      ...demo.snapshot,
      run: { ...demo.snapshot.run, state: "running" },
      lastSeq: live.lastSeq,
    });
    expect(phaseView(fresh, T0 + 999_999).current).toMatchObject({
      state: "running",
      startedAt: null,
      elapsedMs: null,
    });
    // With history (events.list), the real start comes back.
    const seeded = seedHistory(
      fresh,
      events.filter((e) => e.seq <= live.lastSeq),
    );
    const start = at("running", 0).nowMs;
    expect(phaseView(seeded, start + 10).current.startedAt).toBe(start);
  });
});

describe("phaseLog", () => {
  it("returns the phase's own agent lines in order", () => {
    const { live } = at("proof", 2_000);
    expect(phaseLog(live, "kit_draft").map((l) => l.text)[0]).toBe(
      "using the curated Tandem kit (tandem)",
    );
    expect(phaseLog(live, "proof")).toHaveLength(1);
    expect(phaseLog(live, "running")).toEqual([]);
  });
});

describe("envBuildSteps", () => {
  it("classifies the server's lines, including retries and unknown lines", () => {
    expect(classifyEnvLine("booted a Naïve computer").key).toBe("boot");
    expect(classifyEnvLine("Naïve is at capacity; retrying").key).toBe("retry");
    expect(classifyEnvLine("installed the base toolchain").key).toBe("toolchain");
    expect(classifyEnvLine("installed the Anybench runner").key).toBe("runner");
    expect(classifyEnvLine("staged the kit files").key).toBe("kit");
    expect(classifyEnvLine("installed tandem").key).toBe("install");
    expect(classifyEnvLine("snapshot saved; every trial forks from it").key).toBe("snapshot");
    expect(classifyEnvLine("already built for this kit; reusing the snapshot").key).toBe("cached");
    expect(classifyEnvLine("warming the npm cache").key).toBe("other");
  });

  it("tracks both images: steps, retrying now, pending hints, done", () => {
    // 3 s in: trial image booted; scoring image is waiting on Naïve capacity.
    let imgs = envBuildSteps(at("env_build", 3_000).live);
    expect(imgs.map((i) => i.image)).toEqual(["trial", "scoring"]);
    expect(imgs[0]!.steps.map((s) => s.key)).toEqual(["boot"]);
    expect(imgs[0]!.pending).toEqual(["toolchain", "runner", "kit", "install", "snapshot"]);
    expect(imgs[1]).toMatchObject({ retrying: true, retries: 1, steps: [], done: false });

    // 10 s in: the scoring image got its computer.
    imgs = envBuildSteps(at("env_build", 10_000).live);
    expect(imgs[1]).toMatchObject({ retrying: false, retries: 1 });
    expect(imgs[1]!.steps.map((s) => s.key)).toEqual(["boot"]);

    // Done: both snapshots saved, nothing pending.
    imgs = envBuildSteps(at("proof").live);
    expect(imgs.every((i) => i.done && i.pending.length === 0)).toBe(true);
    expect(imgs[0]!.steps.map((s) => s.label)).toContain("installed tandem");
  });

  it("before any env_builder line: just the trial image, everything pending", () => {
    const imgs = envBuildSteps(at("env_build", 0).live);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.steps).toEqual([]);
  });

  it("an unprefixed line belongs to the trial image; a cache hit is done", () => {
    const { live, nowMs } = at("env_build", 0);
    const ev = {
      type: "agent.message",
      source: "agent_session",
      source_id: "env_build:env_builder",
      severity: "info",
      actor: { kind: "system" },
      cost_delta_micro_usd: 0n,
      run_id: live.runId,
      seq: live.lastSeq + 1,
      at: new Date(nowMs).toISOString(),
      payload: {
        agent_role: "env_builder",
        naive_seq: 0,
        message_role: "system",
        text: "trial image: already built for this kit; reusing the snapshot",
        truncated: false,
      },
    } as AnybenchEvent;
    const [trial] = envBuildSteps(applyEvent(live, ev));
    expect(trial).toMatchObject({ done: true, pending: [] });
    expect(trial!.steps[0]!.key).toBe("cached");
  });
});

describe("runningView", () => {
  it("shows at most 5 live trials with stage, timers and spend; the rest are counts", () => {
    const { live, nowMs } = at("running", 20_000);
    const v = runningView(live, nowMs);
    expect(v.live.length).toBeGreaterThan(0);
    expect(v.live.length).toBeLessThanOrEqual(5);
    expect(v.counts.total).toBe(36);
    expect(v.counts.queued + v.counts.running + v.counts.done + v.counts.infra).toBe(36);
    for (const c of v.live) {
      expect(["booting", "running", "grading"]).toContain(c.stage);
      expect(["Claude Code solo", "Tandem ×3"]).toContain(c.setup);
      expect(c.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    // A trial in its work phase has heartbeats.
    const later = at("running", 40_000);
    const running = runningView(later.live, later.nowMs).live.filter((c) => c.stage === "running");
    expect(running.some((c) => c.heartbeatAgeMs !== null && c.heartbeatAgeMs < 5_000)).toBe(true);
  });

  it("respects the cap and reports the overflow", () => {
    const { live, nowMs } = at("running", 20_000);
    const v = runningView(live, nowMs, { cap: 2 });
    expect(v.live).toHaveLength(2);
    expect(v.more).toBe(runningView(live, nowMs).live.length - 2);
  });

  it("lists trials that just finished, for the resolve-out flash", () => {
    // Find the first trial end and look 1 s after it.
    const end = demo.timeline.find(
      (e) =>
        e.event.type === "trial.phase" && ["done", "failed_subject"].includes(e.event.payload.to),
    )!;
    const live = applyEvents(
      initLive(demo.snapshot),
      demo.timeline.filter((e) => e.atMs <= end.atMs).map((e) => e.event),
    );
    const v = runningView(live, T0 + end.atMs + 1_000);
    expect(v.justFinished[0]?.id).toBe(end.event.source_id);
    expect(runningView(live, T0 + end.atMs + 10_000).justFinished).toEqual([]);
  });

  it("never carries a speed or quality number", () => {
    const { live, nowMs } = at("running", 60_000);
    const keys = Object.keys(runningView(live, nowMs).live[0] ?? {});
    expect(keys.join(" ")).not.toMatch(/speed|score|quality|rank|wall/i);
  });
});

describe("run row and event→trial (from launch-ux-wip)", () => {
  it("mergeRun picks up the estimate and kit written after the page opened", async () => {
    const { mergeRun } = await import("../lib/live/model");
    const live = initLive({
      ...demo.snapshot,
      run: { ...demo.snapshot.run, estimate_micro_usd: null },
    });
    expect(live.estimateMicroUsd).toBeNull();
    const next = mergeRun(live, { estimate_micro_usd: 9_000_000n, kit_id: "kit-1" });
    expect(next.estimateMicroUsd).toBe(9_000_000n);
    expect(next.kitId).toBe("kit-1");
    expect(mergeRun(next, { estimate_micro_usd: 9_000_000n, kit_id: null })).toBe(next);
  });

  it("feed items name the trial a computer event is about", () => {
    const live = applyEvents(initLive(demo.snapshot), events.slice(0, 400));
    const comp = live.feed.find((f) => f.type === "computer.created");
    expect(comp?.trialId).toBeTruthy();
    expect(live.trials[comp!.trialId!]).toBeDefined();
  });
});
