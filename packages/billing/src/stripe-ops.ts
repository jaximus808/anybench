// The Stripe calls behind "link a card, then press Go" (plan.md section 8; tickets 10.3, 10.4, 10.5).
//
// One port, `StripeBillingPort`, so the server holds no Stripe types and its tests can pass a fake:
//   - ensureCustomer      one Customer per user (metadata.user_id), idempotent per user.
//   - linkCardCheckout    Checkout Session mode "subscription" with the metered usage price: it
//                         saves the card and starts the usage subscription, $0 due today (TDM-21
//                         spike: the card lands on subscription.default_payment_method).
//   - portal              the Stripe billing portal (cards, invoices, receipts).
//   - accountState        what Stripe says now: the usage subscription, its status mapped to our
//                         payment_status, and whether a card is on file. The webhook and the
//                         billing page both re-read this instead of trusting event order (events in
//                         the same second arrive out of order, docs/findings/stripe.md).
//   - verifyWebhook       signature check on the raw body + a small normalized view of the event.
//   - reportUsage         one meter event per usage entry, `identifier = <usage_entry_id>`; Stripe
//                         dedupes on it and answers 400 "An event already exists with identifier"
//                         for a resend, which counts as already reported.
//
// Money: the meter value is in CENTS (Stripe's unit), our ledger is integer micro-USD. `meterCents`
// turns one entry into cents with the remainder carried across a user's entries, so nothing is lost
// to rounding: floor((reported + amount) / 10_000) - floor(reported / 10_000). No floats.
import type Stripe from "stripe";
import { METER_CUSTOMER_KEY, METER_EVENT_NAME, METER_VALUE_KEY } from "./setup.js";
import { assertLivemode, requireIds, type BillingStripe, type StripeMode } from "./stripe.js";

export const MICRO_PER_CENT = 10_000n;

/** Our payment_status for a Stripe subscription status (`blocked` is ours alone, never Stripe's). */
export type StripePaymentStatus = "none" | "ok" | "past_due";

export function paymentStatusForSubscription(
  status: Stripe.Subscription.Status | undefined,
): StripePaymentStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "ok";
    case "past_due":
    case "unpaid":
      return "past_due";
    default:
      return "none";
  }
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/**
 * Cents to send for one usage entry of `amountMicroUsd`, given the sum of the user's entries
 * already reported (`reportedMicroUsd`). Summed over every entry this is exactly
 * floor(total / 10_000): the fractional cent carries to the next entry instead of being lost.
 */
export function meterCents(reportedMicroUsd: bigint, amountMicroUsd: bigint): bigint {
  return (
    floorDiv(reportedMicroUsd + amountMicroUsd, MICRO_PER_CENT) -
    floorDiv(reportedMicroUsd, MICRO_PER_CENT)
  );
}

export interface StripeAccountState {
  subscriptionId: string | null;
  paymentStatus: StripePaymentStatus;
  hasPaymentMethod: boolean;
}

/** The parts of a webhook event the server acts on, plus the raw payload for stripe_events. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  livemode: boolean;
  /** The Customer the event is about, when it names one. */
  customerId: string | null;
  /** Our user id from Checkout's client_reference_id or the object's metadata.user_id. */
  userIdHint: string | null;
  /** invoice.paid: what was charged, in cents (0 when credit covered it). */
  amountPaidCents: number | null;
  payload: unknown;
}

/** A webhook that is not signed with our secret (or has no secret configured): answer 400. */
export class StripeWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeWebhookError";
  }
}

export interface StripeBillingPort {
  readonly mode: StripeMode;
  ensureCustomer(input: { userId: string; email: string | null; name: string }): Promise<string>;
  linkCardCheckout(input: {
    customerId: string;
    userId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string }>;
  portal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  accountState(customerId: string): Promise<StripeAccountState>;
  verifyWebhook(rawBody: string, signature: string): StripeWebhookEvent;
  reportUsage(input: {
    identifier: string;
    customerId: string;
    cents: bigint;
  }): Promise<"sent" | "duplicate">;
}

function idOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "id" in v && typeof v.id === "string") return v.id;
  return null;
}

