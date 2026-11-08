// Card on file + usage reporting over the database (stripe-onboarding, plan.md section 8).
//
// The Stripe side is packages/billing's StripeBillingPort; this file is the database side:
//   - stripeBillingFromConfig  the port for this deployment, or null (BILLING_MODE=off, no key).
//                              TEST MODE ONLY until the live cutover ticket (10.11): live -> null.
//   - ensureStripeCustomer     billing_accounts.stripe_customer_id, created once per user.
//   - syncBillingAccount       re-read the account from Stripe (subscription status, card on file)
//                              and store it. The webhook and the billing page both call it, so the
//                              order events arrive in never matters.
//   - processStripeEvent       the webhook: stripe_events insert first (redelivery = no-op), then
//                              sync the customer's account; invoice.paid stamps first_paid_invoice_at.
//   - reportUsageToStripe      the meter reporter (job billing.report): every unreported, non-comped
//                              usage entry becomes one meter event (identifier = entry id), in cents
//                              with the remainder carried per user. Comped (founder demo) runs and
//                              runs our pipeline failed never have reportable entries (the ledger
//                              decides that), so nothing here can bill them.
// Every query here runs on the privileged pool role with an explicit user_id filter: billing rows
// are written by us, never by tenants.
import {
  createBillingStripe,
  createLedger,
  createStripeBillingPort,
  meterCents,
  resolveStripeConfig,
  StripeModeError,
  type StripeBillingPort,
  type StripeWebhookEvent,
} from "@anybench/billing";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { billingAccounts, stripeEvents, usageEntries, users } from "../db/schema/index.js";
import type { Logger } from "./logger.js";

type StripeConfigFields = Pick<
  Config,
  | "BILLING_MODE"
  | "STRIPE_SECRET_KEY"
  | "STRIPE_TEST_SECRET_KEY"
  | "STRIPE_LIVE_SECRET_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  | "STRIPE_TEST_WEBHOOK_SECRET"
  | "STRIPE_LIVE_WEBHOOK_SECRET"
  | "STRIPE_METER_ID"
  | "STRIPE_TEST_METER_ID"
  | "STRIPE_LIVE_METER_ID"
  | "STRIPE_PRICE_USAGE"
  | "STRIPE_TEST_PRICE_USAGE"
  | "STRIPE_LIVE_PRICE_USAGE"
>;

/**
 * The Stripe port for this config, or null when billing has no Stripe here: BILLING_MODE=off, no
 * key, or BILLING_MODE=live (refused until 10.11 so no real card is ever charged before then).
 */
export function stripeBillingFromConfig(
  config: StripeConfigFields,
  logger?: Pick<Logger, "warn">,
): StripeBillingPort | null {
  if (config.BILLING_MODE !== "test") {
    if (config.BILLING_MODE === "live") {
      logger?.warn("BILLING_MODE=live is not enabled before the 10.11 cutover; Stripe is off");
    }
    return null;
  }
  try {
    const client = createBillingStripe(
      resolveStripeConfig({
        BILLING_MODE: config.BILLING_MODE,
        STRIPE_SECRET_KEY: config.STRIPE_SECRET_KEY,
        STRIPE_TEST_SECRET_KEY: config.STRIPE_TEST_SECRET_KEY,
        STRIPE_METER_ID: config.STRIPE_METER_ID,
        STRIPE_TEST_METER_ID: config.STRIPE_TEST_METER_ID,
        STRIPE_PRICE_USAGE: config.STRIPE_PRICE_USAGE,
        STRIPE_TEST_PRICE_USAGE: config.STRIPE_TEST_PRICE_USAGE,
      }),
    );
    return createStripeBillingPort(client, {
      webhookSecret: config.STRIPE_WEBHOOK_SECRET ?? config.STRIPE_TEST_WEBHOOK_SECRET,
    });
  } catch (err) {
    if (err instanceof StripeModeError) {
      logger?.warn({ reason: err.message }, "Stripe is not configured; card linking is off");
      return null;
    }
    throw err;
  }
}

export type BillingAccountRow = typeof billingAccounts.$inferSelect;

