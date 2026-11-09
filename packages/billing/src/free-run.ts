// Free starter run: one free benchmark per eligible account, funded by a global pool (TDM-223,
// E20, founder decision 2026-11-08). Replaces the $5 signup grant (SIGNUP_GRANT_MICRO_USD now
// defaults to 0; signup-grant.ts keeps it working when set).
//
// The rules:
//   - Eligible: a GitHub account older than FREE_RUN_MIN_GITHUB_AGE_DAYS (90, the existing abuse
//     rule); an account with no GitHub creation date (email-only) is not. One per account: at most
//     one `reserved` or `consumed` free_starter_runs row per user (partial unique index).
//   - Starter run (isStarterRun, pure): at most FREE_RUN_MAX_SETUPS (2) setups, at most
//     FREE_RUN_MAX_TRIALS trials (warm-ups included), BYOK tokens only (every agent contender reads
//     the user's own Anthropic or OpenAI key, none uses our Naïve proxy, and the user has a key
//     stored in user_secrets), and projected compute AT OUR COST (plus compute the run already
//     used, e.g. an uploaded kit's proof, TDM-218) <= FREE_RUN_CAP_MICRO_USD. An uploaded-kit run
//     qualifies like any other and is cheaper (no agent allowance).
//   - Pool (FREE_RUN_POOL_MICRO_USD, at our cost): Go reserves the starter's cost
//     (projected compute cost + compute already used + agent allowance, where the allowance is the
//     run fee for the kit's origin: what RUN_FEE_MICRO_USD is priced to cover, 0 for an uploaded
//     kit) with ONE conditional UPDATE (`reserved + spent + amount <= pool`), so concurrent Go
//     presses can never oversubscribe it. When it cannot cover the starter, the free run is refused
//     with `pool_exhausted` and freePoolStatus says `paused`: the site shows normal pricing.
//   - Settle (settleFreeRun, idempotent, called by the ledger after it bills the run): once the run
//     is terminal, a real outcome (delivered, subject-failed including a capped subject failure,
//     or cancelled by the user) CONSUMES the entitlement and every charge the ledger recorded for
//     the run (run fee, compute, managed tokens) is covered by a credit grant of source `free_run`,
//     so the user's balance nets to zero and the ledger stays auditable. Covered entries are marked
//     settled with meter id `free_run:<grant id>` and never reach Stripe. A run that failed in our
//     infra or pipeline, or that we cancelled, RELEASES the entitlement (the ledger bills nothing
//     for it either). Either way the reservation goes back to the pool and what the run actually
//     cost us (its computers' registry cost + the agent allowance) is added to `spent`.
//   - releaseFreeRun: Go reserved but the run never started (the Go transaction failed, the user
//     backed out): the reservation and the entitlement go back.
//   - Cancelled before Go (TDM-243): a run the user cancelled while it was still in awaiting_go
//     never started, so a reservation it still holds (possible only after a crash between reserve
//     and the Go transition, or a Go racing the cancel) is RELEASED (`user_cancel_before_go`), not
//     consumed. The cancel route stamps runs.stage_outputs.cancelled_from = 'awaiting_go' in the
//     cancel's own transaction and then calls releaseFreeRun; settleFreeRun applies the same rule,
//     so whichever runs first, the outcome is the same. A user cancel AFTER Go still consumes.
//
// The correctness gate and statistics are unchanged on free runs: nothing here touches results.
//
// Lock order (no deadlock with the ledger or the meter reporter): free_starter_runs row, run
// (FOR SHARE), trials (FOR SHARE), billing account (FOR UPDATE), usage entries, pool row.
// Every amount is bigint micro-USD; no float path.
import {
  isAgentDriver,
  isTerminalRunState,
  KitSpecSchema,
  NonNegativeMicroUsdSchema,
  RunIdSchema,
  UserIdSchema,
  newId,
  CreditGrantIdSchema,
  uuidv7,
  type KitSpec,
  type KitSpecInput,
  type MicroUsd,
} from "@anybench/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { applyNetDelta } from "./balance.js";
import type { RunCostEstimate } from "./estimate.js";
import type { LedgerDb } from "./ledger.js";
import { computeRunDecision } from "./pricing.js";
import {
  billingAccounts,
  computers,
  creditGrants,
  freeRunPool,
  freeStarterRuns,
  runs,
  trials,
  usageEntries,
  userSecrets,
  users,
} from "./tables.js";

type Tx = Parameters<Parameters<LedgerDb["transaction"]>[0]>[0];

