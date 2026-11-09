// Run cost estimate for the test-plan screen and the run gate on Go (TDM-171, plan.md section 8).
//
// Estimate = run fee + projected compute. The run fee is RUN_FEE_MICRO_USD for a kit our agents
// generated, UPLOADED_KIT_RUN_FEE_MICRO_USD (default 0) for a kit the user uploaded (TDM-218: no
// kit generation on our side; pricing.ts runFeeForKit). Projected compute is priced exactly the
// way the ledger will bill it: one charge per eval computer, cost (blocks x block price) plus
// COMPUTE_MARKUP_BPS rounded down per computer. The computer layout is the scheduler's own
// (@anybench/bench expandTrials + groupBlocks): one computer per trial, or one per packed block,
// warm-ups included. A computer is busy for (trials on it) x est_trial_seconds and pays
// max(1, ceil(busy / block_seconds)) blocks, since Naïve bills the first block at create.
//
// Not included: model tokens (the user's own key by default; managed tokens are metered as used)
// and the proof runs before Go: a generated kit's proof computers are ours (RUN_FEE_MICRO_USD
// covers them); an uploaded kit's are billed with the run like any run-level computer (cost +
// COMPUTE_MARKUP_BPS, never for our infra failures) but not projected here. Bigint only.
import {
  estTrialSecondsFromKit,
  expandTrials,
  expandTrialsInputFromKit,
  groupBlocks,
} from "@anybench/bench";
import {
  isAgentDriver,
  KitSpecSchema,
  NonNegativeMicroUsdSchema,
  resolveEnvProvider,
  RunKitOriginSchema,
  type KitSpec,
  type KitSpecInput,
  type MicroUsd,
  type RunKitOrigin,
} from "@anybench/core";
import { z } from "zod";
import {
  ceilDiv,
  computeChargeMicroUsd,
  CostPlusPricingSchema,
  naiveBlockPriceMicroUsd,
  runFeeForKit,
} from "./pricing.js";
import { BYOK_TOKEN_SOURCES } from "./free-run.js";

export const EstimatePricingSchema = CostPlusPricingSchema.extend({
  /**
   * Block price when the kit carries no env (or one we have no rate for, e.g. `vm`):
   * COMPUTER_BLOCK_PRICE_MICRO_USD, the price the registry costs computers at.
   */
  defaultBlockPriceMicroUsd: NonNegativeMicroUsdSchema,
  /** UPLOADED_KIT_RUN_FEE_MICRO_USD: the run fee when the kit was uploaded (TDM-218). */
  uploadedKitRunFeeMicroUsd: NonNegativeMicroUsdSchema.default(0n),
});
export type EstimatePricingInput = z.input<typeof EstimatePricingSchema>;

export interface RunCostEstimate {
  /** Where the kit came from: `uploaded` pays no kit-generation fee. */
  kitOrigin: RunKitOrigin;
  /** The run fee for that origin (runFeeForKit). */
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

export interface EstimateOptions {
  /** Where the run's kit came from; default `generated` (our agents designed it). */
  kitOrigin?: RunKitOrigin;
}

/** What a run of this kit will cost the user: run fee + projected compute (no tokens). */
export function estimateRunCost(
  kitInput: KitSpec | KitSpecInput,
  pricingInput: EstimatePricingInput,
  opts: EstimateOptions = {},
): RunCostEstimate {
  const kit = KitSpecSchema.parse(kitInput);
  const pricing = EstimatePricingSchema.parse(pricingInput);
  const kitOrigin = RunKitOriginSchema.parse(opts.kitOrigin ?? "generated");
  const runFee = runFeeForKit(kitOrigin, pricing);
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
    kitOrigin,
    runFeeMicroUsd: runFee,
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
    totalMicroUsd: runFee + charge,
  };
}

/**
 * TDM-225: an upper bound on what the run's agents spend on the user's OWN model key, which their
 * provider bills (never part of our price): every planned trial (warm-ups included) of a contender
 * whose driver reads a BYOK key (AB_TOKEN_SOURCE anthropic_key / openai_key), at that contender's
 * token_cap_micro_usd (the runner stops the trial there). Null when no contender is on the user's
 * key, or when one of them sets no spend cap: then there is no honest bound. Bigint only.
 */
export function byokTokenCeilingMicroUsd(kitInput: KitSpec | KitSpecInput): MicroUsd | null {
  const kit = KitSpecSchema.parse(kitInput);
  const caps = new Map<string, MicroUsd | null>();
  for (const c of kit.contenders) {
    const source = c.driver.env?.AB_TOKEN_SOURCE;
    if (source === undefined || !BYOK_TOKEN_SOURCES[String(source)]) continue;
    const cap = isAgentDriver(c.driver) ? (c.driver.token_cap_micro_usd ?? null) : null;
    caps.set(c.id, cap);
  }
  if (caps.size === 0) return null;
  let total = 0n;
  for (const t of expandTrials(expandTrialsInputFromKit("estimate", kit))) {
    if (!caps.has(t.contender_id)) continue;
    const cap = caps.get(t.contender_id);
    if (cap === null || cap === undefined) return null;
    total += cap;
  }
  return total;
}
