// TDM-14: env validation and boot assertions.
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { DEFAULT_LOCAL_DATABASE_URL } from "../src/db/client.js";

const fake = (prefix: string) => `${prefix}${"A1b2C3d4E5f6G7h8"}`;

function issuesOf(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig (TDM-14)", () => {
  it("boots local dev with defaults and falls back to the local Docker Postgres", () => {
    const c = loadConfig({});
    expect(c.NODE_ENV).toBe("development");
    expect(c.PORT).toBe(8787);
    expect(c.BILLING_MODE).toBe("test");
    expect(c.databaseUrl).toBe(DEFAULT_LOCAL_DATABASE_URL);
    expect(c.databaseUrlDirect).toBe(DEFAULT_LOCAL_DATABASE_URL);
    expect(c.ANYBENCH_PAUSE).toBe(false);
  });

  it("treats empty strings (.env.example `KEY=` lines) as unset", () => {
    const c = loadConfig({ PORT: "", SENTRY_DSN: "", STRIPE_SECRET_KEY: " ", DATABASE_URL: "" });
    expect(c.PORT).toBe(8787);
    expect(c.SENTRY_DSN).toBeUndefined();
    expect(c.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("uses DATABASE_URL for pooled and DATABASE_URL_DIRECT for direct", () => {
    const c = loadConfig({
      DATABASE_URL: "postgres://u:p@pooler.example/db",
      DATABASE_URL_DIRECT: "postgres://u:p@direct.example/db",
    });
    expect(c.databaseUrl).toContain("pooler");
    expect(c.databaseUrlDirect).toContain("direct");
  });

  it("refuses BILLING_MODE=off when NODE_ENV=production", () => {
    const e = issuesOf({
      NODE_ENV: "production",
      BILLING_MODE: "off",
      DATABASE_URL: "postgres://a/b",
      DATABASE_URL_DIRECT: "postgres://a/b",
    });
    expect(e.issues.map((i) => i.path)).toEqual(["BILLING_MODE"]);
    expect(e.message).toMatch(/BILLING_MODE: off is only allowed in local dev/);
  });

  it("allows BILLING_MODE=off in development, with any key", () => {
    expect(
      loadConfig({ BILLING_MODE: "off", STRIPE_SECRET_KEY: fake("sk_live_") }).BILLING_MODE,
    ).toBe("off");
  });

  it.each([
    ["test", "sk_test_"],
    ["test", "rk_test_"],
    ["live", "sk_live_"],
    ["live", "rk_live_"],
  ])("accepts a %s-mode key starting %s", (mode, prefix) => {
    expect(
      loadConfig({ BILLING_MODE: mode, STRIPE_SECRET_KEY: fake(prefix) }).STRIPE_SECRET_KEY,
    ).toBe(fake(prefix));
  });

  it.each([
    ["test", "sk_live_"],
    ["test", "rk_live_"],
    ["live", "sk_test_"],
    ["live", "rk_test_"],
    ["live", "pk_live_"],
  ])("rejects a %s-mode key starting %s, without echoing the key", (mode, prefix) => {
    const key = fake(prefix);
    const e = issuesOf({ BILLING_MODE: mode, STRIPE_SECRET_KEY: key });
    expect(e.issues.map((i) => i.path)).toEqual(["STRIPE_SECRET_KEY"]);
    expect(e.message).toContain(`for ${mode} mode`);
    expect(e.message).not.toContain(key);
  });

  it("checks the per-mode key slots against their own mode", () => {
    const e = issuesOf({
      STRIPE_TEST_SECRET_KEY: fake("sk_live_"),
      STRIPE_LIVE_SECRET_KEY: fake("rk_test_"),
    });
    expect(e.issues.map((i) => i.path).sort()).toEqual([
      "STRIPE_LIVE_SECRET_KEY",
      "STRIPE_TEST_SECRET_KEY",
    ]);
  });

  it("lists every bad var in one error", () => {
    const e = issuesOf({
      PORT: "abc",
      NODE_ENV: "prod",
      DATABASE_URL: "mysql://x",
      SENTRY_DSN: "not a url",
    });
    const paths = e.issues.map((i) => i.path).sort();
    expect(paths).toEqual(["DATABASE_URL", "NODE_ENV", "PORT", "SENTRY_DSN"]);
    expect(e.message).toMatch(/^Invalid server environment \(4 problems\):/);
    for (const p of paths) expect(e.message).toContain(`  - ${p}: `);
  });

  it("requires both database URLs in production", () => {
    const e = issuesOf({ NODE_ENV: "production" });
    expect(e.issues.map((i) => i.path).sort()).toEqual(["DATABASE_URL", "DATABASE_URL_DIRECT"]);
  });
});