// ---- Constants and config -----------------------------------------------------------------------

/** At most this many setups (contenders x their `vary` combinations) in a starter run. */
export const FREE_RUN_MAX_SETUPS = 2;
/** The existing abuse rule: free credit only for GitHub accounts older than this. */
export const FREE_RUN_MIN_GITHUB_AGE_DAYS = 90;
/** The one pool row. */
export const FREE_RUN_POOL_ID = "global";
/** Prefix of the meter id stamped on usage entries a free run covered (never sent to Stripe). */
export const FREE_RUN_METER_PREFIX = "free_run:";
/** user_secrets.provider values that count as BYOK model keys. */
export const BYOK_PROVIDERS = ["anthropic", "openai"] as const;
export type ByokProvider = (typeof BYOK_PROVIDERS)[number];
/** driver.env AB_TOKEN_SOURCE values that read the user's own key, and the provider they need. */
export const BYOK_TOKEN_SOURCES: Readonly<Record<string, ByokProvider>> = {
  anthropic_key: "anthropic",
  openai_key: "openai",
};
/** The token source that spends OUR tokens (the Naïve proxy, TDM-16): never in a free run. */
export const MANAGED_TOKEN_SOURCE = "naive_proxy";

const DAY_MS = 86_400_000;

/**
 * The free-run knobs, from apps/server config: FREE_RUN_POOL_MICRO_USD, FREE_RUN_CAP_MICRO_USD,
 * FREE_RUN_MAX_TRIALS, and RUN_FEE_MICRO_USD (the agent allowance of the default starter, used by
 * freePoolStatus to say how many free runs are left).
 */
export const FreeRunConfigSchema = z.object({
  /** FREE_RUN_POOL_MICRO_USD: what free runs may cost us in total (default $50). 0 = off. */
  poolMicroUsd: NonNegativeMicroUsdSchema,
  /** FREE_RUN_CAP_MICRO_USD: a starter's compute, at our cost (default $10). */
  capMicroUsd: NonNegativeMicroUsdSchema,
  /** FREE_RUN_MAX_TRIALS: a starter's trials, warm-ups included. */
  maxTrials: z.int().nonnegative(),
  /** RUN_FEE_MICRO_USD: the default starter's agent allowance (freePoolStatus only). */
  runFeeMicroUsd: NonNegativeMicroUsdSchema,
  maxSetups: z.int().positive().default(FREE_RUN_MAX_SETUPS),
  minGithubAgeDays: z.int().nonnegative().default(FREE_RUN_MIN_GITHUB_AGE_DAYS),
});
export type FreeRunConfig = z.output<typeof FreeRunConfigSchema>;
export type FreeRunConfigInput = z.input<typeof FreeRunConfigSchema>;

