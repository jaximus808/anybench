// The harness league run's estimate, offline (TDM-245; logic in
// apps/server/src/orchestrator/league-estimate.ts): the kit the curated designer stores for the
// question, packages/billing's estimateRunCost (run fee + eval computers: what Go checks against
// the budget) and the BYOK ceiling (every trial at its token cap on the owner's key). No database,
// no network, no computer, no model call.
//
//   pnpm exec tsx scripts/ops/harness-league-estimate.ts [--question "<text>"]
//
// Pricing: RUN_FEE_MICRO_USD, COMPUTE_MARKUP_BPS and COMPUTER_BLOCK_PRICE_MICRO_USD when set,
// else the .env.example values. Prints one JSON object (micro-USD as decimal strings).
import { parseArgs } from "node:util";
import { harnessLeagueEstimate } from "../../apps/server/src/orchestrator/league-estimate.js";

/** The question docs/findings/harness-league-run-plan.md gives the founder. */
const DEFAULT_QUESTION =
  "Harness league on project-tracker (v1), n=5: do Claude Code skill packs and harnesses (subagents, gstack, Superpowers, Tandem x3) beat plain Claude Code on a whole-app build?";

function micro(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  return v && /^\d+$/.test(v) ? BigInt(v) : fallback;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { question: { type: "string" } } });
  const pricing = {
    runFeeMicroUsd: micro("RUN_FEE_MICRO_USD", 2_000_000n),
    computeMarkupBps: micro("COMPUTE_MARKUP_BPS", 5_000n),
    defaultBlockPriceMicroUsd: micro("COMPUTER_BLOCK_PRICE_MICRO_USD", 27_600n),
  };
  const e = await harnessLeagueEstimate(values.question ?? DEFAULT_QUESTION, pricing);
  const s = (v: bigint | null) => (v === null ? null : v.toString());
  console.log(
    JSON.stringify(
      {
        question: e.question,
        choice: e.choice,
        trials: e.trials,
        workloads: e.spec.workloads.map((w) => w.id),
        repeats: e.spec.repeats,
        warmups: e.spec.schedule.warmups,
        est_trial_seconds: e.estTrialSeconds,
        caps: e.caps.map((c) => ({ ...c, tokenCapMicroUsd: s(c.tokenCapMicroUsd) })),
        pricing: Object.fromEntries(Object.entries(pricing).map(([k, v]) => [k, v.toString()])),
        estimate: {
          run_fee_micro_usd: s(e.estimate.runFeeMicroUsd),
          computers: e.estimate.compute.computers,
          blocks: s(e.estimate.compute.blocks),
          block_seconds: e.estimate.compute.blockSeconds,
          block_price_micro_usd: s(e.estimate.compute.blockPriceMicroUsd),
          price_source: e.estimate.compute.priceSource,
          compute_cost_micro_usd: s(e.estimate.compute.costMicroUsd),
          compute_charge_micro_usd: s(e.estimate.compute.chargeMicroUsd),
          total_micro_usd: s(e.estimate.totalMicroUsd),
        },
        byok_token_ceiling_micro_usd: s(e.byokCeilingMicroUsd),
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
