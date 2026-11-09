// TDM-245: the harness league run's estimate, offline. The kit the curated designer stores for a
// question (curatedKitFor → leagueChoiceFor → leagueProfile), then packages/billing's
// estimateRunCost (what Go checks against the budget: run fee + eval computers) and
// byokTokenCeilingMicroUsd (the owner's Anthropic key if every trial hit its cap). No database,
// no network. scripts/ops/harness-league-estimate.ts prints it.
import path from "node:path";
import { estTrialSecondsFromKit } from "@anybench/bench";
import {
  byokTokenCeilingMicroUsd,
  estimateRunCost,
  type EstimatePricingInput,
  type RunCostEstimate,
} from "@anybench/billing";
import { isAgentDriver, type KitSpec } from "@anybench/core";
import { loadKit } from "@anybench/kit";
import {
  CURATED_HARNESS_LEAGUE_KIT,
  curatedKitFor,
  defaultKitsDir,
  leagueChoiceFor,
  leagueProfile,
  trialCount,
  type LeagueChoice,
} from "./curated.js";

export interface LeagueEstimate {
  question: string;
  choice: LeagueChoice;
  spec: KitSpec;
  trials: number;
  estTrialSeconds: number;
  estimate: RunCostEstimate;
  /** Every trial at its token cap on the owner's key; null when a setup has no cap. */
  byokCeilingMicroUsd: bigint | null;
  /** Per setup: its token cap on the owner's key and its wall-clock cap. */
  caps: {
    id: string;
    name: string;
    tokenCapMicroUsd: bigint | null;
    wallClockCapS: number | null;
  }[];
}

/** The league run `question` would create, and what packages/billing says it costs. */
export async function harnessLeagueEstimate(
  question: string,
  pricing: EstimatePricingInput,
  opts: { kitsDir?: string } = {},
): Promise<LeagueEstimate> {
  if (curatedKitFor(question) !== CURATED_HARNESS_LEAGUE_KIT) {
    throw new Error(`the question does not pick the harness league: ${question}`);
  }
  const kit = await loadKit(path.join(defaultKitsDir(opts.kitsDir), CURATED_HARNESS_LEAGUE_KIT));
  const picked = leagueChoiceFor(question, kit.spec.repeats);
  if (!picked.ok) throw new Error(picked.reason);
  const league = leagueProfile(kit.spec, picked.choice);
  if (!league.ok) throw new Error(league.reason);
  const spec = league.spec;
  return {
    question,
    choice: picked.choice,
    spec,
    trials: trialCount(spec),
    estTrialSeconds: estTrialSecondsFromKit(spec),
    estimate: estimateRunCost(spec, pricing),
    byokCeilingMicroUsd: byokTokenCeilingMicroUsd(spec),
    caps: spec.contenders.map((c) => ({
      id: c.id,
      name: c.name ?? c.id,
      tokenCapMicroUsd: isAgentDriver(c.driver) ? (c.driver.token_cap_micro_usd ?? null) : null,
      wallClockCapS: isAgentDriver(c.driver) ? (c.driver.wall_clock_cap_s ?? null) : null,
    })),
  };
}
