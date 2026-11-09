// The free starter run's config for packages/billing free-run.ts (TDM-223, E20). The Go gate
// (TDM-224) and the pricing page (TDM-226) call the billing functions with this:
//
//   freeRunConfigFrom(config)                     FreeRunConfigInput from the env
//   freeRunEligibility(db, userId, {config})      does this account still have its free run?
//   isStarterRun(kit, estimate, {byokProviders, config})   pure: is this run small enough, BYOK?
//   reserveFreeRun(db, {userId, runId, kit, estimate}, config)   at Go: entitlement + pool, one tx
//   releaseFreeRun(db, {runId, reason})           Go reserved but the run never left awaiting_go
//   freePoolStatus(db, config)                    open/paused and runs remaining (pricing page)
//   settleFreeRun(db, {runId})                    run terminal; the ledger already calls it after
//                                                 recordRunCharges and recordComputerUsage
//
// All of them run on the privileged pool role (the tenant role cannot write these tables).
import type { FreeRunConfigInput } from "@anybench/billing";
import type { Config } from "../config.js";

export function freeRunConfigFrom(
  config: Pick<
    Config,
    | "FREE_RUN_POOL_MICRO_USD"
    | "FREE_RUN_CAP_MICRO_USD"
    | "FREE_RUN_MAX_TRIALS"
    | "RUN_FEE_MICRO_USD"
  >,
): FreeRunConfigInput {
  return {
    poolMicroUsd: config.FREE_RUN_POOL_MICRO_USD,
    capMicroUsd: config.FREE_RUN_CAP_MICRO_USD,
    maxTrials: config.FREE_RUN_MAX_TRIALS,
    runFeeMicroUsd: config.RUN_FEE_MICRO_USD,
  };
}
