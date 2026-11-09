// Every run's budget (TDM-242 [20.5], plan.md sections 5 and 8). One mechanism for every run: a
// run never launches a trial whose worst case would take it past its limit.
//
// What a user expects from "budget $20": Anybench never charges more than $20 for this run. The
// budget limits what WE bill: the run fee, eval computer time at its billed price (our cost +
// COMPUTE_MARKUP_BPS), and model tokens we pay for (the Naïve proxy, "managed tokens") at their
// billed price too (our cost + MANAGED_TOKEN_MARKUP_BPS, TDM-244: what the ledger charges). Model
// tokens on the user's own key (BYOK) are paid by the user to their provider, not to us, so the
// budget never stops on them; they are tracked and reported next to it (byok_token_micro_usd).
// A free starter run (TDM-223/224) is limited the same way, on the free-run basis: compute at OUR
// cost against FREE_RUN_CAP_MICRO_USD (no fee, no markup), because that is what the pool pays.
//
// The numbers (bigint micro-USD, in the run's basis):
//   spent      run fee (counted from the first trial: it is charged once the report is delivered)
//              + compute: every computer of the run that serves a trial the run bills (or a
//                run-level computer: an uploaded kit's proof, a gate), destroyed = its registry
//                cost, live = the blocks it has paid so far (created_at → now, at least one), with
//                the markup per computer as the ledger bills it
//              + managed tokens: a finished trial's Naïve proxy spend (trials.metrics), or its
//                cap when the spend could not be read, with the token markup per trial as the
//                ledger bills it (billed basis).
//              A computer that served only failed_infra attempts (our infra, our retries) or
//              cancelled trials never counts, exactly as packages/billing never bills it.
//   committed  the worst case still to come of the trials launched but not finished (forking …
//              collecting): each one's compute up to its wall-clock cap (trialCap: every verb at
//              its timeout, plus the computer's boot) minus what its computer has already spent,
//              plus its managed-token cap where we pay (at its billed price). Gating trials add
//              their managed-token cap until their proxy spend is recorded.
//   limit      runs.budget_micro_usd (basis `billed`), or the free-run cap (basis `free_run`).
//
// The rules (advance.ts and the trial store in jobs/trial-execute.ts):
//   - Launch: queued → forking is admitted only when spent + committed + this trial's cap <= limit,
//     checked under the run's row lock, so concurrent launches can never overcommit. A refused
//     trial stays queued, attempt untouched, nothing spent ("held").
//   - Running trials finish: stopping them mid-way would waste the money already spent on them.
//   - Hold: when queued trials remain, none fits, and nothing is in flight, the run goes to
//     paused_budget with a run event saying how much was spent and what the next trial needs.
//   - Hard stop: spent alone passing the limit (a trial overran its cap) holds the run AND asks
//     the running trials' runners to stop the subject (budget_stop): each ends failed_subject
//     `budget` with its workspace frozen and graded (TDM-232).
//   - Infra failures and our own retries never count (see spent above). Stages after `running`
//     (scoring, analyzing) are never held: the trials are paid for, the report is ours to finish.
//
// TDM-245: the BYOK token limit (runs.byok_token_limit_micro_usd, optional). The budget above never
// counts tokens on the user's own key, so a run of 25 trials at a $25 cap could spend $625 there.
// With a limit set, BYOK tokens are held the same way, separately from the budget:
//   byok spent      every trial's runner-metered token spend on the user's key
//                   (trials.token_spend_micro_usd, written when its runner ends); a trial that
//                   finished or is being graded without a reading counts at its BYOK cap.
//   byok committed  each BYOK trial in flight at its BYOK cap (token_cap_micro_usd, where the
//                   runner stops it), whatever it has spent so far (the reading comes at the end).
//   Launch: also needs byok spent + byok committed + this trial's BYOK cap <= the limit. A BYOK
//   trial with no cap cannot be bounded, so it never launches under a limit.
//   Hold and hard stop: as for the budget (paused_budget with the reason; byok spent alone past
//   the limit stops the running trials). Resume can raise the limit (POST /runs/:id/resume).
//
// runs.spent_micro_usd / committed_micro_usd / byok_token_micro_usd are written by
// storeRunBudget (each orchestrator step while the run spends, every admitted launch, and the
// ledger's actual charges when the run is terminal), with a `run.budget` event whose
// cost_delta_micro_usd is the change in spent, so the live page's counter follows it.
import { trialJobFromKit } from "@anybench/bench";
import {
  BYOK_TOKEN_SOURCES,
  DEFAULT_MANAGED_TOKEN_MARKUP_BPS,
  servedTrials,
} from "@anybench/billing";
import {
  isAgentDriver,
  RunIdSchema,
  resolveEnvProvider,
  safeParseKitSpec,
  withMarkupBps,
  type AnybenchEvent,
  type EventActor,
  type KitSpec,
  type TrialState,
} from "@anybench/core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Database, DbTx } from "../db/client.js";
import { computers } from "../db/schema/computers.js";
import { contenders } from "../db/schema/contenders.js";
import { freeStarterRuns } from "../db/schema/free_starter_runs.js";
import { kits } from "../db/schema/kits.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import { usageEntries } from "../db/schema/usage_entries.js";
import { appendEvents } from "../lib/events.js";
import { isUploadedKitRun } from "./ports.js";
import { DEFAULT_TRIAL_PROXY_CAP_MICRO_USD, trialProxyCap } from "./trial-source.js";

