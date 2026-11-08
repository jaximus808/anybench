// Billing routes (stripe-onboarding; contract apiRoutes.billing in @anybench/core, plan.md section 8).
// Mounted at /billing (session users only):
//   GET  /billing/summary    the account the run gate reads (card on file, payment status, unbilled
//                            usage, spend limit) and this month's usage. While a Customer exists but
//                            no card is recorded yet, it re-reads Stripe first, so the page shows
//                            the card as soon as Checkout returns even if the webhook is late.
//   POST /billing/link-card  Stripe Checkout (mode subscription, the metered usage price): saves a
//                            card, $0 due today. Answers {url}; the browser goes there.
//   POST /billing/portal     Stripe billing portal (change card, invoices, receipts).
// And at /webhooks (no session; Stripe signs it):
//   POST /webhooks/stripe    raw body, signature verified, stripe_events insert first (idempotent),
//                            then the customer's account is re-synced from Stripe.
// Every route answers 503 when this deployment has no Stripe (BILLING_MODE=off or no test key).
import {
  API_ERROR_STATUS,
  apiError,
  apiRoutes,
  encodeRouteResponse,
  parseRouteRequest,
  type ApiErrorCode,
  type RouteResult,
} from "@anybench/core";
import { StripeWebhookError, type StripeBillingPort } from "@anybench/billing";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Config } from "../config.js";
import { usageEntries } from "../db/schema/index.js";
import { requireSessionActor, type ActorEnv } from "../lib/auth-key.js";
import {
  ensureStripeCustomer,
  loadBillingAccount,
  processStripeEvent,
  syncBillingAccount,
} from "../lib/stripe-billing.js";
import type { AppDeps, AppEnv } from "../types.js";

const contract = apiRoutes.billing;
const FALLBACK_WEB_ORIGIN = "https://anybench.jaxonp.com";

export type BillingRouteDeps = AppDeps & { stripeBilling: StripeBillingPort | null };

function fail(c: Context, code: ApiErrorCode, message: string, issues?: string[]) {
  return c.json(
    apiError(code, message, {
      request_id: c.get("requestId") as string | undefined,
      ...(issues ? { issues } : {}),
    }),
    API_ERROR_STATUS[code] as ContentfulStatusCode,
  );
}

function webOrigin(config: Pick<Config, "PUBLIC_WEB_URL" | "allowedOrigins">): string {
  return new URL(config.PUBLIC_WEB_URL ?? config.allowedOrigins[0] ?? FALLBACK_WEB_ORIGIN).origin;
}

/** A contract return path on the web origin (the schema already refused absolute URLs). */
function onWeb(config: Pick<Config, "PUBLIC_WEB_URL" | "allowedOrigins">, path: string): string {
  const origin = webOrigin(config);
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error("return path left the web origin");
  return url.toString();
}

