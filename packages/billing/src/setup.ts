// Idempotent Stripe catalog for usage billing (TDM-88 [10.2], moved from the TDM-21 spike).
//
//   pnpm billing:setup            (root; same as `pnpm --filter @anybench/billing stripe:setup`)
//
// Creates (or finds) exactly one of each, in the mode the key belongs to:
//   - Billing Meter   event_name "anybench_usage", sum aggregation, value in CENTS
//                     (payload: { stripe_customer_id, value }). Meters have no metadata or
//                     lookup_key, so the event_name is the idempotency key (Stripe also rejects a
//                     second active meter with the same event_name).
//   - Product         fixed id "anybench_usage" (products accept a caller-chosen id).
//   - Price           lookup_key "anybench_usage_cents_v1": USD, 1 cent per meter unit, monthly,
//                     usage_type metered, linked to the meter. Prices are immutable, so a change
//                     means a new lookup_key (v2) and `transfer_lookup_key`, never an edit.
// Running it twice returns the same ids and creates nothing the second time. Every object it
// returns is checked against the mode (`livemode`), so a test run cannot touch a live catalog.
import type Stripe from "stripe";
import {
  assertLivemode,
  type BillingStripe,
  type StripeConfig,
  type StripeMode,
} from "./stripe.js";

export const METER_EVENT_NAME = "anybench_usage";
export const PRODUCT_ID = "anybench_usage";
export const PRICE_LOOKUP_KEY = "anybench_usage_cents_v1";
/** Meter payload keys (Stripe's defaults, spelled out so the reporter can't drift). */
export const METER_CUSTOMER_KEY = "stripe_customer_id";
export const METER_VALUE_KEY = "value";
/** Checkout shows "$0.01 per <unit_label>"; without it Stripe says "per unit". */
export const PRODUCT_UNIT_LABEL = "usage cent"; // Stripe caps unit_label at 12 chars

export interface BillingCatalog {
  mode: StripeMode;
  meterId: string;
  productId: string;
  priceId: string;
  created: { meter: boolean; product: boolean; price: boolean };
}

export async function ensureMeter(
  stripe: Stripe,
  mode: StripeMode,
): Promise<{ meter: Stripe.Billing.Meter; created: boolean }> {
  for await (const meter of stripe.billing.meters.list({ limit: 100 })) {
    if (meter.event_name !== METER_EVENT_NAME) continue;
    assertLivemode(mode, meter);
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
  assertLivemode(mode, meter);
  return { meter, created: true };
}

function isResourceMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "resource_missing";
}

export async function ensureProduct(
  stripe: Stripe,
  mode: StripeMode,
): Promise<{ product: Stripe.Product; created: boolean }> {
  let existing: Stripe.Product | undefined;
  try {
    existing = await stripe.products.retrieve(PRODUCT_ID);
  } catch (err) {
    if (!isResourceMissing(err)) throw err;
  }
  if (existing) {
    assertLivemode(mode, existing);
    if (!existing.active || existing.unit_label !== PRODUCT_UNIT_LABEL) {
      const product = await stripe.products.update(PRODUCT_ID, {
        active: true,
        unit_label: PRODUCT_UNIT_LABEL,
      });
      return { product, created: false };
    }
    return { product: existing, created: false };
  }
  const product = await stripe.products.create({
    id: PRODUCT_ID,
    name: "Anybench usage",
    description: "Benchmark run fees and eval computer time, billed monthly by usage.",
    unit_label: PRODUCT_UNIT_LABEL,
    metadata: { anybench: "usage" },
  });
  assertLivemode(mode, product);
  return { product, created: true };
}

export async function ensurePrice(
  stripe: Stripe,
  mode: StripeMode,
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
    assertLivemode(mode, found);
    const foundProduct = typeof found.product === "string" ? found.product : found.product.id;
    const ok =
      found.recurring?.usage_type === "metered" &&
      found.recurring.meter === meterId &&
      found.unit_amount === 1 &&
      found.currency === "usd" &&
      foundProduct === productId;
    if (!ok) {
      throw new Error(
        `price ${found.id} (lookup_key ${PRICE_LOOKUP_KEY}) does not match the meter/product/unit; bump the lookup_key instead of editing`,
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
  assertLivemode(mode, price);
  return { price, created: true };
}

export async function ensureBillingCatalog(
  stripe: Stripe,
  mode: StripeMode,
): Promise<BillingCatalog> {
  const m = await ensureMeter(stripe, mode);
  const p = await ensureProduct(stripe, mode);
  const pr = await ensurePrice(stripe, mode, m.meter.id, p.product.id);
  return {
    mode,
    meterId: m.meter.id,
    productId: p.product.id,
    priceId: pr.price.id,
    created: { meter: m.created, product: p.created, price: pr.created },
  };
}

/** The .env lines for a catalog: `STRIPE_TEST_METER_ID=...` and `STRIPE_TEST_PRICE_USAGE=...`. */
export function catalogEnvLines(catalog: BillingCatalog): string[] {
  const upper = catalog.mode === "test" ? "TEST" : "LIVE";
  return [
    `STRIPE_${upper}_METER_ID=${catalog.meterId}`,
    `STRIPE_${upper}_PRICE_USAGE=${catalog.priceId}`,
  ];
}

/** Env vars whose configured value differs from the catalog (unset ones are not listed). */
export function staleCatalogIds(
  config: StripeConfig,
  catalog: BillingCatalog,
): { name: string; configured: string; actual: string }[] {
  const out: { name: string; configured: string; actual: string }[] = [];
  if (config.meterId && config.meterId !== catalog.meterId) {
    out.push({
      name: config.sources.meterId ?? "meter id",
      configured: config.meterId,
      actual: catalog.meterId,
    });
  }
  if (config.priceId && config.priceId !== catalog.priceId) {
    out.push({
      name: config.sources.priceId ?? "price id",
      configured: config.priceId,
      actual: catalog.priceId,
    });
  }
  return out;
}

export interface StripeSetupResult {
  catalog: BillingCatalog;
  /** Configured ids that do not match what Stripe has. Non-empty = update .env. */
  stale: ReturnType<typeof staleCatalogIds>;
}

/** Ensure the catalog and print what .env needs. Output carries ids only, never a key. */
export async function runStripeSetup(
  client: BillingStripe,
  log: (line: string) => void = (line) => console.log(line),
): Promise<StripeSetupResult> {
  log(`[billing:setup] mode=${client.config.mode} key from ${client.config.sources.secretKey}`);
  const catalog = await ensureBillingCatalog(client.stripe, client.config.mode);
  const verb = (created: boolean) => (created ? "created" : "found");
  log(`[billing:setup] meter   ${verb(catalog.created.meter)} ${catalog.meterId}`);
  log(`[billing:setup] product ${verb(catalog.created.product)} ${catalog.productId}`);
  log(`[billing:setup] price   ${verb(catalog.created.price)} ${catalog.priceId}`);
  const stale = staleCatalogIds(client.config, catalog);
  for (const s of stale) {
    log(`[billing:setup] STALE ${s.name}=${s.configured} but Stripe has ${s.actual}`);
  }
  const unset = !client.config.meterId || !client.config.priceId;
  log(
    stale.length > 0 || unset
      ? "[billing:setup] put these in .env:"
      : "[billing:setup] .env already matches:",
  );
  for (const line of catalogEnvLines(catalog)) log(line);
  return { catalog, stale };
}