/** Normalize a verified event: which customer and user it is about, and invoice.paid's amount. */
export function summarizeStripeEvent(event: Stripe.Event): StripeWebhookEvent {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const customerId = obj.object === "customer" ? idOf(obj.id) : idOf(obj.customer);
  const metadata = (obj.metadata ?? {}) as Record<string, unknown>;
  const ref = obj.client_reference_id ?? metadata.user_id;
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    customerId,
    userIdHint: typeof ref === "string" && ref.length > 0 ? ref : null,
    amountPaidCents:
      event.type === "invoice.paid" && typeof obj.amount_paid === "number" ? obj.amount_paid : null,
    payload: event,
  };
}

/** Subscription statuses that still hold a card for us, best first. */
const SUBSCRIPTION_PREFERENCE: readonly Stripe.Subscription.Status[] = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
];

function isAlreadyReported(err: unknown): boolean {
  return (
    err instanceof Error &&
    "statusCode" in err &&
    err.statusCode === 400 &&
    /An event already exists with identifier/i.test(err.message)
  );
}

/** The port over a real Stripe client. `webhookSecret` is required only by verifyWebhook. */
export function createStripeBillingPort(
  client: BillingStripe,
  options: { webhookSecret?: string | undefined } = {},
): StripeBillingPort {
  const { stripe, config } = client;
  const mode = config.mode;
  return {
    mode,

    async ensureCustomer({ userId, email, name }) {
      // The idempotency key makes two concurrent "Add a card" clicks create one Customer; the
      // caller stores the id on billing_accounts (unique) so later calls never reach Stripe.
      const customer = await stripe.customers.create(
        {
          ...(email ? { email } : {}),
          name,
          metadata: { user_id: userId },
        },
        { idempotencyKey: `anybench-customer-${userId}` },
      );
      assertLivemode(mode, customer);
      return customer.id;
    },

    async linkCardCheckout({ customerId, userId, successUrl, cancelUrl }) {
      const { priceId } = requireIds(config);
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: userId,
        // Metered price: no quantity. $0 due today; usage is invoiced monthly.
        line_items: [{ price: priceId }],
        subscription_data: { metadata: { user_id: userId } },
        metadata: { user_id: userId, purpose: "link_card" },
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      assertLivemode(mode, session);
      if (!session.url) throw new Error(`checkout session ${session.id} has no url`);
      return { url: session.url, sessionId: session.id };
    },

    async portal({ customerId, returnUrl }) {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      assertLivemode(mode, session);
      return { url: session.url };
    },

    async accountState(customerId) {
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 20,
      });
      let best: Stripe.Subscription | undefined;
      for (const status of SUBSCRIPTION_PREFERENCE) {
        best = subs.data.find((s) => s.status === status);
        if (best) break;
      }
      if (best) assertLivemode(mode, best);
      let hasPaymentMethod = Boolean(best?.default_payment_method);
      if (!hasPaymentMethod) {
        const pms = await stripe.customers.listPaymentMethods(customerId, { limit: 1 });
        hasPaymentMethod = pms.data.length > 0;
      }
      return {
        subscriptionId: best?.id ?? null,
        paymentStatus: paymentStatusForSubscription(best?.status),
        hasPaymentMethod,
      };
    },

    verifyWebhook(rawBody, signature) {
      if (!options.webhookSecret) {
        throw new StripeWebhookError("no webhook secret configured (STRIPE_WEBHOOK_SECRET)");
      }
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, options.webhookSecret);
      } catch (err) {
        throw new StripeWebhookError(
          `signature check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (event.livemode !== (mode === "live")) {
        throw new StripeWebhookError(
          `event ${event.id} has livemode=${String(event.livemode)} but BILLING_MODE=${mode}`,
        );
      }
      return summarizeStripeEvent(event);
    },

    async reportUsage({ identifier, customerId, cents }) {
      if (cents <= 0n) throw new Error(`meter value must be positive cents (got ${cents})`);
      try {
        await stripe.billing.meterEvents.create({
          event_name: METER_EVENT_NAME,
          identifier,
          payload: { [METER_CUSTOMER_KEY]: customerId, [METER_VALUE_KEY]: cents.toString() },
        });
        return "sent";
      } catch (err) {
        if (isAlreadyReported(err)) return "duplicate";
        throw err;
      }
    },
  };
}