/** The account row, created empty if the user has none. */
export async function loadBillingAccount(db: Database, userId: string): Promise<BillingAccountRow> {
  await db.insert(billingAccounts).values({ userId }).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.userId, userId))
    .limit(1);
  if (!row) throw new Error(`billing account ${userId} vanished`);
  return row;
}

/** The user's Stripe Customer id, creating the Customer (once) when there is none. */
export async function ensureStripeCustomer(
  db: Database,
  port: StripeBillingPort,
  userId: string,
): Promise<string> {
  const account = await loadBillingAccount(db, userId);
  if (account.stripeCustomerId) return account.stripeCustomerId;
  const [user] = await db
    .select({ githubLogin: users.githubLogin, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new Error(`user ${userId} not found`);
  const customerId = await port.ensureCustomer({
    userId,
    email: user.email,
    name: user.githubLogin,
  });
  // A concurrent request may have stored it first; Stripe's idempotency key gave both the same id.
  await db
    .update(billingAccounts)
    .set({ stripeCustomerId: customerId, updatedAt: sql`now()` })
    .where(and(eq(billingAccounts.userId, userId), isNull(billingAccounts.stripeCustomerId)));
  const again = await loadBillingAccount(db, userId);
  return again.stripeCustomerId ?? customerId;
}

/**
 * Re-read the user's subscription and card from Stripe and store them. `blocked` is our own
 * decision (fraud, disputes) and is never lifted by a sync. Returns the updated row.
 */
export async function syncBillingAccount(
  db: Database,
  port: StripeBillingPort,
  userId: string,
): Promise<BillingAccountRow> {
  const account = await loadBillingAccount(db, userId);
  if (!account.stripeCustomerId) return account;
  const state = await port.accountState(account.stripeCustomerId);
  const [row] = await db
    .update(billingAccounts)
    .set({
      subscriptionId: state.subscriptionId,
      hasPaymentMethod: state.hasPaymentMethod,
      paymentStatus: sql`case when ${billingAccounts.paymentStatus} = 'blocked' then 'blocked' else ${state.paymentStatus} end`,
      updatedAt: sql`now()`,
    })
    .where(eq(billingAccounts.userId, userId))
    .returning();
  return row ?? account;
}

/** Event types that change what the run gate should see; every other type is only recorded. */
export const ACCOUNT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "payment_method.attached",
  "payment_method.detached",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
]);

export interface ProcessedStripeEvent {
  duplicate: boolean;
  userId: string | null;
}

/** Which of our users an event is about: by stored customer id, else by the user id hint. */
async function userForEvent(db: Database, ev: StripeWebhookEvent): Promise<string | null> {
  if (ev.customerId) {
    const [row] = await db
      .select({ userId: billingAccounts.userId })
      .from(billingAccounts)
      .where(eq(billingAccounts.stripeCustomerId, ev.customerId))
      .limit(1);
    if (row) return row.userId;
  }
  if (!ev.userIdHint || !ev.customerId) return null;
  // Checkout for a Customer we created but whose id we failed to store: adopt it only when the
  // hinted user exists and has no customer yet (never re-point an account at another customer).
  const hint = /^[0-9a-f-]{36}$/i.test(ev.userIdHint) ? ev.userIdHint : null;
  if (!hint) return null;
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, hint)).limit(1);
  if (!user) return null;
  await loadBillingAccount(db, user.id);
  const [adopted] = await db
    .update(billingAccounts)
    .set({ stripeCustomerId: ev.customerId, updatedAt: sql`now()` })
    .where(and(eq(billingAccounts.userId, user.id), isNull(billingAccounts.stripeCustomerId)))
    .returning({ userId: billingAccounts.userId });
  return adopted?.userId ?? null;
}

/**
 * Handle one verified webhook event. Insert into stripe_events first: a redelivered event that was
 * processed is a no-op (`duplicate: true`). A failure stores last_error and rethrows, so the route
 * answers 500 and Stripe redelivers.
 */