export class FreeRunError extends Error {
  readonly code: "invalid_input";
  constructor(message: string) {
    super(message);
    this.name = "FreeRunError";
    this.code = "invalid_input";
  }
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new FreeRunError(
      r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  return r.data;
}

// ---- Pure rules ---------------------------------------------------------------------------------

/** Whether a GitHub account created at `githubCreatedAt` is old enough at `now`. Null = no. */
export function githubAgeEligible(
  githubCreatedAt: Date | null | undefined,
  now: Date,
  minDays: number = FREE_RUN_MIN_GITHUB_AGE_DAYS,
): boolean {
  if (!githubCreatedAt) return false;
  return now.getTime() - githubCreatedAt.getTime() > minDays * DAY_MS;
}

/**
 * Setups in a kit: each contender once per combination of the `vary` values that apply to it (a
 * `vary` key applies when the contender's driver.env sets it, packages/kit expandVarySetups).
 */
export function kitSetupCount(kitInput: KitSpec | KitSpecInput): number {
  const kit = KitSpecSchema.parse(kitInput);
  let total = 0;
  for (const c of kit.contenders) {
    let combos = 1;
    for (const [key, values] of Object.entries(kit.vary)) {
      if (c.driver.env?.[key] !== undefined) combos *= values.length;
    }
    total += combos;
  }
  return total;
}

export interface KitTokenUse {
  /** Contenders on our tokens (AB_TOKEN_SOURCE=naive_proxy). */
  managed: string[];
  /** Agent contenders on the user's own key, and which provider's key. */
  byok: { contenderId: string; provider: ByokProvider }[];
  /** Agent contenders that declare no BYOK token source: whose tokens they spend is unknown. */
  undeclared: string[];
}

/** Whose model tokens each contender spends, from driver.env AB_TOKEN_SOURCE. */
export function kitTokenUse(kitInput: KitSpec | KitSpecInput): KitTokenUse {
  const kit = KitSpecSchema.parse(kitInput);
  const out: KitTokenUse = { managed: [], byok: [], undeclared: [] };
  for (const c of kit.contenders) {
    const source = c.driver.env?.AB_TOKEN_SOURCE;
    const provider = source === undefined ? undefined : BYOK_TOKEN_SOURCES[String(source)];
    if (source === MANAGED_TOKEN_SOURCE) out.managed.push(c.id);
    else if (provider) out.byok.push({ contenderId: c.id, provider });
    else if (isAgentDriver(c.driver)) out.undeclared.push(c.id);
  }
  return out;
}

export type StarterRejectionCode =
  | "pool_off"
  | "too_many_setups"
  | "too_many_trials"
  | "managed_tokens"
  | "undeclared_tokens"
  | "no_byok_key"
  | "missing_provider_key"
  | "over_compute_cap";

export interface StarterRejection {
  code: StarterRejectionCode;
  message: string;
}

export type StarterRunDecision =
  | {
      starter: true;
      setups: number;
      trials: number;
      /** Projected compute at our cost plus compute the run already used. */
      computeCostMicroUsd: MicroUsd;
      /** Our kit agents' share: the run fee for the kit's origin (0 for an uploaded kit). */
      agentAllowanceMicroUsd: MicroUsd;
      /** What Go reserves from the pool: computeCostMicroUsd + agentAllowanceMicroUsd. */
      reserveMicroUsd: MicroUsd;
    }
  | { starter: false; reasons: StarterRejection[] };

export interface IsStarterRunOptions {
  /** user_secrets providers the run owner has stored (`anthropic`, `openai`, ...). */
  byokProviders: readonly string[];
  config: FreeRunConfigInput;
  /**
   * Compute the run already used, at our cost (an uploaded kit's proof computers, billed with the
   * run, TDM-218). reserveFreeRun reads it from the computers registry. Default 0.
   */
  spentCostMicroUsd?: MicroUsd;
}

/**
 * Whether a run of this kit, at this estimate (estimate.ts estimateRunCost), is a free starter
 * run. Pure: every reason it is not comes back, so the Go screen can say what to trim.
 */
export function isStarterRun(
  specInput: KitSpec | KitSpecInput,
  estimate: RunCostEstimate,
  opts: IsStarterRunOptions,
): StarterRunDecision {
  const kit = KitSpecSchema.parse(specInput);
  const config = parse(FreeRunConfigSchema, opts.config);
  const spent = parse(NonNegativeMicroUsdSchema, opts.spentCostMicroUsd ?? 0n);
  const reasons: StarterRejection[] = [];
  if (config.poolMicroUsd === 0n) {
    reasons.push({ code: "pool_off", message: "free runs are off (FREE_RUN_POOL_MICRO_USD=0)" });
  }
  const setups = kitSetupCount(kit);
  if (setups > config.maxSetups) {
    reasons.push({
      code: "too_many_setups",
      message: `${setups} setups; a free run compares at most ${config.maxSetups}`,
    });
  }
  const trialCount = estimate.compute.trials;
  if (trialCount > config.maxTrials) {
    reasons.push({
      code: "too_many_trials",
      message: `${trialCount} trials; a free run has at most ${config.maxTrials}`,
    });
  }
  const tokens = kitTokenUse(kit);
  if (tokens.managed.length > 0) {
    reasons.push({
      code: "managed_tokens",
      message: `contenders ${tokens.managed.join(", ")} use our tokens; a free run uses your own model key`,
    });
  }
  if (tokens.undeclared.length > 0) {
    reasons.push({
      code: "undeclared_tokens",
      message: `agent contenders ${tokens.undeclared.join(", ")} declare no BYOK token source (AB_TOKEN_SOURCE=anthropic_key or openai_key)`,
    });
  }
  const stored = new Set(opts.byokProviders);
  if (!BYOK_PROVIDERS.some((p) => stored.has(p))) {
    reasons.push({
      code: "no_byok_key",
      message: "a free run needs your own Anthropic or OpenAI key stored first",
    });
  } else {
    const missing = [
      ...new Set(tokens.byok.filter((b) => !stored.has(b.provider)).map((b) => b.provider)),
    ];
    if (missing.length > 0) {
      reasons.push({
        code: "missing_provider_key",
        message: `the kit needs your ${missing.join(" and ")} key, which is not stored`,
      });
    }
  }
  const computeCost = estimate.compute.costMicroUsd + spent;
  if (computeCost > config.capMicroUsd) {
    reasons.push({
      code: "over_compute_cap",
      message: `compute ${computeCost} micro-USD at our cost is over the free-run cap of ${config.capMicroUsd}`,
    });
  }
  if (reasons.length > 0) return { starter: false, reasons };
  return {
    starter: true,
    setups,
    trials: trialCount,
    computeCostMicroUsd: computeCost,
    agentAllowanceMicroUsd: estimate.runFeeMicroUsd,
    reserveMicroUsd: computeCost + estimate.runFeeMicroUsd,
  };
}

// ---- Rows ---------------------------------------------------------------------------------------

export type FreeStarterRun = typeof freeStarterRuns.$inferSelect;

const ACTIVE_STATES = ["reserved", "consumed"] as const;

async function ensurePool(tx: Tx | LedgerDb): Promise<void> {
  await tx.insert(freeRunPool).values({ id: FREE_RUN_POOL_ID }).onConflictDoNothing();
}

async function activeFreeRunForUser(
  db: Tx | LedgerDb,
  userId: string,
): Promise<FreeStarterRun | undefined> {
  const [row] = await db
    .select()
    .from(freeStarterRuns)
    .where(and(eq(freeStarterRuns.userId, userId), inArray(freeStarterRuns.state, ACTIVE_STATES)))
    .limit(1);
  return row;
}

/** The run's free starter row while it holds or used the entitlement, else null. */
export async function freeRunForRun(
  db: LedgerDb,
  rawRunId: string,
): Promise<FreeStarterRun | null> {
  const runId = parse(RunIdSchema, rawRunId);
  const [row] = await db
    .select()
    .from(freeStarterRuns)
    .where(and(eq(freeStarterRuns.runId, runId), inArray(freeStarterRuns.state, ACTIVE_STATES)))
    .limit(1);
  return row ?? null;
}

// ---- Eligibility --------------------------------------------------------------------------------

export type FreeRunIneligibleReason =
  /** No users row. */
  | "unknown_user"
  /** No GitHub account creation date (an email-only account): never eligible. */
  | "no_github_account_age"
  /** The GitHub account is not older than 90 days. */
  | "github_account_too_new"
  /** A free run is reserved for another run right now. */
  | "in_use"
  /** The account already used its free run. */
  | "already_used";

export type FreeRunEligibility =
  { eligible: true } | { eligible: false; reason: FreeRunIneligibleReason; runId?: string };

export interface EligibilityOptions {
  config: FreeRunConfigInput;
  /** Default: now. */
  now?: Date;
}

async function eligibilityIn(
  db: Tx | LedgerDb,
  userId: string,
  config: FreeRunConfig,
  now: Date,
): Promise<FreeRunEligibility> {
  const [user] = await db
    .select({ githubCreatedAt: users.githubCreatedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return { eligible: false, reason: "unknown_user" };
  if (!user.githubCreatedAt) return { eligible: false, reason: "no_github_account_age" };
  if (!githubAgeEligible(user.githubCreatedAt, now, config.minGithubAgeDays)) {
    return { eligible: false, reason: "github_account_too_new" };
  }
  const active = await activeFreeRunForUser(db, userId);
  if (active) {
    return {
      eligible: false,
      reason: active.state === "reserved" ? "in_use" : "already_used",
      runId: active.runId,
    };
  }
  return { eligible: true };
}

/** Whether `userId` still has its free starter run (account age rule + not used yet). */
export async function freeRunEligibility(
  db: LedgerDb,
  rawUserId: string,
  opts: EligibilityOptions,
): Promise<FreeRunEligibility> {
  const userId = parse(UserIdSchema, rawUserId);
  const config = parse(FreeRunConfigSchema, opts.config);
  return eligibilityIn(db, userId, config, opts.now ?? new Date());
}

// ---- Pool status --------------------------------------------------------------------------------

export interface FreePoolStatus {
  /** `open` while the pool can fund at least one default-size starter; else `paused`. */
  state: "open" | "paused";
  poolMicroUsd: MicroUsd;
  reservedMicroUsd: MicroUsd;
  spentMicroUsd: MicroUsd;
  /** pool - reserved - spent, never below 0. */
  availableMicroUsd: MicroUsd;
  /** The default (largest generated-kit) starter: FREE_RUN_CAP_MICRO_USD + RUN_FEE_MICRO_USD. */
  defaultStarterMicroUsd: MicroUsd;
  /** Free runs left at the default starter size (smaller starters may fit more). A count, bigint. */
  runsRemaining: bigint;
}

/** Pure: the status for a pool row's numbers. */
export function poolStatusFrom(
  configInput: FreeRunConfigInput,
  reserved: MicroUsd,
  spent: MicroUsd,
): FreePoolStatus {
  const config = parse(FreeRunConfigSchema, configInput);
  const left = config.poolMicroUsd - reserved - spent;
  const available = left > 0n ? left : 0n;
  const size = config.capMicroUsd + config.runFeeMicroUsd;
  const runs = config.poolMicroUsd === 0n ? 0n : available / (size > 0n ? size : 1n);
  return {
    state: runs >= 1n ? "open" : "paused",
    poolMicroUsd: config.poolMicroUsd,
    reservedMicroUsd: reserved,
    spentMicroUsd: spent,
    availableMicroUsd: available,
    defaultStarterMicroUsd: size,
    runsRemaining: runs,
  };
}

/** Read the global pool: open or paused, and how many default-size free runs it can still fund. */
export async function freePoolStatus(
  db: LedgerDb,
  configInput: FreeRunConfigInput,
): Promise<FreePoolStatus> {
  const [row] = await db
    .select()
    .from(freeRunPool)
    .where(eq(freeRunPool.id, FREE_RUN_POOL_ID))
    .limit(1);
  return poolStatusFrom(configInput, row?.reservedMicroUsd ?? 0n, row?.spentMicroUsd ?? 0n);
}

// ---- Reserve (Go) -------------------------------------------------------------------------------

export const ReserveFreeRunInputSchema = z.object({
  userId: UserIdSchema,
  runId: RunIdSchema,
  /** The run's kit (the one the estimate was made from). */
  kit: z.custom<KitSpec | KitSpecInput>((v) => KitSpecSchema.safeParse(v).success, {
    message: "invalid kit spec",
  }),
  /** estimateRunCost for that kit and the run's kit origin. */
  estimate: z.custom<RunCostEstimate>(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as RunCostEstimate).runFeeMicroUsd === "bigint" &&
      typeof (v as RunCostEstimate).compute?.costMicroUsd === "bigint",
    { message: "expected a RunCostEstimate (estimateRunCost)" },
  ),
  now: z.date().optional(),
});
export type ReserveFreeRunInput = z.input<typeof ReserveFreeRunInputSchema>;

export type ReserveRefusal =
  | { reason: "run_mismatch" | "run_not_awaiting_go" | "kit_origin_mismatch"; message: string }
  | { reason: "not_eligible"; eligibility: FreeRunIneligibleReason; message: string }
  | { reason: "not_starter"; rejections: StarterRejection[]; message: string }
  | { reason: "pool_exhausted"; pool: FreePoolStatus; message: string };

export type ReserveFreeRunResult =
  | {
      status: "reserved";
      freeRun: FreeStarterRun;
      starter: Extract<StarterRunDecision, { starter: true }>;
    }
  /** This run already holds the free run (a repeated Go): nothing changed. */
  | { status: "duplicate"; freeRun: FreeStarterRun }
  | ({ status: "refused" } & ReserveRefusal);

class Refused extends Error {
  constructor(readonly refusal: ReserveRefusal) {
    super(refusal.message);
  }
}

/**
 * Go for a free run: check the account, the run and the starter rules, then take the entitlement
 * and reserve the starter's cost from the pool, all in one transaction. The pool reservation is a
 * single conditional UPDATE, so of N concurrent Go presses exactly the ones that fit succeed;
 * the entitlement is a partial unique index, so one account can never hold two. Anything refused
 * leaves no trace (the transaction rolls back).
 */
export async function reserveFreeRun(
  db: LedgerDb,
  raw: ReserveFreeRunInput,
  configInput: FreeRunConfigInput,
): Promise<ReserveFreeRunResult> {
  const input = parse(ReserveFreeRunInputSchema, raw);
  const config = parse(FreeRunConfigSchema, configInput);
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(freeStarterRuns)
        .where(
          and(
            eq(freeStarterRuns.runId, input.runId),
            inArray(freeStarterRuns.state, ACTIVE_STATES),
          ),
        )
        .limit(1);
      if (existing && existing.userId === input.userId) {
        return { status: "duplicate", freeRun: existing } as const;
      }
      const [run] = await tx
        .select({ ownerId: runs.ownerId, state: runs.state, intake: runs.intake })
        .from(runs)
        .where(eq(runs.id, input.runId))
        .for("share");
      if (!run || run.ownerId !== input.userId) {
        throw new Refused({
          reason: "run_mismatch",
          message: `run ${input.runId} is not visible or not owned by ${input.userId}`,
        });
      }
      if (run.state !== "awaiting_go") {
        throw new Refused({
          reason: "run_not_awaiting_go",
          message: `run ${input.runId} is ${run.state}, not awaiting_go`,
        });
      }
      const intakeOrigin =
        typeof run.intake === "object" &&
        run.intake !== null &&
        (run.intake as { kit_origin?: unknown }).kit_origin === "uploaded"
          ? "uploaded"
          : "generated";
      if (input.estimate.kitOrigin !== intakeOrigin) {
        throw new Refused({
          reason: "kit_origin_mismatch",
          message: `estimate is for a ${input.estimate.kitOrigin} kit but run ${input.runId} is ${intakeOrigin}`,
        });
      }
      const eligibility = await eligibilityIn(tx, input.userId, config, now);
      if (!eligibility.eligible) {
        throw new Refused({
          reason: "not_eligible",
          eligibility: eligibility.reason,
          message: `no free run for this account: ${eligibility.reason}`,
        });
      }
      const keys = await tx
        .select({ provider: userSecrets.provider })
        .from(userSecrets)
        .where(eq(userSecrets.ownerId, input.userId));
      // Compute the run already used (an uploaded kit's proof computers carry the run id).
      const [spentRow] = await tx
        .select({
          sum: sql<string>`coalesce(sum(${computers.costMicroUsd}), 0)::text`,
        })
        .from(computers)
        .where(eq(computers.runId, input.runId));
      const decision = isStarterRun(input.kit, input.estimate, {
        byokProviders: keys.map((k) => k.provider),
        config,
        spentCostMicroUsd: BigInt(spentRow?.sum ?? "0"),
      });
      if (!decision.starter) {
        throw new Refused({
          reason: "not_starter",
          rejections: decision.reasons,
          message: decision.reasons.map((r) => r.message).join("; "),
        });
      }
      const [inserted] = await tx
        .insert(freeStarterRuns)
        .values({
          id: uuidv7(),
          userId: input.userId,
          runId: input.runId,
          state: "reserved",
          reservedMicroUsd: decision.reserveMicroUsd,
          agentAllowanceMicroUsd: decision.agentAllowanceMicroUsd,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        // A concurrent Go of this account (another run) took the entitlement first.
        throw new Refused({
          reason: "not_eligible",
          eligibility: "in_use",
          message: "no free run for this account: in_use",
        });
      }
      await ensurePool(tx);
      const amount = decision.reserveMicroUsd;
      const [pool] = await tx
        .update(freeRunPool)
        .set({
          reservedMicroUsd: sql`${freeRunPool.reservedMicroUsd} + ${amount.toString()}::bigint`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(freeRunPool.id, FREE_RUN_POOL_ID),
            sql`${freeRunPool.reservedMicroUsd} + ${freeRunPool.spentMicroUsd} + ${amount.toString()}::bigint <= ${config.poolMicroUsd.toString()}::bigint`,
          ),
        )
        .returning();
      if (!pool) {
        const [now_] = await tx
          .select()
          .from(freeRunPool)
          .where(eq(freeRunPool.id, FREE_RUN_POOL_ID));
        throw new Refused({
          reason: "pool_exhausted",
          pool: poolStatusFrom(config, now_?.reservedMicroUsd ?? 0n, now_?.spentMicroUsd ?? 0n),
          message: `the free-run pool cannot cover ${amount} micro-USD right now; free runs are paused`,
        });
      }
      return { status: "reserved", freeRun: inserted, starter: decision } as const;
    });
  } catch (err) {
    if (err instanceof Refused) return { status: "refused", ...err.refusal };
    throw err;
  }
}

