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
  // ── Link a card + usage billing (stripe-onboarding, plan.md section 8). Each generic name falls
  // back to STRIPE_<MODE>_<NAME> (packages/billing resolveStripeConfig), so local dev only needs
  // the TEST set from .env. Unset = the billing routes answer 503 and the gate refuses non-admins.
  /** Signing secret of the /webhooks/stripe endpoint (whsec_...). */
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_TEST_WEBHOOK_SECRET: optionalString,
  STRIPE_LIVE_WEBHOOK_SECRET: optionalString,
  /** The usage meter (mtr_...) and metered price (price_...); `pnpm billing:setup` prints them. */
  STRIPE_METER_ID: optionalString,
  STRIPE_TEST_METER_ID: optionalString,
  STRIPE_LIVE_METER_ID: optionalString,
  STRIPE_PRICE_USAGE: optionalString,
  STRIPE_TEST_PRICE_USAGE: optionalString,
  STRIPE_LIVE_PRICE_USAGE: optionalString,
  /**
   * Run gate: max unbilled usage (plus the run's estimate) for an account with no paid invoice
   * yet, integer micro-USD ($100). billing_accounts.spend_limit_micro_usd overrides it per account.
   */
  NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,15}$/, "must be a non-negative integer of micro-USD")
      .default("100000000")
      .transform((v) => BigInt(v)),
  ),
  /** Shown on the billing page: Stripe invoices early at this much unbilled usage ($50). */
  USAGE_INVOICE_THRESHOLD_MICRO_USD: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,15}$/, "must be a non-negative integer of micro-USD")
      .default("50000000")
      .transform((v) => BigInt(v)),
  ),
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
   * worker-hardening: the provider-outage breaker (lib/provider-breaker.ts) opens after this many
   * consecutive provider 5xx / 429 on create, fork or mint within PROVIDER_BREAKER_WINDOW_MS, and
   * while open probes the provider every PROVIDER_BREAKER_PROBE_MS.
   */
  PROVIDER_BREAKER_THRESHOLD: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(100).default(3),
  ),
  PROVIDER_BREAKER_WINDOW_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
  ),
  PROVIDER_BREAKER_PROBE_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
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
  /** `GET /trials/:id/log/stream` (TDM-74): re-authenticate an open log tail this often. */
  LOG_STREAM_AUTH_RECHECK_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(10).max(300_000).default(30_000),
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
  // ── Publish (E12, @anybench/publish keys.ts). Optional at boot: POST /runs/:id/publication
  // answers 503 until the key is set. Public keys are served at /.well-known/anybench-keys.json.
  PUBLISH_SIGNING_KEY_ID: optionalString,
  PUBLISH_SIGNING_PRIVATE_KEY_DER_B64: optionalString,
  PUBLISH_SIGNING_PUBLIC_KEY_DER_B64: optionalString,
  PUBLISH_SIGNING_PREVIOUS_PUBLIC_KEYS: optionalString,
  /**
   * Price of one eval-computer billing block (Naïve: 10 min, paid in advance), integer micro-USD,
   * for computer cost and leak alerts (TDM-31). Default: Naïve's default 2 vCPU / 4 GiB size at
   * $0.0084 per vCPU-block + $0.0027 per GiB-block (docs/findings/naive-platform-hosting.md).
   */
  /**
   * Naïve API key (TDM-54): the run orchestrator cancels a cancelled run's live Naïve sessions.
   * E6 agent roles use it to run sessions. Unset = no session can be cancelled (none are started).
   */
  NAIVE_API_KEY: optionalString,
  NAIVE_BASE_URL: optionalUrl,
  /**
   * Naïve model for POST /runs/suggest (the New run screen's repo reader). A cheap model that keeps
   * to a JSON schema; each call is capped at about $0.05. Default: lib/suggest.ts SUGGEST_DEFAULT_MODEL.
   */
  ANYBENCH_SUGGEST_MODEL: optionalString,
  /**
   * Where the bun-compiled runner binaries are (runner-linux-x64/arm64), for the env build to put
   * in every image. Default: packages/runner/dist/bin (`pnpm --filter @anybench/runner build:bin`).
   */
  ANYBENCH_RUNNER_BIN_DIR: optionalString,
  /**
   * Ceiling of each trial's Naïve proxy spend cap, integer micro-USD (default $3, the smoke
   * profile). A contender's own cap (token cap at list price) applies when it is lower.
   */
  TRIAL_PROXY_CAP_MICRO_USD: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,15}$/, "must be a non-negative integer of micro-USD")
      .default("3000000")
      .transform((v) => BigInt(v)),
  ),
  /**
   * TDM-212: the key-encryption key for BYOK model keys (user_secrets, lib/byok.ts). Unset = no
   * stored key can be read, so an AB_TOKEN_SOURCE=anthropic_key trial fails to prepare.
   */
  ANYBENCH_KEK: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .min(32, { error: "must be at least 32 characters (openssl rand -base64 32)" })
      .optional(),
  ),
  /** The previous KEK during a rotation (rows with kek_version 0). */
  ANYBENCH_KEK_PREVIOUS: z.preprocess(
    emptyToUndefined,
    z.string().min(32, { error: "must be at least 32 characters" }).optional(),
  ),
  /** The curated kits directory (TDM-54 CuratedKitStage); default: the repo's kits/. */
  ANYBENCH_KITS_DIR: optionalString,
  /**
   * Where generated kits are written (TDM-44 contract C1), as `<dir>/<run_id>/v<n>/`; default
   * ~/.anybench/generated-kits (orchestrator/generated-kits.ts generatedKitDir).
   */
  ANYBENCH_GENERATED_KITS_DIR: optionalString,
  /** Optional GitHub token for ingest (TDM-54 → packages/kit ingestGitHubRepo): private repos, rate limits. */
  GITHUB_TOKEN: optionalString,
  /**
   * One 10-minute eval-computer block (2 vCPU / 4 GiB at Naïve). TDM-252: a Naïve computer costs
   * its own size's rate-card block (lib/computer-store.ts computerPricing; 4 vCPU / 8 GiB =
   * 55,200); this is the price of another provider's block and of rows from before that.
   */
  COMPUTER_BLOCK_PRICE_MICRO_USD: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,15}$/, "must be a non-negative integer of micro-USD")
      .default("27600")
      .transform((v) => BigInt(v)),
  ),
  // ── Cost-plus billing (TDM-171, plan.md section 8): the run fee plus eval computer time at
  // Naïve cost + COMPUTE_MARKUP_BPS. Read by packages/billing (recordRunFee, recordComputerUsage,
  // estimateRunCost); never parsed as a float.
  /** Flat fee per delivered or subject-failed run, integer micro-USD ($2). */
  RUN_FEE_MICRO_USD: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,15}$/, "must be a non-negative integer of micro-USD")
      .default("2000000")
      .transform((v) => BigInt(v)),
  ),
  /**
   * TDM-218: the run fee for a run from an uploaded kit (the user's own agent built it, so none of
   * our kit-generation agents ran). Integer micro-USD; default 0: the user pays trial compute only.
   */
  UPLOADED_KIT_RUN_FEE_MICRO_USD: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,15}$/, "must be a non-negative integer of micro-USD")
      .default("0")
      .transform((v) => BigInt(v)),
  ),
  // ── Free starter run (TDM-223, E20): a new eligible account's first benchmark is free, no card,
  // funded by a global pool at OUR cost. packages/billing free-run.ts; lib/free-run.ts maps these.
  /** The pool every free run is funded from, integer micro-USD at our cost ($50). 0 = free runs off. */
  FREE_RUN_POOL_MICRO_USD: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,15}$/, "must be a non-negative integer of micro-USD")
      .default("50000000")
      .transform((v) => BigInt(v)),
  ),
  /** A starter run's compute ceiling at our cost, integer micro-USD ($10). */
  FREE_RUN_CAP_MICRO_USD: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,15}$/, "must be a non-negative integer of micro-USD")
      .default("10000000")
      .transform((v) => BigInt(v)),
  ),
  /** A starter run's trials, warm-ups included (the reduced trial count). */
  FREE_RUN_MAX_TRIALS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(10_000).default(24),
  ),
  /**
   * The once-per-account signup credit grant (GitHub accounts older than 90 days), integer
   * micro-USD. Default 0: the free starter run replaced the $5 grant. Our ledger only until 10.7
   * mirrors it to a Stripe credit grant, so keep it 0 in production.
   */
  SIGNUP_GRANT_MICRO_USD: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,15}$/, "must be a non-negative integer of micro-USD")
      .default("0")
      .transform((v) => BigInt(v)),
  ),
  // ── Run emails (run.notify, jobs/run-notify.ts): "your benchmark is done" to the run owner. ──
  /**
   * `1`/`0` turns the run-owner emails on/off. Unset = on when MONID_API_KEY and a sending inbox
   * (NOTIFY_FROM_INBOX, else OUTREACH_FROM_ADDRESS) are set. Transactional, never outreach.
   */
  NOTIFY_EMAIL_ENABLED: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).optional()),
  /** Monid key: run emails go through AgentMail via Monid (docs/findings/monid-agentmail.md). */
  MONID_API_KEY: optionalString,
  MONID_BASE_URL: optionalUrl,
  /** The AgentMail inbox run emails are sent from. Default: OUTREACH_FROM_ADDRESS. */
  NOTIFY_FROM_INBOX: optionalString,
  OUTREACH_FROM_ADDRESS: optionalString,
  /** Company postal address, shown in the run email footer. */
  COMPANY_POSTAL_ADDRESS: optionalString,
  /** Markup on eval computer cost in basis points (5000 = +50%), rounded down per computer. */
  COMPUTE_MARKUP_BPS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,6}$/, "must be a non-negative integer of basis points")
      .default("5000")
      .transform((v) => BigInt(v)),
  ),
  /**
   * TDM-244: markup on our model tokens (the Naïve proxy, AB_TOKEN_SOURCE=naive_proxy) in basis
   * points (2000 = +20%), rounded down per trial. A user's run on our tokens is billed the key's
   * Naïve spend plus this (packages/billing recordTrialManagedTokens); their own key is never billed.
   */
  MANAGED_TOKEN_MARKUP_BPS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,6}$/, "must be a non-negative integer of basis points")
      .default("2000")
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
    STRIPE_WEBHOOK_SECRET: config.STRIPE_WEBHOOK_SECRET,
    STRIPE_TEST_WEBHOOK_SECRET: config.STRIPE_TEST_WEBHOOK_SECRET,
    STRIPE_LIVE_WEBHOOK_SECRET: config.STRIPE_LIVE_WEBHOOK_SECRET,
    SENTRY_DSN: config.SENTRY_DSN,
    GITHUB_CLIENT_SECRET: config.GITHUB_CLIENT_SECRET,
    SESSION_SECRET: config.SESSION_SECRET,
    RUNNER_TOKEN_SECRET: config.RUNNER_TOKEN_SECRET,
    ANYBENCH_KEK: config.ANYBENCH_KEK,
    ANYBENCH_KEK_PREVIOUS: config.ANYBENCH_KEK_PREVIOUS,
    MONID_API_KEY: config.MONID_API_KEY,
    PUBLISH_SIGNING_PRIVATE_KEY_DER_B64: config.PUBLISH_SIGNING_PRIVATE_KEY_DER_B64,
  };
}
