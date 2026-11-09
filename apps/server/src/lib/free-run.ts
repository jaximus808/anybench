// The free starter run's config for packages/billing free-run.ts (TDM-223, E20). The Go gate
// (TDM-224) and the pricing page (TDM-226) call the billing functions with this:
//
//   freeRunConfigFrom(config)                     FreeRunConfigInput from the env
//   freeRunEligibility(db, userId, {config})      does this account still have its free run?
//   isStarterRun(kit, estimate, {byokProviders, config})   pure: is this run small enough, BYOK?
//   reserveFreeRun(db, {userId, runId, kit, estimate}, config)   at Go: entitlement + pool, one tx
//   releaseFreeRun(db, {runId, reason})           Go reserved but the run never left awaiting_go
//   freePoolStatus(db, config)                    open/paused and runs remaining (internal)
//   settleFreeRun(db, {runId})                    run terminal; the ledger already calls it after
//                                                 recordRunCharges and recordComputerUsage
//
// TDM-224 adds the Go side here:
//
//   freeRunAtGo(deps, {userId, run})      POST /runs/:id/go, BEFORE the card gate: try to take the
//                                         free run. `skip` (not in play: BILLING_MODE=off, a comped
//                                         run, an admin's run, a kit that does not parse),
//                                         `reserved` (Go needs no card), `refused` (say why; the
//                                         card gate then decides as before) or `conflict` (the run
//                                         moved under us: 409).
//   freeRunRefusalMessage(code, config)   every refusal reason in plain words.
//   freeRunStatusFor(db, config, userId)  the billing summary's `free_run` (onboarding shows it).
//
// TDM-225 adds the read-only estimate the run page shows before Go:
//
//   runEstimateFor(deps, {userId, run})   GET /runs/:id/estimate: the normal price line by line,
//                                         the bound on BYOK tokens (billed by the user's provider,
//                                         never in our price), and whether the free run covers this
//                                         run: the same rules Go applies (isStarterRun on the same
//                                         estimate, the account's eligibility, the pool). `null`
//                                         when the run has no readable kit yet. TDM-244: a kit on
//                                         our model tokens adds `normal.managed_tokens` (at cost +
//                                         MANAGED_TOKEN_MARKUP_BPS, as used) and, with no card on
//                                         file, card_needed + card_message (the Go gate's rule).
//
// TDM-226 adds the public pricing page's two reads (no session, no amounts about the pool):
//
//   publicPricingFor(config)              GET /billing/pricing: rates, free-run limits and the two
//                                         worked examples (packages/billing publicPricingFigures).
//   publicFreePoolFor(db, config)         GET /billing/free-pool: `open` or `paused`, nothing else.
//
// All of them run on the privileged pool role (the tenant role cannot write these tables).
import {
  BYOK_PROVIDERS,
  byokTokenCeilingMicroUsd,
  estimateRunCost,
  FREE_RUN_MAX_SETUPS,
  FREE_RUN_MIN_GITHUB_AGE_DAYS,
  freePoolStatus,
  freeRunEligibility,
  isStarterRun,
  kitSetupCount,
  kitTokenUse,
  publicPricingFigures,
  reserveFreeRun,
  type FreeRunConfigInput,
} from "@anybench/billing";
import {
  safeParseKitSpec,
  type FreeRunRefusal,
  type FreeRunRefusalReason,
  type FreeRunStatus,
  type MicroUsd,
  type PublicFreePool,
  type PublicPricing,
  type RunEstimate,
} from "@anybench/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { computers, kits, runs, userSecrets, users } from "../db/schema/index.js";
import { loadBillingAccount } from "./stripe-billing.js";
import { isUploadedKitRun } from "../orchestrator/ports.js";
import { isAdminLogin } from "./admin.js";
import { MANAGED_TOKENS_NEED_CARD_MESSAGE, managedTokensGateDecision } from "./billing-gate.js";