// ---- Release (Go abandoned) ---------------------------------------------------------------------

export const ReleaseFreeRunInputSchema = z.object({
  runId: RunIdSchema,
  /** Why (`go_abandoned`, `go_failed`, ...): stored on the row. */
  reason: z.string().min(1).max(200),
});
export type ReleaseFreeRunInput = z.input<typeof ReleaseFreeRunInputSchema>;

export type ReleaseFreeRunResult =
  | { status: "released"; freeRun: FreeStarterRun }
  | { status: "not_reserved"; freeRun: FreeStarterRun | null };

/** The release reason of a run the user cancelled while it was still in awaiting_go (TDM-243). */
export const USER_CANCEL_BEFORE_GO = "user_cancel_before_go";

/** TDM-243: the run was cancelled while in awaiting_go (the cancel route's stamp): it never ran. */
export function cancelledBeforeGo(run: { state: string; stageOutputs: unknown }): boolean {
  if (run.state !== "cancelled") return false;
  const out = run.stageOutputs;
  return (
    !!out &&
    typeof out === "object" &&
    (out as Record<string, unknown>).cancelled_from === "awaiting_go"
  );
}

/**
 * Give back a reservation whose run never started (the Go transaction failed, or the user backed
 * out before the run left awaiting_go): the pool gets the whole reservation back and the account
 * gets its free run back. Only a `reserved` row on a run still `awaiting_go`, or one cancelled
 * while it was in awaiting_go (cancelledBeforeGo, TDM-243), is released; a run that started is
 * settled by settleFreeRun instead.
 */
