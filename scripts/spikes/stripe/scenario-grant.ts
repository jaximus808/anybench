// TDM-21 main proof: $7.50 of metered usage, a $5 promotional credit grant, and the invoice that
// charges the card only the $2.50 difference. Runs on a Stripe test clock so a month passes in
// minutes. Also proves meter event dedupe on `identifier` and micro-USD -> cents with carry.
//
//   node --env-file=<repo>/.env scripts/spikes/stripe/scenario-grant.ts
import { toCents, type MicroUsd } from "@anybench/core";
import type Stripe from "stripe";
import { advanceClock, createSpikeContext, errorSummary, runId, sleep, step } from "./lib.ts";
import {
  ensureBillingCatalog,
  METER_CUSTOMER_KEY,
  METER_EVENT_NAME,
  METER_VALUE_KEY,
} from "./setup.ts";

const ctx = createSpikeContext();
const { stripe } = ctx;
const startedAt = Math.floor(Date.now() / 1000);
const rid = runId();
const out: Record<string, unknown> = { run_id: rid, started_at: startedAt };

const catalog = await ensureBillingCatalog(stripe);
out.catalog = catalog;
step("catalog", "ensured", catalog);

// 1. Test clock + customer with a saved test card (pm_card_visa = 4242 4242 4242 4242).
const clock = await stripe.testHelpers.testClocks.create({
  frozen_time: startedAt,
  name: `tdm21-grant-${rid}`,
});
const customer = await stripe.customers.create({
  test_clock: clock.id,
  name: `TDM-21 spike ${rid}`,
  email: `tdm21+${rid}@example.com`,
  metadata: { user_id: `spike-${rid}`, anybench_spike: "TDM-21" },
});
const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
step("customer", "created on test clock with card", {
  clock: clock.id,
  customer: customer.id,
  pm: pm.id,
  card: pm.card?.last4,
});
out.ids = { clock: clock.id, customer: customer.id, payment_method: pm.id };

// 2. $5 promotional credit grant, metered prices only (plan.md section 8 signup grant).
const grant = await stripe.billing.creditGrants.create({
  customer: customer.id,
  name: "Signup grant (spike)",
  category: "promotional",
  amount: { type: "monetary", monetary: { currency: "usd", value: 500 } },
  applicability_config: { scope: { price_type: "metered" } },
  metadata: { anybench_spike: "TDM-21", reason: "signup" },
});
step("grant", "created", {
  id: grant.id,
  amount: grant.amount,
  effective_at: grant.effective_at,
  expires_at: grant.expires_at,
});
out.grant = grant;

// 3. Subscription on the metered price (what Checkout mode=subscription creates; see checkout.ts).
const sub = await stripe.subscriptions.create({
  customer: customer.id,
  items: [{ price: catalog.priceId }],
  metadata: { user_id: `spike-${rid}` },
  expand: ["latest_invoice"],
});
const item = sub.items.data[0];
if (!item) throw new Error("subscription has no item");
const firstInvoice = sub.latest_invoice as Stripe.Invoice | null;
step("subscription", "created", {
  id: sub.id,
  status: sub.status,
  billing_mode: sub.billing_mode?.type,
  period: [item.current_period_start, item.current_period_end],
  first_invoice: firstInvoice && {
    id: firstInvoice.id,
    status: firstInvoice.status,
    amount_due: firstInvoice.amount_due,
  },
});
out.subscription = {
  id: sub.id,
  status: sub.status,
  billing_mode: sub.billing_mode,
  item: item.id,
  period: [item.current_period_start, item.current_period_end],
  first_invoice: firstInvoice && {
    id: firstInvoice.id,
    status: firstInvoice.status,
    amount_due: firstInvoice.amount_due,
    billing_reason: firstInvoice.billing_reason,
  },
};

// 4. Usage entries in micro-USD -> cents with carry. Sum = 7_500_000 micro = $7.50 = 750 cents.
const entries: MicroUsd[] = [2_000_000n, 1_234_567n, 2_000_005n, 2_265_428n];
let carry: MicroUsd = 0n;
const reported: {
  identifier: string;
  micro: string;
  cents: string;
  carry_after: string;
  timestamp: number;
}[] = [];
for (const [i, micro] of entries.entries()) {
  const conv = toCents(micro, carry);
  carry = conv.carry;
  const identifier = `ue_${rid}_${i}`;
  const timestamp = startedAt + 10 + i;
  const ev = await stripe.billing.meterEvents.create({
    event_name: METER_EVENT_NAME,
    identifier,
    timestamp,
    payload: { [METER_CUSTOMER_KEY]: customer.id, [METER_VALUE_KEY]: conv.cents.toString() },
  });
  reported.push({
    identifier: ev.identifier,
    micro: micro.toString(),
    cents: conv.cents.toString(),
    carry_after: carry.toString(),
    timestamp: ev.timestamp,
  });
}
step("meter", "reported 4 events", reported);
out.meter_events = reported;

// 5. Dedupe: resend #1 unchanged, and resend #1's identifier with a different value (9999 cents).
const dedupe: Record<string, unknown> = {};
for (const [label, value] of [
  ["same_identifier_same_value", reported[1]!.cents],
  ["same_identifier_value_9999", "9999"],
] as const) {
  try {
    const ev = await stripe.billing.meterEvents.create({
      event_name: METER_EVENT_NAME,
      identifier: reported[1]!.identifier,
      timestamp: reported[1]!.timestamp,
      payload: { [METER_CUSTOMER_KEY]: customer.id, [METER_VALUE_KEY]: value },
    });
    dedupe[label] = { accepted: true, identifier: ev.identifier, created: ev.created };
  } catch (err) {
    dedupe[label] = { accepted: false, error: errorSummary(err) };
  }
}
step("dedupe", "resends", dedupe);
out.dedupe_responses = dedupe;

