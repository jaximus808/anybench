// Cost-plus pricing (TDM-171, plan.md section 8, founder decision 2026-11-07).
//
// What a user pays for one benchmark run, decided once the run is terminal:
//   - delivered, or failed because of the subject: one `run_fee` of RUN_FEE_MICRO_USD plus compute;
//   - cancelled by the user: compute actually consumed, no run fee (otherwise start-then-cancel
//     would be free compute);
//   - failed because of infrastructure or our own pipeline: nothing at all;
//   - not terminal yet (live or on hold): nothing yet (`run_not_final`).
// Compute is one `compute` charge per eval computer: what Naïve charged us for it (the computers
// registry, TDM-31: blocks billed x block price, `computers.cost_micro_usd`) plus
// COMPUTE_MARKUP_BPS, rounded down. Inside a billable run, a computer that only served
// failed_infra attempts (or was an earlier attempt of a retried trial) is never billed.
//
// Everything here is pure and bigint: the ledger (ledger.ts) feeds it the rows it read under lock,
// so the decisions are made from what the DATABASE says, never from what a caller claims.
import {
  isTerminalRunState,
  NonNegativeMicroUsdSchema,
  RunKitOriginSchema,
  withMarkupBps,
  type MicroUsd,
  type RunKitOrigin,
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

/** MANAGED_TOKEN_MARKUP_BPS's default: our model tokens are billed at Naïve cost + 20%. */
export const DEFAULT_MANAGED_TOKEN_MARKUP_BPS = 2000n;

/**
 * The cost-plus knobs, from config (RUN_FEE_MICRO_USD, COMPUTE_MARKUP_BPS,
 * MANAGED_TOKEN_MARKUP_BPS).
 */
export const CostPlusPricingSchema = z.object({
  runFeeMicroUsd: NonNegativeMicroUsdSchema,
  computeMarkupBps: BpsSchema,
  /** TDM-244: our model tokens (Naïve proxy) are billed at cost + this. */
  managedTokenMarkupBps: BpsSchema.default(DEFAULT_MANAGED_TOKEN_MARKUP_BPS),
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

/**
 * Where a run's eval kit came from (TDM-218, E19). `generated`: our Naïve agents understood the
 * project, researched baselines and designed the kit, which RUN_FEE_MICRO_USD pays for.
 * `uploaded`: the user's own coding agent built the kit and uploaded it, so no kit generation runs
 * on our side and the run fee is UPLOADED_KIT_RUN_FEE_MICRO_USD (default 0). The proof still runs
 * on our computers either way. An uploaded kit's proof computers carry the run id (proof-runner.ts
 * billToRun), so they are billed as compute with the run (computeDecision folds a run-level
 * computer into the run's trials: never for our infra failures or our cancels).
 */

export const RunFeePricingSchema = z.object({
  /** RUN_FEE_MICRO_USD: a run whose kit our agents generated. */
  runFeeMicroUsd: NonNegativeMicroUsdSchema,
  /** UPLOADED_KIT_RUN_FEE_MICRO_USD: a run from an uploaded kit (no kit generation). */
  uploadedKitRunFeeMicroUsd: NonNegativeMicroUsdSchema.default(0n),
});
export type RunFeePricingInput = z.input<typeof RunFeePricingSchema>;

/** The run fee for a run whose kit has this origin, integer micro-USD. */
export function runFeeForKit(origin: RunKitOrigin, pricingInput: RunFeePricingInput): MicroUsd {
  const pricing = RunFeePricingSchema.parse(pricingInput);
  return RunKitOriginSchema.parse(origin) === "uploaded"
    ? pricing.uploadedKitRunFeeMicroUsd
    : pricing.runFeeMicroUsd;
}

export type RunFeeDecision =
  | { billable: true; outcome: "delivered" | "failed_subject" }
  | { billable: false; reason: "run_not_final" | "cancelled" | "failed_not_subject" };

/**
 * Who cancelled a run: `runs.cancel_cause` (TDM-54). The cancel route stores `user`; the
 * orchestrator stores `ours` for a kill switch or ANYBENCH_PAUSE (and 9.3 auto-actions / admin
 * must too). A cancel by us bills nothing. Rows from before TDM-54 have none and count as `user`.
 */
export type CancelCause = "user" | "ours";

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

export type ComputeRunDecision =
  | {
      billable: true;
      basis: "delivered" | "failed_subject" | "user_cancelled";
      /** Trial states whose computers are billed in this run. */
      trialStates: readonly TrialState[];
    }
  | { billable: false; reason: "run_not_final" | "not_billable"; detail: string };

const SUBJECT_STATES: readonly TrialState[] = ["done", "failed_subject"];
/** A user cancel bills what ran: also the trials cut off mid-run by the cancel. */
const USER_CANCELLED_STATES: readonly TrialState[] = ["done", "failed_subject", "cancelled"];

/**
 * Whether a run's compute is billable at all, from its stored state and its trials' states:
 * delivered or subject-failed (the run fee rule, runFeeDecision), or cancelled by the user.
 * A run that failed in infra or our pipeline, or that we cancelled, bills no compute; a run that is
 * not terminal bills nothing yet.
 */
export function computeRunDecision(
  runState: RunState,
  trialStates: readonly TrialState[],
  cancelCause: CancelCause = "user",
): ComputeRunDecision {
  if (runState === "cancelled") {
    return cancelCause === "user"
      ? { billable: true, basis: "user_cancelled", trialStates: USER_CANCELLED_STATES }
      : { billable: false, reason: "not_billable", detail: "run was cancelled by us" };
  }
  if (!isTerminalRunState(runState)) {
    return {
      billable: false,
      reason: "run_not_final",
      detail: `run is ${runState}, not terminal`,
    };
  }
  const fee = runFeeDecision(runState, trialStates);
  if (!fee.billable) {
    return {
      billable: false,
      reason: "not_billable",
      detail: `run is ${runState} (${fee.reason}): failed in infra or our pipeline`,
    };
  }
  return { billable: true, basis: fee.outcome, trialStates: SUBJECT_STATES };
}

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
      reason: "run_not_final" | "computer_not_final" | "zero_cost" | "not_billable";
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
 * Whether one eval computer is billed, from its stored row, its run's stored state and the run's
 * stored trials.
 *
 * - Only inside a compute-billable run (computeRunDecision): delivered, subject-failed or
 *   user-cancelled. A non-terminal run gives `run_not_final` (bill it later); a run that failed in
 *   infra or our pipeline, or that we cancelled, is never billed.
 * - Only a `destroyed` computer: its blocks and cost are final.
 * - A computer that served trials is billed iff at least one of them ended in a state the run
 *   bills (done or failed_subject; plus cancelled in a user-cancelled run). One that served only
 *   failed_infra trials is never billed, and neither is an earlier attempt of a trial that was
 *   retried onto another computer.
 * - A run-level computer (no creating trial, no trial pointing at it, e.g. scoring) is folded into
 *   the run's trials: billed iff some trial of the run is billed.
 * - A zero-cost computer (docker-local) makes no entry.
 *
 * Every input is final once the run is terminal, so the answer cannot change afterwards.
 */
export function computeDecision(
  computer: ComputerForBilling,
  runState: RunState,
  runTrials: readonly TrialForBilling[],
  cancelCause: CancelCause = "user",
): ComputeDecision {
  const run = computeRunDecision(
    runState,
    runTrials.map((t) => t.state),
    cancelCause,
  );
  if (!run.billable) return { billable: false, reason: run.reason, detail: run.detail };
  if (computer.status !== "destroyed") {
    return {
      billable: false,
      reason: "computer_not_final",
      detail: `computer ${computer.id} is ${computer.status}, not destroyed`,
    };
  }
  const bills = (t: TrialForBilling) => run.trialStates.includes(t.state);
  const served = servedTrials(computer, runTrials);
  let billed: TrialForBilling[];
  if (served.length > 0) {
    billed = served.filter(bills);
  } else if (computer.trialId === null) {
    billed = runTrials.filter(bills);
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
      detail: `computer ${computer.id} served no trial in a billed state (${run.trialStates.join(", ")})`,
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

// ---- Managed tokens (TDM-244) -------------------------------------------------------------------

/** The `trials` columns the managed-token decision needs (the trial being billed). */
export interface TrialTokensForBilling {
  id: string;
  state: TrialState;
  attempt: number;
  /** The attempt's Naïve proxy key; null = the trial ran on the user's own key (BYOK) or no model. */
  proxyKeyId: string | null;
  proxyKeyAttempt: number | null;
}

export type ManagedTokensDecision =
  | { billable: true; cost: MicroUsd }
  | {
      billable: false;
      reason: "run_not_final" | "not_billable" | "spend_unknown" | "zero_cost";
      detail: string;
    };

/**
 * Whether one trial's model tokens on OUR Naïve proxy key are billed, and at what cost to us.
 * The same rules as its compute (computeRunDecision): only inside a delivered, subject-failed or
 * user-cancelled run, and only for a trial in a state the run bills (done, failed_subject; plus
 * cancelled in a user-cancelled run). A failed_infra trial, a run that failed in our infra or
 * pipeline and a cancel by us never bill tokens. Only the CURRENT attempt's key counts: an earlier
 * attempt (a failed_infra retry) was ours. `cost` is that key's spend (Naïve credits ledger),
 * null when it could not be read: then nothing is billed (`spend_unknown`), never a guess.
 */
export function managedTokensDecision(
  trial: TrialTokensForBilling,
  runState: RunState,
  runTrialStates: readonly TrialState[],
  cancelCause: CancelCause,
  cost: MicroUsd | null,
): ManagedTokensDecision {
  const run = computeRunDecision(runState, runTrialStates, cancelCause);
  if (!run.billable) return { billable: false, reason: run.reason, detail: run.detail };
  if (trial.proxyKeyId === null) {
    return {
      billable: false,
      reason: "not_billable",
      detail: `trial ${trial.id} used no Anybench model tokens (its own key, or no model)`,
    };
  }
  if (!run.trialStates.includes(trial.state)) {
    return {
      billable: false,
      reason: "not_billable",
      detail: `trial ${trial.id} is ${trial.state}, not a billed state (${run.trialStates.join(", ")})`,
    };
  }
  if (trial.proxyKeyAttempt !== trial.attempt) {
    return {
      billable: false,
      reason: "spend_unknown",
      detail: `trial ${trial.id}: its proxy key belongs to attempt ${String(trial.proxyKeyAttempt)}, not ${trial.attempt}`,
    };
  }
  if (cost === null) {
    return {
      billable: false,
      reason: "spend_unknown",
      detail: `trial ${trial.id}: its proxy key spend could not be read`,
    };
  }
  if (cost === 0n) {
    return { billable: false, reason: "zero_cost", detail: `trial ${trial.id}: no model tokens` };
  }
  return { billable: true, cost };
}

/** What the user pays for model tokens that cost us `cost`: cost + floor(cost x bps / 10_000). */
export function managedTokensChargeMicroUsd(cost: MicroUsd, markupBps: bigint | number): MicroUsd {
  return withMarkupBps(cost, markupBps);
}