async function readJson(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (text.trim() === "") return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function monthBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export function billingRoutes(deps: BillingRouteDeps): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  r.use(requireSessionActor(deps));
  const unavailable = (c: Context) =>
    fail(c, "unavailable", "billing is not configured on this deployment");

  r.get("/summary", async (c) => {
    const actor = c.get("actor");
    let account = await loadBillingAccount(deps.db, actor.userId);
    const port = deps.stripeBilling;
    if (port && account.stripeCustomerId && !account.hasPaymentMethod) {
      try {
        account = await syncBillingAccount(deps.db, port, actor.userId);
      } catch (err) {
        c.get("log").warn({ err }, "billing summary: Stripe sync failed; showing stored state");
      }
    }
    const { start, end } = monthBounds(new Date());
    const [usage] = await deps.db
      .select({ sum: sql<string>`coalesce(sum(${usageEntries.amountMicroUsd}), 0)::text` })
      .from(usageEntries)
      .where(
        and(
          eq(usageEntries.userId, actor.userId),
          isNull(usageEntries.compedBy),
          gte(usageEntries.createdAt, start),
          lt(usageEntries.createdAt, end),
        ),
      );
    // The gate applies it until the first paid invoice (lib/billing-gate.ts accountGateDecision).
    const limit = account.spendLimitMicroUsd ?? deps.config.NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD;
    const result: RouteResult<typeof contract.summary> = {
      account: {
        payment_status: account.paymentStatus,
        has_payment_method: account.hasPaymentMethod,
        unbilled_micro_usd: account.unbilledMicroUsd,
        granted_remaining_micro_usd: account.grantedRemainingMicroUsd,
        spend_limit_micro_usd: limit,
        daily_cap_micro_usd: null,
        invoice_threshold_micro_usd: deps.config.USAGE_INVOICE_THRESHOLD_MICRO_USD,
      },
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
        usage_micro_usd: BigInt(usage?.sum ?? "0"),
      },
      grants: [],
      invoices: [],
      mode: port ? port.mode : deps.config.BILLING_MODE,
    };
    return c.json(encodeRouteResponse(contract.summary, result) as object, 200);
  });

  r.post("/link-card", async (c) => {
    const port = deps.stripeBilling;
    if (!port) return unavailable(c);
    const raw = await readJson(c);
    if (!raw.ok) return fail(c, "validation_failed", "body must be JSON");
    const parsed = parseRouteRequest(contract.linkCard, { body: raw.body });
    if (!parsed.ok) {
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);
    }
    const actor = c.get("actor");
    const customerId = await ensureStripeCustomer(deps.db, port, actor.userId);
    const { url } = await port.linkCardCheckout({
      customerId,
      userId: actor.userId,
      successUrl: onWeb(deps.config, parsed.request.body.success_path),
      cancelUrl: onWeb(deps.config, parsed.request.body.cancel_path),
    });
    return c.json(encodeRouteResponse(contract.linkCard, { url }) as object, 200);
  });

  r.post("/portal", async (c) => {
    const port = deps.stripeBilling;
    if (!port) return unavailable(c);
    const raw = await readJson(c);
    if (!raw.ok) return fail(c, "validation_failed", "body must be JSON");
    const parsed = parseRouteRequest(contract.portal, { body: raw.body });
    if (!parsed.ok) {
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);
    }
    const actor = c.get("actor");
    const account = await loadBillingAccount(deps.db, actor.userId);
    if (!account.stripeCustomerId) return fail(c, "conflict", "add a card first");
    const { url } = await port.portal({
      customerId: account.stripeCustomerId,
      returnUrl: onWeb(deps.config, parsed.request.body.return_path),
    });
    return c.json(encodeRouteResponse(contract.portal, { url }) as object, 200);
  });

  return r;
}

/** POST /webhooks/stripe. Mounted at /webhooks. */
export function stripeWebhookRoutes(deps: BillingRouteDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post("/stripe", async (c) => {
    const port = deps.stripeBilling;
    if (!port) return fail(c, "unavailable", "billing is not configured on this deployment");
    const signature = c.req.header("stripe-signature");
    if (!signature) return fail(c, "bad_request", "missing stripe-signature header");
    const rawBody = await c.req.text();
    let event;
    try {
      event = port.verifyWebhook(rawBody, signature);
    } catch (err) {
      if (err instanceof StripeWebhookError) {
        c.get("log").warn({ reason: err.message }, "stripe webhook refused");
        return fail(c, "bad_request", "invalid Stripe signature");
      }
      throw err;
    }
    const out = await processStripeEvent(deps.db, port, event);
    c.get("log").info(
      { stripeEvent: event.id, type: event.type, duplicate: out.duplicate, userId: out.userId },
      "stripe webhook",
    );
    return c.json(
      encodeRouteResponse(contract.stripeWebhook, {
        received: true,
        duplicate: out.duplicate,
      }) as object,
      200,
    );
  });
  return r;
}