type FreeRunConfigKeys =
  | "FREE_RUN_POOL_MICRO_USD"
  | "FREE_RUN_CAP_MICRO_USD"
  | "FREE_RUN_MAX_TRIALS"
  | "RUN_FEE_MICRO_USD";

export function freeRunConfigFrom(config: Pick<Config, FreeRunConfigKeys>): FreeRunConfigInput {
  return {
    poolMicroUsd: config.FREE_RUN_POOL_MICRO_USD,
    capMicroUsd: config.FREE_RUN_CAP_MICRO_USD,
    maxTrials: config.FREE_RUN_MAX_TRIALS,
    runFeeMicroUsd: config.RUN_FEE_MICRO_USD,
  };
}

/** Dollars from integer micro-USD for messages ("$10", "$2.50"); cents truncated. Bigint only. */
export function dollars(micro: MicroUsd): string {
  const cents = micro / 10_000n;
  const whole = cents / 100n;
  const rest = cents % 100n;
  return rest === 0n ? `$${whole}` : `$${whole}.${rest.toString().padStart(2, "0")}`;
}

type MessageConfig = Pick<Config, "FREE_RUN_CAP_MICRO_USD" | "FREE_RUN_MAX_TRIALS">;

/** Every reason the free run did not apply, in plain words (the Go screen shows it as is). */
export function freeRunRefusalMessage(code: FreeRunRefusalReason, config: MessageConfig): string {
  switch (code) {
    case "too_many_setups":
      return `A free run compares at most ${FREE_RUN_MAX_SETUPS} setups, and this test plan has more. Drop a contender, or add a card to run it as is.`;
    case "too_many_trials":
      return `A free run has at most ${config.FREE_RUN_MAX_TRIALS} trials, and this test plan has more. Lower the repeats, or add a card to run it as is.`;
    case "managed_tokens":
      return "A free run uses your own model key, but a contender in this test plan runs on Anybench's tokens. Switch it to your Anthropic or OpenAI key, or add a card.";
    case "undeclared_tokens":
      return "A free run uses your own model key, but an agent in this test plan doesn't say which key it uses. Set it to your Anthropic or OpenAI key, or add a card.";
    case "no_byok_key":
      return "A free run uses your own model key. Add your Anthropic or OpenAI key in Settings, or add a card.";
    case "missing_provider_key":
      return "This test plan needs a model key you haven't added yet. Add it in Settings, or add a card.";
    case "over_compute_cap":
      return `This run needs more compute than a free run covers (${dollars(config.FREE_RUN_CAP_MICRO_USD)}). Make it smaller, or add a card to run it as is.`;
    case "pool_off":
      return "Free runs are off right now. Add a card to run at the normal price.";
    case "pool_exhausted":
      return "Free runs are paused right now. Add a card to run at the normal price.";
    case "unknown_user":
      return "This account has no free run. Add a card to continue.";
    case "no_github_account_age":
      return `Free runs are for GitHub accounts older than ${FREE_RUN_MIN_GITHUB_AGE_DAYS} days, and we couldn't read your account's age. Add a card to continue.`;
    case "github_account_too_new":
      return `Free runs are for GitHub accounts older than ${FREE_RUN_MIN_GITHUB_AGE_DAYS} days. Add a card to continue.`;
    case "already_used":
      return "You've used your free run. Add a card to continue.";
    case "in_use":
      return "Your free run is in use on another run. Add a card to start this one too, or wait for that run to finish.";
  }
}

function refusalOf(codes: FreeRunRefusalReason[], config: MessageConfig): FreeRunRefusal {
  const reasons = codes.map((code) => ({ code, message: freeRunRefusalMessage(code, config) }));
  return { reason: reasons[0]!.code, reasons, message: reasons[0]!.message };
}

