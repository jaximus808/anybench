// TDM-154: deploy inputs → app secrets. Pure; no network.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffSecrets,
  findEnvFile,
  OWNED_SECRETS,
  parseDeployEnv,
  planSecrets,
  secretValueHash,
  siteOf,
} from "../lib/api-plan.js";
import { checkHealth, checkOAuthRedirect, checkPreflight } from "../lib/verify.js";

const raw = {
  NAIVE_API_KEY: "naive-key-tdm154",
  DATABASE_URL: "postgres://u:p@ep-dev-1-pooler.neon.tech/neondb?sslmode=require",
  DATABASE_URL_DIRECT: "postgres://u:p@ep-dev-1.neon.tech/neondb?sslmode=require",
  DATABASE_URL_PROD: "postgres://u:p@ep-prod-9-pooler.neon.tech/neondb",
  GITHUB_CLIENT_ID: "Iv1.client",
  GITHUB_CLIENT_SECRET: "gh-secret-tdm154",
  SESSION_SECRET: "s".repeat(40),
  BILLING_MODE: "test",
  STRIPE_TEST_SECRET_KEY: "sk_test_abc",
  // .env keys this deploy must ignore
  NODE_ENV: "development",
  GITHUB_OAUTH_CALLBACK_URL: "http://localhost:8787/auth/github/callback",
};

describe("parseDeployEnv (TDM-154)", () => {
  it("accepts the dev branch in test billing mode", () => {
    const env = parseDeployEnv(raw);
    expect(env.DEPLOY_API_APP_NAME).toBe("anybench-api");
    expect(env.DEPLOY_API_WEB_URL).toBe("https://anybench.vercel.app");
  });

  it("refuses any billing mode but test, without echoing secrets", () => {
    for (const mode of ["live", "off"]) {
      let msg = "";
      try {
        parseDeployEnv({ ...raw, BILLING_MODE: mode });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/BILLING_MODE: must be test/);
      expect(msg).not.toContain("gh-secret-tdm154");
    }
    expect(() => parseDeployEnv({ ...raw, STRIPE_TEST_SECRET_KEY: "sk_live_x" })).toThrow(
      /STRIPE_TEST_SECRET_KEY/,
    );
  });

  it("refuses the prod Neon branch (pooled or direct spelling)", () => {
    expect(() =>
      parseDeployEnv({ ...raw, DATABASE_URL: "postgres://u:p@ep-prod-9-pooler.neon.tech/neondb" }),
    ).toThrow(/DATABASE_URL: points at the prod branch/);
    expect(() =>
      parseDeployEnv({
        ...raw,
        DATABASE_URL_DIRECT_PROD: "postgres://x:y@ep-dev-1.neon.tech/neondb",
      }),
    ).toThrow(/DATABASE_URL_DIRECT: points at the prod branch/);
  });

  it("lists every missing key at once", () => {
    expect(() => parseDeployEnv({ BILLING_MODE: "test" })).toThrow(
      /NAIVE_API_KEY[\s\S]*DATABASE_URL[\s\S]*GITHUB_CLIENT_ID[\s\S]*SESSION_SECRET/,
    );
  });
});

describe("planSecrets (TDM-154)", () => {
  const env = parseDeployEnv(raw);

  it("on *.vercel.app: callback on the app URL, SameSite=None, host-only cookie, platform-safe DB names", () => {
    const plan = planSecrets(env, "https://anybench-api-x.vercel.app");
    expect(plan.callbackUrl).toBe("https://anybench-api-x.vercel.app/auth/github/callback");
    expect(plan.sameSite).toBe("none");
    expect(plan.cookieDomain).toBeUndefined();
    expect(plan.secrets).toMatchObject({
      NODE_ENV: "production",
      BILLING_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_abc",
      ANYBENCH_DATABASE_URL: raw.DATABASE_URL,
      ANYBENCH_DATABASE_URL_DIRECT: raw.DATABASE_URL_DIRECT,
      ALLOWED_ORIGINS: "https://anybench.vercel.app,https://anybench.jaxonp.com",
      PUBLIC_WEB_URL: "https://anybench.vercel.app",
      SESSION_COOKIE_SAMESITE: "none",
      EVENTS_STREAM_MODE: "poll",
      EVENTS_STREAM_MAX_DURATION_MS: "240000",
    });
    // The platform owns DATABASE_* on the app; we never try to set them.
    expect(Object.keys(plan.secrets).filter((k) => k.startsWith("DATABASE_"))).toEqual([]);
    expect(plan.secrets.SESSION_COOKIE_DOMAIN).toBeUndefined();
  });

  it("on the custom domains: SameSite=Lax and the shared .anybench.jaxonp.com cookie", () => {
    const custom = parseDeployEnv({ ...raw, DEPLOY_API_WEB_URL: "https://anybench.jaxonp.com" });
    const plan = planSecrets(custom, "https://api.anybench.jaxonp.com");
    expect(plan.sameSite).toBe("lax");
    expect(plan.cookieDomain).toBe(".anybench.jaxonp.com");
    expect(plan.allowedOrigins).toEqual(["https://anybench.jaxonp.com"]);
  });

  it("refuses a plain-http API URL", () => {
    expect(() => planSecrets(env, "http://localhost:8787")).toThrow(/https/);
  });

  it("siteOf treats vercel.app as a public suffix", () => {
    expect(siteOf("anybench.vercel.app")).toBe("anybench.vercel.app");
    expect(siteOf("api.anybench.jaxonp.com")).toBe("jaxonp.com");
  });
});

