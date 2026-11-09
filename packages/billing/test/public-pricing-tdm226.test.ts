// TDM-226: the public pricing page's numbers are the billing code's own. Every rate echoes the
// config, and both worked examples are estimateRunCost on the fixed example kits, so the page
// cannot drift from what a run is billed. Pure, no database.
import { KitSpecSchema } from "@anybench/core";
import { describe, expect, it } from "vitest";
import {
  computeChargeMicroUsd,
  estimateRunCost,
  HEAD_TO_HEAD_EXAMPLE_KIT,
  isStarterRun,
  kitSetupCount,
  naiveBlockPriceMicroUsd,
  publicPricingFigures,
  STARTER_EXAMPLE_KIT,
  type PublicPricingConfig,
} from "../src/index.js";

/** apps/server's config defaults (config.ts). */
const DEFAULTS: PublicPricingConfig = {
  runFeeMicroUsd: 2_000_000n,
  uploadedKitRunFeeMicroUsd: 0n,
  computeMarkupBps: 5000n,
  managedTokenMarkupBps: 2000n,
  defaultBlockPriceMicroUsd: 27_600n,
  freeRun: {
    poolMicroUsd: 50_000_000n,
    capMicroUsd: 10_000_000n,
    maxTrials: 24,
    runFeeMicroUsd: 2_000_000n,
  },
};

const ESTIMATE_PRICING = {
  runFeeMicroUsd: DEFAULTS.runFeeMicroUsd,
  uploadedKitRunFeeMicroUsd: DEFAULTS.uploadedKitRunFeeMicroUsd,
  computeMarkupBps: DEFAULTS.computeMarkupBps,
  managedTokenMarkupBps: DEFAULTS.managedTokenMarkupBps,
  defaultBlockPriceMicroUsd: DEFAULTS.defaultBlockPriceMicroUsd,
};

describe("publicPricingFigures (TDM-226)", () => {
  it("echoes the config's rates, and prices the standard computer's block at cost + markup", () => {
    const f = publicPricingFigures(DEFAULTS);
    expect(f.rates.runFeeMicroUsd).toBe(2_000_000n);
    expect(f.rates.uploadedKitRunFeeMicroUsd).toBe(0n);
    expect(f.rates.computeMarkupBps).toBe(5000n);
    expect(f.rates.managedTokenMarkupBps).toBe(2000n);
    expect(f.rates.blockSeconds).toBe(600);
    const cost = naiveBlockPriceMicroUsd({ vcpu: 2, memory_gb: 4 });
    expect(f.rates.machine).toEqual({
      vcpu: 2,
      memory_gb: 4,
      blockCostMicroUsd: cost,
      blockChargeMicroUsd: computeChargeMicroUsd(cost, 5000n),
    });
    expect(cost).toBe(27_600n);
    expect(f.rates.machine.blockChargeMicroUsd).toBe(41_400n);
    expect(f.freeRun).toEqual({
      offered: true,
      maxSetups: 2,
      maxTrials: 24,
      computeCapMicroUsd: 10_000_000n,
      minGithubAgeDays: 90,
    });
  });

  it("prices both worked examples with estimateRunCost on the fixed example kits", () => {
    const f = publicPricingFigures(DEFAULTS);
    expect(f.examples.map((e) => e.id)).toEqual(["starter", "head_to_head"]);
    const [starter, h2h] = f.examples;
    expect(starter!.estimate).toEqual(estimateRunCost(STARTER_EXAMPLE_KIT, ESTIMATE_PRICING));
    expect(h2h!.estimate).toEqual(estimateRunCost(HEAD_TO_HEAD_EXAMPLE_KIT, ESTIMATE_PRICING));
    // Pinned at the defaults so a change to the billing math shows up here, not on the page.
    // Starter: 2 setups x 2 tasks x (3 repeats + 1 warm-up) = 16 trials, 15-min caps = 2 blocks
    // each on 2 vCPU / 4 GiB: 32 x $0.0276 = $0.8832 cost, $1.3248 billed, + $2 run fee.
    expect(starter!.estimate.compute.trials).toBe(16);
    expect(starter!.estimate.compute.blocks).toBe(32n);
    expect(starter!.estimate.compute.chargeMicroUsd).toBe(1_324_800n);
    expect(starter!.estimate.totalMicroUsd).toBe(3_324_800n);
    // Head-to-head: 2 setups x 3 tasks x (6 + 1) = 42 trials at their 1-hour cap = 6 blocks each
    // on 4 vCPU / 8 GiB ($0.0552 a block): 252 blocks, $13.9104 cost, $20.8656 billed, + $2.
    expect(h2h!.estimate.compute.trials).toBe(42);
    expect(h2h!.estimate.compute.blocks).toBe(252n);
    expect(h2h!.estimate.compute.chargeMicroUsd).toBe(20_865_600n);
    expect(h2h!.estimate.totalMicroUsd).toBe(22_865_600n);
    expect(h2h!.repeats * h2h!.workloads).toBe(18);
  });

  it("the starter is a free run under every starter limit; the head-to-head is not", () => {
    const f = publicPricingFigures(DEFAULTS);
    const [starter, h2h] = f.examples;
    expect(starter).toMatchObject({ free: true, tokens: "own_key", setups: 2 });
    expect(h2h).toMatchObject({ free: false, tokens: "managed", setups: 2 });
    const kit = KitSpecSchema.parse(HEAD_TO_HEAD_EXAMPLE_KIT);
    const decision = isStarterRun(kit, h2h!.estimate, {
      byokProviders: ["anthropic"],
      config: DEFAULTS.freeRun,
    });
    expect(decision.starter).toBe(false);
    if (!decision.starter) {
      expect(decision.reasons.map((r) => r.code)).toEqual([
        "too_many_trials",
        "managed_tokens",
        "over_compute_cap",
      ]);
    }
    expect(kitSetupCount(STARTER_EXAMPLE_KIT)).toBe(2);
  });

  it("follows the config: a different fee, markup and pool change the page, nothing is fixed", () => {
    const f = publicPricingFigures({
      ...DEFAULTS,
      runFeeMicroUsd: 3_000_000n,
      computeMarkupBps: 2500n,
      freeRun: { ...DEFAULTS.freeRun, poolMicroUsd: 0n, maxTrials: 8 },
    });
    expect(f.rates.runFeeMicroUsd).toBe(3_000_000n);
    expect(f.rates.machine.blockChargeMicroUsd).toBe(34_500n);
    expect(f.freeRun).toMatchObject({ offered: false, maxTrials: 8 });
    // 16 trials > 8, and the pool is off: the starter example is no longer free.
    expect(f.examples[0]!.free).toBe(false);
    expect(f.examples[0]!.estimate.runFeeMicroUsd).toBe(3_000_000n);
  });
});
