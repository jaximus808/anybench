// Cost-plus pricing (TDM-171, plan.md section 8, founder decision 2026-11-07).
//
// What a user pays for one benchmark run:
//   - one `run_fee` of RUN_FEE_MICRO_USD, when the run was delivered or failed because of the
//     subject. A run that ended failed because of infrastructure or our own pipeline pays nothing;
//   - one `compute` charge per eval computer: what Naïve charged us for it (the computers registry,
//     TDM-31: blocks billed x block price, `computers.cost_micro_usd`) plus COMPUTE_MARKUP_BPS,
//     rounded down. A computer that only served failed_infra attempts is never billed.
//
// Everything here is pure and bigint: the ledger (ledger.ts) feeds it the rows it read under lock,
// so the decisions are made from what the DATABASE says, never from what a caller claims.
import {
  isBillableTrialState,
  NonNegativeMicroUsdSchema,
  withMarkupBps,
  type MicroUsd,
  type RunState,
  type TrialState,
} from "@anybench/core";
import { z } from "zod";

// ---- Naïve rates (docs/findings/naive-platform-hosting.md) --------------------------------------

/** $0.0504 per vCPU-hour, in micro-USD. */
export const NAIVE_VCPU_HOUR_MICRO_USD = 50_400n;
/** $0.0162 per GiB-hour, in micro-USD. */
export const NAIVE_GIB_HOUR_MICRO_USD = 16_200n;
/** Naïve bills 10-minute blocks, paid in advance. */
export const NAIVE_BLOCK_SECONDS = 600;

const SECONDS_PER_HOUR = 3600n;

/** Basis points are not money: a bigint or a safe JS integer (unsafe integers are rejected). */
export const BpsSchema = z.union([z.bigint().nonnegative(), z.number().int().safe().nonnegative()]);

/** The two cost-plus knobs, from config (RUN_FEE_MICRO_USD, COMPUTE_MARKUP_BPS). */
export const CostPlusPricingSchema = z.object({
  runFeeMicroUsd: NonNegativeMicroUsdSchema,
  computeMarkupBps: BpsSchema,
});
export type CostPlusPricing = z.output<typeof CostPlusPricingSchema>;
export type CostPlusPricingInput = z.input<typeof CostPlusPricingSchema>;

/** Ceiling division of non-negative bigints. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new RangeError(`ceilDiv needs a >= 0 and b > 0, got ${a}/${b}`);
  return (a + b - 1n) / b;
}

export const MachineSizeSchema = z.object({
  vcpu: z.int().positive(),
  memory_gb: z.int().positive(),
});
export type MachineSize = z.infer<typeof MachineSizeSchema>;

/**
 * Naïve's price for one billing block of a machine this size, integer micro-USD, rounded up to
 * the micro-dollar (exact for 600 s blocks: 2 vCPU / 4 GiB = 27_600).
 */
export function naiveBlockPriceMicroUsd(
  size: MachineSize,
  blockSeconds: number = NAIVE_BLOCK_SECONDS,
): MicroUsd {
  const s = MachineSizeSchema.parse(size);
  const secs = z.int().positive().parse(blockSeconds);
  const perHour =
    BigInt(s.vcpu) * NAIVE_VCPU_HOUR_MICRO_USD + BigInt(s.memory_gb) * NAIVE_GIB_HOUR_MICRO_USD;
  return ceilDiv(perHour * BigInt(secs), SECONDS_PER_HOUR);
}

/** What the user pays for a computer that cost us `cost`: cost + floor(cost x bps / 10_000). */
export function computeChargeMicroUsd(cost: MicroUsd, markupBps: bigint | number): MicroUsd {
  return withMarkupBps(cost, markupBps);
}

// ---- Run fee ------------------------------------------------------------------------------------

export type RunFeeDecision =
  | { billable: true; outcome: "delivered" | "failed_subject" }
  | { billable: false; reason: "run_not_final" | "cancelled" | "failed_not_subject" };

/**
 * Whether a run owes its run fee, from the run's stored state and its trials' stored states.
 *
 * - `delivered`: yes.
 * - `failed`: only when the subject is what failed: the run has trials, at least one ended
 *   `failed_subject`, and every other one is `failed_subject` or `cancelled` (the rest of a run
 *   that stopped). Any `done`, `failed_infra` or unfinished trial means the failure was ours
 *   (infra, scoring, analysis), and a run with no trials failed in our pipeline before any test ran.
 * - `cancelled` or not finished: no.
 *
 * When in doubt this says no: under-billing is a support ticket, over-billing is a broken promise.
 */
