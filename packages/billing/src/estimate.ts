// Run cost estimate for the test-plan screen and the run gate on Go (TDM-171, plan.md section 8).
//
// Estimate = RUN_FEE_MICRO_USD + projected compute, where projected compute is priced exactly the
// way the ledger will bill it: one charge per eval computer, cost (blocks x block price) plus
// COMPUTE_MARKUP_BPS rounded down per computer. The computer layout is the scheduler's own
// (@anybench/bench expandTrials + groupBlocks): one computer per trial, or one per packed block,
// warm-ups included. A computer is busy for (trials on it) x est_trial_seconds and pays
// max(1, ceil(busy / block_seconds)) blocks, since Naïve bills the first block at create.
//
// Not included: model tokens (the user's own key by default; managed tokens are metered as used)
// and the proof runs before Go (covered by the run fee). Bigint only: no float path.
import {
  estTrialSecondsFromKit,
  expandTrials,
  expandTrialsInputFromKit,
  groupBlocks,
} from "@anybench/bench";
import {
  KitSpecSchema,
  NonNegativeMicroUsdSchema,
  resolveEnvProvider,
  type KitSpec,
  type KitSpecInput,
  type MicroUsd,
} from "@anybench/core";
import { z } from "zod";
import {
  ceilDiv,
  computeChargeMicroUsd,
  CostPlusPricingSchema,
  naiveBlockPriceMicroUsd,
} from "./pricing.js";

export const EstimatePricingSchema = CostPlusPricingSchema.extend({
  /**
   * Block price when the kit carries no env (or one we have no rate for, e.g. `vm`):
   * COMPUTER_BLOCK_PRICE_MICRO_USD, the price the registry costs computers at.
   */
  defaultBlockPriceMicroUsd: NonNegativeMicroUsdSchema,
});
export type EstimatePricingInput = z.input<typeof EstimatePricingSchema>;

export interface RunCostEstimate {
  runFeeMicroUsd: MicroUsd;
  compute: {
    /** Eval computers the scheduler will create (one per block). */
    computers: number;
    /** Trials, warm-ups included. */
    trials: number;
    /** Billing blocks over all computers. */
    blocks: bigint;
    blockSeconds: number;
    estTrialSeconds: number;
    blockPriceMicroUsd: MicroUsd;
    /** Where the block price came from. */
    priceSource: "naive_rate" | "default" | "free";
    /** What the computers cost us (Naïve). */
    costMicroUsd: MicroUsd;
    /** What the user pays for them: per computer, cost + floor(cost x bps / 10_000). */
    chargeMicroUsd: MicroUsd;
  };
  /** runFeeMicroUsd + compute.chargeMicroUsd. Model tokens not included. */
  totalMicroUsd: MicroUsd;
}

function blockPrice(
  kit: KitSpec,
  defaultPrice: MicroUsd,
): { price: MicroUsd; source: RunCostEstimate["compute"]["priceSource"] } {
  if (!kit.env) return { price: defaultPrice, source: "default" };
  const provider = resolveEnvProvider(kit.env);
  if (provider === "docker-local" || provider === "fake") return { price: 0n, source: "free" };
  if (provider !== "naive") return { price: defaultPrice, source: "default" };
  return {
    price: naiveBlockPriceMicroUsd(kit.env.resources, kit.schedule.block_seconds),
    source: "naive_rate",
  };
}

/** What a run of this kit will cost the user: run fee + projected compute (no tokens). */
export function estimateRunCost(
  kitInput: KitSpec | KitSpecInput,
  pricingInput: EstimatePricingInput,
): RunCostEstimate {
  const kit = KitSpecSchema.parse(kitInput);
  const pricing = EstimatePricingSchema.parse(pricingInput);
  const plan = expandTrials(expandTrialsInputFromKit("estimate", kit));
  const blocks = groupBlocks(plan);
  const estTrialSeconds = estTrialSecondsFromKit(kit);
  const blockSeconds = kit.schedule.block_seconds;
  const { price, source } = blockPrice(kit, pricing.defaultBlockPriceMicroUsd);

  let totalBlocks = 0n;
  let cost = 0n;
  let charge = 0n;
  for (const b of blocks) {
    const busy = BigInt(b.trials.length) * BigInt(estTrialSeconds);
    const n = ceilDiv(busy, BigInt(blockSeconds));
    const paid = n < 1n ? 1n : n;
    const computerCost = paid * price;
    totalBlocks += paid;
    cost += computerCost;
    charge += computeChargeMicroUsd(computerCost, pricing.computeMarkupBps);
  }

  return {
    runFeeMicroUsd: pricing.runFeeMicroUsd,
    compute: {
      computers: blocks.length,
      trials: plan.length,
      blocks: totalBlocks,
      blockSeconds,
      estTrialSeconds,
      blockPriceMicroUsd: price,
      priceSource: source,
      costMicroUsd: cost,
      chargeMicroUsd: charge,
    },
    totalMicroUsd: pricing.runFeeMicroUsd + charge,
  };
}