/** Naïve's billing block (the registry's default). */
export const BUDGET_BLOCK_SECONDS = 600;
/** The computer's own boot before the runner starts (executor readyTimeoutMs). */
export const TRIAL_BOOT_ALLOWANCE_S = 300;
/** runner TrialJob defaults, when the kit sets none. */
const DEFAULT_VERB_TIMEOUT_S = 300;
const DEFAULT_READY_TIMEOUT_S = 60;
/** start, ready, stop, healthcheck: each may run to its timeout. */
const VERBS_PER_TRIAL = 4;
/** Providers whose computers cost nothing (docker-local: the registry bills them at 0). */
export const FREE_COMPUTE_PROVIDERS = ["docker-local"] as const;

export type BudgetBasis = "billed" | "free_run";

export interface BudgetPricing {
  /** RUN_FEE_MICRO_USD (a generated kit). */
  runFeeMicroUsd: bigint;
  /** UPLOADED_KIT_RUN_FEE_MICRO_USD. */
  uploadedKitRunFeeMicroUsd: bigint;
  /** COMPUTE_MARKUP_BPS. */
  computeMarkupBps: bigint;
  /** TDM-244: MANAGED_TOKEN_MARKUP_BPS (default 2000, the config default). */
  managedTokenMarkupBps?: bigint;
  /** COMPUTER_BLOCK_PRICE_MICRO_USD: what the registry costs one block of a computer at. */
  blockPriceMicroUsd: bigint;
  blockSeconds?: number;
  /** TRIAL_PROXY_CAP_MICRO_USD: the ceiling of a trial's managed-token cap. */
  proxyCapCeilingMicroUsd?: bigint;
  /** FREE_RUN_CAP_MICRO_USD: a free run's limit, at our cost. Unset = free runs use `billed`. */
  freeRunCapMicroUsd?: bigint;
  /** Computer providers billed at 0. */
  freeProviders?: readonly string[];
}

export function budgetPricingFromConfig(config: Config): BudgetPricing {
  return {
    runFeeMicroUsd: config.RUN_FEE_MICRO_USD,
    uploadedKitRunFeeMicroUsd: config.UPLOADED_KIT_RUN_FEE_MICRO_USD,
    computeMarkupBps: config.COMPUTE_MARKUP_BPS,
    managedTokenMarkupBps: config.MANAGED_TOKEN_MARKUP_BPS,
    blockPriceMicroUsd: config.COMPUTER_BLOCK_PRICE_MICRO_USD,
    proxyCapCeilingMicroUsd: config.TRIAL_PROXY_CAP_MICRO_USD,
    freeRunCapMicroUsd: config.FREE_RUN_CAP_MICRO_USD,
  };
}

