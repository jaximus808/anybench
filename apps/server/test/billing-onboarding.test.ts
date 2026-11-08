// stripe-onboarding: sign up -> add a card (Checkout) -> webhook records it -> Go passes the gate,
// against local Postgres with a fake StripeBillingPort (no network, no key, no money). Plus the
// meter reporter (cents carry, comped runs never sent) and the gate's pure decision.
import {
  StripeWebhookError,
  type StripeBillingPort,
  type StripeWebhookEvent,
} from "@anybench/billing";
import { PaymentRequiredSchema } from "@anybench/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import {
  billingAccounts,
  interventions,
  runs,
  stripeEvents,
  usageEntries,
} from "../src/db/schema/index.js";
import { accountGateDecision } from "../src/lib/billing-gate.js";
import { reportUsageToStripe, stripeBillingFromConfig } from "../src/lib/stripe-billing.js";
import type { AppDeps } from "../src/types.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import {
  forceRunStateTdm67,
  recordingJobsTdm67,
  seedKitTdm67,
  seedUserTdm67,
} from "./helpers/runs-tdm67.js";
import { recordingSentryTdm14, silentLoggerTdm14 } from "./helpers/server-tdm14.js";

const available = await pgAvailableTdm11();
const BASE = "http://api.test";
const WEB = "https://anybench.jaxonp.com";

/** An in-memory Stripe: customers, a Checkout that "completes" when the test says so, the meter. */
function fakeStripeOnboarding() {
  const state = {
    customers: [] as { id: string; userId: string; email: string | null }[],
    checkouts: [] as { customerId: string; successUrl: string; cancelUrl: string }[],
    /** customer id -> card saved by a completed Checkout */
    linked: new Map<string, "ok" | "past_due">(),
    meter: [] as { identifier: string; customerId: string; cents: bigint }[],
    failMeterFor: null as string | null,
  };
  const port: StripeBillingPort = {
    mode: "test",
    async ensureCustomer({ userId, email }) {
      const found = state.customers.find((c) => c.userId === userId);
      if (found) return found.id;
      const id = `cus_fake_${state.customers.length + 1}`;
      state.customers.push({ id, userId, email });
      return id;
    },
    async linkCardCheckout({ customerId, successUrl, cancelUrl }) {
      state.checkouts.push({ customerId, successUrl, cancelUrl });
      return {
        url: `https://checkout.stripe.com/c/pay/cs_test_${state.checkouts.length}`,
        sessionId: "cs",
      };
    },
    async portal() {
      return { url: "https://billing.stripe.com/p/session/fake" };
    },
    async accountState(customerId) {
      const s = state.linked.get(customerId);
      return s
        ? { subscriptionId: `sub_${customerId}`, paymentStatus: s, hasPaymentMethod: true }
        : { subscriptionId: null, paymentStatus: "none", hasPaymentMethod: false };
    },
    verifyWebhook(rawBody, signature) {
      if (signature !== "t=1,v1=good") throw new StripeWebhookError("bad signature");
      const e = JSON.parse(rawBody) as { id: string; type: string; customer: string };
      const ev: StripeWebhookEvent = {
        id: e.id,
        type: e.type,
        livemode: false,
        customerId: e.customer,
        userIdHint: null,
        amountPaidCents: null,
        payload: e,
      };
      return ev;
    },
    async reportUsage({ identifier, customerId, cents }) {
      if (state.failMeterFor === identifier) throw new Error("stripe down");
      if (state.meter.some((m) => m.identifier === identifier)) return "duplicate";
      state.meter.push({ identifier, customerId, cents });
      return "sent";
    },
  };
  return { state, port };
}

function appWith(url: string, port: StripeBillingPort | null, env: Record<string, string> = {}) {
  const config = loadConfig({
    DATABASE_URL: url,
    DATABASE_URL_DIRECT: url,
    LOG_LEVEL: "silent",
    PUBLIC_WEB_URL: WEB,
    ALLOWED_ORIGINS: WEB,
    ...env,
  });
  const dbh = createDb(url, { max: 4 });
  const deps: AppDeps = {
    config,
    logger: silentLoggerTdm14(),
    db: dbh.db,
    sentry: recordingSentryTdm14(),
    authenticate: async (req) => {
      const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
      return m ? { kind: "user", userId: m[1]! } : null;
    },
    jobs: recordingJobsTdm67(),
    stripeBilling: port,
  };
  return { app: createApp(deps), dbh };
}

