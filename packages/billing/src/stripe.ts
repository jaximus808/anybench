// The one Stripe client and its mode assertions (TDM-88 [10.2], plan.md section 8).
//
// Modes. BILLING_MODE is `off` (local only, no Stripe at all), `test` or `live`. The key must
// match the mode: test takes sk_test_/rk_test_, live takes sk_live_/rk_live_. A mismatch throws
// before any request is made, so a test deploy can never touch live money and the reverse.
//
// Keys and ids. The app reads the generic names (STRIPE_SECRET_KEY, STRIPE_METER_ID,
// STRIPE_PRICE_USAGE), which deploy maps from the TEST or LIVE set. Locally only the TEST set is in
// .env, so each generic name falls back to STRIPE_<MODE>_<NAME>.
//
// Secrets. Error messages name the variable and the key's non-secret prefix, never the key. The
// resolved config keeps the key in a non-enumerable property, so logging or JSON-serialising a
// StripeConfig cannot leak it.
//
// Using it. Server code builds one `BillingStripe` at boot (`createBillingStripe(resolveStripeConfig
// (env))`) and passes it through deps. Scripts call `billingStripe()`, which memoises one instance
// per process. Tests pass `overrides` (host/port/protocol) to point the real SDK at a fake server.
import Stripe from "stripe";
import { z } from "zod";

/**
 * Pinned Stripe API version: the default of the `stripe` 23.1.0 SDK, the version the TDM-21 spike
 * ran against (docs/findings/stripe.md). Bump it together with the SDK, never implicitly.
 */
export const STRIPE_API_VERSION = "2026-10-28.endive" as const;

export const BILLING_MODES = ["off", "test", "live"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
export type StripeMode = Exclude<BillingMode, "off">;

export const STRIPE_KEY_PREFIXES: Record<StripeMode, readonly string[]> = {
  test: ["sk_test_", "rk_test_"],
  live: ["sk_live_", "rk_live_"],
};

/** Thrown when the mode, key or ids are missing or disagree. Its message never contains a key. */
export class StripeModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeModeError";
  }
}

/**
 * Why `key` cannot be used in `mode`, or undefined when it can (or when there is no key). Shared
 * with the server's boot assertions so both say the same thing.
 */
export function stripeKeyModeIssue(key: string | undefined, mode: StripeMode): string | undefined {
  if (key === undefined) return undefined;
  const allowed = STRIPE_KEY_PREFIXES[mode];
  if (allowed.some((p) => key.startsWith(p))) return undefined;
  // Only the first segments (`sk_live_`), which are not secret.
  const seen = /^[a-z]{2,4}_[a-z]+_/.exec(key)?.[0] ?? "an unrecognised prefix";
  return `must start with ${allowed.join(" or ")} for ${mode} mode (got ${seen})`;
}

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = z.preprocess(emptyToUndefined, z.string().optional());

/** The env vars this module reads. Empty strings count as unset (.env.example ships `KEY=`). */
export const StripeEnvSchema = z.object({
  BILLING_MODE: z.preprocess(emptyToUndefined, z.enum(BILLING_MODES).default("test")),
  STRIPE_SECRET_KEY: optional,
  STRIPE_TEST_SECRET_KEY: optional,
  STRIPE_LIVE_SECRET_KEY: optional,
  STRIPE_METER_ID: optional,
  STRIPE_TEST_METER_ID: optional,
  STRIPE_LIVE_METER_ID: optional,
  STRIPE_PRICE_USAGE: optional,
  STRIPE_TEST_PRICE_USAGE: optional,
  STRIPE_LIVE_PRICE_USAGE: optional,
});
export type StripeEnv = z.infer<typeof StripeEnvSchema>;

export interface StripeConfig {
  readonly mode: StripeMode;
  /** Non-enumerable: absent from JSON.stringify, console.log and object spread. */
  readonly secretKey: string;
  /** The usage meter (`mtr_...`), when configured. Run `pnpm billing:setup` to get it. */
  readonly meterId: string | undefined;
  /** The metered usage price (`price_...`), when configured. Checkout needs it. */
  readonly priceId: string | undefined;
  /** Which env var each value came from, for error messages and the setup script. */
  readonly sources: { secretKey: string; meterId?: string; priceId?: string };
}

function pick(
  env: StripeEnv,
  generic: keyof StripeEnv,
  perMode: keyof StripeEnv,
): { value: string; source: string } | undefined {
  const g = env[generic];
  if (typeof g === "string") return { value: g, source: generic };
  const m = env[perMode];
  if (typeof m === "string") return { value: m, source: perMode };
  return undefined;
}

/**
 * Resolve and check the Stripe settings from `source` (default process.env). Throws
 * StripeModeError when BILLING_MODE is off, when no key is set, or when the key does not match
 * the mode. Meter and price ids are optional here; callers that need them use `requireIds`.
 */
