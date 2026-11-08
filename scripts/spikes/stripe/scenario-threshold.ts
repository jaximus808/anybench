// TDM-21: does a usage threshold invoice early with Billing Meters?
//   (a) subscription billing_thresholds.amount_gte with a meter-backed price
//   (b) a Billing Alert (usage_threshold on the meter, per customer) -> billing.alert.triggered
//   (c) fallback early invoice: reset billing_cycle_anchor to now
//
//   node --env-file=<repo>/.env scripts/spikes/stripe/scenario-threshold.ts
import type Stripe from "stripe";
import { advanceClock, createSpikeContext, errorSummary, runId, sleep, step } from "./lib.ts";
import {
  ensureBillingCatalog,
  METER_CUSTOMER_KEY,
  METER_EVENT_NAME,
  METER_VALUE_KEY,
} from "./setup.ts";

const THRESHOLD_CENTS = 500; // $5 here; production is USAGE_INVOICE_THRESHOLD_MICRO_USD ($50)
const USAGE_CENTS = 600;

const ctx = createSpikeContext();
const { stripe } = ctx;
const startedAt = Math.floor(Date.now() / 1000);
const rid = runId();
const out: Record<string, unknown> = {
  run_id: rid,
  started_at: startedAt,
  threshold_cents: THRESHOLD_CENTS,
  usage_cents: USAGE_CENTS,
};

const catalog = await ensureBillingCatalog(stripe);
const clock = await stripe.testHelpers.testClocks.create({
  frozen_time: startedAt,
  name: `tdm21-threshold-${rid}`,
});
const customer = await stripe.customers.create({
  test_clock: clock.id,
  name: `TDM-21 threshold ${rid}`,
  email: `tdm21+thr-${rid}@example.com`,
  metadata: { user_id: `spike-thr-${rid}`, anybench_spike: "TDM-21" },
});
const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
out.ids = { clock: clock.id, customer: customer.id };
step("customer", "created", out.ids);

// (a) billing_thresholds on create; if refused, create plain and try it on update.
let sub: Stripe.Subscription;
const thresholds: Record<string, unknown> = {};
try {
  sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: catalog.priceId }],
    billing_thresholds: { amount_gte: THRESHOLD_CENTS, reset_billing_cycle_anchor: false },
  });
  thresholds.on_create = {
    accepted: true,
    billing_thresholds: sub.billing_thresholds,
    billing_mode: sub.billing_mode,
  };
} catch (err) {
  thresholds.on_create = { accepted: false, error: errorSummary(err) };
  sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: catalog.priceId }],
  });
  try {
    const updated = await stripe.subscriptions.update(sub.id, {
      billing_thresholds: { amount_gte: THRESHOLD_CENTS, reset_billing_cycle_anchor: false },
    });
    thresholds.on_update = { accepted: true, billing_thresholds: updated.billing_thresholds };
  } catch (err2) {
    thresholds.on_update = { accepted: false, error: errorSummary(err2) };
  }
  // Classic billing mode is where thresholds historically lived; try a classic subscription too.
  try {
    const classic = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: catalog.priceId }],
      billing_mode: { type: "classic" },
      billing_thresholds: { amount_gte: THRESHOLD_CENTS, reset_billing_cycle_anchor: false },
    });
    thresholds.classic_mode = {
      accepted: true,
      id: classic.id,
      billing_thresholds: classic.billing_thresholds,
    };
    await stripe.subscriptions.cancel(classic.id);
  } catch (err3) {
    thresholds.classic_mode = { accepted: false, error: errorSummary(err3) };
  }
}
step("thresholds", "billing_thresholds attempts", thresholds);
out.billing_thresholds = thresholds;
out.subscription = { id: sub.id, billing_mode: sub.billing_mode?.type };