describe("accountGateDecision (stripe-onboarding)", () => {
  const base = {
    paymentStatus: "ok" as const,
    hasPaymentMethod: true,
    unbilledMicroUsd: 0n,
    grantedRemainingMicroUsd: 0n,
    spendLimitMicroUsd: null,
    firstPaidInvoiceAt: null,
  };
  it("allows a card on file under the new-account limit, refuses everything else with its reason", () => {
    expect(accountGateDecision(undefined, 1n)).toBe("no_payment_method");
    expect(accountGateDecision(base, 2_000_000n)).toBeNull();
    expect(accountGateDecision({ ...base, hasPaymentMethod: false }, 1n)).toBe("no_payment_method");
    expect(accountGateDecision({ ...base, paymentStatus: "none" }, 1n)).toBe("no_payment_method");
    expect(accountGateDecision({ ...base, paymentStatus: "past_due" }, 1n)).toBe(
      "payment_past_due",
    );
    expect(accountGateDecision({ ...base, paymentStatus: "blocked" }, 1n)).toBe("account_blocked");
    // $99 unbilled + a $2 run > $100 limit; fine once an invoice was paid; per-account override.
    const heavy = { ...base, unbilledMicroUsd: 99_000_000n };
    expect(accountGateDecision(heavy, 2_000_000n, 100_000_000n)).toBe("spend_limit");
    expect(
      accountGateDecision({ ...heavy, firstPaidInvoiceAt: new Date() }, 2_000_000n),
    ).toBeNull();
    expect(
      accountGateDecision({ ...heavy, spendLimitMicroUsd: 200_000_000n }, 2_000_000n),
    ).toBeNull();
    // Credit grants alone may cover a run when no card is on file.
    const credit = { ...base, paymentStatus: "none" as const, hasPaymentMethod: false };
    expect(
      accountGateDecision({ ...credit, grantedRemainingMicroUsd: 5_000_000n }, 2_000_000n),
    ).toBeNull();
    expect(
      accountGateDecision({ ...credit, grantedRemainingMicroUsd: 1_000_000n }, 2_000_000n),
    ).toBe("insufficient_credit");
  });

  it("stripeBillingFromConfig: off and no key give null; test and live each use their own set", () => {
    const testKey = `sk_test_${"Qq1Ww2Ee3R".repeat(3)}`;
    const liveKey = `sk_live_${"Qq1Ww2Ee3R".repeat(3)}`;
    const cfg = (env: Record<string, string>) => loadConfig({ LOG_LEVEL: "silent", ...env });
    expect(stripeBillingFromConfig(cfg({ BILLING_MODE: "off" }))).toBeNull();
    expect(stripeBillingFromConfig(cfg({ BILLING_MODE: "test" }))).toBeNull();
    expect(stripeBillingFromConfig(cfg({ BILLING_MODE: "live" }))).toBeNull();
    // A test key never serves live mode, even when it is the only key present.
    expect(
      stripeBillingFromConfig(cfg({ BILLING_MODE: "live", STRIPE_TEST_SECRET_KEY: testKey })),
    ).toBeNull();
    const port = stripeBillingFromConfig(
      cfg({ BILLING_MODE: "test", STRIPE_TEST_SECRET_KEY: testKey }),
    );
    expect(port?.mode).toBe("test");
    const live = stripeBillingFromConfig(
      cfg({ BILLING_MODE: "live", STRIPE_LIVE_SECRET_KEY: liveKey }),
    );
    expect(live?.mode).toBe("live");
    const liveGeneric = stripeBillingFromConfig(
      cfg({ BILLING_MODE: "live", STRIPE_SECRET_KEY: liveKey }),
    );
    expect(liveGeneric?.mode).toBe("live");
  });
});