export async function processStripeEvent(
  db: Database,
  port: StripeBillingPort,
  ev: StripeWebhookEvent,
): Promise<ProcessedStripeEvent> {
  await db
    .insert(stripeEvents)
    .values({ id: ev.id, type: ev.type, payload: ev.payload as object })
    .onConflictDoNothing();
  const [stored] = await db
    .select({ processedAt: stripeEvents.processedAt })
    .from(stripeEvents)
    .where(eq(stripeEvents.id, ev.id))
    .limit(1);
  if (stored?.processedAt) return { duplicate: true, userId: null };
  try {
    let userId: string | null = null;
    if (ACCOUNT_EVENT_TYPES.has(ev.type)) {
      userId = await userForEvent(db, ev);
      if (userId) {
        await syncBillingAccount(db, port, userId);
        if (ev.type === "invoice.paid" && (ev.amountPaidCents ?? 0) > 0) {
          await db
            .update(billingAccounts)
            .set({ firstPaidInvoiceAt: sql`now()` })
            .where(
              and(eq(billingAccounts.userId, userId), isNull(billingAccounts.firstPaidInvoiceAt)),
            );
        }
      }
    }
    await db
      .update(stripeEvents)
      .set({ processedAt: sql`now()`, lastError: null })
      .where(eq(stripeEvents.id, ev.id));
    return { duplicate: false, userId };
  } catch (err) {
    await db
      .update(stripeEvents)
      .set({ lastError: err instanceof Error ? err.message.slice(0, 2000) : String(err) })
      .where(eq(stripeEvents.id, ev.id));
    throw err;
  }
}

export interface UsageReport {
  sent: number;
  duplicate: number;
  /** Entries whose carried cents round to 0 this time: marked reported, no meter event. */
  zero: number;
  /** Users with unreported usage but no Stripe Customer (nothing to bill yet). */
  skippedNoCustomer: number;
  failed: number;
}

/**
 * Send every unreported, non-comped, positive usage entry to the Stripe meter, oldest first.
 * Idempotent: identifier = usage entry id (Stripe dedupes), and an entry is marked reported only
 * after Stripe accepted it. One failure stops that user's batch (to keep the carry in order) but
 * not other users'.
 */
export async function reportUsageToStripe(
  db: Database,
  port: StripeBillingPort,
  options: { limit?: number; logger?: Pick<Logger, "warn" | "error"> } = {},
): Promise<UsageReport> {
  const out: UsageReport = { sent: 0, duplicate: 0, zero: 0, skippedNoCustomer: 0, failed: 0 };
  const pending = await db
    .select({
      id: usageEntries.id,
      userId: usageEntries.userId,
      amount: usageEntries.amountMicroUsd,
      customerId: billingAccounts.stripeCustomerId,
    })
    .from(usageEntries)
    .leftJoin(billingAccounts, eq(billingAccounts.userId, usageEntries.userId))
    .where(
      and(
        isNull(usageEntries.reportedAt),
        isNull(usageEntries.compedBy),
        sql`${usageEntries.amountMicroUsd} > 0`,
      ),
    )
    .orderBy(asc(usageEntries.createdAt), asc(usageEntries.id))
    .limit(options.limit ?? 500);

  const ledger = createLedger(db);
  const stopped = new Set<string>();
  for (const entry of pending) {
    if (stopped.has(entry.userId)) continue;
    if (!entry.customerId) {
      out.skippedNoCustomer++;
      stopped.add(entry.userId);
      continue;
    }
    try {
      const [prior] = await db
        .select({ sum: sql<string>`coalesce(sum(${usageEntries.amountMicroUsd}), 0)::text` })
        .from(usageEntries)
        .where(
          and(
            eq(usageEntries.userId, entry.userId),
            isNotNull(usageEntries.reportedAt),
            isNull(usageEntries.compedBy),
            sql`${usageEntries.amountMicroUsd} > 0`,
          ),
        );
      const cents = meterCents(BigInt(prior?.sum ?? "0"), entry.amount);
      let meterEventId: string;
      if (cents > 0n) {
        const r = await port.reportUsage({
          identifier: entry.id,
          customerId: entry.customerId,
          cents,
        });
        if (r === "sent") out.sent++;
        else out.duplicate++;
        meterEventId = entry.id;
      } else {
        out.zero++;
        meterEventId = `zero:${entry.id}`;
      }
      await ledger.markReported([entry.id], [meterEventId]);
    } catch (err) {
      out.failed++;
      stopped.add(entry.userId);
      options.logger?.error({ err, usageEntryId: entry.id }, "meter event failed; will retry");
    }
  }
  return out;
}
