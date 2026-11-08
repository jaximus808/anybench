// TDM-171: cost-plus pricing decisions and the run estimate (pure, no database).
import {
  RUN_STATES,
  TRIAL_STATES,
  isBillableTrialState,
  withMarkupBps,
  type KitSpecInput,
  type TrialState,
} from "@anybench/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ceilDiv,
  computeDecision,
  estimateRunCost,
  naiveBlockPriceMicroUsd,
  runFeeDecision,
  type TrialForBilling,
} from "../src/index.js";

describe("naiveBlockPriceMicroUsd", () => {
  it("matches Naïve's rates: 2 vCPU / 4 GiB = $0.0276, 4 vCPU / 8 GiB = $0.0552 per 10 min", () => {
    expect(naiveBlockPriceMicroUsd({ vcpu: 2, memory_gb: 4 })).toBe(27_600n);
    expect(naiveBlockPriceMicroUsd({ vcpu: 4, memory_gb: 8 })).toBe(55_200n);
    // One hour of 1 vCPU + 1 GiB: $0.0504 + $0.0162.
    expect(naiveBlockPriceMicroUsd({ vcpu: 1, memory_gb: 1 }, 3600)).toBe(66_600n);
    // A 7 s block rounds up to the micro-dollar.
    expect(naiveBlockPriceMicroUsd({ vcpu: 1, memory_gb: 1 }, 7)).toBe(
      ceilDiv(66_600n * 7n, 3600n),
    );
  });

  it("rejects fractional sizes and blocks", () => {
    expect(() => naiveBlockPriceMicroUsd({ vcpu: 1.5, memory_gb: 1 })).toThrow();
    expect(() => naiveBlockPriceMicroUsd({ vcpu: 1, memory_gb: 1 }, 0.5)).toThrow();
  });
});

describe("runFeeDecision", () => {
  it("bills delivered, and failed only when the subject failed", () => {
    expect(runFeeDecision("delivered", []).billable).toBe(true);
    expect(runFeeDecision("failed", ["failed_subject", "cancelled"]).billable).toBe(true);
    expect(runFeeDecision("failed", ["failed_subject", "failed_infra"]).billable).toBe(false);
    expect(runFeeDecision("failed", ["failed_subject", "done"]).billable).toBe(false);
    expect(runFeeDecision("failed", []).billable).toBe(false);
    expect(runFeeDecision("cancelled", ["done"]).billable).toBe(false);
  });

  it("property: a failed run with any failed_infra trial is never billed; non-final runs never", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RUN_STATES),
        fc.array(fc.constantFrom<TrialState>(...TRIAL_STATES), { maxLength: 6 }),
        (run, states) => {
          const d = runFeeDecision(run, states);
          if (run !== "delivered" && run !== "failed") expect(d.billable).toBe(false);
          if (run === "failed" && states.includes("failed_infra")) expect(d.billable).toBe(false);
          if (run === "delivered") expect(d.billable).toBe(true);
        },
      ),
    );
  });
});

describe("computeDecision", () => {
  const computer = (over: Partial<Parameters<typeof computeDecision>[0]> = {}) => ({
    id: "c1",
    status: "destroyed",
    trialId: "t1",
    costMicroUsd: 100n,
    ...over,
  });

  it("property: billed iff destroyed, cost > 0 and a served trial is done/failed_subject", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            state: fc.constantFrom<TrialState>(...TRIAL_STATES),
            on: fc.constantFrom<"c1" | "other" | null>("c1", "other", null),
          }),
          { maxLength: 5 },
        ),
        fc.boolean(),
        fc.constantFrom("destroyed", "running", "leaked"),
        fc.bigInt({ min: 0n, max: 10n }),
        (trials, tagged, status, cost) => {
          const runTrials: TrialForBilling[] = trials.map((t, i) => ({
            id: `t${i + 1}`,
            state: t.state,
            computerId: t.on,
          }));
          const c = computer({ status, costMicroUsd: cost, trialId: tagged ? "t1" : null });
          const d = computeDecision(c, runTrials);
          const served = runTrials.filter(
            (t) => t.computerId === "c1" || (tagged && t.id === "t1" && t.computerId === null),
          );
          const pool = served.length > 0 || tagged ? served : runTrials;
          const expected =
            status === "destroyed" && cost > 0n && pool.some((t) => isBillableTrialState(t.state));
          expect(d.billable).toBe(expected);
          // A computer that served only failed_infra trials is never billed.
          if (served.length > 0 && served.every((t) => t.state === "failed_infra")) {
            expect(d.billable).toBe(false);
          }
        },
      ),
    );
  });
});

