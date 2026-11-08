// The API deploy's inputs and the app secrets they turn into (TDM-154). Pure: no network, no
// process.env. Values never leave the returned objects except as Naïve secret writes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const req = (name: string) =>
  z.preprocess(blank, z.string({ error: `${name} is required in .env` }).min(1));
const opt = z.preprocess(blank, z.string().optional());
const pgUrl = (name: string) =>
  req(name).refine((v) => /^postgres(ql)?:\/\//.test(v), `${name} must be a postgres:// URL`);

/** The .env keys the API deploy reads. Anything else in .env is ignored. */
export const DeployEnvSchema = z
  .object({
    NAIVE_API_KEY: req("NAIVE_API_KEY"),
    NAIVE_BASE_URL: opt,
    /** Neon pooled URL of the branch this deploy targets (dev for now). */
    DATABASE_URL: pgUrl("DATABASE_URL"),
    DATABASE_URL_DIRECT: pgUrl("DATABASE_URL_DIRECT"),
    DATABASE_URL_PROD: opt,
    DATABASE_URL_DIRECT_PROD: opt,
    GITHUB_CLIENT_ID: req("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: req("GITHUB_CLIENT_SECRET"),
    SESSION_SECRET: req("SESSION_SECRET").refine(
      (v) => v.length >= 32,
      "SESSION_SECRET must be 32+ chars",
    ),
    RUNNER_TOKEN_SECRET: opt,
    ADMIN_GITHUB_LOGINS: opt,
    BILLING_MODE: z.preprocess(blank, z.string().default("test")),
    STRIPE_TEST_SECRET_KEY: opt,
    SENTRY_DSN: opt,
    S3_ENDPOINT: opt,
    S3_REGION: opt,
    S3_BUCKET: opt,
    S3_ACCESS_KEY_ID: opt,
    S3_SECRET_ACCESS_KEY: opt,
    DEPLOY_API_APP_NAME: z.preprocess(
      blank,
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
        .default("anybench-api"),
    ),
    DEPLOY_API_WEB_URL: z.preprocess(blank, z.url().default("https://anybench.vercel.app")),
    DEPLOY_API_EXTRA_ORIGINS: z.preprocess(
      blank,
      z.string().default("https://anybench.jaxonp.com"),
    ),
    DEPLOY_API_PUBLIC_URL: z.preprocess(blank, z.url().optional()),
  })
  .superRefine((env, ctx) => {
    // This deploy is test-mode only: refuse a live billing mode outright.
    if (env.BILLING_MODE !== "test") {
      ctx.addIssue({
        code: "custom",
        path: ["BILLING_MODE"],
        message: `must be test for this deploy (got ${env.BILLING_MODE}); live billing is refused`,
      });
    }
    if (env.STRIPE_TEST_SECRET_KEY && !/^(sk|rk)_test_/.test(env.STRIPE_TEST_SECRET_KEY)) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_TEST_SECRET_KEY"],
        message: "is not a test-mode key",
      });
    }
    // First deploy targets the Neon dev branch: never the prod URLs.
    for (const [name, value, prod] of [
      ["DATABASE_URL", env.DATABASE_URL, env.DATABASE_URL_PROD],
      ["DATABASE_URL_DIRECT", env.DATABASE_URL_DIRECT, env.DATABASE_URL_DIRECT_PROD],
    ] as const) {
      if (prod && sameDatabase(value, prod)) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "points at the prod branch; this deploy uses dev",
        });
      }
    }
  });
export type DeployEnv = z.infer<typeof DeployEnvSchema>;

