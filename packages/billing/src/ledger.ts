// Usage ledger in integer micro-USD (TDM-87, plan.md section 8; cost-plus entries TDM-171).
//
// What it bills (cost-plus, pricing.ts), once the run is terminal:
//   - delivered or subject-failed run: one `run_fee` (`run:<id>:fee`) plus one `compute` entry
//     per eval computer at the registry's cost + COMPUTE_MARKUP_BPS (`computer:<id>:compute`);
//   - user-cancelled run: the compute it consumed, no run fee;
//   - run that failed in infra or our pipeline (or that we cancelled): nothing;
//   - run not terminal yet: nothing yet (skipped with `run_not_final`).
// Inside a billable run, a computer that only served failed_infra attempts is never billed. Every
// decision is made from the run, trial and computer rows read in the same transaction
// (FOR SHARE), never from what the caller says.
//
// Caller contract (the worker, 5.x / 10.x):
//   1. When a run reaches a terminal state, call `recordRunCharges` (run fee, then every computer
//      of the run). Computers still being destroyed skip with `computer_not_final`.
//   2. When the registry destroys a computer whose run is already terminal (a late destroy, or the
//      reaper), call `recordComputerUsage` for it from that destroy hook.
// Every call is idempotent, so calling both, or retrying either, never bills twice.
//
// The ledger owns usage_entries, credit_grants, cost_entries and the cached balances on
// billing_accounts. Every mutation runs in ONE transaction that first locks the account row with
// `SELECT ... FOR UPDATE`, so concurrent writers for the same user are serialized and the cache
// can never drift from the rows it summarizes.
//
// Balance model. Let U = sum of non-comped usage_entries.amount and G = sum of credit_grants.amount
// for a user. The ledger nets them into one position N = U - G and caches it split by sign:
//   unbilled_micro_usd          = max(N, 0)
//   granted_remaining_micro_usd = max(-N, 0)
// At most one of them is non-zero. `auditAccount` recomputes both from the rows.
//
// How that relates to Stripe. A Stripe credit grant applies to invoices whose period_end >=
// the grant's effective_at, while the grant still has balance when the invoice is finalized.
// So netting a new grant against usage in the OPEN billing period matches what Stripe will do. It
// does NOT match for usage already on a finalized invoice (a threshold invoice, or one that is
// past due): Stripe will not apply a later grant to that invoice, while N above would. The
// tickets that own the rest of the lifecycle must close that gap:
//   - 10.4 (webhooks): on invoice.finalized, remove the invoiced usage from the net position and
//     record the credit Stripe actually applied to that invoice (not our estimate).
//   - 10.7 (credit grants): a grant with a future effective_at must not count until it is
//     effective; 10.7 also owns expiry and the order in which grants are consumed.
//   - 10.10 (reconciliation): cents rounding drift between our micro-USD and Stripe's cents.
//
// No float path: amounts are bigint end to end. Inputs go through core's MicroUsdSchema, which
// rejects JS numbers, and Postgres sums come back as text and go straight to BigInt().
import {
  ComputerIdSchema,
  InterventionIdSchema,
  newId,
  NonNegativeMicroUsdSchema,
  RunIdSchema,
  TrialIdSchema,
  UsageEntryIdSchema,
  CreditGrantIdSchema,
  UserIdSchema,
  uuidv7,
  withMarkupBps,
  type MicroUsd,
  type RunState,
} from "@anybench/core";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  BpsSchema,
  computeChargeMicroUsd,
  computeDecision,
  CostPlusPricingSchema,
  runFeeDecision,
} from "./pricing.js";
import {
  billingAccounts,
  computers,
  CREDIT_GRANT_CATEGORIES,
  CREDIT_GRANT_SOURCES,
  costEntries,
  creditGrants,
  runs,
  trials,
  usageEntries,
  type PaymentStatus,
} from "./tables.js";