function kit(over: Partial<KitSpecInput> = {}): KitSpecInput {
  return {
    schema_version: 2,
    subject: { kind: "software", name: "tool", summary: "A CLI", better_means: ["faster"] },
    contenders: [
      {
        id: "new",
        role: "subject",
        source: { github: "example/tool", ref: "v2" },
        driver: { type: "cli", verbs: { run: "run {in} {out}" } },
      },
      {
        id: "old",
        role: "baseline",
        source: { github: "example/tool", ref: "v1" },
        driver: { type: "cli", verbs: { run: "run {in} {out}" } },
      },
    ],
    workloads: [{ id: "small" }, { id: "large" }],
    gates: [{ id: "same-output", kind: "output-diff" }],
    requirements: [
      {
        id: "wall",
        type: "measured",
        title: "Wall time",
        metric: "wall_s",
        better: "lower",
        gate_id: "same-output",
      },
    ],
    proof: { oracle: { id: "reference", dir: "proof/oracle/" } },
    scoring: { weights: { wall: 100 } },
    repeats: 3,
    ...over,
  } as KitSpecInput;
}

const PRICING = {
  runFeeMicroUsd: 2_000_000n,
  computeMarkupBps: 5000,
  defaultBlockPriceMicroUsd: 27_600n,
};

describe("estimateRunCost", () => {
  it("run fee + one computer per trial (warm-ups included) at the default block price + 50%", () => {
    // 2 contenders x 2 workloads x (3 repeats + 1 warm-up) = 16 trials, unpacked: 16 computers.
    // est_trial_seconds falls back to the 600 s block: 1 block each.
    const e = estimateRunCost(kit(), PRICING);
    expect(e.compute).toMatchObject({
      computers: 16,
      trials: 16,
      blocks: 16n,
      priceSource: "default",
      blockPriceMicroUsd: 27_600n,
      costMicroUsd: 16n * 27_600n,
      chargeMicroUsd: 16n * withMarkupBps(27_600n, 5000),
    });
    expect(e.totalMicroUsd).toBe(2_000_000n + 16n * 41_400n);
  });

  it("prices the kit's env at Naïve rates and counts blocks per computer", () => {
    // The plan.md worked example: 30 min trials on 4 vCPU / 8 GB = 3 blocks of $0.0552 each.
    const e = estimateRunCost(
      kit({
        env: { profile: "base", resources: { vcpu: 4, memory_gb: 8, disk_gb: 20 } },
        schedule: { warmups: 0, est_trial_seconds: 1800 },
        repeats: 15,
      }),
      PRICING,
    );
    // 2 x 2 x 15 = 60 trials.
    expect(e.compute.trials).toBe(60);
    expect(e.compute.priceSource).toBe("naive_rate");
    expect(e.compute.blocks).toBe(180n);
    expect(e.compute.costMicroUsd).toBe(180n * 55_200n);
    // 60 x (165_600 + 82_800) = $14.904 compute.
    expect(e.compute.chargeMicroUsd).toBe(60n * withMarkupBps(3n * 55_200n, 5000));
    expect(e.totalMicroUsd).toBe(2_000_000n + e.compute.chargeMicroUsd);
  });

  it("packed trials share a computer for one block", () => {
    const e = estimateRunCost(
      kit({ schedule: { warmups: 0, est_trial_seconds: 60, packing: true } }),
      PRICING,
    );
    expect(e.compute.trials).toBe(12);
    expect(e.compute.computers).toBeLessThan(12);
    expect(e.compute.blocks).toBe(BigInt(e.compute.computers));
  });

  it("docker-local is free; markup applies per computer, rounded down", () => {
    const free = estimateRunCost(
      kit({ env: { profile: "docker", resources: { vcpu: 2, memory_gb: 4, disk_gb: 10 } } }),
      PRICING,
    );
    expect(free.compute.priceSource).toBe("free");
    expect(free.totalMicroUsd).toBe(2_000_000n);
    const odd = estimateRunCost(kit(), { ...PRICING, defaultBlockPriceMicroUsd: 3n });
    // 3 + floor(1.5) = 4 per computer, not floor(16 * 4.5).
    expect(odd.compute.chargeMicroUsd).toBe(16n * 4n);
  });

  it("rejects float money in the pricing", () => {
    expect(() =>
      estimateRunCost(kit(), { ...PRICING, runFeeMicroUsd: 2 as unknown as bigint }),
    ).toThrow();
    expect(() => estimateRunCost(kit(), { ...PRICING, computeMarkupBps: 0.5 })).toThrow();
  });
});