function sameDatabase(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const host = (h: string) => h.replace(/-pooler(?=\.)/, "");
    return host(ua.hostname) === host(ub.hostname) && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

/** Every issue at once, as `KEY: message` (never a value). */
export function parseDeployEnv(raw: Record<string, string | undefined>): DeployEnv {
  const parsed = DeployEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`deploy env is not usable:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/**
 * The .env to read: $ANYBENCH_ENV_FILE, else `<repo>/.env`, else the main checkout's .env when
 * run from a git worktree (worktrees have no .env of their own).
 */
export function findEnvFile(repoRoot: string, explicit?: string): string {
  if (explicit) return resolve(explicit);
  const own = join(repoRoot, ".env");
  if (existsSync(own)) return own;
  const gitFile = join(repoRoot, ".git");
  if (existsSync(gitFile)) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitFile, "utf8"));
    if (m) {
      // <main>/.git/worktrees/<name> → <main>
      const main = dirname(dirname(dirname(resolve(repoRoot, m[1]!.trim()))));
      const shared = join(main, ".env");
      if (existsSync(shared)) return shared;
    }
  }
  throw new Error(`no .env found (looked in ${own}); set ANYBENCH_ENV_FILE`);
}

export function readEnvFile(path: string): Record<string, string> {
  return parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
}

/** Registrable site of a host, enough for our hosts: `vercel.app` is a public suffix. */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().split(".");
  const publicSuffix2 = ["vercel.app"];
  const tail2 = labels.slice(-2).join(".");
  return publicSuffix2.includes(tail2) ? labels.slice(-3).join(".") : tail2;
}

/** Every secret name this deploy owns; one it no longer wants is deleted from the app. */
export const OWNED_SECRETS = [
  "NODE_ENV",
  "ANYBENCH_ENV",
  "LOG_LEVEL",
  "ANYBENCH_DATABASE_URL",
  "ANYBENCH_DATABASE_URL_DIRECT",
  "BILLING_MODE",
  "STRIPE_SECRET_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_OAUTH_CALLBACK_URL",
  "SESSION_SECRET",
  "SESSION_COOKIE_DOMAIN",
  "SESSION_COOKIE_SAMESITE",
  "ALLOWED_ORIGINS",
  "PUBLIC_WEB_URL",
  "ADMIN_GITHUB_LOGINS",
  "RUNNER_TOKEN_SECRET",
  "EVENTS_STREAM_MODE",
  "EVENTS_STREAM_MAX_DURATION_MS",
  "EVENTS_POLL_INTERVAL_MS",
  "SENTRY_DSN",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  // POST /runs/suggest runs one bounded Naïve session from the API (New run screen).
  "NAIVE_API_KEY",
  "ANYBENCH_SUGGEST_MODEL",
] as const;
export type OwnedSecret = (typeof OWNED_SECRETS)[number];

/** Requests are cut at 300 s on the host; streams end well before and clients reconnect. */
export const SSE_MAX_DURATION_MS = 240_000;

export interface SecretPlan {
  secrets: Partial<Record<OwnedSecret, string>>;
  /** The API base the browser uses, with its path (`https://anybench.vercel.app/api`), no trailing slash. */
  baseUrl: string;
  callbackUrl: string;
  allowedOrigins: string[];
  sameSite: "lax" | "none";
  cookieDomain: string | undefined;
}

/**
 * The app secrets for an API the browser reaches at `publicUrl`. That may carry a base path: behind
 * the web app's same-origin proxy it is `https://anybench.vercel.app/api`, and the callback, the
 * OAuth state cookie path (derived from the callback by the server) and the live checks keep it.
 * SameSite and the cookie Domain follow that browser-facing host, not the app's own host.
 */
export function planSecrets(env: DeployEnv, publicUrl: string): SecretPlan {
  const api = new URL(publicUrl);
  if (api.protocol !== "https:") throw new Error(`API URL must be https (got ${api.origin})`);
  if (api.search || api.hash) throw new Error("API URL must not carry a query or fragment");
  const basePath = api.pathname.replace(/\/+$/, "");
  const baseUrl = `${api.origin}${basePath}`;
  const web = new URL(env.DEPLOY_API_WEB_URL);
  const callbackUrl = `${baseUrl}/auth/github/callback`;
  const allowedOrigins = [
    ...new Set(
      [web.origin, ...env.DEPLOY_API_EXTRA_ORIGINS.split(",")]
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => new URL(s).origin),
    ),
  ];
  const crossSite = siteOf(api.hostname) !== siteOf(web.hostname);
  // api.anybench.jaxonp.com + anybench.jaxonp.com share `.anybench.jaxonp.com`; *.vercel.app hosts
  // cannot share a cookie at all (public suffix), so the cookie stays host-only on the API. Behind
  // the same-origin proxy the hosts are equal: same site, Lax, host-only on the web host.
  const cookieDomain =
    !crossSite && api.hostname.endsWith(`.${web.hostname}`) ? `.${web.hostname}` : undefined;
  const sameSite = crossSite ? "none" : "lax";

  const s: Partial<Record<OwnedSecret, string>> = {
    NODE_ENV: "production",
    ANYBENCH_ENV: "staging",
    LOG_LEVEL: "info",
    ANYBENCH_DATABASE_URL: env.DATABASE_URL,
    ANYBENCH_DATABASE_URL_DIRECT: env.DATABASE_URL_DIRECT,
    BILLING_MODE: "test",
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
    GITHUB_OAUTH_CALLBACK_URL: callbackUrl,
    SESSION_SECRET: env.SESSION_SECRET,
    SESSION_COOKIE_SAMESITE: sameSite,
    ALLOWED_ORIGINS: allowedOrigins.join(","),
    PUBLIC_WEB_URL: web.origin,
    EVENTS_STREAM_MODE: "poll",
    EVENTS_STREAM_MAX_DURATION_MS: String(SSE_MAX_DURATION_MS),
    EVENTS_POLL_INTERVAL_MS: "1000",
  };
  if (cookieDomain) s.SESSION_COOKIE_DOMAIN = cookieDomain;
  if (env.STRIPE_TEST_SECRET_KEY) s.STRIPE_SECRET_KEY = env.STRIPE_TEST_SECRET_KEY;
  if (env.ADMIN_GITHUB_LOGINS) s.ADMIN_GITHUB_LOGINS = env.ADMIN_GITHUB_LOGINS;
  if (env.RUNNER_TOKEN_SECRET) s.RUNNER_TOKEN_SECRET = env.RUNNER_TOKEN_SECRET;
  if (env.SENTRY_DSN) s.SENTRY_DSN = env.SENTRY_DSN;
  s.NAIVE_API_KEY = env.NAIVE_API_KEY;
  if (env.S3_BUCKET) {
    for (const k of [
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ] as const) {
      if (env[k]) s[k] = env[k];
    }
  }
  return { secrets: s, baseUrl, callbackUrl, allowedOrigins, sameSite, cookieDomain };
}

/**
 * The opaque `value_hash` stored with each secret, so a re-run can tell an unchanged value without
 * reading one back. Salted with the name so equal values do not share a hash.
 */
export function secretValueHash(name: string, value: string): string {
  return `v1:${createHash("sha256").update(`anybench-deploy\n${name}\n${value}`).digest("hex")}`;
}

export interface SecretDiff {
  set: OwnedSecret[];
  unchanged: OwnedSecret[];
  remove: OwnedSecret[];
}

/** What to write, given the names and hashes the app holds now. */
export function diffSecrets(
  want: Partial<Record<OwnedSecret, string>>,
  have: { name: string; value_hash: string | null }[],
): SecretDiff {
  const current = new Map(have.map((s) => [s.name, s.value_hash]));
  const diff: SecretDiff = { set: [], unchanged: [], remove: [] };
  for (const name of OWNED_SECRETS) {
    const value = want[name];
    if (value === undefined) {
      if (current.has(name)) diff.remove.push(name);
    } else if (current.get(name) === secretValueHash(name, value)) {
      diff.unchanged.push(name);
    } else {
      diff.set.push(name);
    }
  }
  return diff;
}