/**
 * Any Drizzle Postgres database or transaction handle (the server's `Database`, a `DbTx` from
 * `scopedDb(...).transaction`, or a bare `drizzle(pool)`). Passing a transaction makes the ledger
 * write inside it (as a savepoint), so callers can pair a ledger write with their own rows.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LedgerDb = PgDatabase<PgQueryResultHKT, any, any>;
type Tx = Parameters<Parameters<LedgerDb["transaction"]>[0]>[0];

export type LedgerErrorCode =
  | "invalid_input"
  | "idempotency_conflict"
  | "trial_mismatch"
  | "run_mismatch"
  | "computer_mismatch"
  | "comp_mismatch"
  | "unknown_entry"
  | "comped_not_reportable"
  | "already_reported";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new LedgerError("invalid_input", issues.join("; "));
  }
  return r.data;
}

// ---- Inputs -------------------------------------------------------------------------------------

/**
 * Comp status is read from the run (runs.comped_by + comp_intervention_id, set by the admin comp
 * action with its interventions row), never taken from the caller. A comped entry is recorded,
 * never counted in the balance and never reported to Stripe. The optional `comped` input is only
 * an assertion: if given and it disagrees with the run, the call fails with `comp_mismatch`.
 */
const CompAssertionSchema = z.boolean().nullish();

interface Comp {
  by: string;
  interventionId: string | null;
}

export const RecordRunFeeInputSchema = z.object({
  runId: RunIdSchema,
  userId: UserIdSchema,
  /** RUN_FEE_MICRO_USD. A bigint or a decimal string, never a number. */
  amount: NonNegativeMicroUsdSchema,
  comped: CompAssertionSchema,
});
export type RecordRunFeeInput = z.input<typeof RecordRunFeeInputSchema>;

export const RecordComputerUsageInputSchema = z.object({
  /** `computers.id` (the registry's UUIDv7). Its run, trial, status and cost are read from the row. */
  computerId: ComputerIdSchema,
  userId: UserIdSchema,
  /** Optional assertion: if given, the computer's run must be this one. */
  runId: RunIdSchema.nullish(),
  /** COMPUTE_MARKUP_BPS. The user is billed cost + floor(cost * bps / 10_000). */
  markupBps: BpsSchema,
  comped: CompAssertionSchema,
});
export type RecordComputerUsageInput = z.input<typeof RecordComputerUsageInputSchema>;

export const RecordManagedTokensInputSchema = z.object({
  userId: UserIdSchema,
  runId: RunIdSchema.nullish(),
  trialId: TrialIdSchema.nullish(),
  /** What Naïve charged us for the tokens, in micro-USD. Recorded as COGS in cost_entries. */
  cost: NonNegativeMicroUsdSchema,
  /** MANAGED_TOKEN_MARKUP_BPS. The user is billed cost + floor(cost * bps / 10_000). */
  markupBps: BpsSchema,
  /** Caller-chosen and stable across retries, e.g. `<agent_session_id>:<naive_seq>`. */
  idempotencyKey: z.string().min(1).max(200),
  /** External reference for the COGS row (Naïve session id); defaults to the idempotency key. */
  ref: z.string().min(1).max(500).nullish(),
  comped: CompAssertionSchema,
});
export type RecordManagedTokensInput = z.input<typeof RecordManagedTokensInputSchema>;

export const ApplyGrantInputSchema = z.object({
  userId: UserIdSchema,
  amount: NonNegativeMicroUsdSchema.refine((v) => v > 0n, { message: "grant must be > 0" }),
  category: z.enum(CREDIT_GRANT_CATEGORIES),
  source: z.enum(CREDIT_GRANT_SOURCES),
  reason: z.string().min(1),
  /** Required for `admin` grants: an interventions row about this user (DB trigger). */
  interventionId: InterventionIdSchema.nullish(),
  /** Stripe's credit grant id (`credgr_...`). Applying the same one twice is a no-op. */
  stripeCreditGrantId: z.string().min(1).nullish(),
  expiresAt: z.date().nullish(),
});
export type ApplyGrantInput = z.input<typeof ApplyGrantInputSchema>;

const MarkReportedInputSchema = z
  .object({
    entryIds: z.array(UsageEntryIdSchema),
    meterEventIds: z.array(z.string().min(1)),
  })
  .refine((v) => v.entryIds.length === v.meterEventIds.length, {
    message: "entryIds and meterEventIds must have the same length",
  })
  .refine((v) => new Set(v.entryIds).size === v.entryIds.length, {
    message: "entryIds must be unique",
  });

// ---- Outputs ------------------------------------------------------------------------------------

export type UsageEntry = typeof usageEntries.$inferSelect;
export type CreditGrant = typeof creditGrants.$inferSelect;

/**
 * `run_not_final`: the run is live or on hold, bill it once terminal. `computer_not_final`: the
 * registry has not destroyed it yet, bill it from the destroy hook. `not_billable` and
 * `zero_cost` are final.
 */