// 6. Wait for the meter to aggregate (it is async), then preview the invoice.
const minute = (t: number) => Math.floor(t / 60) * 60;
let aggregated: number | null = null;
const aggStart = Date.now();
while (Date.now() - aggStart < 6 * 60_000) {
  const summaries = await stripe.billing.meters.listEventSummaries(catalog.meterId, {
    customer: customer.id,
    start_time: minute(startedAt),
    end_time: minute(startedAt) + 3600,
  });
  aggregated = summaries.data.reduce((s, x) => s + x.aggregated_value, 0);
  if (aggregated >= 750) break;
  await sleep(10_000);
}
step("meter", `summary aggregated_value after ${Math.round((Date.now() - aggStart) / 1000)}s`, {
  aggregated_value: aggregated,
  expected: 750,
});
out.meter_summary = {
  aggregated_value: aggregated,
  expected_cents: 750,
  waited_s: Math.round((Date.now() - aggStart) / 1000),
};

const preview = await stripe.invoices.createPreview({
  customer: customer.id,
  subscription: sub.id,
});
const previewOut = {
  subtotal: preview.subtotal,
  total: preview.total,
  amount_due: preview.amount_due,
  total_pretax_credit_amounts: preview.total_pretax_credit_amounts,
  lines: preview.lines.data.map((l) => ({
    description: l.description,
    amount: l.amount,
    quantity: l.quantity,
  })),
};
step("preview", "upcoming invoice", previewOut);
out.preview = previewOut;

// 7. Advance past the period end: Stripe drafts the cycle invoice, finalizes ~1 h later, charges.
const periodEnd = item.current_period_end;
await advanceClock(stripe, clock.id, periodEnd + 60, "to period end + 1 min");
const draft = (await stripe.invoices.list({ customer: customer.id, limit: 10 })).data.find(
  (i) => i.billing_reason === "subscription_cycle",
);
step(
  "invoice",
  "after period end",
  draft && {
    id: draft.id,
    status: draft.status,
    subtotal: draft.subtotal,
    amount_due: draft.amount_due,
  },
);
out.invoice_after_period_end = draft && {
  id: draft.id,
  status: draft.status,
  subtotal: draft.subtotal,
  total: draft.total,
  amount_due: draft.amount_due,
  total_pretax_credit_amounts: draft.total_pretax_credit_amounts,
};

await advanceClock(
  stripe,
  clock.id,
  periodEnd + 3 * 3600,
  "to period end + 3 h (auto-finalize + charge)",
);
const invoices = await stripe.invoices.list({ customer: customer.id, limit: 10 });
const cycle = invoices.data.find((i) => i.billing_reason === "subscription_cycle");
if (!cycle) throw new Error("no subscription_cycle invoice");
const payments = await stripe.invoicePayments.list({ invoice: cycle.id! });
const cycleOut = {
  id: cycle.id,
  status: cycle.status,
  billing_reason: cycle.billing_reason,
  period: [cycle.period_start, cycle.period_end],
  subtotal: cycle.subtotal,
  total_pretax_credit_amounts: cycle.total_pretax_credit_amounts,
  total: cycle.total,
  amount_due: cycle.amount_due,
  amount_paid: cycle.amount_paid,
  lines: cycle.lines.data.map((l) => ({
    description: l.description,
    amount: l.amount,
    quantity: l.quantity,
    pretax_credit_amounts: l.pretax_credit_amounts,
  })),
  payments: payments.data.map((p) => ({
    id: p.id,
    status: p.status,
    amount_paid: p.amount_paid,
    payment: p.payment,
  })),
  hosted_invoice_url: cycle.hosted_invoice_url,
};
step("invoice", "cycle invoice", cycleOut);
out.cycle_invoice = cycleOut;
out.all_invoices = invoices.data.map((i) => ({
  id: i.id,
  billing_reason: i.billing_reason,
  status: i.status,
  subtotal: i.subtotal,
  amount_due: i.amount_due,
  amount_paid: i.amount_paid,
}));

// 8. Grant balance and its ledger.
const balance = await stripe.billing.creditBalanceSummaries.retrieve({
  customer: customer.id,
  filter: { type: "credit_grant", credit_grant: grant.id },
});
const txns = await stripe.billing.creditBalanceTransactions.list({
  customer: customer.id,
  credit_grant: grant.id,
});
const balanceOut = {
  balances: balance.balances.map((b) => ({
    available: b.available_balance,
    ledger: b.ledger_balance,
  })),
  transactions: txns.data.map((t) => ({
    id: t.id,
    type: t.type,
    effective_at: t.effective_at,
    credit: t.credit,
    debit: t.debit,
  })),
};
step("grant", "balance after invoice", balanceOut);
out.grant_balance = balanceOut;

// 9. Event sequence for this customer (what the webhook endpoint would receive, in order).
const events: { created: number; type: string; id: string; object: string }[] = [];
for await (const ev of stripe.events.list({ created: { gte: startedAt - 5 }, limit: 100 })) {
  const obj = ev.data.object as unknown as Record<string, unknown>;
  const related =
    obj.customer === customer.id ||
    obj.id === customer.id ||
    obj.test_clock === clock.id ||
    obj.id === clock.id;
  if (related)
    events.push({ created: ev.created, type: ev.type, id: ev.id, object: String(obj.id) });
}
events.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
step(
  "events",
  `${events.length} events`,
  events.map((e) => e.type),
);
out.events = events;

out.calls = ctx.calls;
step("done", `saved ${ctx.save(`scenario-grant-${rid}`, out)}`);