// (b) Billing alert on the meter for this customer.
let alertId: string | null = null;
try {
  const alert = await stripe.billing.alerts.create({
    alert_type: "usage_threshold",
    title: `tdm21 ${rid} usage >= ${THRESHOLD_CENTS}c`,
    usage_threshold: {
      gte: THRESHOLD_CENTS,
      meter: catalog.meterId,
      recurrence: "one_time",
      filters: [{ type: "customer", customer: customer.id }],
    },
  });
  alertId = alert.id;
  out.alert = { accepted: true, id: alert.id, status: alert.status };
} catch (err) {
  out.alert = { accepted: false, error: errorSummary(err) };
}
step("alert", "create", out.alert);

// Usage over the threshold.
await stripe.billing.meterEvents.create({
  event_name: METER_EVENT_NAME,
  identifier: `thr_${rid}_0`,
  timestamp: startedAt + 10,
  payload: { [METER_CUSTOMER_KEY]: customer.id, [METER_VALUE_KEY]: String(USAGE_CENTS) },
});
const minute = (t: number) => Math.floor(t / 60) * 60;
for (let i = 0; i < 36; i++) {
  const s = await stripe.billing.meters.listEventSummaries(catalog.meterId, {
    customer: customer.id,
    start_time: minute(startedAt),
    end_time: minute(startedAt) + 3600,
  });
  if (s.data.reduce((a, x) => a + x.aggregated_value, 0) >= USAGE_CENTS) break;
  await sleep(10_000);
}
step("meter", "usage aggregated", { cents: USAGE_CENTS });

// Give thresholds/alerts a chance: real-time wait, then clock jumps of 1 h and 1 day.
const observations: Record<string, unknown>[] = [];
const observe = async (label: string) => {
  const invs = await stripe.invoices.list({ customer: customer.id, limit: 20 });
  const o = {
    label,
    invoices: invs.data.map((i) => ({
      id: i.id,
      billing_reason: i.billing_reason,
      status: i.status,
      subtotal: i.subtotal,
      amount_due: i.amount_due,
    })),
  };
  observations.push(o);
  step("observe", label, o.invoices);
};
await sleep(90_000);
await observe("90 s real time after usage aggregated");
await advanceClock(stripe, clock.id, startedAt + 3600, "+1 h");
await observe("clock +1 h");
await advanceClock(stripe, clock.id, startedAt + 86_400, "+1 day");
await observe("clock +1 day");
out.observations = observations;

// (c) Fallback early invoice: reset the billing cycle anchor now (invoices usage to date).
try {
  const reset = await stripe.subscriptions.update(sub.id, {
    billing_cycle_anchor: { type: "now" },
    proration_behavior: "none",
  });
  out.anchor_reset = { accepted: true, latest_invoice: reset.latest_invoice };
} catch (err) {
  out.anchor_reset = { accepted: false, error: errorSummary(err) };
}
step("anchor_reset", "billing_cycle_anchor.type=now", out.anchor_reset);
await observe("after billing_cycle_anchor.type=now");
const t = (await stripe.testHelpers.testClocks.retrieve(clock.id)).frozen_time;
await advanceClock(stripe, clock.id, t + 3 * 3600, "+3 h (finalize + charge the early invoice)");
await observe("after anchor reset + 3 h");

// Events for this customer, including billing.alert.triggered (its object is the alert trigger).
const events: { created: number; type: string; id: string }[] = [];
for await (const ev of stripe.events.list({ created: { gte: startedAt - 5 }, limit: 100 })) {
  const obj = ev.data.object as unknown as Record<string, unknown>;
  if (
    obj.customer === customer.id ||
    obj.id === customer.id ||
    obj.id === clock.id ||
    (alertId && JSON.stringify(obj).includes(alertId))
  ) {
    events.push({ created: ev.created, type: ev.type, id: ev.id });
  }
}
events.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
out.events = events;
step(
  "events",
  `${events.length}`,
  events.map((e) => e.type),
);

if (alertId) {
  try {
    await stripe.billing.alerts.archive(alertId);
  } catch (err) {
    step("alert", "archive failed", errorSummary(err));
  }
}
out.calls = ctx.calls;
step("done", `saved ${ctx.save(`scenario-threshold-${rid}`, out)}`);