describe("diffSecrets (TDM-154)", () => {
  it("writes only changed values, deletes owned names no longer wanted, ignores platform names", () => {
    const want = { NODE_ENV: "production", BILLING_MODE: "test" } as const;
    const have = [
      { name: "NODE_ENV", value_hash: secretValueHash("NODE_ENV", "production") },
      { name: "BILLING_MODE", value_hash: secretValueHash("BILLING_MODE", "live") },
      { name: "SESSION_COOKIE_DOMAIN", value_hash: "v1:old" },
      { name: "DATABASE_URL", value_hash: null },
      { name: "VETTA_MCP_TOKEN", value_hash: null },
    ];
    expect(diffSecrets(want, have)).toEqual({
      set: ["BILLING_MODE"],
      unchanged: ["NODE_ENV"],
      remove: ["SESSION_COOKIE_DOMAIN"],
    });
    expect(OWNED_SECRETS.some((n) => n.startsWith("DATABASE_"))).toBe(false);
  });

  it("hashes are salted by name and do not contain the value", () => {
    const a = secretValueHash("A", "same-value-123");
    expect(a).not.toBe(secretValueHash("B", "same-value-123"));
    expect(a).not.toContain("same-value-123");
  });
});

describe("findEnvFile (TDM-154)", () => {
  it("uses the main checkout's .env from a git worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "tdm154-env-"));
    const main = join(root, "main");
    const wt = join(root, "wt");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(wt);
    writeFileSync(join(main, ".env"), "X=1\n");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    expect(findEnvFile(wt)).toBe(join(main, ".env"));
    expect(findEnvFile(wt, join(root, "other.env"))).toBe(join(root, "other.env"));
  });
});

describe("live checks (TDM-154)", () => {
  const expected = {
    clientId: "Iv1.client",
    callbackUrl: "https://a.vercel.app/auth/github/callback",
  };
  const loc = (q: Record<string, string>) =>
    `https://github.com/login/oauth/authorize?${new URLSearchParams(q).toString()}`;

  it("OAuth start: 302 to GitHub with our client_id, callback and a state", () => {
    const good = loc({ client_id: "Iv1.client", redirect_uri: expected.callbackUrl, state: "n" });
    expect(checkOAuthRedirect(302, good, expected).ok).toBe(true);
    expect(checkOAuthRedirect(200, good, expected).ok).toBe(false);
    const wrong = loc({ client_id: "Iv1.client", redirect_uri: "https://evil/cb", state: "n" });
    expect(checkOAuthRedirect(302, wrong, expected).ok).toBe(false);
    expect(checkOAuthRedirect(302, null, expected).ok).toBe(false);
  });

  it("health needs a 200 and a working db ping; preflight needs the exact origin", () => {
    expect(checkHealth(200, { ok: true, db: { ok: true } }).ok).toBe(true);
    expect(checkHealth(503, { ok: false, db: { ok: false } }).ok).toBe(false);
    const h = new Headers({
      "access-control-allow-origin": "https://w.app",
      "access-control-allow-credentials": "true",
    });
    expect(checkPreflight(204, h, "https://w.app").ok).toBe(true);
    expect(checkPreflight(204, h, "https://other.app").ok).toBe(false);
  });
});