export type FreeRunAtGo =
  /** The free run is not in play (BILLING_MODE=off, a comped or admin run, an unreadable kit). */
  | { kind: "skip" }
  /** This run holds the free run; `created` = this call reserved it (false: a repeated Go). */
  | { kind: "reserved"; created: boolean; reserveMicroUsd: MicroUsd }
  /** Not free; the card gate decides, and its 402 carries this. */
  | { kind: "refused"; refusal: FreeRunRefusal }
  /** The run moved under us (not awaiting_go, not this owner's, kit origin changed): 409. */
  | { kind: "conflict"; message: string };

export interface FreeRunGoDeps {
  db: Database;
  config: Pick<
    Config,
    | FreeRunConfigKeys
    | "BILLING_MODE"
    | "adminGithubLogins"
    | "UPLOADED_KIT_RUN_FEE_MICRO_USD"
    | "COMPUTE_MARKUP_BPS"
    | "COMPUTER_BLOCK_PRICE_MICRO_USD"
    | "MANAGED_TOKEN_MARKUP_BPS"
  >;
}

export type FreeRunGoRun = Pick<typeof runs.$inferSelect, "id" | "kitId" | "intake" | "compedBy">;

/**
 * Go's free path (TDM-224). Runs BEFORE the card gate, so an eligible account's first starter run
 * is free even with a card on file. The reservation (entitlement + pool) is one transaction in
 * packages/billing reserveFreeRun; the caller moves the run out of awaiting_go afterwards and must
 * releaseFreeRun when it reserved (`created`) and that move fails.
 */
export async function freeRunAtGo(
  deps: FreeRunGoDeps,
  input: { userId: string; run: FreeRunGoRun },
): Promise<FreeRunAtGo> {
  const { db, config } = deps;
  if (config.BILLING_MODE === "off") return { kind: "skip" };
  // A comped run bills nothing, and an admin's run is comped by the gate (founder demo): neither
  // spends the account's free run or the pool.
  if (input.run.compedBy !== null) return { kind: "skip" };
  const [owner] = await db
    .select({ githubLogin: users.githubLogin })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (owner && isAdminLogin(config, owner.githubLogin)) return { kind: "skip" };
  if (!input.run.kitId) return { kind: "skip" };
  const [kit] = await db
    .select({ spec: kits.spec })
    .from(kits)
    .where(eq(kits.id, input.run.kitId))
    .limit(1);
  const spec = kit ? safeParseKitSpec(kit.spec) : null;
  if (!spec?.success) return { kind: "skip" };
  const estimate = estimateRunCost(
    spec.data,
    {
      runFeeMicroUsd: config.RUN_FEE_MICRO_USD,
      uploadedKitRunFeeMicroUsd: config.UPLOADED_KIT_RUN_FEE_MICRO_USD,
      computeMarkupBps: config.COMPUTE_MARKUP_BPS,
      defaultBlockPriceMicroUsd: config.COMPUTER_BLOCK_PRICE_MICRO_USD,
    },
    { kitOrigin: isUploadedKitRun(input.run.intake) ? "uploaded" : "generated" },
  );
  const result = await reserveFreeRun(
    db,
    { userId: input.userId, runId: input.run.id, kit: spec.data, estimate },
    freeRunConfigFrom(config),
  );
  if (result.status === "reserved" || result.status === "duplicate") {
    return {
      kind: "reserved",
      created: result.status === "reserved",
      reserveMicroUsd: result.freeRun.reservedMicroUsd,
    };
  }
  switch (result.reason) {
    case "not_eligible":
      return { kind: "refused", refusal: refusalOf([result.eligibility], config) };
    case "not_starter":
      return {
        kind: "refused",
        refusal: refusalOf(
          result.rejections.map((r) => r.code),
          config,
        ),
      };
    case "pool_exhausted":
      return { kind: "refused", refusal: refusalOf(["pool_exhausted"], config) };
    default:
      return { kind: "conflict", message: result.message };
  }
}