export async function releaseFreeRun(
  db: LedgerDb,
  raw: ReleaseFreeRunInput,
): Promise<ReleaseFreeRunResult> {
  const input = parse(ReleaseFreeRunInputSchema, raw);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(freeStarterRuns)
      .where(
        and(eq(freeStarterRuns.runId, input.runId), inArray(freeStarterRuns.state, ACTIVE_STATES)),
      )
      .for("update");
    if (!row || row.state !== "reserved") return { status: "not_reserved", freeRun: row ?? null };
    const [run] = await tx
      .select({ state: runs.state, stageOutputs: runs.stageOutputs })
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for("share");
    if (run && run.state !== "awaiting_go" && !cancelledBeforeGo(run)) {
      return { status: "not_reserved", freeRun: row };
    }
    const [released] = await tx
      .update(freeStarterRuns)
      .set({
        state: "released",
        releaseReason: input.reason,
        settledAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(freeStarterRuns.id, row.id))
      .returning();
    await returnReservation(tx, row.reservedMicroUsd, 0n);
    return { status: "released", freeRun: released! };
  });
}

async function returnReservation(tx: Tx, reserved: MicroUsd, spentDelta: MicroUsd): Promise<void> {
  if (reserved === 0n && spentDelta === 0n) return;
  await ensurePool(tx);
  await tx
    .update(freeRunPool)
    .set({
      reservedMicroUsd: sql`greatest(${freeRunPool.reservedMicroUsd} - ${reserved.toString()}::bigint, 0)`,
      spentMicroUsd: sql`${freeRunPool.spentMicroUsd} + ${spentDelta.toString()}::bigint`,
      updatedAt: sql`now()`,
    })
    .where(eq(freeRunPool.id, FREE_RUN_POOL_ID));
}

