// Stripe test -> live cutover (plan.md 10.11), one shot and idempotent:
//
//   pnpm tsx scripts/ops/stripe-go-live.ts [--dry-run] [--skip-db] [--webhook-url <url>]
//                                          [--allow-inactive-account]
//
// Needs STRIPE_LIVE_SECRET_KEY in .env (sk_live_ or rk_live_; anything else is refused before a
// request is made). Then, in this order:
//   1. Account check: when the live account cannot take charges yet (activation unfinished), steps
//      2, 3 and the id writes still run, but BILLING_MODE stays test and step 4 is skipped (exit 3).
//   2. Catalog: the same idempotent meter / product / price setup as `pnpm billing:setup`, in live.
//   3. Webhook: create-or-find the live endpoint at <DEPLOY_API_WEB_URL>/api/webhooks/stripe (the
//      web app's same-origin proxy to POST /webhooks/stripe) with WEBHOOK_EVENTS. Stripe returns a
//      signing secret only on create: when the endpoint already exists and .env has no
//      STRIPE_LIVE_WEBHOOK_SECRET, roll it in the Dashboard, paste it, and re-run.
//   4. Database (DATABASE_URL_DIRECT, the branch the API deploy uses): forget test-mode Stripe state
//      so a test card never passes the live run gate (stripe_customer_id, subscription_id and
//      has_payment_method cleared; payment_status back to none unless blocked), and mark usage that
//      was never reported in test mode as settled (`testmode:<id>`) so it is never billed in live.
//      --skip-db leaves the database alone.
//   5. .env: STRIPE_LIVE_METER_ID, STRIPE_LIVE_PRICE_USAGE, STRIPE_LIVE_WEBHOOK_SECRET (only when
//      Stripe just created the endpoint) are written in place; BILLING_MODE=live is set once all
//      four live values are present. Every other byte of .env is preserved.
//
// Output: ids (mtr_, price_, we_) and "set"/"missing" only. No key or signing secret is printed,
// put on argv, or logged. Then deploy: `pnpm tsx scripts/deploy/api.ts --skip-migrate` and
// `pnpm tsx scripts/deploy/worker.ts --skip-migrate` (the worker reports usage to the meter).
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
// Relative imports only: scripts/ops has no package.json, so bare specifiers do not resolve here.
import type Stripe from "stripe";
import { createDb } from "../../apps/server/src/db/client.js";
import { forgetTestModeStripeState } from "../../apps/server/src/lib/stripe-billing.js";
import { redact } from "../../packages/core/src/redact.js";
import { runStripeSetup } from "../../packages/billing/src/setup.js";
import {
  assertLivemode,
  createBillingStripe,
  resolveStripeConfig,
  STRIPE_API_VERSION,
  StripeModeError,
} from "../../packages/billing/src/stripe.js";
import { findEnvFile } from "../deploy/lib/api-plan.js";

/** The events the webhook takes (the list in .env.example, the same one the test endpoint uses). */
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "payment_method.attached",
  "payment_method.detached",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "radar.early_fraud_warning.created",
  "billing.credit_grant.created",
  "billing.credit_grant.updated",
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];

/** The webhook route on the API (apps/server/src/routes/index.ts mounts it at /webhooks). */
export const WEBHOOK_PATH = "/api/webhooks/stripe";

/**
 * `text` with each `KEY=value` line's value replaced (first occurrence; an inline `# comment`
 * and its padding are kept), and keys with no line appended. Every other byte is unchanged.
 */