/** The billing summary's `free_run`: does this account still have its free run, and can it Go? */
export async function freeRunStatusFor(
  db: Database,
  config: Pick<Config, FreeRunConfigKeys>,
  userId: string,
): Promise<FreeRunStatus> {
  const freeConfig = freeRunConfigFrom(config);
  const [eligibility, pool, keys] = await Promise.all([
    freeRunEligibility(db, userId, { config: freeConfig }),
    freePoolStatus(db, freeConfig),
    db
      .select({ provider: userSecrets.provider })
      .from(userSecrets)
      .where(
        and(eq(userSecrets.ownerId, userId), inArray(userSecrets.provider, [...BYOK_PROVIDERS])),
      ),
  ]);
  const base = {
    has_model_key: keys.length > 0,
    limits: {
      max_setups: FREE_RUN_MAX_SETUPS,
      max_trials: config.FREE_RUN_MAX_TRIALS,
      compute_cap_micro_usd: config.FREE_RUN_CAP_MICRO_USD,
    },
  };
  if (!eligibility.eligible) {
    const reason = eligibility.reason;
    const runId = (eligibility.runId ?? null) as FreeRunStatus["run_id"];
    if (reason === "in_use") {
      return {
        status: "in_use",
        reason,
        message: "Your free run is in progress.",
        run_id: runId,
        ...base,
      };
    }
    if (reason === "already_used") {
      return {
        status: "used",
        reason,
        message: "You've used your free run. Add a card to keep benchmarking.",
        run_id: runId,
        ...base,
      };
    }
    return {
      status: "not_eligible",
      reason,
      message: freeRunRefusalMessage(reason, config),
      run_id: null,
      ...base,
    };
  }
  if (config.FREE_RUN_POOL_MICRO_USD === 0n || pool.state === "paused") {
    const reason = config.FREE_RUN_POOL_MICRO_USD === 0n ? "pool_off" : "pool_exhausted";
    return {
      status: "paused",
      reason,
      message: freeRunRefusalMessage(reason, config),
      run_id: null,
      ...base,
    };
  }
  return {
    status: "available",
    reason: null,
    message: base.has_model_key
      ? "Your first benchmark is free: no card needed."
      : "Your first benchmark is free: no card needed. Add your Anthropic or OpenAI key to use it.",
    run_id: null,
    ...base,
  };
}

// ---- The estimate before Go (TDM-225) -----------------------------------------------------------

export type RunEstimateRun = Pick<typeof runs.$inferSelect, "id" | "kitId" | "intake" | "compedBy">;

/**
 * GET /runs/:id/estimate (TDM-225): what the run costs, line by line, and whether the account's
 * free starter run covers it. Read-only: the same rules freeRunAtGo applies at Go (isStarterRun on
 * the same estimate, with the compute the run already used, the account, the pool), so the page
 * says "Free" exactly when Go would take the free run. `null` while the run has no readable kit.
 */