describe.skipIf(!available)("link a card, then Go (stripe-onboarding)", () => {
  let db: FreshDbTdm11;
  let h: { app: ReturnType<typeof createApp>; dbh: DbHandle };
  let fake: ReturnType<typeof fakeStripeOnboarding>;
  let carol: string;

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    fake = fakeStripeOnboarding();
    h = appWith(db.url, fake.port);
    carol = await seedUserTdm67(db.db, "carol");
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  const req = (method: string, path: string, user: string | null, body?: unknown, headers = {}) =>
    h.app.request(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(user ? { authorization: `Bearer ${user}` } : {}),
        ...headers,
      },
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    });

  async function waitingRun(owner: string): Promise<string> {
    const res = await req("POST", "/runs", owner, {
      question: "Is ripgrep faster than grep on large trees?",
      source: { kind: "github", github: "BurntSushi/ripgrep", ref: "14.1.1" },
      budget_micro_usd: "5000000",
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { run } = (await res.json()) as { run: { id: string } };
    await forceRunStateTdm67(db.db, run.id, "awaiting_go", 2_000_000n);
    await seedKitTdm67(db.db, run.id, true);
    return run.id;
  }

  it("the whole path: 402 -> Checkout -> webhook -> summary shows the card -> Go starts the run", async () => {
    const runId = await waitingRun(carol);

    // 1. No card: Go answers the 402 with the add-card link for this run.
    const refused = await req("POST", `/runs/${runId}/go`, carol);
    expect(refused.status).toBe(402);
    expect(PaymentRequiredSchema.parse(await refused.json())).toEqual({
      reason: "no_payment_method",
      link_card_url: `${WEB}/settings/billing?run=${runId}`,
    });

    // 2. The billing page: no card yet, test mode.
    const before = await req("GET", "/billing/summary", carol);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      mode: "test",
      account: {
        payment_status: "none",
        has_payment_method: false,
        spend_limit_micro_usd: "100000000",
      },
    });

    // 3. Add a card: a Customer is created once and Checkout returns to the web origin.
    const link = await req("POST", "/billing/link-card", carol, {
      success_path: `/billing?linked=1&run=${runId}`,
      cancel_path: `/billing?run=${runId}`,
    });
    expect(link.status, await link.clone().text()).toBe(200);
    expect(((await link.json()) as { url: string }).url).toMatch(
      /^https:\/\/checkout\.stripe\.com/,
    );
    expect(fake.state.checkouts.at(-1)).toEqual({
      customerId: "cus_fake_1",
      successUrl: `${WEB}/billing?linked=1&run=${runId}`,
      cancelUrl: `${WEB}/billing?run=${runId}`,
    });
    const again = await req("POST", "/billing/link-card", carol, {});
    expect(again.status).toBe(200);
    expect(fake.state.customers).toHaveLength(1);
    const [acct] = await db.db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.userId, carol));
    expect(acct!.stripeCustomerId).toBe("cus_fake_1");
    // An absolute return URL is refused by the contract.
    expect(
      (await req("POST", "/billing/link-card", carol, { success_path: "https://evil.test/" }))
        .status,
    ).toBe(400);

    // 4. The user pays nothing in Checkout; Stripe sends the webhook. Bad signature first.
    fake.state.linked.set("cus_fake_1", "ok");
    const evt = JSON.stringify({
      id: "evt_onb_1",
      type: "checkout.session.completed",
      customer: "cus_fake_1",
    });
    const forged = await req("POST", "/webhooks/stripe", null, evt, {
      "stripe-signature": "t=1,v1=bad",
    });
    expect(forged.status).toBe(400);
    expect((await req("POST", "/webhooks/stripe", null, evt)).status).toBe(400);
    const hook = await req("POST", "/webhooks/stripe", null, evt, {
      "stripe-signature": "t=1,v1=good",
    });
    expect(hook.status).toBe(200);
    expect(await hook.json()).toEqual({ received: true, duplicate: false });
    const redelivered = await req("POST", "/webhooks/stripe", null, evt, {
      "stripe-signature": "t=1,v1=good",
    });
    expect(await redelivered.json()).toEqual({ received: true, duplicate: true });
    const [row] = await db.db.select().from(stripeEvents).where(eq(stripeEvents.id, "evt_onb_1"));
    expect(row!.processedAt).not.toBeNull();
    const [linked] = await db.db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.userId, carol));
    expect(linked).toMatchObject({
      paymentStatus: "ok",
      hasPaymentMethod: true,
      subscriptionId: "sub_cus_fake_1",
    });

    // 5. Go now passes the gate; nothing was comped (carol is not an admin).
    const went = await req("POST", `/runs/${runId}/go`, carol);
    expect(went.status, await went.clone().text()).toBe(200);
    const [run] = await db.db.select().from(runs).where(eq(runs.id, runId));
    expect(run).toMatchObject({ state: "running", compedBy: null });
  });

  it("the summary syncs from Stripe when the webhook is late", async () => {
    const dave = await seedUserTdm67(db.db, "dave");
    expect((await req("POST", "/billing/link-card", dave, {})).status).toBe(200);
    const customer = fake.state.customers.find((c) => c.userId === dave)!.id;
    fake.state.linked.set(customer, "ok");
    const s = await req("GET", "/billing/summary", dave);
    expect(await s.json()).toMatchObject({
      account: { payment_status: "ok", has_payment_method: true },
    });
  });

  it("a failed payment blocks the next Go with payment_past_due", async () => {
    const erin = await seedUserTdm67(db.db, "erin");
    await req("POST", "/billing/link-card", erin, {});
    const customer = fake.state.customers.find((c) => c.userId === erin)!.id;
    fake.state.linked.set(customer, "past_due");
    const evt = JSON.stringify({ id: "evt_onb_pf", type: "invoice.payment_failed", customer });
    expect(
      (await req("POST", "/webhooks/stripe", null, evt, { "stripe-signature": "t=1,v1=good" }))
        .status,
    ).toBe(200);
    const runId = await waitingRun(erin);
    const refused = await req("POST", `/runs/${runId}/go`, erin);
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { reason: string }).reason).toBe("payment_past_due");
  });

  it("billing routes need a session and answer 503 without Stripe", async () => {
    expect((await req("GET", "/billing/summary", null)).status).toBe(401);
    const off = appWith(db.url, null);
    try {
      const res = await off.app.request(`${BASE}/billing/link-card`, {
        method: "POST",
        headers: { authorization: `Bearer ${carol}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(503);
    } finally {
      await off.dbh.close();
    }
  });

  it("the meter reporter sends billable usage in carried cents, never comped usage, once", async () => {
    const frank = await seedUserTdm67(db.db, "frank");
    await req("POST", "/billing/link-card", frank, {});
    const customer = fake.state.customers.find((c) => c.userId === frank)!.id;
    const runId = await waitingRun(frank);
    const compedRun = await waitingRun(frank);
    const ledgerEntry = (
      amount: bigint,
      key: string,
      extra: Partial<typeof usageEntries.$inferInsert> = {},
    ) =>
      db.db
        .insert(usageEntries)
        .values({
          userId: frank,
          runId,
          type: "compute",
          amountMicroUsd: amount,
          idempotencyKey: key,
          ...extra,
        })
        .returning({ id: usageEntries.id });
    // The ledger normally writes these from a terminal run; ids are UUIDv7 like the ledger's.
    const { newId, UsageEntryIdSchema } = await import("@anybench/core");
    const [fee] = await ledgerEntry(2_000_000n, `run:${runId}:fee`, {
      id: newId(UsageEntryIdSchema),
      type: "run_fee",
    });
    const [c1] = await ledgerEntry(1_234_567n, "computer:a:compute", {
      id: newId(UsageEntryIdSchema),
    });
    const [c2] = await ledgerEntry(2_000_005n, "computer:b:compute", {
      id: newId(UsageEntryIdSchema),
    });
    // A comped (founder demo) run's usage: recorded with its intervention, never sent.
    const [iv] = await db.db
      .insert(interventions)
      .values({
        runId: compedRun,
        userId: frank,
        who: "founder",
        what: "comp",
        why: "founder demo",
      })
      .returning({ id: interventions.id });
    await ledgerEntry(9_000_000n, `run:${compedRun}:fee`, {
      id: newId(UsageEntryIdSchema),
      runId: compedRun,
      type: "run_fee",
      compedBy: "founder",
      interventionId: iv!.id,
    });

    const first = await reportUsageToStripe(db.db, fake.port);
    expect(first).toMatchObject({ sent: 3, failed: 0 });
    const mine = fake.state.meter.filter((m) => m.customerId === customer);
    expect(mine.map((m) => [m.identifier, m.cents])).toEqual([
      [fee!.id, 200n],
      [c1!.id, 123n],
      [c2!.id, 200n],
    ]);
    const rows = await db.db.select().from(usageEntries).where(eq(usageEntries.userId, frank));
    for (const r of rows) {
      if (r.compedBy) expect(r.reportedAt).toBeNull();
      else expect(r.stripeMeterEventId).toBe(r.id);
    }
    const second = await reportUsageToStripe(db.db, fake.port);
    expect(second.sent + second.duplicate).toBe(0);
  });
});