export function setEnvValues(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z0-9_]+$/.test(key) || /[\s#"'\\]/.test(value)) {
      throw new Error(`refusing to write ${key}: unexpected characters`);
    }
    const line = new RegExp(`^(${key}=)([^\\s#]*)(.*)$`, "m");
    if (line.test(out)) {
      out = out.replace(line, (_m, head: string, _old: string, rest: string) => {
        // `KEY=# c` would read as an empty value: keep a space before the comment.
        const tail = rest.startsWith("#") ? ` ${rest}` : rest;
        return `${head}${value}${tail}`;
      });
    } else {
      out = `${out}${out === "" || out.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
    }
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const say = (line: string) => console.log(`[stripe:go-live] ${line}`);

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const skipDb = process.argv.includes("--skip-db");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const envPath = findEnvFile(repoRoot, process.env.ANYBENCH_ENV_FILE);
  const envText = readFileSync(envPath, "utf8");
  const env = parseEnv(envText) as Record<string, string | undefined>;
  const nonEmpty = (k: string) => (env[k]?.trim() ? env[k]!.trim() : undefined);

  const key = nonEmpty("STRIPE_LIVE_SECRET_KEY");
  if (!key) throw new StripeModeError(`STRIPE_LIVE_SECRET_KEY is empty in ${envPath}`);
  if (!/^(sk|rk)_live_/.test(key)) {
    throw new StripeModeError("STRIPE_LIVE_SECRET_KEY must start with sk_live_ or rk_live_");
  }
  // Only the LIVE key: a generic STRIPE_SECRET_KEY in .env must not be picked up here.
  const client = createBillingStripe(
    resolveStripeConfig({ BILLING_MODE: "live", STRIPE_LIVE_SECRET_KEY: key }),
  );
  const { stripe } = client;
  say(`env file ${envPath}${dryRun ? " (dry run: no writes)" : ""}`);

  // 1. Can this account take money yet? Going live before it can would break "add a card" for
  //    everyone, so BILLING_MODE stays test (and the database untouched) until charges are enabled.
  const allowInactive = process.argv.includes("--allow-inactive-account");
  let chargesEnabled: boolean | undefined;
  try {
    const acct = await stripe.accounts.retrieve();
    say(
      `account ${acct.id} charges_enabled=${String(acct.charges_enabled)} payouts_enabled=${String(acct.payouts_enabled)} details_submitted=${String(acct.details_submitted)}`,
    );
    chargesEnabled = acct.charges_enabled;
    if (!acct.charges_enabled) {
      say("WARNING: charges are not enabled: finish account activation in the Stripe Dashboard");
    }
  } catch (err) {
    say(`account check skipped (${err instanceof Error ? err.message : "error"}); restricted key?`);
  }

  // 2. Catalog (idempotent; read-only lookups in a dry run would still need the ids, so a dry run
  //    only reports what exists).
  let meterId: string | undefined;
  let priceId: string | undefined;
  if (dryRun) {
    const meters = await stripe.billing.meters.list({ limit: 100 });
    meterId = meters.data.find((m) => m.event_name === "anybench_usage")?.id;
    const prices = await stripe.prices.list({ lookup_keys: ["anybench_usage_cents_v1"], limit: 1 });
    priceId = prices.data[0]?.id;
    say(`catalog: meter ${meterId ?? "(would create)"} price ${priceId ?? "(would create)"}`);
  } else {
    const { catalog } = await runStripeSetup(client, (l) =>
      say(l.replace(/^\[billing:setup\] /, "")),
    );
    meterId = catalog.meterId;
    priceId = catalog.priceId;
  }

  // 3. Webhook endpoint.
  const webBase =
    (arg("--webhook-url") ? undefined : nonEmpty("DEPLOY_API_WEB_URL")) ??
    "https://anybench.vercel.app";
  const url = arg("--webhook-url") ?? `${new URL(webBase).origin}${WEBHOOK_PATH}`;
  if (!/^https:\/\//.test(url)) throw new Error(`webhook URL must be https (got ${url})`);
  let existing: Stripe.WebhookEndpoint | undefined;
  for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (ep.url === url) {
      existing = ep;
      break;
    }
  }
  let newWebhookSecret: string | undefined;
  const haveSecret = /^whsec_/.test(nonEmpty("STRIPE_LIVE_WEBHOOK_SECRET") ?? "");
  if (existing) {
    assertLivemode("live", existing);
    const want = new Set<string>(WEBHOOK_EVENTS);
    const have = new Set(existing.enabled_events);
    const same = want.size === have.size && [...want].every((e) => have.has(e));
    say(`webhook found ${existing.id} ${url} status=${existing.status}`);
    if ((!same || existing.status !== "enabled") && !dryRun) {
      await stripe.webhookEndpoints.update(existing.id, {
        enabled_events: [...WEBHOOK_EVENTS],
        disabled: false,
      });
      say(`webhook ${existing.id} events/status updated (signing secret unchanged)`);
    }
    if (!haveSecret) {
      say(
        `ACTION: STRIPE_LIVE_WEBHOOK_SECRET is missing and Stripe only shows it once. Dashboard -> Developers -> Webhooks -> ${existing.id} -> Roll secret, paste the whsec_ into .env, then re-run this script.`,
      );
    }
  } else if (dryRun) {
    say(`webhook would be created at ${url} (${WEBHOOK_EVENTS.length} events)`);
  } else {
    const created = await stripe.webhookEndpoints.create({
      url,
      enabled_events: [...WEBHOOK_EVENTS],
      api_version: STRIPE_API_VERSION as Stripe.WebhookEndpointCreateParams.ApiVersion,
      description: "Anybench API (POST /webhooks/stripe via the web proxy)",
      metadata: { anybench: "webhook" },
    });
    assertLivemode("live", created);
    newWebhookSecret = created.secret;
    say(
      `webhook created ${created.id} ${url} (signing secret ${newWebhookSecret ? "received" : "MISSING"})`,
    );
  }

  const complete = Boolean(meterId && priceId && (newWebhookSecret || haveSecret));
  const ready = chargesEnabled !== false || allowInactive;

  // 4. Database: drop test-mode Stripe state, only together with the flip to live (and only while
  //    .env still says test: once live, these rows are real customers and real usage).
  if (!complete || !ready) {
    say("database: unchanged (not flipping to live on this run)");
  } else if (skipDb) {
    say("database: skipped (--skip-db)");
  } else if (nonEmpty("BILLING_MODE") === "live") {
    say("database: skipped (BILLING_MODE is already live; live rows are never cleared)");
  } else {
    const dbUrl = nonEmpty("DATABASE_URL_DIRECT") ?? nonEmpty("DATABASE_URL");
    if (!dbUrl) throw new Error("DATABASE_URL_DIRECT is empty; pass --skip-db to skip this step");
    const h = createDb(dbUrl, { max: 1 });
    try {
      const found = await forgetTestModeStripeState(h.db, { apply: !dryRun });
      say(
        `database: ${found.accounts} account(s) with a test-mode Stripe customer, ${found.unreportedUsage} unreported usage entr(ies)${dryRun ? " [dry run: unchanged]" : found.accounts + found.unreportedUsage > 0 ? " -> cleared; usage marked testmode:<id>" : ""}`,
      );
    } finally {
      await h.close();
    }
  }

  // 5. .env.
  const updates: Record<string, string> = {};
  if (meterId) updates.STRIPE_LIVE_METER_ID = meterId;
  if (priceId) updates.STRIPE_LIVE_PRICE_USAGE = priceId;
  if (newWebhookSecret) updates.STRIPE_LIVE_WEBHOOK_SECRET = newWebhookSecret;
  if (complete && ready) updates.BILLING_MODE = "live";
  if (!dryRun) {
    const next = setEnvValues(envText, updates);
    if (next !== envText) {
      const tmp = join(dirname(envPath), `.env.go-live.${process.pid}.tmp`);
      writeFileSync(tmp, next, { mode: statSync(envPath).mode & 0o777 });
      renameSync(tmp, envPath);
    }
  }
  for (const k of [
    "STRIPE_LIVE_SECRET_KEY",
    "STRIPE_LIVE_WEBHOOK_SECRET",
    "STRIPE_LIVE_METER_ID",
    "STRIPE_LIVE_PRICE_USAGE",
  ]) {
    const set = k in updates || Boolean(nonEmpty(k));
    const shown =
      k === "STRIPE_LIVE_METER_ID"
        ? meterId
        : k === "STRIPE_LIVE_PRICE_USAGE"
          ? priceId
          : undefined;
    say(
      `.env ${k} ${set ? "set" : "missing"}${shown ? ` (${shown})` : ""}${dryRun && k in updates ? " [dry run: not written]" : ""}`,
    );
  }
  if (complete && !ready) {
    say(
      "BILLING_MODE left at test: the live account cannot take charges yet. Finish activation in the Stripe Dashboard, then re-run (or pass --allow-inactive-account).",
    );
    process.exitCode = 3;
  } else if (complete) {
    say(`.env BILLING_MODE=live${dryRun ? " [dry run: not written]" : ""}`);
    say(
      "next: pnpm tsx scripts/deploy/api.ts --skip-migrate && pnpm tsx scripts/deploy/worker.ts --skip-migrate",
    );
  } else {
    say("BILLING_MODE left unchanged: fix the missing values above and re-run");
    process.exitCode = 2;
  }
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  let env: Record<string, string | undefined> = {};
  try {
    env = parseEnv(
      readFileSync(
        findEnvFile(
          resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
          process.env.ANYBENCH_ENV_FILE,
        ),
        "utf8",
      ),
    );
  } catch {
    // no .env: nothing to redact
  }
  console.error(
    redact(
      `[stripe:go-live] ${err instanceof StripeModeError ? "refusing to run" : "failed"}: ${message}`,
      {
        STRIPE_LIVE_SECRET_KEY: env.STRIPE_LIVE_SECRET_KEY,
        STRIPE_LIVE_WEBHOOK_SECRET: env.STRIPE_LIVE_WEBHOOK_SECRET,
        DATABASE_URL_DIRECT: env.DATABASE_URL_DIRECT,
        DATABASE_URL: env.DATABASE_URL,
      },
    ),
  );
  process.exitCode = 1;
}
