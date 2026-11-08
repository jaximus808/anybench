// TDM-21: idempotent Stripe catalog setup for usage billing (plan.md section 8). 10.2 reuses this.
//
//   node --env-file=<repo>/.env scripts/spikes/stripe/setup.ts
//
// Creates (or finds) exactly one of each:
//   - Billing Meter   event_name "anybench_usage", sum aggregation, value in CENTS
//                     (payload: { stripe_customer_id, value }). Meters have no metadata or
//                     lookup_key, so the event_name is the idempotency key (Stripe also rejects a
//                     second active meter with the same event_name).
//   - Product         fixed id "anybench_usage" (products accept a caller-chosen id).
//   - Price           lookup_key "anybench_usage_cents_v1": USD, 1 cent per meter unit, monthly,
//                     usage_type metered, linked to the meter. Prices are immutable, so a change
//                     means a new lookup_key (v2) and `transfer_lookup_key`, never an edit.
// Running it twice returns the same ids and creates nothing the second time.
import type Stripe from "stripe";
import { createSpikeContext, step } from "./lib.ts";

export const METER_EVENT_NAME = "anybench_usage";
export const PRODUCT_ID = "anybench_usage";
export const PRICE_LOOKUP_KEY = "anybench_usage_cents_v1";
/** Meter payload keys (Stripe's defaults, spelled out so the reporter can't drift). */
export const METER_CUSTOMER_KEY = "stripe_customer_id";
export const METER_VALUE_KEY = "value";

export interface BillingCatalog {
  meterId: string;
  productId: string;
  priceId: string;
  created: { meter: boolean; product: boolean; price: boolean };
}

export async function ensureMeter(
  stripe: Stripe,
): Promise<{ meter: Stripe.Billing.Meter; created: boolean }> {
  for await (const meter of stripe.billing.meters.list({ limit: 100 })) {
    if (meter.event_name !== METER_EVENT_NAME) continue;
    if (meter.status === "inactive") {
      // A deactivated meter still owns the event name; bring it back instead of failing.
      return { meter: await stripe.billing.meters.reactivate(meter.id), created: false };
    }
    return { meter, created: false };
  }
  const meter = await stripe.billing.meters.create({
    display_name: "Anybench usage (cents)",
    event_name: METER_EVENT_NAME,
    default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: METER_CUSTOMER_KEY },
    value_settings: { event_payload_key: METER_VALUE_KEY },
  });
  return { meter, created: true };
}

export async function ensureProduct(
  stripe: Stripe,
): Promise<{ product: Stripe.Product; created: boolean }> {
  try {
    const product = await stripe.products.retrieve(PRODUCT_ID);
    if (!product.active)
      return {
        product: await stripe.products.update(PRODUCT_ID, { active: true }),
        created: false,
      };
    return { product, created: false };
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "resource_missing")) throw err;
  }
  const product = await stripe.products.create({
    id: PRODUCT_ID,
    name: "Anybench usage",
    description: "Benchmark run fees and eval computer time, billed monthly by usage.",
    metadata: { anybench: "usage" },
  });
  return { product, created: true };
}

export async function ensurePrice(
  stripe: Stripe,
  meterId: string,
  productId: string,
): Promise<{ price: Stripe.Price; created: boolean }> {
  const existing = await stripe.prices.list({
    lookup_keys: [PRICE_LOOKUP_KEY],
    active: true,
    limit: 1,
  });
  const found = existing.data[0];
  if (found) {
    const ok =
      found.recurring?.usage_type === "metered" &&
      found.recurring.meter === meterId &&
      found.unit_amount === 1 &&
      found.currency === "usd";
    if (!ok) {
      throw new Error(
        `price ${found.id} (lookup_key ${PRICE_LOOKUP_KEY}) does not match the meter/unit; bump the lookup_key instead of editing`,
      );
    }
    return { price: found, created: false };
  }
  const price = await stripe.prices.create({
    currency: "usd",
    product: productId,
    unit_amount: 1, // 1 cent per meter unit; the meter value is cents
    billing_scheme: "per_unit",
    recurring: { interval: "month", usage_type: "metered", meter: meterId },
    lookup_key: PRICE_LOOKUP_KEY,
    nickname: "Anybench usage (1 cent per unit)",
    metadata: { anybench: "usage", unit: "cent" },
  });
  return { price, created: true };
}

export async function ensureBillingCatalog(stripe: Stripe): Promise<BillingCatalog> {
  const m = await ensureMeter(stripe);
  const p = await ensureProduct(stripe);
  const pr = await ensurePrice(stripe, m.meter.id, p.product.id);
  return {
    meterId: m.meter.id,
    productId: p.product.id,
    priceId: pr.price.id,
    created: { meter: m.created, product: p.created, price: pr.created },
  };
}

if (import.meta.main) {
  const ctx = createSpikeContext();
  const first = await ensureBillingCatalog(ctx.stripe);
  step("setup", "pass 1", first);
  const second = await ensureBillingCatalog(ctx.stripe);
  step("setup", "pass 2 (must create nothing, same ids)", second);
  if (
    second.meterId !== first.meterId ||
    second.priceId !== first.priceId ||
    second.created.meter ||
    second.created.product ||
    second.created.price
  ) {
    throw new Error("setup is not idempotent");
  }
  ctx.save("setup", { first, second, calls: ctx.calls });
  step("setup", `calls: ${ctx.calls.map((c) => `${c.method} ${c.path} ${c.status}`).join(" | ")}`);
}
