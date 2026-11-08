// Server config (TDM-14): every env var the API and worker read, validated once at boot with zod.
//
// Conventions for later tickets:
// - Add a var here AND to .env.example (same name). Empty strings count as unset, because
//   .env.example ships `KEY=` lines.
// - Cross-field rules go in `bootAssertions` below, each pushing a `{ path, message }` issue; never
//   throw one at a time. `loadConfig` throws a single ConfigError that lists every bad var.
// - Read config from `deps.config`, never from `process.env`, outside this file and the entries.
import { z } from "zod";
import { DEFAULT_LOCAL_DATABASE_URL } from "./db/client.js";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());
const flag = z
  .preprocess(emptyToUndefined, z.enum(["0", "1"]).default("0"))
  .transform((v) => v === "1");

const postgresUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// or postgresql:// URL");

export const BILLING_MODES = ["off", "test", "live"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const EnvSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(["development", "test", "production"]).default("development"),
  ),
  ANYBENCH_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(["local", "staging", "prod"]).default("local"),
  ),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(8787)),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ),
  /** Neon pooled URL (PgBouncer, transaction mode): API queries. */
  DATABASE_URL: z.preprocess(emptyToUndefined, postgresUrl.optional()),
  /** Neon direct URL: migrations, graphile-worker, LISTEN/NOTIFY. */
  DATABASE_URL_DIRECT: z.preprocess(emptyToUndefined, postgresUrl.optional()),
  LOCAL_DATABASE_URL: z.preprocess(emptyToUndefined, postgresUrl.optional()),
  ANYBENCH_PAUSE: flag,
  BILLING_MODE: z.preprocess(emptyToUndefined, z.enum(BILLING_MODES).default("test")),
  /** The key the app uses; deploy maps it from STRIPE_TEST_SECRET_KEY or STRIPE_LIVE_SECRET_KEY. */
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_TEST_SECRET_KEY: optionalString,
  STRIPE_LIVE_SECRET_KEY: optionalString,
  SENTRY_DSN: optionalUrl,
  /** HMAC key for per-trial runner tokens (lib/runner-token.ts). Unset = runner ingest answers 503. */
  RUNNER_TOKEN_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().min(32, { error: "must be at least 32 chars (openssl rand -base64 48)" }).optional(),
  ),
  /** Defaults to `<hostname>:<pid>`. */
  WORKER_ID: optionalString,
  WORKER_CONCURRENCY: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(64).default(5),
  ),
  /**
   * `GET /runs/:id/stream` (TDM-72): `poll` re-reads events every EVENTS_POLL_INTERVAL_MS and ends
   * the response after EVENTS_STREAM_MAX_DURATION_MS (required on Vercel Functions); `listen` wakes
   * streams from one shared LISTEN connection on DATABASE_URL_DIRECT (long-lived Node only).
   */
  EVENTS_STREAM_MODE: z.preprocess(emptyToUndefined, z.enum(["poll", "listen"]).default("poll")),
  EVENTS_STREAM_MAX_DURATION_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(100).max(3_600_000).default(50_000),
  ),
  EVENTS_POLL_INTERVAL_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(10).max(60_000).default(1_000),
  ),
  // ── Auth (TDM-65, plan.md section 9). Optional at boot (the worker never needs them); the
  // /auth routes answer 503 until GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and SESSION_SECRET are set.
  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  GITHUB_OAUTH_CALLBACK_URL: optionalUrl,
  /** HMAC key for the OAuth state cookie. */
  SESSION_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().min(32, { error: "must be at least 32 characters" }).optional(),
  ),
  /** e.g. `.anybench.jaxonp.com`; unset = host-only cookie on the API host. */
  SESSION_COOKIE_DOMAIN: optionalString,
  /**
   * SameSite of the session cookie. `lax` (default) when the web app and the API share a site
   * (anybench.jaxonp.com + api.anybench.jaxonp.com). `none` when they do not (anybench.vercel.app and
   * the API's own *.vercel.app host): the browser then sends the cookie on credentialed fetches.
   * Requires Secure (an https callback). Browsers that block third-party cookies still drop it.
   */
  SESSION_COOKIE_SAMESITE: z.preprocess(emptyToUndefined, z.enum(["lax", "none"]).default("lax")),
  /** Comma list of exact origins for CORS (with credentials) and the CSRF Origin check. */
  ALLOWED_ORIGINS: optionalString,
  /** Comma list of GitHub logins that are admins, checked per request (case-insensitive). */
  ADMIN_GITHUB_LOGINS: optionalString,
  /** Where sign-in lands afterwards; defaults to the first ALLOWED_ORIGINS entry. */
  PUBLIC_WEB_URL: optionalUrl,
  /**
   * Public base URL of this API (TDM-49): the runner ingest URL the worker writes into each
   * trial.json. Unset = runners are file-only (the worker follows status.json).
   */
  PUBLIC_API_URL: optionalUrl,
  /**
   * Price of one eval-computer billing block (Naïve: 10 min, paid in advance), integer micro-USD,
   * for computer cost and leak alerts (TDM-31). Default: Naïve's default 2 vCPU / 4 GiB size at
   * $0.0084 per vCPU-block + $0.0027 per GiB-block (docs/findings/naive-platform-hosting.md).
   */
  COMPUTER_BLOCK_PRICE_MICRO_USD: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,15}$/, "must be a non-negative integer of micro-USD")
      .default("27600")
      .transform((v) => BigInt(v)),
  ),
});
export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  /** Resolved pooled URL (DATABASE_URL, else the local Docker Postgres outside production). */
  databaseUrl: string;
  /** Resolved direct URL (DATABASE_URL_DIRECT, else DATABASE_URL / local outside production). */
  databaseUrlDirect: string;
  isProduction: boolean;
  /** ALLOWED_ORIGINS parsed into serialized origins (`https://anybench.jaxonp.com`). */
  allowedOrigins: readonly string[];
  /** ADMIN_GITHUB_LOGINS, lowercased. Admin is decided per request from this, never stored. */
  adminGithubLogins: readonly string[];
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super(
      `Invalid server environment (${issues.length} problem${issues.length === 1 ? "" : "s"}):\n` +
        issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n"),
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const STRIPE_PREFIXES: Record<Exclude<BillingMode, "off">, readonly string[]> = {
  test: ["sk_test_", "rk_test_"],
  live: ["sk_live_", "rk_live_"],
};

function stripeKeyIssue(key: string | undefined, mode: "test" | "live"): string | undefined {
  if (key === undefined) return undefined;
  const allowed = STRIPE_PREFIXES[mode];
  if (allowed.some((p) => key.startsWith(p))) return undefined;
  // Never echo the key itself: only the first segment, which is not secret.
  const seen = /^[a-z]{2,4}_[a-z]+_/.exec(key)?.[0] ?? "an unrecognised prefix";
  return `must start with ${allowed.join(" or ")} for ${mode} mode (got ${seen})`;
}

function bootAssertions(env: Env): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const prod = env.NODE_ENV === "production";

  if (env.BILLING_MODE === "off" && prod) {
    issues.push({
      path: "BILLING_MODE",
      message: "off is only allowed in local dev; refusing to boot with NODE_ENV=production",
    });
  }
  if (env.BILLING_MODE !== "off") {
    const msg = stripeKeyIssue(env.STRIPE_SECRET_KEY, env.BILLING_MODE);
    if (msg) issues.push({ path: "STRIPE_SECRET_KEY", message: msg });
  }
  const testMsg = stripeKeyIssue(env.STRIPE_TEST_SECRET_KEY, "test");
  if (testMsg) issues.push({ path: "STRIPE_TEST_SECRET_KEY", message: testMsg });
  const liveMsg = stripeKeyIssue(env.STRIPE_LIVE_SECRET_KEY, "live");
  if (liveMsg) issues.push({ path: "STRIPE_LIVE_SECRET_KEY", message: liveMsg });

  if (prod && !env.DATABASE_URL) {
    issues.push({ path: "DATABASE_URL", message: "required when NODE_ENV=production" });
  }
  if (prod && !env.DATABASE_URL_DIRECT) {
    issues.push({ path: "DATABASE_URL_DIRECT", message: "required when NODE_ENV=production" });
  }

  const origins = parseOrigins(env.ALLOWED_ORIGINS);
  for (const bad of origins.invalid) {
    issues.push({
      path: "ALLOWED_ORIGINS",
      message: `'${bad}' is not an origin (scheme://host[:port], http or https, no path)`,
    });
  }
  // Sign-in only ever redirects to the web origin, and that origin must be an allowed one.
  if (env.PUBLIC_WEB_URL) {
    const webOrigin = new URL(env.PUBLIC_WEB_URL).origin;
    if (!origins.valid.includes(webOrigin)) {
      issues.push({
        path: "PUBLIC_WEB_URL",
        message: `origin ${webOrigin} must be listed in ALLOWED_ORIGINS`,
      });
    }
  }
  if (prod && env.GITHUB_OAUTH_CALLBACK_URL?.startsWith("http://")) {
    issues.push({
      path: "GITHUB_OAUTH_CALLBACK_URL",
      message: "must be https when NODE_ENV=production",
    });
  }
  if (
    env.SESSION_COOKIE_SAMESITE === "none" &&
    !prod &&
    env.GITHUB_OAUTH_CALLBACK_URL?.startsWith("http://")
  ) {
    issues.push({
      path: "SESSION_COOKIE_SAMESITE",
      message: "none needs a Secure cookie, which a plain-http GITHUB_OAUTH_CALLBACK_URL turns off",
    });
  }
  const domain = env.SESSION_COOKIE_DOMAIN;
  if (domain !== undefined && !/^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) {
    issues.push({ path: "SESSION_COOKIE_DOMAIN", message: "must be a domain like .example.com" });
  }
  return issues;
}

