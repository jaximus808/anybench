// TDM-21: link a card with Checkout (mode=subscription, metered price, nothing charged upfront).
//
//   node --env-file=<repo>/.env scripts/spikes/stripe/checkout.ts create
//     -> creates a Customer (metadata.user_id) and a Checkout Session; prints its URL.
//        Open it and pay with 4242 4242 4242 4242, any future expiry, any CVC.
//   node --env-file=<repo>/.env scripts/spikes/stripe/checkout.ts inspect <cs_test_...>
//     -> what the session left behind: subscription, saved card, default payment method.
//
// Checkout Sessions cannot be completed through the API; the card must be entered on the page.
import { randomBytes } from "node:crypto";
import type Stripe from "stripe";
import { z } from "zod";
import { createSpikeContext, runId, step } from "./lib.ts";
import { ensureBillingCatalog } from "./setup.ts";

const ArgsSchema = z.union([
  z.tuple([z.literal("create")]),
  z.tuple([z.literal("inspect"), z.string().regex(/^cs_test_[A-Za-z0-9]+$/)]),
]);
const args = ArgsSchema.parse(process.argv.slice(2));
const ctx = createSpikeContext();
const { stripe } = ctx;

if (args[0] === "create") {
  const catalog = await ensureBillingCatalog(stripe);
  const rid = runId();
  const userId = `spike-checkout-${rid}`;
  const customer = await stripe.customers.create({
    email: `tdm21+co-${rid}@example.com`,
    name: `TDM-21 checkout ${rid}`,
    metadata: { user_id: userId, anybench_spike: "TDM-21" },
  });
  // 8 random lowercase letters, per Stripe's integration_identifier guidance.
  const suffix = Array.from(randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join("");
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    client_reference_id: userId,
    line_items: [{ price: catalog.priceId }], // metered: no quantity
    subscription_data: { metadata: { user_id: userId } },
    success_url: "http://localhost:3000/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "http://localhost:3000/billing?checkout=cancel",
    integration_identifier: `anybench_link_card_${suffix}`,
    metadata: { user_id: userId, anybench_spike: "TDM-21" },
  });
  const created = {
    customer: customer.id,
    session: session.id,
    status: session.status,
    payment_status: session.payment_status,
    amount_total: session.amount_total,
    url: session.url,
  };
  step("checkout", "session created", created);
  ctx.save(`checkout-create-${rid}`, { ...created, calls: ctx.calls });
} else {
  const session = await stripe.checkout.sessions.retrieve(args[1], {
    expand: ["subscription", "setup_intent"],
  });
  const sub = session.subscription as Stripe.Subscription | null;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const customer = customerId ? await stripe.customers.retrieve(customerId) : null;
  const pms = customerId
    ? await stripe.customers.listPaymentMethods(customerId, { limit: 5 })
    : null;
  const inspected = {
    session: {
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      mode: session.mode,
    },
    subscription: sub && {
      id: sub.id,
      status: sub.status,
      default_payment_method: sub.default_payment_method,
      metadata: sub.metadata,
      latest_invoice: sub.latest_invoice,
    },
    customer:
      customer && !customer.deleted
        ? {
            id: customer.id,
            metadata: customer.metadata,
            invoice_settings: customer.invoice_settings,
          }
        : null,
    payment_methods: pms?.data.map((p) => ({
      id: p.id,
      type: p.type,
      brand: p.card?.brand,
      last4: p.card?.last4,
    })),
  };
  step("checkout", "inspect", inspected);
  ctx.save(`checkout-inspect-${session.id.slice(-8)}`, { ...inspected, calls: ctx.calls });
}