export async function runEstimateFor(
  deps: FreeRunGoDeps,
  input: { userId: string; run: RunEstimateRun },
): Promise<RunEstimate | null> {
  const { db, config } = deps;
  const { run } = input;
  if (!run.kitId) return null;
  const [kit] = await db
    .select({ spec: kits.spec })
    .from(kits)
    .where(eq(kits.id, run.kitId))
    .limit(1);
  const spec = kit ? safeParseKitSpec(kit.spec) : null;
  if (!spec?.success) return null;
  const kitOrigin = isUploadedKitRun(run.intake) ? "uploaded" : "generated";
  const estimate = estimateRunCost(
    spec.data,
    {
      runFeeMicroUsd: config.RUN_FEE_MICRO_USD,
      uploadedKitRunFeeMicroUsd: config.UPLOADED_KIT_RUN_FEE_MICRO_USD,
      computeMarkupBps: config.COMPUTE_MARKUP_BPS,
      defaultBlockPriceMicroUsd: config.COMPUTER_BLOCK_PRICE_MICRO_USD,
    },
    { kitOrigin },
  );
  const tokens = kitTokenUse(spec.data);
  const byokProviders = [...new Set(tokens.byok.map((b) => b.provider))].sort();
  const base = {
    run_id: run.id as RunEstimate["run_id"],
    kit_origin: kitOrigin,
    normal: {
      run_fee_micro_usd: estimate.runFeeMicroUsd,
      compute: {
        computers: estimate.compute.computers,
        trials: estimate.compute.trials,
        blocks: Number(estimate.compute.blocks),
        block_seconds: estimate.compute.blockSeconds,
        charge_micro_usd: estimate.compute.chargeMicroUsd,
      },
      total_micro_usd: estimate.totalMicroUsd,
      // TDM-244: our model tokens are real charges now: at cost + MANAGED_TOKEN_MARKUP_BPS.
      managed_tokens:
        tokens.managed.length > 0
          ? {
              contenders: tokens.managed,
              markup_bps: Number(config.MANAGED_TOKEN_MARKUP_BPS),
            }
          : null,
    },
    tokens: {
      byok_providers: byokProviders,
      byok_ceiling_micro_usd: byokTokenCeilingMicroUsd(spec.data),
      managed_contenders: tokens.managed,
    },
  } satisfies Omit<
    RunEstimate,
    "price" | "total_micro_usd" | "free_run" | "card_needed" | "card_message"
  >;
  const paid = { price: "paid" as const, total_micro_usd: estimate.totalMicroUsd };

  // Not in play: nothing is billed (BILLING_MODE=off), or the run is comped (an admin's run is
  // comped by the gate at Go): no free run, and no card.
  const [owner] = await db
    .select({ githubLogin: users.githubLogin })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (
    config.BILLING_MODE === "off" ||
    run.compedBy !== null ||
    (owner && isAdminLogin(config, owner.githubLogin))
  ) {
    return { ...base, ...paid, free_run: null, card_needed: false, card_message: null };
  }

  const status = await freeRunStatusFor(db, config, input.userId);
  const setups = kitSetupCount(spec.data);
  let applies = false;
  let refusal: FreeRunRefusal | null = null;
  if (status.status === "in_use" && status.run_id === run.id) {
    applies = true; // this run already holds the free run (Go reserved it)
  } else if (status.status === "available") {
    const keys = await db
      .select({ provider: userSecrets.provider })
      .from(userSecrets)
      .where(eq(userSecrets.ownerId, input.userId));
    const [spentRow] = await db
      .select({ sum: sql<string>`coalesce(sum(${computers.costMicroUsd}), 0)::text` })
      .from(computers)
      .where(eq(computers.runId, run.id));
    const decision = isStarterRun(spec.data, estimate, {
      byokProviders: keys.map((k) => k.provider),
      config: freeRunConfigFrom(config),
      spentCostMicroUsd: BigInt(spentRow?.sum ?? "0"),
    });
    if (decision.starter) applies = true;
    else
      refusal = refusalOf(
        decision.reasons.map((r) => r.code),
        config,
      );
  } else if (status.reason) {
    refusal = refusalOf([status.reason], config);
  }

  const freeRun = {
    status: status.status,
    applies,
    refusal,
    limits: status.limits,
    setups,
  };
  if (applies) {
    return {
      ...base,
      price: "free",
      total_micro_usd: 0n,
      free_run: freeRun,
      card_needed: false,
      card_message: null,
    };
  }
  const account = await loadBillingAccount(db, input.userId);
  const card = account.paymentStatus === "ok" && account.hasPaymentMethod;
  const covered = account.grantedRemainingMicroUsd >= estimate.totalMicroUsd;
  // TDM-244: the same rule as the Go gate: our model tokens need a card on file, credit or not.
  const managedNeedsCard = managedTokensGateDecision(account, tokens.managed) !== null;
  return {
    ...base,
    ...paid,
    free_run: freeRun,
    card_needed: (!card && !covered) || managedNeedsCard,
    card_message: managedNeedsCard ? MANAGED_TOKENS_NEED_CARD_MESSAGE : null,
  };
}