export function runFeeDecision(
  runState: RunState,
  trialStates: readonly TrialState[],
): RunFeeDecision {
  if (runState === "delivered") return { billable: true, outcome: "delivered" };
  if (runState === "cancelled") return { billable: false, reason: "cancelled" };
  if (runState !== "failed") return { billable: false, reason: "run_not_final" };
  const subjectFailed =
    trialStates.some((s) => s === "failed_subject") &&
    trialStates.every((s) => s === "failed_subject" || s === "cancelled");
  return subjectFailed
    ? { billable: true, outcome: "failed_subject" }
    : { billable: false, reason: "failed_not_subject" };
}

// ---- Compute ------------------------------------------------------------------------------------

/** The `computers` columns a billing decision needs. */
export interface ComputerForBilling {
  id: string;
  status: string;
  /** The trial that created it (from its `ab-<run>-<trial>` tag); null for a run-level computer. */
  trialId: string | null;
  costMicroUsd: MicroUsd;
}

/** The `trials` columns a billing decision needs, for every trial of the computer's run. */
export interface TrialForBilling {
  id: string;
  state: TrialState;
  computerId: string | null;
}

export type ComputeDecision =
  | {
      billable: true;
      /** The trials the computer served whose state is billable. */
      billedTrialIds: string[];
      /** The usage entry's trial_id: the creating trial when it is one of them, else null. */
      entryTrialId: string | null;
    }
  | {
      billable: false;
      reason: "computer_not_final" | "zero_cost" | "not_billable";
      detail: string;
    };

/**
 * The trials a computer served: every trial whose `computer_id` is this computer (packed blocks
 * share one), plus the creating trial while it has no `computer_id` yet. A creating trial whose
 * `computer_id` now points at ANOTHER computer was retried: this computer was its failed_infra
 * attempt, so it does not count as served (the same rule the reaper uses, TDM-31).
 */
export function servedTrials(
  computer: Pick<ComputerForBilling, "id" | "trialId">,
  runTrials: readonly TrialForBilling[],
): TrialForBilling[] {
  return runTrials.filter(
    (t) => t.computerId === computer.id || (t.id === computer.trialId && t.computerId === null),
  );
}

/**
 * Whether one eval computer is billed, from its stored row and its run's stored trials.
 *
 * - Only a `destroyed` computer: its blocks and cost are final.
 * - A computer that served trials is billed iff at least one of them ended `done` or
 *   `failed_subject` (both terminal, so the answer cannot change later). One that served only
 *   failed_infra (or cancelled) trials is never billed, and neither is an earlier attempt of a
 *   trial that was retried onto another computer.
 * - A run-level computer (no creating trial, no trial pointing at it, e.g. scoring) is folded into
 *   the run's trials: billed iff some trial of the run is billable.
 * - A zero-cost computer (docker-local) makes no entry.
 */
export function computeDecision(
  computer: ComputerForBilling,
  runTrials: readonly TrialForBilling[],
): ComputeDecision {
  if (computer.status !== "destroyed") {
    return {
      billable: false,
      reason: "computer_not_final",
      detail: `computer ${computer.id} is ${computer.status}, not destroyed`,
    };
  }
  const served = servedTrials(computer, runTrials);
  let billed: TrialForBilling[];
  if (served.length > 0) {
    billed = served.filter((t) => isBillableTrialState(t.state));
  } else if (computer.trialId === null) {
    billed = runTrials.filter((t) => isBillableTrialState(t.state));
  } else {
    return {
      billable: false,
      reason: "not_billable",
      detail: `computer ${computer.id} was an earlier attempt of trial ${computer.trialId}, which moved to another computer`,
    };
  }
  if (billed.length === 0) {
    return {
      billable: false,
      reason: "not_billable",
      detail: `computer ${computer.id} served no done or failed_subject trial`,
    };
  }
  if (computer.costMicroUsd === 0n) {
    return { billable: false, reason: "zero_cost", detail: `computer ${computer.id} cost 0` };
  }
  const ids = billed.map((t) => t.id).sort();
  const entryTrialId =
    computer.trialId !== null && ids.includes(computer.trialId) ? computer.trialId : null;
  return { billable: true, billedTrialIds: ids, entryTrialId };
}