/** One trial's worst case, in the run's basis. */
export interface TrialCap {
  /** Its computer, kept for its whole wall-clock cap (every verb at its timeout). */
  compute: bigint;
  /** Its managed-token cap (Naïve proxy, we pay), in the run's basis; 0 for BYOK or no model. */
  managedTokens: bigint;
  /** compute + managedTokens: what the budget holds it to. */
  total: bigint;
  /**
   * TDM-245: its cap on the user's own key (token_cap_micro_usd of a BYOK contender); 0 when it
   * does not use the user's key; null when it does with no cap (unbounded).
   */
  byokTokens: bigint | null;
}

/** TDM-245: the run's BYOK token limit and what counts against it (all null-free when no limit). */
export interface ByokBudget {
  /** runs.byok_token_limit_micro_usd; null = no limit (BYOK tokens never hold the run). */
  limit: bigint | null;
  /** Measured spend, plus finished / grading BYOK trials without a reading at their cap. */
  spent: bigint;
  /** BYOK trials in flight, each at its BYOK cap. */
  committed: bigint;
  /** A BYOK trial without a cap is in flight: nothing more may launch under a limit. */
  unbounded: boolean;
}

export interface RunBudget {
  runId: string;
  /** runs.state as read. */
  state: string;
  basis: BudgetBasis;
  limit: bigint;
  spent: { runFee: bigint; compute: bigint; managedTokens: bigint; total: bigint };
  committed: bigint;
  /** Model tokens on the user's own key, measured (not billed; reported). */
  byokTokens: bigint;
  /** TDM-245: the BYOK token limit and what counts against it. */
  byok: ByokBudget;
  /** Trials launched and not finished (forking … collecting). */
  inFlight: string[];
  /** Queued trials (never launched, or waiting to relaunch), oldest first, with their caps. */
  queued: { id: string; cap: bigint; byokCap: bigint | null }[];
  /** What runs.* says now (to write only what changed). */
  stored: {
    spent: bigint;
    committed: bigint;
    byokTokens: bigint;
    basis: BudgetBasis;
    limit: bigint | null;
  };
  /** The worst case of one of the run's trials. */
  capOf(trialId: string): TrialCap;
}

/** spent + committed + `extra` stays within the limit. */
export function fitsBudget(b: RunBudget, extra: bigint): boolean {
  return b.spent.total + b.committed + extra <= b.limit;
}

/**
 * TDM-245: BYOK spent + committed + a trial's BYOK cap stays within the BYOK limit (always true
 * with no limit, or for a trial that does not use the user's key).
 */
export function fitsByok(b: RunBudget, byokCap: bigint | null): boolean {
  if (b.byok.limit === null || byokCap === 0n) return true;
  if (byokCap === null || b.byok.unbounded) return false;
  return b.byok.spent + b.byok.committed + byokCap <= b.byok.limit;
}

/** Why the next trial (at `cap`) cannot launch now, or null when it may: the budget, then BYOK. */
export function launchRefusal(
  b: RunBudget,
  cap: Pick<TrialCap, "total" | "byokTokens">,
): string | null {
  if (!fitsBudget(b, cap.total)) return launchHeldReason(b, cap.total);
  if (!fitsByok(b, cap.byokTokens)) return byokHeldReason(b, cap.byokTokens);
  return null;
}

/** $1.23 (micro-USD to the nearest cent, half up; no float). */
export function usd(micro: bigint): string {
  const cents = micro <= 0n ? 0n : (micro + 5_000n) / 10_000n;
  const dollars = cents / 100n;
  const rest = (cents % 100n).toString().padStart(2, "0");
  return `$${dollars}.${rest}`;
}

const IN_FLIGHT: readonly TrialState[] = [
  "forking",
  "installing",
  "warming",
  "running",
  "collecting",
];
const GRADING: readonly TrialState[] = ["gating", "reviewing"];
const FINISHED_BILLED: readonly TrialState[] = ["done", "failed_subject"];
/** Trial states whose computers count as spent: launched, and not an infra failure or a cancel. */
const COUNTED: readonly TrialState[] = [...IN_FLIGHT, ...GRADING, ...FINISHED_BILLED];