export type SkipReason = "run_not_final" | "not_billable" | "computer_not_final" | "zero_cost";

export type RecordUsageResult =
  | { status: "recorded"; entry: UsageEntry }
  | { status: "duplicate"; entry: UsageEntry }
  | { status: "skipped"; reason: SkipReason; detail?: string };

export const RecordRunChargesInputSchema = z.object({
  runId: RunIdSchema,
  userId: UserIdSchema,
  /** RUN_FEE_MICRO_USD and COMPUTE_MARKUP_BPS from config. */
  pricing: CostPlusPricingSchema,
  comped: CompAssertionSchema,
});
export type RecordRunChargesInput = z.input<typeof RecordRunChargesInputSchema>;

export interface RecordRunChargesResult {
  runFee: RecordUsageResult;
  /** One per computer of the run, oldest first. */
  computers: { computerId: string; result: RecordUsageResult }[];
}

export type ApplyGrantResult =
  { status: "applied"; grant: CreditGrant } | { status: "duplicate"; grant: CreditGrant };

export interface AccountSummary {
  unbilled: MicroUsd;
  granted_remaining: MicroUsd;
  has_payment_method: boolean;
  payment_status: PaymentStatus;
}

export interface AccountAudit {
  ok: boolean;
  cached: { unbilled: MicroUsd; granted_remaining: MicroUsd };
  expected: { unbilled: MicroUsd; granted_remaining: MicroUsd };
  /** Sum of non-comped usage entries (U). */
  usage: MicroUsd;
  /** Sum of credit grants (G). */
  granted: MicroUsd;
}

export interface MarkReportedResult {
  /** Entries marked reported by this call. */
  reported: number;
  /** Entries that were already reported with the same meter event id (a retry). */
  alreadyReported: number;
}

// ---- Balance arithmetic -------------------------------------------------------------------------

interface Balance {
  unbilled: MicroUsd;
  granted_remaining: MicroUsd;
}

/** Split a net position (usage minus grants) into the two cached columns. */
export function balanceFromNet(net: MicroUsd): Balance {
  return net >= 0n
    ? { unbilled: net, granted_remaining: 0n }
    : { unbilled: 0n, granted_remaining: -net };
}

/** Add `delta` (usage > 0, grant < 0) to a balance. Grants are spent first, both ways. */
export function applyNetDelta(balance: Balance, delta: MicroUsd): Balance {
  return balanceFromNet(balance.unbilled - balance.granted_remaining + delta);
}

// ---- The ledger ---------------------------------------------------------------------------------

export interface Ledger {
  /**
   * The run fee, once per run (`run:<id>:fee`), if the stored run and trial states say it is owed
   * (pricing.ts runFeeDecision: delivered or subject-failed). Call it when the run reaches a
   * terminal state; earlier it skips with `run_not_final`.
   */
  recordRunFee(input: RecordRunFeeInput): Promise<RecordUsageResult>;
  /**
   * One computer's compute charge (`computer:<id>:compute`): its registry cost plus the markup, if
   * the stored rows say it is billable (pricing.ts computeDecision): the run is terminal and
   * compute-billable (delivered, subject-failed or user-cancelled), the computer is destroyed, and
   * it served a trial the run bills. Skips with `run_not_final` while the run is live and with
   * `computer_not_final` until the registry destroys it.
   */
  recordComputerUsage(input: RecordComputerUsageInput): Promise<RecordUsageResult>;
  /**
   * The run-terminal hook: recordRunFee, then recordComputerUsage for every computer of the run
   * (each in its own transaction, all idempotent). Computers destroyed later are billed from their
   * destroy hook with recordComputerUsage.
   */
  recordRunCharges(input: RecordRunChargesInput): Promise<RecordRunChargesResult>;
  recordManagedTokens(input: RecordManagedTokensInput): Promise<RecordUsageResult>;
  applyGrant(input: ApplyGrantInput): Promise<ApplyGrantResult>;
  getAccountSummary(userId: string): Promise<AccountSummary>;
  /** Record that these entries were sent to Stripe as these meter events (same order). */
  markReported(
    entryIds: readonly string[],
    meterEventIds: readonly string[],
  ): Promise<MarkReportedResult>;
  /** Non-comped entries not yet reported to Stripe, oldest first (for the meter reporter, 10.5). */
  listUnreported(options?: { userId?: string; limit?: number }): Promise<UsageEntry[]>;
  /** Recompute the balance from the rows and compare with the cache (one snapshot). */
  auditAccount(userId: string): Promise<AccountAudit>;
}

