import {
  AnybenchEventSchema,
  isLegalTrialEdge,
  mulMicro,
  TrialIdSchema,
  type AnybenchEvent,
  type MicroUsd,
} from "@anybench/core";
import { FakeProvider } from "@anybench/providers";
import { describe, expect, it } from "vitest";
import {
  ComputerPool,
  estimatePlanCost,
  expandTrials,
  groupBlocks,
  packCapacity,
  Scheduler,
  SchedulableKitSchema,
  type ConcurrencyCaps,
  type GateDecision,
  type KillSwitchState,
  type SchedulableKitInput,
  type SchedulerResult,
  type TrialPlan,
} from "../src/index.js";

const TDM48_EST: MicroUsd = 250_000n; // $0.25 per trial

/** 2 contenders × 3 workloads × (9 repeats + 1 warm-up) = 60 trials. */
const TDM48_KIT_60: SchedulableKitInput = {
  contenders: ["alpha", "beta"],
  workloads: ["small", "medium", "large"],
  repeats: 9,
  warmups: 1,
  est_trial_seconds: 90,
};

function tdm48Plans(runId: string, kit: SchedulableKitInput = TDM48_KIT_60): TrialPlan[] {
  return expandTrials({ run_id: runId, kit });
}

interface Tdm48Live {
  global: number;
  peakGlobal: number;
  byUser: Map<string, number>;
  peakUser: Map<string, number>;
  byRun: Map<string, number>;
  peakRun: Map<string, number>;
}

function tdm48Live(): Tdm48Live {
  return {
    global: 0,
    peakGlobal: 0,
    byUser: new Map(),
    peakUser: new Map(),
    byRun: new Map(),
    peakRun: new Map(),
  };
}

function bump(m: Map<string, number>, peak: Map<string, number>, k: string, d: number) {
  const v = (m.get(k) ?? 0) + d;
  m.set(k, v);
  peak.set(k, Math.max(peak.get(k) ?? 0, v));
}

interface Tdm48HarnessOptions {
  runId: string;
  userId: string;
  plans: TrialPlan[];
  pool: ComputerPool;
  provider: FakeProvider;
  live: Tdm48Live;
  budgetCap?: MicroUsd;
  spent?: MicroUsd;
  gate?: (launches: number) => GateDecision;
  kill?: (launches: number) => KillSwitchState;
  throwOn?: (t: TrialPlan) => boolean;
  events?: AnybenchEvent[];
  startOrder?: TrialPlan[];
  perComputerActive?: Map<string, number>;
  computerOf?: Map<string, string>;
}

/**
 * A trial executor stand-in on FakeProvider: one fake computer per block (created on the block's
 * first trial, destroyed in onBlockEnd), the trial is a virtual `sleep`.
 */
function tdm48Scheduler(h: Tdm48HarnessOptions): Scheduler {
  const computers = new Map<string, string>();
  let launches = 0;
  const events = h.events ?? [];
  return new Scheduler({
    run_id: h.runId,
    user_id: h.userId,
    plans: h.plans,
    pool: h.pool,
    budget: {
      cap_micro_usd: h.budgetCap ?? mulMicro(TDM48_EST, 1000),
      spent_micro_usd: h.spent ?? 0n,
      estimate_per_trial_micro_usd: TDM48_EST,
    },
    billingGate: () => h.gate?.(launches) ?? { allowed: true },
    killSwitch: async () => h.kill?.(launches) ?? { engaged: false },
    sink: { emit: (e) => void events.push(e) },
    actor: { kind: "worker", id: "tdm48-test" },
    launch: async (trial, ctx) => {
      launches++;
      h.startOrder?.push(trial);
      if (h.throwOn?.(trial)) throw new Error(`boom ${trial.index}`);
      let id = computers.get(ctx.computer_key);
      if (id === undefined) {
        expect(ctx.position_in_block).toBe(0);
        const c = await h.provider.create({ tags: [`ab-${h.runId}`] });
        id = c.id;
        computers.set(ctx.computer_key, id);
        h.live.global++;
        h.live.peakGlobal = Math.max(h.live.peakGlobal, h.live.global);
        bump(h.live.byUser, h.live.peakUser, h.userId, 1);
        bump(h.live.byRun, h.live.peakRun, h.runId, 1);
        await h.provider.waitReady(id);
      }
      h.computerOf?.set(trial.trial_id, id);
      const active = (h.perComputerActive?.get(id) ?? 0) + 1;
      h.perComputerActive?.set(id, active);
      expect(active).toBe(1); // trials on one computer never overlap
      const r = await h.provider.exec(id, `sleep ${1 + ((trial.index * 7) % 5)}`);
      h.perComputerActive?.set(id, active - 1);
      return { state: r.exitCode === 0 ? "done" : "failed_infra", cost_micro_usd: TDM48_EST };
    },
    onBlockEnd: async (key) => {
      const id = computers.get(key);
      if (id === undefined) return;
      computers.delete(key);
      await h.provider.destroy(id);
      h.live.global--;
      bump(h.live.byUser, h.live.peakUser, h.userId, -1);
      bump(h.live.byRun, h.live.peakRun, h.runId, -1);
    },
  });
}