/** Seconds a trial may legitimately keep its computer: boot, every verb at its timeout, the run(s). */
export function trialCapSeconds(job: {
  wall_clock_s: number;
  warmup_runs?: number;
  verb_timeout_s?: number;
  ready_timeout_s?: number;
}): number {
  const runs = ((job.warmup_runs ?? 0) + 1) * job.wall_clock_s;
  const verbs =
    VERBS_PER_TRIAL * (job.verb_timeout_s ?? DEFAULT_VERB_TIMEOUT_S) +
    (job.ready_timeout_s ?? DEFAULT_READY_TIMEOUT_S);
  return runs + verbs + TRIAL_BOOT_ALLOWANCE_S;
}

function blocksFor(seconds: number, blockSeconds: number): bigint {
  const b = BigInt(Math.ceil(Math.max(0, seconds) / blockSeconds));
  return b < 1n ? 1n : b;
}

function charge(cost: bigint, basis: BudgetBasis, pricing: BudgetPricing): bigint {
  return basis === "billed" ? withMarkupBps(cost, pricing.computeMarkupBps) : cost;
}

/** Managed tokens that cost us `cost`, in the run's basis (billed: + MANAGED_TOKEN_MARKUP_BPS). */
export function tokenCharge(cost: bigint, basis: BudgetBasis, pricing: BudgetPricing): bigint {
  return basis === "billed"
    ? withMarkupBps(cost, pricing.managedTokenMarkupBps ?? DEFAULT_MANAGED_TOKEN_MARKUP_BPS)
    : cost;
}

/**
 * The worst case of a trial of `contenderId` × `workloadId` (pure). An unknown contender (a kit
 * that changed under the run) gets the default hour and no managed tokens.
 */
export function trialCap(
  spec: KitSpec | null,
  contenderId: string,
  workloadId: string,
  basis: BudgetBasis,
  pricing: BudgetPricing,
): TrialCap {
  const blockSeconds = pricing.blockSeconds ?? BUDGET_BLOCK_SECONDS;
  let wall = 3600;
  let managed = 0n;
  let byok: bigint | null = 0n;
  let price = pricing.blockPriceMicroUsd;
  if (spec) {
    if (spec.env) {
      const provider = resolveEnvProvider(spec.env);
      if ((pricing.freeProviders ?? FREE_COMPUTE_PROVIDERS).includes(provider)) price = 0n;
    }
    try {
      const job = trialJobFromKit(spec, contenderId, workloadId);
      wall = job.wall_clock_s;
      const contender = spec.contenders.find((c) => c.id === contenderId);
      const source = job.env?.AB_TOKEN_SOURCE;
      if (contender && isAgentDriver(contender.driver) && source !== undefined) {
        // TDM-245: a contender on the user's own key: its cap there (the runner stops it).
        if (BYOK_TOKEN_SOURCES[String(source)]) {
          byok = contender.driver.token_cap_micro_usd ?? null;
        }
      }
      if (
        contender &&
        isAgentDriver(contender.driver) &&
        job.env?.AB_TOKEN_SOURCE === "naive_proxy"
      ) {
        managed = tokenCharge(
          trialProxyCap(
            contender.driver,
            pricing.proxyCapCeilingMicroUsd ?? DEFAULT_TRIAL_PROXY_CAP_MICRO_USD,
          ),
          basis,
          pricing,
        );
      }
    } catch {
      // the kit has no such contender / workload: the default hour, no managed tokens
    }
  }
  const compute = charge(
    blocksFor(trialCapSeconds({ wall_clock_s: wall }), blockSeconds) * price,
    basis,
    pricing,
  );
  return { compute, managedTokens: managed, total: compute + managed, byokTokens: byok };
}

type DbLike = Database | DbTx;

function micro(raw: unknown): bigint | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null;
}

/**
 * Read a run's budget now. `lock`: take the run row FOR UPDATE first (the launch admission, inside
 * the caller's transaction), so concurrent launches of one run serialize on it.
 */