export function runFeeIdempotencyKey(runId: string): string {
  return `run:${runId}:fee`;
}

export function computeIdempotencyKey(computerId: string): string {
  return `computer:${computerId}:compute`;
}

export function managedTokensIdempotencyKey(key: string): string {
  return `tokens:${key}`;
}

/** Create the account row if missing, then lock it for the rest of the transaction. */
async function lockAccount(tx: Tx, userId: string) {
  await tx.insert(billingAccounts).values({ userId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.userId, userId))
    .for("update");
  if (!row) throw new Error(`billing_accounts row for ${userId} vanished under lock`);
  return row;
}

async function addToBalance(tx: Tx, account: typeof billingAccounts.$inferSelect, delta: MicroUsd) {
  if (delta === 0n) return;
  const next = applyNetDelta(
    { unbilled: account.unbilledMicroUsd, granted_remaining: account.grantedRemainingMicroUsd },
    delta,
  );
  await tx
    .update(billingAccounts)
    .set({
      unbilledMicroUsd: next.unbilled,
      grantedRemainingMicroUsd: next.granted_remaining,
      updatedAt: sql`now()`,
    })
    .where(eq(billingAccounts.userId, account.userId));
}

interface NewEntry {
  userId: string;
  runId: string | null;
  trialId: string | null;
  type: UsageEntry["type"];
  amount: MicroUsd;
  idempotencyKey: string;
  comped: Comp | null;
}

/**
 * Insert one usage entry under the account lock, idempotent on its key. A repeat with the same key
 * returns the existing row; a repeat that disagrees about who or how much is a bug and throws.
 */
async function insertEntry(
  tx: Tx,
  e: NewEntry,
  afterInsert?: (entry: UsageEntry) => Promise<void>,
): Promise<RecordUsageResult> {
  const account = await lockAccount(tx, e.userId);
  const [inserted] = await tx
    .insert(usageEntries)
    .values({
      id: newId(UsageEntryIdSchema),
      userId: e.userId,
      runId: e.runId,
      trialId: e.trialId,
      type: e.type,
      amountMicroUsd: e.amount,
      idempotencyKey: e.idempotencyKey,
      compedBy: e.comped?.by ?? null,
      interventionId: e.comped?.interventionId ?? null,
    })
    .onConflictDoNothing({ target: usageEntries.idempotencyKey })
    .returning();
  if (inserted) {
    if (inserted.compedBy === null) await addToBalance(tx, account, inserted.amountMicroUsd);
    await afterInsert?.(inserted);
    return { status: "recorded", entry: inserted };
  }
  const [existing] = await tx
    .select()
    .from(usageEntries)
    .where(eq(usageEntries.idempotencyKey, e.idempotencyKey));
  if (!existing) throw new Error(`usage entry ${e.idempotencyKey} conflicted but is not visible`);
  const same =
    existing.userId === e.userId &&
    existing.type === e.type &&
    existing.amountMicroUsd === e.amount &&
    (existing.compedBy === null) === !e.comped;
  if (!same) {
    throw new LedgerError(
      "idempotency_conflict",
      `usage entry ${e.idempotencyKey} already exists with different user, type, amount or comp`,
    );
  }
  return { status: "duplicate", entry: existing };
}

/**
 * Read the run under FOR SHARE (a concurrent comp or state change waits for this transaction),
 * check it belongs to the user, and return its comp status and state. `asserted` is the caller's
 * optional `comped` flag. Lock order everywhere: run, then computer, then trials, then account.
 */