export function resolveStripeConfig(
  source: Record<string, string | undefined> = process.env,
): StripeConfig {
  const parsed = StripeEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new StripeModeError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const env = parsed.data;
  if (env.BILLING_MODE === "off") {
    throw new StripeModeError("BILLING_MODE is off: Stripe is disabled in this environment");
  }
  const mode = env.BILLING_MODE;
  const upper = mode === "test" ? "TEST" : "LIVE";
  const key = pick(env, "STRIPE_SECRET_KEY", `STRIPE_${upper}_SECRET_KEY`);
  if (!key) {
    throw new StripeModeError(
      `no Stripe key for ${mode} mode: set STRIPE_SECRET_KEY or STRIPE_${upper}_SECRET_KEY`,
    );
  }
  const issue = stripeKeyModeIssue(key.value, mode);
  if (issue) throw new StripeModeError(`${key.source}: ${issue} (BILLING_MODE=${mode})`);

  const meter = pick(env, "STRIPE_METER_ID", `STRIPE_${upper}_METER_ID`);
  const price = pick(env, "STRIPE_PRICE_USAGE", `STRIPE_${upper}_PRICE_USAGE`);
  if (meter && !meter.value.startsWith("mtr_")) {
    throw new StripeModeError(`${meter.source}: must be a meter id (mtr_...)`);
  }
  if (price && !price.value.startsWith("price_")) {
    throw new StripeModeError(`${price.source}: must be a price id (price_...)`);
  }
  const config = {
    mode,
    meterId: meter?.value,
    priceId: price?.value,
    sources: {
      secretKey: key.source,
      ...(meter ? { meterId: meter.source } : {}),
      ...(price ? { priceId: price.source } : {}),
    },
  } as StripeConfig;
  Object.defineProperty(config, "secretKey", { value: key.value, enumerable: false });
  return Object.freeze(config);
}

/** The meter and price ids, or a StripeModeError telling the operator to run the setup script. */
export function requireIds(config: StripeConfig): { meterId: string; priceId: string } {
  const { meterId, priceId } = config;
  if (meterId && priceId) return { meterId, priceId };
  const upper = config.mode === "test" ? "TEST" : "LIVE";
  const missing = [
    meterId ? undefined : `STRIPE_${upper}_METER_ID`,
    priceId ? undefined : `STRIPE_${upper}_PRICE_USAGE`,
  ].filter((v) => v !== undefined);
  throw new StripeModeError(
    `${missing.join(" and ")} not set: run \`pnpm billing:setup\` and copy the ids into .env`,
  );
}

/** Transport overrides, for tests that point the real SDK at a local fake. */
export type StripeTransportOverrides = Pick<
  Stripe.StripeConfig,
  "host" | "port" | "protocol" | "httpClient" | "maxNetworkRetries" | "timeout"
>;

export interface BillingStripe {
  readonly stripe: Stripe;
  readonly config: StripeConfig;
}

/** Build a Stripe client for a resolved config: pinned API version, retries, app info. */
export function createBillingStripe(
  config: StripeConfig,
  overrides: StripeTransportOverrides = {},
): BillingStripe {
  // Re-check: a StripeConfig built by hand must not bypass the mode assertion.
  const issue = stripeKeyModeIssue(config.secretKey, config.mode);
  if (issue) throw new StripeModeError(`${config.sources.secretKey}: ${issue}`);
  const stripe = new Stripe(config.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 30_000,
    appInfo: { name: "anybench", url: "https://anybench.jaxonp.com" },
    ...overrides,
  });
  return { stripe, config };
}

let shared: BillingStripe | undefined;

/**
 * The process-wide client, built from `source` on first use. Later calls return the same
 * instance and ignore `source`. Server code should prefer passing a BillingStripe through deps.
 */
export function billingStripe(
  source: Record<string, string | undefined> = process.env,
): BillingStripe {
  shared ??= createBillingStripe(resolveStripeConfig(source));
  return shared;
}

/** Tests only: drop the shared instance so the next `billingStripe()` rebuilds it. */
export function resetBillingStripeForTests(): void {
  shared = undefined;
}

/**
 * Check that an object Stripe returned belongs to the expected mode. Restricted keys and copied
 * env files make it possible to hold a key whose prefix looks right for the wrong account; the
 * `livemode` flag on every object is the server's own answer.
 */
export function assertLivemode(mode: StripeMode, obj: { id: string; livemode: boolean }): void {
  if (obj.livemode !== (mode === "live")) {
    throw new StripeModeError(
      `${obj.id} has livemode=${String(obj.livemode)} but BILLING_MODE=${mode}; refusing to continue`,
    );
  }
}