// ---- Settle (run terminal) ----------------------------------------------------------------------

export type SettleFreeRunResult =
  /** The run holds no free starter run: nothing to do. */
  | { status: "not_free_run" }
  /** Reserved, but the run is still going: settle again once it is terminal. */
  | { status: "run_not_final" }
  | {
      status: "consumed" | "released";
      freeRun: FreeStarterRun;
      /** User charges covered by this call (0 on a repeat with nothing new). */
      coveredMicroUsd: MicroUsd;
      /** The free_run grant this call wrote, if it covered anything. */
      grantId: string | null;
    };

const COVERED_TYPES = ["run_fee", "compute", "managed_tokens"] as const;

/**
 * Settle a free run once its run is terminal; idempotent, and safe to call again after a late
 * computer charge (the ledger calls it after recordRunCharges and after recordComputerUsage).
 *
 * - Outcome (first settle only): the ledger's own rule (pricing.ts computeRunDecision) decides.
 *   Delivered, subject-failed (a capped subject failure included) or user-cancelled = a real outcome:
 *   `consumed`. Failed in infra or our pipeline, or cancelled by us = `released`, the account gets
 *   its free run back.
 * - Coverage (consumed): every positive, non-comped, not-yet-settled run_fee / compute /
 *   managed_tokens entry of the run is covered by one `free_run` grant of the same total, and
 *   stamped settled (`free_run:<grant id>`), so it never reaches Stripe and the balance nets to 0.
 * - Pool: the reservation is returned (first settle) and what the run cost us so far (every
 *   computer of the run at registry cost, plus the agent allowance) replaces what was charged before.
 */