async function lockRun(
  tx: Tx,
  runId: string,
  userId: string,
  asserted: boolean | null | undefined,
): Promise<{ comp: Comp | null; state: RunState }> {
  const [run] = await tx
    .select({
      ownerId: runs.ownerId,
      state: runs.state,
      compedBy: runs.compedBy,
      compInterventionId: runs.compInterventionId,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("share");
  if (!run || run.ownerId !== userId) {
    throw new LedgerError("run_mismatch", `run ${runId} is not visible or not owned by ${userId}`);
  }
  const comp =
    run.compedBy === null ? null : { by: run.compedBy, interventionId: run.compInterventionId };
  if (asserted !== null && asserted !== undefined && asserted !== (comp !== null)) {
    throw new LedgerError(
      "comp_mismatch",
      `caller says comped=${String(asserted)} but run ${runId} is ${comp ? "comped" : "not comped"}`,
    );
  }
  return { comp, state: run.state };
}

/** Every trial of a run, under FOR SHARE, so their states cannot change until we commit. */
async function lockRunTrials(tx: Tx, runId: string, userId: string) {
  const rows = await tx
    .select({
      id: trials.id,
      ownerId: trials.ownerId,
      state: trials.state,
      computerId: trials.computerId,
    })
    .from(trials)
    .where(eq(trials.runId, runId))
    .orderBy(asc(trials.id))
    .for("share");
  if (rows.some((t) => t.ownerId !== userId)) {
    throw new LedgerError("trial_mismatch", `run ${runId} has trials not owned by ${userId}`);
  }
  return rows;
}

/** Build the ledger over an injected Drizzle database or transaction. */
export function createLedger(db: LedgerDb): Ledger {
  const ledger: Ledger = {
    async recordRunFee(raw) {
      const input = parse(RecordRunFeeInputSchema, raw);
      return db.transaction(async (tx) => {
        const run = await lockRun(tx, input.runId, input.userId, input.comped);
        const runTrials = await lockRunTrials(tx, input.runId, input.userId);
        const decision = runFeeDecision(
          run.state,
          runTrials.map((t) => t.state),
        );
        if (!decision.billable) {
          return {
            status: "skipped",
            reason: decision.reason === "run_not_final" ? "run_not_final" : "not_billable",
            detail: `run ${input.runId} is ${run.state}: ${decision.reason}`,
          };
        }
        return insertEntry(tx, {
          userId: input.userId,
          runId: input.runId,
          trialId: null,
          type: "run_fee",
          amount: input.amount,
          idempotencyKey: runFeeIdempotencyKey(input.runId),
          comped: run.comp,
        });
      });
    },

    async recordComputerUsage(raw) {
      const input = parse(RecordComputerUsageInputSchema, raw);
      return db.transaction(async (tx) => {
        // Unlocked peek for the run id, so the run can be locked first (the lock order).
        const [peek] = await tx
          .select({ runId: computers.runId })
          .from(computers)
          .where(eq(computers.id, input.computerId));
        if (!peek || peek.runId === null) {
          throw new LedgerError(
            "computer_mismatch",
            `computer ${input.computerId} is not visible or belongs to no run`,
          );
        }
        if (input.runId && input.runId !== peek.runId) {
          throw new LedgerError(
            "computer_mismatch",
            `computer ${input.computerId} belongs to run ${peek.runId}, not ${input.runId}`,
          );
        }
        const runId = peek.runId;
        const run = await lockRun(tx, runId, input.userId, input.comped);
        const [computer] = await tx
          .select()
          .from(computers)
          .where(eq(computers.id, input.computerId))
          .for("share");
        if (!computer || computer.runId !== runId) {
          throw new LedgerError(
            "computer_mismatch",
            `computer ${input.computerId} moved off run ${runId} while being billed`,
          );
        }
        const runTrials = await lockRunTrials(tx, runId, input.userId);
        // TODO(9.3 auto-actions): pass the stored cancel cause once runs record one; until then a
        // cancelled run is treated as user-cancelled (compute billed, no run fee).
        const decision = computeDecision(computer, run.state, runTrials);
        if (!decision.billable) {
          return { status: "skipped", reason: decision.reason, detail: decision.detail };
        }
        return insertEntry(tx, {
          userId: input.userId,
          runId,
          trialId: decision.entryTrialId,
          type: "compute",
          amount: computeChargeMicroUsd(computer.costMicroUsd, input.markupBps),
          idempotencyKey: computeIdempotencyKey(computer.id),
          comped: run.comp,
        });
      });
    },

    async recordRunCharges(raw) {
      const input = parse(RecordRunChargesInputSchema, raw);
      const runFee = await ledger.recordRunFee({
        runId: input.runId,
        userId: input.userId,
        amount: input.pricing.runFeeMicroUsd,
        comped: input.comped,
      });
      const rows = await db
        .select({ id: computers.id })
        .from(computers)
        .where(eq(computers.runId, input.runId))
        .orderBy(asc(computers.id));
      const results: RecordRunChargesResult["computers"] = [];
      for (const { id } of rows) {
        results.push({
          computerId: id,
          result: await ledger.recordComputerUsage({
            computerId: id,
            userId: input.userId,
            runId: input.runId,
            markupBps: input.pricing.computeMarkupBps,
            comped: input.comped,
          }),
        });
      }
      return { runFee, computers: results };
    },

    async recordManagedTokens(raw) {
      const input = parse(RecordManagedTokensInputSchema, raw);
      const key = managedTokensIdempotencyKey(input.idempotencyKey);
      const amount = withMarkupBps(input.cost, input.markupBps);
      return db.transaction(async (tx) => {
        let comp: Comp | null = null;
        if (input.runId) {
          comp = (await lockRun(tx, input.runId, input.userId, input.comped)).comp;
        } else if (input.comped) {
          throw new LedgerError("comp_mismatch", "only usage tied to a comped run can be comped");
        }
        if (input.trialId) {
          const [trial] = await tx
            .select({ ownerId: trials.ownerId, runId: trials.runId })
            .from(trials)
            .where(eq(trials.id, input.trialId));
          if (!trial || trial.ownerId !== input.userId || trial.runId !== (input.runId ?? null)) {
            throw new LedgerError(
              "trial_mismatch",
              `trial ${input.trialId} is not visible or does not belong to run ${input.runId ?? "(none)"} / user ${input.userId}`,
            );
          }
        }
        return insertEntry(
          tx,
          {
            userId: input.userId,
            runId: input.runId ?? null,
            trialId: input.trialId ?? null,
            type: "managed_tokens",
            amount,
            idempotencyKey: key,
            comped: comp,
          },
          // Our COGS for the same tokens, written once with the entry (comped or not: we paid it).
          async () => {
            await tx.insert(costEntries).values({
              id: uuidv7(),
              source: "naive",
              runId: input.runId ?? null,
              amountMicroUsd: input.cost,
              ref: input.ref ?? key,
            });
          },
        );
      });
    },

    async applyGrant(raw) {
      const input = parse(ApplyGrantInputSchema, raw);
      return db.transaction(async (tx) => {
        const account = await lockAccount(tx, input.userId);
        const [inserted] = await tx
          .insert(creditGrants)
          .values({
            id: newId(CreditGrantIdSchema),
            userId: input.userId,
            stripeCreditGrantId: input.stripeCreditGrantId ?? null,
            amountMicroUsd: input.amount,
            category: input.category,
            source: input.source,
            reason: input.reason,
            interventionId: input.interventionId ?? null,
            expiresAt: input.expiresAt ?? null,
          })
          // Unique on stripe_credit_grant_id, and one signup grant per user (partial unique index).
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          await addToBalance(tx, account, -inserted.amountMicroUsd);
          return { status: "applied", grant: inserted };
        }
        // The conflict was on the Stripe grant id, or on the one-signup-grant-per-user index.
        let existing: CreditGrant | undefined;
        if (input.stripeCreditGrantId) {
          [existing] = await tx
            .select()
            .from(creditGrants)
            .where(eq(creditGrants.stripeCreditGrantId, input.stripeCreditGrantId));
        }
        if (!existing && input.source === "signup") {
          [existing] = await tx
            .select()
            .from(creditGrants)
            .where(and(eq(creditGrants.userId, input.userId), eq(creditGrants.source, "signup")));
        }
        if (!existing) {
          throw new LedgerError(
            "idempotency_conflict",
            `credit grant for ${input.userId} conflicted with a grant that is not visible`,
          );
        }
        const same =
          existing.userId === input.userId &&
          existing.amountMicroUsd === input.amount &&
          existing.category === input.category &&
          existing.source === input.source &&
          (!input.stripeCreditGrantId ||
            existing.stripeCreditGrantId === null ||
            existing.stripeCreditGrantId === input.stripeCreditGrantId);
        if (!same) {
          throw new LedgerError(
            "idempotency_conflict",
            `credit grant ${existing.id} already exists with different user, amount, category, source or Stripe id`,
          );
        }
        return { status: "duplicate", grant: existing };
      });
    },

    async getAccountSummary(rawUserId) {
      const userId = parse(UserIdSchema, rawUserId);
      const [row] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.userId, userId));
      if (!row) {
        return {
          unbilled: 0n,
          granted_remaining: 0n,
          has_payment_method: false,
          payment_status: "none",
        };
      }
      return {
        unbilled: row.unbilledMicroUsd,
        granted_remaining: row.grantedRemainingMicroUsd,
        has_payment_method: row.hasPaymentMethod,
        payment_status: row.paymentStatus,
      };
    },

    async markReported(rawEntryIds, rawMeterEventIds) {
      const input = parse(MarkReportedInputSchema, {
        entryIds: [...rawEntryIds],
        meterEventIds: [...rawMeterEventIds],
      });
      if (input.entryIds.length === 0) return { reported: 0, alreadyReported: 0 };
      const meterFor = new Map<string, string>(
        input.entryIds.map((id, i) => [id, input.meterEventIds[i]!]),
      );
      return db.transaction(async (tx) => {
        const owners = await tx
          .selectDistinct({ userId: usageEntries.userId })
          .from(usageEntries)
          .where(inArray(usageEntries.id, input.entryIds));
        // Lock every account involved, in a fixed order so concurrent reporters cannot deadlock.
        for (const userId of owners.map((o) => o.userId).sort()) await lockAccount(tx, userId);
        const rows = await tx
          .select()
          .from(usageEntries)
          .where(inArray(usageEntries.id, input.entryIds))
          .orderBy(asc(usageEntries.id))
          .for("update");
        if (rows.length !== input.entryIds.length) {
          const found = new Set(rows.map((r) => r.id));
          const missing = input.entryIds.filter((id) => !found.has(id));
          throw new LedgerError("unknown_entry", `unknown usage entries: ${missing.join(", ")}`);
        }
        let reported = 0;
        let alreadyReported = 0;
        for (const row of rows) {
          const meterEventId = meterFor.get(row.id)!;
          if (row.compedBy !== null) {
            throw new LedgerError("comped_not_reportable", `usage entry ${row.id} is comped`);
          }
          if (row.reportedAt !== null) {
            if (row.stripeMeterEventId !== meterEventId) {
              throw new LedgerError(
                "already_reported",
                `usage entry ${row.id} was reported as ${row.stripeMeterEventId ?? "?"}, not ${meterEventId}`,
              );
            }
            alreadyReported++;
            continue;
          }
          await tx
            .update(usageEntries)
            .set({ stripeMeterEventId: meterEventId, reportedAt: sql`now()` })
            .where(and(eq(usageEntries.id, row.id), isNull(usageEntries.reportedAt)));
          reported++;
        }
        return { reported, alreadyReported };
      });
    },

    async listUnreported(options = {}) {
      const userId = options.userId === undefined ? undefined : parse(UserIdSchema, options.userId);
      const limit = parse(z.number().int().min(1).max(10_000), options.limit ?? 1000);
      return db
        .select()
        .from(usageEntries)
        .where(
          and(
            isNull(usageEntries.reportedAt),
            isNull(usageEntries.compedBy),
            userId === undefined ? undefined : eq(usageEntries.userId, userId),
          ),
        )
        .orderBy(asc(usageEntries.createdAt), asc(usageEntries.id))
        .limit(limit);
    },

    async auditAccount(rawUserId) {
      const userId = parse(UserIdSchema, rawUserId);
      // One statement, so cache and sums come from the same snapshot even under concurrent writes.
      const [row] = await db
        .select({
          unbilled: sql<
            string | null
          >`(select unbilled_micro_usd::text from billing_accounts where user_id = ${userId})`,
          granted_remaining: sql<
            string | null
          >`(select granted_remaining_micro_usd::text from billing_accounts where user_id = ${userId})`,
          usage: sql<string>`(select coalesce(sum(amount_micro_usd), 0)::text from usage_entries where user_id = ${userId} and comped_by is null)`,
          granted: sql<string>`(select coalesce(sum(amount_micro_usd), 0)::text from credit_grants where user_id = ${userId})`,
        })
        .from(sql`(select 1) as one`);
      if (!row) throw new Error("audit query returned no row");
      const usage = BigInt(row.usage);
      const granted = BigInt(row.granted);
      const cached = {
        unbilled: BigInt(row.unbilled ?? "0"),
        granted_remaining: BigInt(row.granted_remaining ?? "0"),
      };
      const expected = balanceFromNet(usage - granted);
      return {
        ok:
          cached.unbilled === expected.unbilled &&
          cached.granted_remaining === expected.granted_remaining,
        cached,
        expected,
        usage,
        granted,
      };
    },
  };
  return ledger;
}