/** Split a comma list into exact origins. An entry with a path, query or other scheme is invalid. */
export function parseOrigins(list: string | undefined): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of (list ?? "").split(",").map((s) => s.trim())) {
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      invalid.push(raw);
      continue;
    }
    const bare = /^https?:\/\/[^/?#@\s]+\/?$/i.test(raw);
    if (!bare || (url.protocol !== "https:" && url.protocol !== "http:")) {
      invalid.push(raw);
      continue;
    }
    if (!valid.includes(url.origin)) valid.push(url.origin);
  }
  return { valid, invalid };
}

function parseLogins(list: string | undefined): string[] {
  return [
    ...new Set(
      (list ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Validate `source` (default process.env). Throws one ConfigError listing every bad var. */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
    );
  }
  const env = parsed.data;
  const issues = bootAssertions(env);
  if (issues.length > 0) throw new ConfigError(issues);

  const local = env.LOCAL_DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;
  const databaseUrl = env.DATABASE_URL ?? local;
  return {
    ...env,
    databaseUrl,
    databaseUrlDirect: env.DATABASE_URL_DIRECT ?? env.DATABASE_URL ?? local,
    isProduction: env.NODE_ENV === "production",
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS).valid,
    adminGithubLogins: parseLogins(env.ADMIN_GITHUB_LOGINS),
  };
}

/** Secret values in this config, for the log/Sentry redactor (exact-match redaction). */
export function configSecrets(config: Config): Record<string, string | undefined> {
  return {
    DATABASE_URL: config.DATABASE_URL,
    DATABASE_URL_DIRECT: config.DATABASE_URL_DIRECT,
    STRIPE_SECRET_KEY: config.STRIPE_SECRET_KEY,
    STRIPE_TEST_SECRET_KEY: config.STRIPE_TEST_SECRET_KEY,
    STRIPE_LIVE_SECRET_KEY: config.STRIPE_LIVE_SECRET_KEY,
    SENTRY_DSN: config.SENTRY_DSN,
    GITHUB_CLIENT_SECRET: config.GITHUB_CLIENT_SECRET,
    SESSION_SECRET: config.SESSION_SECRET,
    RUNNER_TOKEN_SECRET: config.RUNNER_TOKEN_SECRET,
  };
}
