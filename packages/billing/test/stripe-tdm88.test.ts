// TDM-88: mode assertions, key resolution and the one Stripe client.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLivemode,
  billingStripe,
  createBillingStripe,
  requireIds,
  resetBillingStripeForTests,
  resolveStripeConfig,
  STRIPE_API_VERSION,
  stripeKeyModeIssue,
  StripeModeError,
  type StripeConfig,
} from "../src/index.js";

// Built at runtime so no key-shaped literal sits in the repo.
const fakeKey = (prefix: string) => `${prefix}${"A1b2C3d4E5".repeat(3)}`;
const TEST_SK = fakeKey("sk_test_");
const TEST_RK = fakeKey("rk_test_");
const LIVE_SK = fakeKey("sk_live_");
const LIVE_RK = fakeKey("rk_live_");

function refusal(env: Record<string, string | undefined>): StripeModeError {
  try {
    resolveStripeConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(StripeModeError);
    return err as StripeModeError;
  }
  throw new Error("expected resolveStripeConfig to refuse");
}

afterEach(() => resetBillingStripeForTests());

describe("resolveStripeConfig (TDM-88)", () => {
  it("defaults to test mode and falls back to STRIPE_TEST_SECRET_KEY and the TEST ids", () => {
    const c = resolveStripeConfig({
      STRIPE_TEST_SECRET_KEY: TEST_SK,
      STRIPE_TEST_METER_ID: "mtr_test_1",
      STRIPE_TEST_PRICE_USAGE: "price_1",
      STRIPE_LIVE_METER_ID: "mtr_live_ignored",
    });
    expect(c.mode).toBe("test");
    expect(c.secretKey).toBe(TEST_SK);
    expect(c.meterId).toBe("mtr_test_1");
    expect(c.priceId).toBe("price_1");
    expect(c.sources).toEqual({
      secretKey: "STRIPE_TEST_SECRET_KEY",
      meterId: "STRIPE_TEST_METER_ID",
      priceId: "STRIPE_TEST_PRICE_USAGE",
    });
  });

  it("prefers the generic names the deployed app reads", () => {
    const c = resolveStripeConfig({
      BILLING_MODE: "test",
      STRIPE_SECRET_KEY: TEST_RK,
      STRIPE_TEST_SECRET_KEY: TEST_SK,
      STRIPE_PRICE_USAGE: "price_generic",
      STRIPE_TEST_PRICE_USAGE: "price_test",
    });
    expect(c.secretKey).toBe(TEST_RK);
    expect(c.priceId).toBe("price_generic");
    expect(c.sources.secretKey).toBe("STRIPE_SECRET_KEY");
  });

  it.each([
    ["test", TEST_SK],
    ["test", TEST_RK],
    ["live", LIVE_SK],
    ["live", LIVE_RK],
  ])("accepts BILLING_MODE=%s with a matching key", (mode, key) => {
    expect(resolveStripeConfig({ BILLING_MODE: mode, STRIPE_SECRET_KEY: key }).mode).toBe(mode);
  });

  it.each([
    ["test", LIVE_SK, "sk_live_"],
    ["test", LIVE_RK, "rk_live_"],
    ["live", TEST_SK, "sk_test_"],
    ["live", TEST_RK, "rk_test_"],
    ["test", "pk_test_abc", "pk_test_"],
    ["test", "whatever", "an unrecognised prefix"],
  ])("refuses BILLING_MODE=%s with key %#, never echoing the key", (mode, key, seen) => {
    const e = refusal({ BILLING_MODE: mode, STRIPE_SECRET_KEY: key });
    expect(e.message).toContain("STRIPE_SECRET_KEY");
    expect(e.message).toContain(`got ${seen}`);
    expect(e.message).not.toContain(key);
  });

  it("refuses a live key in the per-mode TEST slot too", () => {
    const e = refusal({ STRIPE_TEST_SECRET_KEY: LIVE_SK });
    expect(e.message).toMatch(/^STRIPE_TEST_SECRET_KEY: must start with sk_test_ or rk_test_/);
  });

  it("in live mode reads only the LIVE fallback, never the TEST key", () => {
    const e = refusal({ BILLING_MODE: "live", STRIPE_TEST_SECRET_KEY: TEST_SK });
    expect(e.message).toMatch(/no Stripe key for live mode/);
  });

  it("refuses BILLING_MODE=off, a missing key and an unknown mode", () => {
    expect(refusal({ BILLING_MODE: "off", STRIPE_SECRET_KEY: TEST_SK }).message).toMatch(
      /BILLING_MODE is off/,
    );
    expect(refusal({ STRIPE_SECRET_KEY: "  " }).message).toMatch(/no Stripe key for test mode/);
    expect(refusal({ BILLING_MODE: "prod", STRIPE_SECRET_KEY: TEST_SK }).message).toMatch(
      /^BILLING_MODE:/,
    );
  });

  it("refuses ids that are not a meter or a price", () => {
    expect(
      refusal({ STRIPE_SECRET_KEY: TEST_SK, STRIPE_TEST_METER_ID: "price_x" }).message,
    ).toMatch(/STRIPE_TEST_METER_ID: must be a meter id/);
    expect(refusal({ STRIPE_SECRET_KEY: TEST_SK, STRIPE_PRICE_USAGE: "mtr_x" }).message).toMatch(
      /STRIPE_PRICE_USAGE: must be a price id/,
    );
  });

  it("keeps the key out of JSON, inspection and spreads", () => {
    const c = resolveStripeConfig({ STRIPE_SECRET_KEY: TEST_SK });
    expect(JSON.stringify(c)).not.toContain(TEST_SK);
    expect(Object.keys(c)).not.toContain("secretKey");
    expect({ ...c }).not.toHaveProperty("secretKey");
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("requireIds names the missing vars and points at the setup script", () => {
    const c = resolveStripeConfig({ STRIPE_SECRET_KEY: TEST_SK, STRIPE_TEST_METER_ID: "mtr_1" });
    expect(() => requireIds(c)).toThrow(
      /STRIPE_TEST_PRICE_USAGE not set: run `pnpm billing:setup`/,
    );
    const full = resolveStripeConfig({
      STRIPE_SECRET_KEY: TEST_SK,
      STRIPE_TEST_METER_ID: "mtr_1",
      STRIPE_TEST_PRICE_USAGE: "price_1",
    });
    expect(requireIds(full)).toEqual({ meterId: "mtr_1", priceId: "price_1" });
  });
});

describe("stripeKeyModeIssue (TDM-88, shared with server boot)", () => {
  it("is undefined for no key or a matching key, and a message otherwise", () => {
    expect(stripeKeyModeIssue(undefined, "live")).toBeUndefined();
    expect(stripeKeyModeIssue(TEST_RK, "test")).toBeUndefined();
    expect(stripeKeyModeIssue(TEST_SK, "live")).toBe(
      "must start with sk_live_ or rk_live_ for live mode (got sk_test_)",
    );
  });
});

describe("createBillingStripe / billingStripe (TDM-88)", () => {
  it("pins the API version", () => {
    const { stripe, config } = createBillingStripe(
      resolveStripeConfig({ STRIPE_SECRET_KEY: TEST_SK }),
    );
    expect(config.mode).toBe("test");
    expect(stripe.getApiField("version")).toBe(STRIPE_API_VERSION);
  });

  it("re-checks a hand-built config so it cannot bypass the mode assertion", () => {
    const forged = {
      mode: "test",
      secretKey: LIVE_SK,
      meterId: undefined,
      priceId: undefined,
      sources: { secretKey: "forged" },
    } satisfies StripeConfig;
    expect(() => createBillingStripe(forged)).toThrow(StripeModeError);
  });

  it("billingStripe() returns one instance per process", () => {
    const a = billingStripe({ STRIPE_SECRET_KEY: TEST_SK });
    const b = billingStripe({ STRIPE_SECRET_KEY: fakeKey("rk_test_") });
    expect(b).toBe(a);
    resetBillingStripeForTests();
    expect(billingStripe({ STRIPE_SECRET_KEY: TEST_SK })).not.toBe(a);
  });

  it("billingStripe() refuses a mismatched key before building anything", () => {
    expect(() => billingStripe({ BILLING_MODE: "test", STRIPE_SECRET_KEY: LIVE_SK })).toThrow(
      StripeModeError,
    );
  });
});

describe("assertLivemode (TDM-88)", () => {
  it("rejects an object from the other mode", () => {
    expect(() => assertLivemode("test", { id: "mtr_1", livemode: false })).not.toThrow();
    expect(() => assertLivemode("live", { id: "mtr_1", livemode: true })).not.toThrow();
    expect(() => assertLivemode("test", { id: "mtr_1", livemode: true })).toThrow(
      /mtr_1 has livemode=true but BILLING_MODE=test/,
    );
  });
});

describe("pnpm billing:setup entry (TDM-88)", () => {
  const BILLING_DIR = fileURLToPath(new URL("..", import.meta.url));
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/bin/stripe-setup.ts"], {
      cwd: BILLING_DIR,
      // Clean env: a developer's shell or .env cannot make this pass or fail.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      encoding: "utf8",
      timeout: 55_000,
    });

  it("refuses a live key in test mode with exit 1, before any request, without printing it", () => {
    const r = run({ BILLING_MODE: "test", STRIPE_SECRET_KEY: LIVE_SK });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing to run: STRIPE_SECRET_KEY: must start with sk_test_/);
    expect(r.stdout + r.stderr).not.toContain(LIVE_SK);
  }, 120_000);

  it("refuses BILLING_MODE=off", () => {
    const r = run({ BILLING_MODE: "off", STRIPE_SECRET_KEY: TEST_SK });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BILLING_MODE is off/);
  }, 120_000);
});