// ---- The public pricing page (TDM-226) ----------------------------------------------------------

export type PublicPricingConfigKeys =
  | FreeRunConfigKeys
  | "UPLOADED_KIT_RUN_FEE_MICRO_USD"
  | "COMPUTE_MARKUP_BPS"
  | "COMPUTER_BLOCK_PRICE_MICRO_USD"
  | "MANAGED_TOKEN_MARKUP_BPS";

/**
 * GET /billing/pricing: every number on /pricing, from this deployment's billing config through
 * packages/billing publicPricingFigures (estimateRunCost and isStarterRun on the fixed example
 * kits). Pure; the integer JSON fields (basis points, block counts) are converted here.
 */
export function publicPricingFor(config: Pick<Config, PublicPricingConfigKeys>): PublicPricing {
  const f = publicPricingFigures({
    runFeeMicroUsd: config.RUN_FEE_MICRO_USD,
    uploadedKitRunFeeMicroUsd: config.UPLOADED_KIT_RUN_FEE_MICRO_USD,
    computeMarkupBps: config.COMPUTE_MARKUP_BPS,
    managedTokenMarkupBps: config.MANAGED_TOKEN_MARKUP_BPS,
    defaultBlockPriceMicroUsd: config.COMPUTER_BLOCK_PRICE_MICRO_USD,
    freeRun: freeRunConfigFrom(config),
  });
  return {
    rates: {
      run_fee_micro_usd: f.rates.runFeeMicroUsd,
      uploaded_kit_run_fee_micro_usd: f.rates.uploadedKitRunFeeMicroUsd,
      compute_markup_bps: Number(f.rates.computeMarkupBps),
      managed_token_markup_bps: Number(f.rates.managedTokenMarkupBps),
      block_seconds: f.rates.blockSeconds,
      machine: {
        vcpu: f.rates.machine.vcpu,
        memory_gb: f.rates.machine.memory_gb,
        block_cost_micro_usd: f.rates.machine.blockCostMicroUsd,
        block_charge_micro_usd: f.rates.machine.blockChargeMicroUsd,
      },
    },
    free_run: {
      offered: f.freeRun.offered,
      max_setups: f.freeRun.maxSetups,
      max_trials: f.freeRun.maxTrials,
      compute_cap_micro_usd: f.freeRun.computeCapMicroUsd,
      min_github_age_days: f.freeRun.minGithubAgeDays,
    },
    examples: f.examples.map((e) => ({
      id: e.id,
      title: e.title,
      summary: e.summary,
      kit_origin: e.estimate.kitOrigin,
      setups: e.setups,
      workloads: e.workloads,
      repeats: e.repeats,
      tokens: e.tokens,
      free: e.free,
      run_fee_micro_usd: e.estimate.runFeeMicroUsd,
      compute: {
        computers: e.estimate.compute.computers,
        trials: e.estimate.compute.trials,
        blocks: Number(e.estimate.compute.blocks),
        block_seconds: e.estimate.compute.blockSeconds,
        est_trial_seconds: e.estimate.compute.estTrialSeconds,
        charge_micro_usd: e.estimate.compute.chargeMicroUsd,
      },
      total_micro_usd: e.estimate.totalMicroUsd,
    })),
  };
}

/**
 * GET /billing/free-pool: `open` while the pool can fund a default-size starter, else `paused`
 * (packages/billing freePoolStatus). Only the state leaves the server: never the pool's amounts
 * or how many runs are left.
 */
export async function publicFreePoolFor(
  db: Database,
  config: Pick<Config, FreeRunConfigKeys>,
): Promise<PublicFreePool> {
  const pool = await freePoolStatus(db, freeRunConfigFrom(config));
  return { state: pool.state };
}