function tdm48Provider(maxComputers: number): FakeProvider {
  return new FakeProvider({ timeScale: 0.002, maxComputers });
}

function expectCountsMatch(res: SchedulerResult, plans: TrialPlan[]) {
  const ids = [
    ...res.outcomes.map((o) => o.trial.trial_id),
    ...res.queued.map((t) => t.trial_id),
    ...res.cancelled.map((t) => t.trial_id),
  ];
  expect(ids).toHaveLength(plans.length);
  expect(new Set(ids)).toEqual(new Set(plans.map((p) => p.trial_id)));
}

describe("expandTrials", () => {
  it("expands contender × workload × repeat plus warm-ups, interleaved A B A B", () => {
    const plans = tdm48Plans("run-x");
    expect(plans).toHaveLength(60);
    expect(plans.map((p) => p.index)).toEqual([...Array(60).keys()]);
    expect(new Set(plans.map((p) => p.trial_id)).size).toBe(60);
    for (const p of plans) expect(TrialIdSchema.safeParse(p.trial_id).success).toBe(true);

    // Warm-ups: one per contender × workload, all first, marked.
    const warm = plans.filter((p) => p.warmup);
    expect(warm).toHaveLength(6);
    expect(warm.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);

    // Strict A B A B over the whole sequence.
    plans.forEach((p, i) => expect(p.contender_id).toBe(i % 2 === 0 ? "alpha" : "beta"));
    // Each interleave round pairs the same workload and repeat.
    for (let i = 0; i < 60; i += 2) {
      expect(plans[i]!.workload_id).toBe(plans[i + 1]!.workload_id);
      expect(plans[i]!.repeat).toBe(plans[i + 1]!.repeat);
    }
    // Every cell gets repeats 0..8.
    for (const c of ["alpha", "beta"])
      for (const w of ["small", "medium", "large"]) {
        const reps = plans
          .filter((p) => !p.warmup && p.contender_id === c && p.workload_id === w)
          .map((p) => p.repeat);
        expect(reps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      }
    // No packing: every trial its own computer.
    expect(new Set(plans.map((p) => p.block)).size).toBe(60);
    expect(estimatePlanCost(plans, TDM48_EST)).toBe(15_000_000n);
  });

  it("packs short trials into whole rounds per billing block, never two repeats of a cell", () => {
    const kit = { ...TDM48_KIT_60, packing: true, est_trial_seconds: 120 }; // 600/120 = 5 → 4
    expect(packCapacity(SchedulableKitSchema.parse(kit), 600)).toBe(4);
    const plans = tdm48Plans("run-p", kit);
    expect(plans).toHaveLength(60);
    const blocks = groupBlocks(plans);
    expect(blocks).toHaveLength(15);
    for (const b of blocks) {
      expect(b.trials.length).toBeLessThanOrEqual(4);
      const cells = b.trials.map((t) => `${t.warmup}/${t.contender_id}/${t.workload_id}`);
      expect(new Set(cells).size).toBe(cells.length);
      // Both contenders on every packed machine.
      expect(new Set(b.trials.map((t) => t.contender_id))).toEqual(new Set(["alpha", "beta"]));
    }
    // Repeats of one cell land on different computers.
    const measured = plans.filter(
      (p) => !p.warmup && p.contender_id === "alpha" && p.workload_id === "small",
    );
    expect(new Set(measured.map((p) => p.block)).size).toBe(measured.length);
  });

  it("does not pack long trials or kits without packing", () => {
    const long = SchedulableKitSchema.parse({
      ...TDM48_KIT_60,
      packing: true,
      est_trial_seconds: 400,
    });
    expect(packCapacity(long, 600)).toBe(1);
    expect(
      packCapacity(SchedulableKitSchema.parse({ ...TDM48_KIT_60, est_trial_seconds: 10 }), 600),
    ).toBe(1);
    const plans = tdm48Plans("run-l", { ...TDM48_KIT_60, packing: true, est_trial_seconds: 400 });
    expect(new Set(plans.map((p) => p.block)).size).toBe(60);
  });

  it("rejects bad kits at the boundary", () => {
    expect(() => tdm48Plans("r", { ...TDM48_KIT_60, contenders: ["a", "a"] })).toThrow();
    expect(() => tdm48Plans("r", { ...TDM48_KIT_60, repeats: 0 })).toThrow();
    expect(() => tdm48Plans("r", { ...TDM48_KIT_60, workloads: [] })).toThrow();
  });
});

describe("ComputerPool", () => {
  it("serves waiters FIFO but skips one whose user is at its cap", async () => {
    const pool = new ComputerPool({
      max_computers: 2,
      max_computers_per_user: 1,
      max_computers_per_run: 5,
    });
    const a1 = await pool.acquire("ua", "r1");
    const b1 = await pool.acquire("ub", "r2");
    const order: string[] = [];
    const a2 = pool.acquire("ua", "r1").then((l) => (order.push("ua"), l));
    const c1 = pool.acquire("uc", "r3").then((l) => (order.push("uc"), l));
    expect(pool.waiting).toBe(2);
    b1.release(); // ua still at its cap, so uc goes first
    await c1;
    expect(order).toEqual(["uc"]);
    a1.release();
    a1.release(); // idempotent
    await a2;
    expect(order).toEqual(["uc", "ua"]);
    expect(pool.inUseCount()).toBe(2);
    expect(pool.peak()).toBe(2);
  });
});

describe("Scheduler on FakeProvider (60-trial run)", () => {
  const caps: ConcurrencyCaps = {
    max_computers: 8,
    max_computers_per_user: 4,
    max_computers_per_run: 3,
  };

  it("runs every trial, never exceeds caps, launches in A B A B order, counts match", async () => {
    const plans = tdm48Plans("run-a");
    const provider = tdm48Provider(caps.max_computers);
    const pool = new ComputerPool(caps);
    const live = tdm48Live();
    const events: AnybenchEvent[] = [];
    const startOrder: TrialPlan[] = [];
    const res = await tdm48Scheduler({
      runId: "run-a",
      userId: "u1",
      plans,
      pool,
      provider,
      live,
      events,
      startOrder,
    }).run();

    expect(res.stop).toBeNull();
    expect(res.outcomes).toHaveLength(60);
    expect(res.outcomes.every((o) => o.state === "done")).toBe(true);
    expect(res.queued).toEqual([]);
    expect(res.cancelled).toEqual([]);
    expectCountsMatch(res, plans);
    expect(res.spent_micro_usd).toBe(mulMicro(TDM48_EST, 60));

    // Caps: per run 3 is the binding one; it is reached, never exceeded.
    expect(live.peakRun.get("run-a")).toBe(3);
    expect(res.peak_computers).toBe(3);
    expect(live.peakGlobal).toBeLessThanOrEqual(caps.max_computers);
    expect(await provider.list()).toEqual([]); // every computer destroyed

    // Launch order is the interleaved plan order.
    expect(startOrder.map((t) => t.index)).toEqual([...Array(60).keys()]);
    startOrder.forEach((t, i) => expect(t.contender_id).toBe(i % 2 === 0 ? "alpha" : "beta"));

    // One valid trial.phase ∅ → queued per trial, seq strictly increasing.
    expect(events).toHaveLength(60);
    for (const e of events) {
      expect(AnybenchEventSchema.parse(e)).toEqual(e);
      expect(e.type).toBe("trial.phase");
    }
    expect(events.map((e) => e.seq)).toEqual([...Array(60).keys()]);
    expect(new Set(events.map((e) => e.source_id))).toEqual(new Set(plans.map((p) => p.trial_id)));
  });

  it("stops launching at the budget and leaves the rest queued", async () => {
    const plans = tdm48Plans("run-b");
    const pool = new ComputerPool(caps);
    const res = await tdm48Scheduler({
      runId: "run-b",
      userId: "u1",
      plans,
      pool,
      provider: tdm48Provider(caps.max_computers),
      live: tdm48Live(),
      budgetCap: mulMicro(TDM48_EST, 25) + 100_000n, // room for 25 trials, not 26
      spent: 0n,
    }).run();
    expect(res.stop?.kind).toBe("budget");
    expect(res.outcomes).toHaveLength(25);
    expect(res.queued).toHaveLength(35);
    expect(res.cancelled).toEqual([]);
    expect(res.spent_micro_usd).toBeLessThanOrEqual(mulMicro(TDM48_EST, 25) + 100_000n);
    expectCountsMatch(res, plans);
    // The launched ones are a prefix of the plan, so the queue resumes in order.
    expect(res.queued.map((t) => t.index)).toEqual([...Array(35).keys()].map((i) => i + 25));
  });

  it("counts what was already spent on resume", async () => {
    const plans = tdm48Plans("run-b2");
    const res = await tdm48Scheduler({
      runId: "run-b2",
      userId: "u1",
      plans,
      pool: new ComputerPool(caps),
      provider: tdm48Provider(caps.max_computers),
      live: tdm48Live(),
      budgetCap: mulMicro(TDM48_EST, 25),
      spent: mulMicro(TDM48_EST, 5),
    }).run();
    expect(res.outcomes).toHaveLength(20);
    expect(res.spent_micro_usd).toBe(mulMicro(TDM48_EST, 25));
  });

  it("stops launching when the billing gate says no; live trials finish", async () => {
    const plans = tdm48Plans("run-c");
    const res = await tdm48Scheduler({
      runId: "run-c",
      userId: "u1",
      plans,
      pool: new ComputerPool(caps),
      provider: tdm48Provider(caps.max_computers),
      live: tdm48Live(),
      gate: (n) => (n < 17 ? { allowed: true } : { allowed: false, reason: "payment_failed" }),
    }).run();
    expect(res.stop).toEqual({ kind: "billing_gate", reason: "payment_failed" });
    expect(res.outcomes).toHaveLength(17);
    expect(res.outcomes.every((o) => o.state === "done")).toBe(true);
    expect(res.queued).toHaveLength(43);
    expectCountsMatch(res, plans);
  });

  it("stops at the kill switch and cancels everything not launched", async () => {
    const plans = tdm48Plans("run-d");
    const events: AnybenchEvent[] = [];
    const res = await tdm48Scheduler({
      runId: "run-d",
      userId: "u1",
      plans,
      pool: new ComputerPool(caps),
      provider: tdm48Provider(caps.max_computers),
      live: tdm48Live(),
      events,
      kill: (n) => ({ engaged: n >= 30, scope: "global", reason: "ANYBENCH_PAUSE=1" }),
    }).run();
    expect(res.stop?.kind).toBe("kill_switch");
    expect(res.outcomes).toHaveLength(30);
    expect(res.cancelled).toHaveLength(30);
    expect(res.queued).toEqual([]);
    expectCountsMatch(res, plans);
    const cancels = events.filter((e) => e.type === "trial.phase" && e.payload.to === "cancelled");
    expect(cancels).toHaveLength(30);
    for (const e of cancels) {
      if (e.type !== "trial.phase") throw new Error("unreachable");
      expect(e.payload.from).toBe("queued");
      expect(isLegalTrialEdge("queued", "cancelled")).toBe(true);
      expect(e.payload.reason).toBe("ANYBENCH_PAUSE=1");
    }
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
  });

  it("records a throwing launch as failed_infra (not billed) and keeps going", async () => {
    const plans = tdm48Plans("run-e");
    const res = await tdm48Scheduler({
      runId: "run-e",
      userId: "u1",
      plans,
      pool: new ComputerPool(caps),
      provider: tdm48Provider(caps.max_computers),
      live: tdm48Live(),
      throwOn: (t) => t.index % 10 === 3,
    }).run();
    expect(res.outcomes).toHaveLength(60);
    const failed = res.outcomes.filter((o) => o.state === "failed_infra");
    expect(failed).toHaveLength(6);
    expect(failed.every((o) => o.cost_micro_usd === 0n && o.error?.startsWith("boom"))).toBe(true);
    expect(res.spent_micro_usd).toBe(mulMicro(TDM48_EST, 54));
  });

  it("packs 60 short trials onto 15 computers, one trial at a time per computer", async () => {
    const kit = { ...TDM48_KIT_60, packing: true, est_trial_seconds: 120 };
    const plans = tdm48Plans("run-f", kit);
    const provider = tdm48Provider(caps.max_computers);
    const computerOf = new Map<string, string>();
    const res = await tdm48Scheduler({
      runId: "run-f",
      userId: "u1",
      plans,
      pool: new ComputerPool(caps),
      provider,
      live: tdm48Live(),
      perComputerActive: new Map(),
      computerOf,
    }).run();
    expect(res.outcomes).toHaveLength(60);
    expect(res.peak_computers).toBeLessThanOrEqual(3);
    expect((await provider.list({ includeDestroyed: true })).length).toBe(15);
    expect(await provider.list()).toEqual([]);
    for (const b of groupBlocks(plans)) {
      expect(new Set(b.trials.map((t) => computerOf.get(t.trial_id))).size).toBe(1);
    }
  });

  it("holds global and per-user caps across concurrent runs sharing one pool", async () => {
    const shared: ConcurrencyCaps = {
      max_computers: 5,
      max_computers_per_user: 3,
      max_computers_per_run: 2,
    };
    const provider = tdm48Provider(shared.max_computers); // a 6th live computer would throw
    const pool = new ComputerPool(shared);
    const live = tdm48Live();
    const runs = [
      ["run-g1", "u1"],
      ["run-g2", "u1"],
      ["run-g3", "u2"],
      ["run-g4", "u3"],
    ] as const;
    const planned = runs.map(([r]) => tdm48Plans(r));
    const results = await Promise.all(
      runs.map(([runId, userId], i) =>
        tdm48Scheduler({ runId, userId, plans: planned[i]!, pool, provider, live }).run(),
      ),
    );
    results.forEach((res, i) => {
      expect(res.stop).toBeNull();
      expect(res.outcomes).toHaveLength(60);
      expectCountsMatch(res, planned[i]!);
      expect(res.peak_computers).toBeLessThanOrEqual(2);
    });
    expect(live.peakGlobal).toBeLessThanOrEqual(5);
    expect(live.peakGlobal).toBe(5); // the global cap is what binds
    expect(live.peakUser.get("u1")).toBeLessThanOrEqual(3);
    for (const [r] of runs) expect(live.peakRun.get(r)).toBeLessThanOrEqual(2);
    expect(pool.peak()).toBe(5);
    expect(pool.peak({ user_id: "u1" })).toBeLessThanOrEqual(3);
    expect(pool.inUseCount()).toBe(0);
  });

  it("rejects plans from another run and duplicate trial ids", () => {
    const plans = tdm48Plans("run-h");
    const base = {
      user_id: "u",
      pool: new ComputerPool(caps),
      launch: async () => ({ state: "done" as const, cost_micro_usd: 0n }),
      budget: { cap_micro_usd: 1n, estimate_per_trial_micro_usd: 0n },
      billingGate: () => ({ allowed: true }),
      killSwitch: () => ({ engaged: false }),
      sink: { emit: () => {} },
    };
    expect(() => new Scheduler({ ...base, run_id: "other", plans })).toThrow(/belongs to run/);
    const dup = [plans[0]!, { ...plans[1]!, trial_id: plans[0]!.trial_id }];
    expect(() => new Scheduler({ ...base, run_id: "run-h", plans: dup })).toThrow(/unique/);
  });
});