export async function settleFreeRun(
  db: LedgerDb,
  raw: { runId: string },
): Promise<SettleFreeRunResult> {
  const runId = parse(RunIdSchema, raw.runId);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(freeStarterRuns)
      .where(and(eq(freeStarterRuns.runId, runId), inArray(freeStarterRuns.state, ACTIVE_STATES)))
      .for("update");
    if (!row) return { status: "not_free_run" } as const;
    const [run] = await tx
      .select({
        state: runs.state,
        cancelCause: runs.cancelCause,
        stageOutputs: runs.stageOutputs,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("share");
    if (!run) throw new Error(`run ${runId} of free run ${row.id} vanished`);
    if (row.state === "reserved" && !isTerminalRunState(run.state)) {
      return { status: "run_not_final" } as const;
    }
    let next: "consumed" | "released" = row.state === "consumed" ? "consumed" : "released";
    let releaseReason: string | null = row.releaseReason;
    if (row.state === "reserved") {
      const runTrials = await tx
        .select({ state: trials.state })
        .from(trials)
        .where(eq(trials.runId, runId))
        .for("share");
      const decision = computeRunDecision(
        run.state,
        runTrials.map((t) => t.state),
        run.cancelCause === "ours" ? "ours" : "user",
      );
      // TDM-243: cancelled while still in awaiting_go = it never ran: released, not consumed.
      const beforeGo = cancelledBeforeGo(run);
      next = decision.billable && !beforeGo ? "consumed" : "released";
      releaseReason =
        next === "consumed"
          ? null
          : beforeGo
            ? USER_CANCEL_BEFORE_GO
            : run.state === "cancelled"
              ? "cancelled_by_us"
              : "failed_not_subject";
    }

    // Coverage: lock the account first (the ledger's order), then the run's open entries.
    let covered = 0n;
    let grantId: string | null = null;
    if (next === "consumed") {
      await tx.insert(billingAccounts).values({ userId: row.userId }).onConflictDoNothing();
      const [account] = await tx
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.userId, row.userId))
        .for("update");
      const open = await tx
        .select({ id: usageEntries.id, amount: usageEntries.amountMicroUsd })
        .from(usageEntries)
        .where(
          and(
            eq(usageEntries.runId, runId),
            eq(usageEntries.userId, row.userId),
            isNull(usageEntries.compedBy),
            isNull(usageEntries.reportedAt),
            inArray(usageEntries.type, COVERED_TYPES),
            sql`${usageEntries.amountMicroUsd} > 0`,
          ),
        )
        .for("update");
      covered = open.reduce((s, e) => s + e.amount, 0n);
      if (covered > 0n && account) {
        grantId = newId(CreditGrantIdSchema);
        await tx.insert(creditGrants).values({
          id: grantId,
          userId: row.userId,
          amountMicroUsd: covered,
          category: "promotional",
          source: "free_run",
          reason: `free starter run ${runId}`,
        });
        await tx
          .update(usageEntries)
          .set({ reportedAt: sql`now()`, stripeMeterEventId: `${FREE_RUN_METER_PREFIX}${grantId}` })
          .where(
            inArray(
              usageEntries.id,
              open.map((e) => e.id),
            ),
          );
        // The entries already added `covered` to the net position; the grant takes it off again.
        const nextBalance = applyNetDelta(
          {
            unbilled: account.unbilledMicroUsd,
            granted_remaining: account.grantedRemainingMicroUsd,
          },
          -covered,
        );
        await tx
          .update(billingAccounts)
          .set({
            unbilledMicroUsd: nextBalance.unbilled,
            grantedRemainingMicroUsd: nextBalance.granted_remaining,
            updatedAt: sql`now()`,
          })
          .where(eq(billingAccounts.userId, row.userId));
      }
    }

    // Pool: what the run cost us so far replaces what was charged before.
    const [costRow] = await tx
      .select({ sum: sql<string>`coalesce(sum(${computers.costMicroUsd}), 0)::text` })
      .from(computers)
      .where(eq(computers.runId, runId));
    const poolSpent = BigInt(costRow?.sum ?? "0") + row.agentAllowanceMicroUsd;
    const delta = poolSpent > row.poolSpentMicroUsd ? poolSpent - row.poolSpentMicroUsd : 0n;
    await returnReservation(tx, row.state === "reserved" ? row.reservedMicroUsd : 0n, delta);

    const [updated] = await tx
      .update(freeStarterRuns)
      .set({
        state: next,
        releaseReason,
        poolSpentMicroUsd: row.poolSpentMicroUsd + delta,
        coveredMicroUsd: row.coveredMicroUsd + covered,
        settledAt: row.settledAt ?? sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(freeStarterRuns.id, row.id))
      .returning();
    return { status: next, freeRun: updated!, coveredMicroUsd: covered, grantId };
  });
}