export async function readRunBudget(
  db: DbLike,
  runId: string,
  pricing: BudgetPricing,
  opts: { lock?: boolean; now?: Date } = {},
): Promise<RunBudget | null> {
  const now = opts.now ?? new Date();
  const blockSeconds = pricing.blockSeconds ?? BUDGET_BLOCK_SECONDS;
  const base = db
    .select({
      id: runs.id,
      state: runs.state,
      budget: runs.budgetMicroUsd,
      byokLimit: runs.byokTokenLimitMicroUsd,
      kitId: runs.kitId,
      intake: runs.intake,
      spent: runs.spentMicroUsd,
      committed: runs.committedMicroUsd,
      byok: runs.byokTokenMicroUsd,
      basis: runs.budgetBasis,
      limit: runs.budgetLimitMicroUsd,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  const [run] = opts.lock ? await base.for("update") : await base;
  if (!run) return null;

  const [free] = await db
    .select({ id: freeStarterRuns.id })
    .from(freeStarterRuns)
    .where(
      and(
        eq(freeStarterRuns.runId, runId),
        inArray(freeStarterRuns.state, ["reserved", "consumed"]),
      ),
    )
    .limit(1);
  const basis: BudgetBasis =
    free && pricing.freeRunCapMicroUsd !== undefined ? "free_run" : "billed";
  const limit = basis === "free_run" ? pricing.freeRunCapMicroUsd! : run.budget;

  let spec: KitSpec | null = null;
  if (run.kitId) {
    const [k] = await db.select({ spec: kits.spec }).from(kits).where(eq(kits.id, run.kitId));
    const parsed = k ? safeParseKitSpec(k.spec) : null;
    spec = parsed?.success ? parsed.data : null;
  }
  const slugs = new Map(
    (
      await db
        .select({ id: contenders.id, source: contenders.source })
        .from(contenders)
        .where(eq(contenders.runId, runId))
    ).map((c) => [c.id, c.source]),
  );
  const rows = await db
    .select({
      id: trials.id,
      state: trials.state,
      contenderId: trials.contenderId,
      workloadId: trials.workloadId,
      computerId: trials.computerId,
      proxyKeyId: trials.proxyKeyId,
      metrics: trials.metrics,
      tokenSpend: trials.tokenSpendMicroUsd,
    })
    .from(trials)
    .where(eq(trials.runId, runId))
    .orderBy(asc(trials.createdAt), asc(trials.id));
  const machines = await db
    .select({
      id: computers.id,
      provider: computers.provider,
      trialId: computers.trialId,
      status: computers.status,
      createdAt: computers.createdAt,
      cost: computers.costMicroUsd,
    })
    .from(computers)
    .where(eq(computers.runId, runId));

  const capCache = new Map<string, TrialCap>();
  const byId = new Map(rows.map((t) => [t.id, t]));
  const capOf = (trialId: string): TrialCap => {
    const hit = capCache.get(trialId);
    if (hit) return hit;
    const t = byId.get(trialId);
    const cap = trialCap(
      spec,
      t ? (slugs.get(t.contenderId) ?? t.contenderId) : "",
      t?.workloadId ?? "",
      basis,
      pricing,
    );
    capCache.set(trialId, cap);
    return cap;
  };

  // Compute: each counted computer at its cost so far, marked up per computer (the ledger's way).
  const forBilling = rows.map((t) => ({ id: t.id, state: t.state, computerId: t.computerId }));
  const freeProviders = pricing.freeProviders ?? FREE_COMPUTE_PROVIDERS;
  const liveByComputer = new Map<string, bigint>();
  let compute = 0n;
  for (const c of machines) {
    const served = servedTrials({ id: c.id, trialId: c.trialId }, forBilling);
    const counts =
      served.length > 0 ? served.some((t) => COUNTED.includes(t.state)) : c.trialId === null;
    if (!counts) continue;
    let cost = c.cost;
    if (c.status !== "destroyed") {
      const price = freeProviders.includes(c.provider) ? 0n : pricing.blockPriceMicroUsd;
      const secs = (now.getTime() - c.createdAt.getTime()) / 1000;
      cost = blocksFor(secs, blockSeconds) * price;
    }
    const billed = charge(cost, basis, pricing);
    liveByComputer.set(c.id, billed);
    compute += billed;
  }

  let managed = 0n;
  let committed = 0n;
  let byok = 0n;
  const byokBudget: ByokBudget = {
    limit: run.byokLimit ?? null,
    spent: 0n,
    committed: 0n,
    unbounded: false,
  };
  const inFlight: string[] = [];
  const queued: { id: string; cap: bigint; byokCap: bigint | null }[] = [];
  for (const t of rows) {
    if (t.proxyKeyId === null && t.tokenSpend !== null) byok += t.tokenSpend;
    // TDM-245: the BYOK limit's view of this trial (only trials of a contender on the user's key).
    const byokCap =
      t.state === "queued" || IN_FLIGHT.includes(t.state) || t.tokenSpend === null
        ? capOf(t.id).byokTokens
        : 0n;
    if (t.proxyKeyId === null && t.tokenSpend !== null) {
      byokBudget.spent += t.tokenSpend;
    } else if (
      t.tokenSpend === null &&
      (GRADING.includes(t.state) || FINISHED_BILLED.includes(t.state)) &&
      byokCap !== 0n
    ) {
      // Finished on the user's key with no reading: count it at its cap (never loosen the limit).
      if (byokCap === null) byokBudget.unbounded = true;
      else byokBudget.spent += byokCap;
    }
    // A collecting trial's runner has ended and its reading is in: measured, no longer committed.
    const read = t.state === "collecting" && t.tokenSpend !== null;
    if (IN_FLIGHT.includes(t.state) && byokCap !== 0n && !read) {
      if (byokCap === null) byokBudget.unbounded = true;
      else byokBudget.committed += byokCap;
    }
    const rawProxyCost = micro((t.metrics as Record<string, unknown> | null)?.proxy_cost_micro_usd);
    const proxyCost = rawProxyCost === null ? null : tokenCharge(rawProxyCost, basis, pricing);
    if (t.state === "queued") {
      queued.push({ id: t.id, cap: capOf(t.id).total, byokCap });
    } else if (IN_FLIGHT.includes(t.state)) {
      inFlight.push(t.id);
      const cap = capOf(t.id);
      const used = t.computerId ? (liveByComputer.get(t.computerId) ?? 0n) : 0n;
      committed += (cap.compute > used ? cap.compute - used : 0n) + cap.managedTokens;
    } else if (GRADING.includes(t.state)) {
      if (t.proxyKeyId !== null) {
        if (proxyCost !== null) managed += proxyCost;
        else committed += capOf(t.id).managedTokens;
      }
    } else if (FINISHED_BILLED.includes(t.state) && t.proxyKeyId !== null) {
      // Spend we could not read counts at its cap: a bad read never loosens the budget.
      managed += proxyCost ?? capOf(t.id).managedTokens;
    }
  }

  const runFee =
    basis === "billed" && rows.length > 0
      ? isUploadedKitRun(run.intake)
        ? pricing.uploadedKitRunFeeMicroUsd
        : pricing.runFeeMicroUsd
      : 0n;
  return {
    runId,
    state: run.state,
    basis,
    limit,
    spent: { runFee, compute, managedTokens: managed, total: runFee + compute + managed },
    committed,
    byokTokens: byok,
    byok: byokBudget,
    inFlight,
    queued,
    stored: {
      spent: run.spent,
      committed: run.committed,
      byokTokens: run.byok,
      basis: run.basis,
      limit: run.limit,
    },
    capOf,
  };
}

/**
 * A terminal run: what the ledger actually charged for it (run fee, compute, managed tokens,
 * comped entries included) replaces the live estimate; nothing is committed any more. A free run
 * keeps its free-run basis (our cost, read live: every computer is destroyed by now).
 */
export async function terminalRunBudget(
  db: DbLike,
  runId: string,
  pricing: BudgetPricing,
): Promise<RunBudget | null> {
  const b = await readRunBudget(db, runId, pricing);
  if (!b) return null;
  if (b.basis === "billed") {
    const entries = await db
      .select({
        type: usageEntries.type,
        sum: sql<string>`coalesce(sum(${usageEntries.amountMicroUsd}), 0)::text`,
      })
      .from(usageEntries)
      .where(
        and(
          eq(usageEntries.runId, runId),
          inArray(usageEntries.type, ["run_fee", "compute", "managed_tokens"]),
        ),
      )
      .groupBy(usageEntries.type);
    const of = (type: string) => BigInt(entries.find((e) => e.type === type)?.sum ?? "0");
    const runFee = of("run_fee");
    const compute = of("compute");
    // TDM-244: managed tokens are ledgered per trial at cost + markup, like compute.
    const managedTokens = of("managed_tokens");
    b.spent = { runFee, compute, managedTokens, total: runFee + compute + managedTokens };
  }
  b.committed = 0n;
  b.byok.committed = 0n;
  b.inFlight = [];
  return b;
}

/**
 * Write the run's budget numbers if they changed, with a `run.budget` event (cost delta = the
 * change in spent). Returns whether anything was written.
 */
export async function storeRunBudget(
  db: DbLike,
  b: RunBudget,
  actor: EventActor,
): Promise<boolean> {
  const s = b.stored;
  const limitStored = b.basis === "billed" ? null : b.limit;
  if (
    s.spent === b.spent.total &&
    s.committed === b.committed &&
    s.byokTokens === b.byokTokens &&
    s.basis === b.basis &&
    s.limit === limitStored
  ) {
    return false;
  }
  await db
    .update(runs)
    .set({
      spentMicroUsd: b.spent.total,
      committedMicroUsd: b.committed,
      byokTokenMicroUsd: b.byokTokens,
      budgetBasis: b.basis,
      budgetLimitMicroUsd: limitStored,
      updatedAt: sql`now()`,
    })
    .where(eq(runs.id, b.runId));
  const ev: AnybenchEvent = {
    run_id: b.runId,
    seq: 0,
    type: "run.budget",
    source: "run",
    source_id: b.runId,
    severity: "debug",
    actor,
    cost_delta_micro_usd: b.spent.total - s.spent,
    at: new Date().toISOString(),
    payload: {
      basis: b.basis,
      limit_micro_usd: b.limit,
      spent_micro_usd: b.spent.total,
      committed_micro_usd: b.committed,
      byok_token_micro_usd: b.byokTokens,
      spent_by_kind: {
        run_fee: b.spent.runFee,
        compute: b.spent.compute,
        managed_tokens: b.spent.managedTokens,
      },
    },
  };
  await appendEvents(db, RunIdSchema.parse(b.runId), [ev]);
  s.spent = b.spent.total;
  s.committed = b.committed;
  s.byokTokens = b.byokTokens;
  s.basis = b.basis;
  s.limit = limitStored;
  return true;
}

/** The basis in words, for hold reasons and the run page. */
export function limitWords(b: Pick<RunBudget, "basis" | "limit">): string {
  return b.basis === "free_run"
    ? `the free run's ${usd(b.limit)} compute cap`
    : `the ${usd(b.limit)} budget`;
}

/** TDM-245: why a trial on the user's key cannot launch under the BYOK token limit. */
export function byokHeldReason(b: RunBudget, byokCap: bigint | null): string {
  const limit = usd(b.byok.limit ?? 0n);
  if (byokCap === null) {
    return `the next trial runs on your own model key with no token cap, so it cannot be held to the ${limit} BYOK token limit`;
  }
  if (b.byok.unbounded) {
    return `a running trial on your own model key has no token cap, so nothing more fits the ${limit} BYOK token limit until it ends`;
  }
  return (
    `BYOK tokens spent ${usd(b.byok.spent)} + ${usd(b.byok.committed)} committed to running ` +
    `trials at their caps + ${usd(byokCap)} for the next trial at its cap would pass the ` +
    `${limit} BYOK token limit`
  );
}

/** Why a trial cannot launch now (the store's `held` message, the hold reason). */
export function launchHeldReason(b: RunBudget, cap: bigint): string {
  return (
    `spent ${usd(b.spent.total)} + ${usd(b.committed)} committed to running trials + ` +
    `${usd(cap)} for the next trial at its cap would pass ${limitWords(b)}`
  );
}
