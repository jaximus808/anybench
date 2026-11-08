// stripe-onboarding: the StripeBillingPort over the real SDK, pointed at a local fake Stripe (no
// network, no key, no money), plus the pure helpers (cents carry, subscription status mapping).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBillingStripe,
  createStripeBillingPort,
  meterCents,
  paymentStatusForSubscription,
  resolveStripeConfig,
  StripeWebhookError,
  type StripeBillingPort,
} from "../src/index.js";

const fakeKey = `sk_test_${"Zz9Yy8Xx7W".repeat(3)}`;
const WEBHOOK_SECRET = `whsec_${"onboarding".repeat(3)}`;

interface Call {
  method: string;
  path: string;
  form: URLSearchParams;
  idempotencyKey: string | undefined;
}

let server: Server;
let port: StripeBillingPort;
const calls: Call[] = [];
const meterIdentifiers = new Set<string>();
let subscriptions: Record<string, unknown>[] = [];
let paymentMethods: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const url = new URL(req.url ?? "/", "http://fake");
      const form = new URLSearchParams(req.method === "POST" ? raw : url.search);
      calls.push({
        method: req.method ?? "GET",
        path: url.pathname,
        form,
        idempotencyKey: req.headers["idempotency-key"] as string | undefined,
      });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "request-id": "req_fake" });
        res.end(JSON.stringify(body));
      };
      const list = (data: unknown[]) => ({
        object: "list",
        data,
        has_more: false,
        url: url.pathname,
      });
      if (url.pathname === "/v1/customers" && req.method === "POST") {
        return send(200, { id: "cus_fake1", object: "customer", livemode: false });
      }
      if (url.pathname === "/v1/checkout/sessions" && req.method === "POST") {
        return send(200, {
          id: "cs_test_fake1",
          object: "checkout.session",
          livemode: false,
          url: "https://checkout.stripe.com/c/pay/cs_test_fake1",
        });
      }
      if (url.pathname === "/v1/billing_portal/sessions" && req.method === "POST") {
        return send(200, {
          id: "bps_fake",
          object: "billing_portal.session",
          livemode: false,
          url: "https://billing.stripe.com/p/session/fake",
        });
      }
      if (url.pathname === "/v1/subscriptions" && req.method === "GET") {
        return send(200, list(subscriptions));
      }
      if (/^\/v1\/customers\/[^/]+\/payment_methods$/.test(url.pathname)) {
        return send(200, list(paymentMethods));
      }
      if (url.pathname === "/v1/billing/meter_events" && req.method === "POST") {
        const id = form.get("identifier") ?? "";
        if (meterIdentifiers.has(id)) {
          return send(400, {
            error: {
              type: "invalid_request_error",
              message: `An event already exists with identifier ${id}.`,
            },
          });
        }
        meterIdentifiers.add(id);
        return send(200, { object: "billing.meter_event", identifier: id, livemode: false });
      }
      send(404, { error: { type: "invalid_request_error", message: `fake: ${url.pathname}` } });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: p } = server.address() as AddressInfo;
  const client = createBillingStripe(
    resolveStripeConfig({
      STRIPE_SECRET_KEY: fakeKey,
      STRIPE_PRICE_USAGE: "price_usage_fake",
      STRIPE_METER_ID: "mtr_fake",
    }),
    { host: "127.0.0.1", port: p, protocol: "http", maxNetworkRetries: 0 },
  );
  port = createStripeBillingPort(client, { webhookSecret: WEBHOOK_SECRET });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const last = (path: string) => [...calls].reverse().find((c) => c.path === path)!;

describe("StripeBillingPort (stripe-onboarding)", () => {
  it("creates one Customer per user (idempotency key) and a subscription-mode Checkout with the usage price", async () => {
    const customerId = await port.ensureCustomer({
      userId: "u-1",
      email: "a@example.com",
      name: "alice",
    });
    expect(customerId).toBe("cus_fake1");
    const cust = last("/v1/customers");
    expect(cust.idempotencyKey).toBe("anybench-customer-u-1");
    expect(cust.form.get("metadata[user_id]")).toBe("u-1");

    const s = await port.linkCardCheckout({
      customerId,
      userId: "u-1",
      successUrl: "https://web.test/billing?linked=1",
      cancelUrl: "https://web.test/billing",
    });
    expect(s.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const co = last("/v1/checkout/sessions");
    expect(co.form.get("mode")).toBe("subscription");
    expect(co.form.get("customer")).toBe("cus_fake1");
    expect(co.form.get("client_reference_id")).toBe("u-1");
    expect(co.form.get("line_items[0][price]")).toBe("price_usage_fake");
    expect(co.form.has("line_items[0][quantity]")).toBe(false);
    expect(co.form.get("subscription_data[metadata][user_id]")).toBe("u-1");
    expect(co.form.get("success_url")).toBe("https://web.test/billing?linked=1");
  });

  it("accountState: an active subscription with its card is ok; none is none; past_due maps", async () => {
    subscriptions = [];
    paymentMethods = [];
    expect(await port.accountState("cus_fake1")).toEqual({
      subscriptionId: null,
      paymentStatus: "none",
      hasPaymentMethod: false,
    });
    subscriptions = [
      { id: "sub_old", object: "subscription", status: "canceled", livemode: false },
      {
        id: "sub_1",
        object: "subscription",
        status: "active",
        default_payment_method: "pm_1",
        livemode: false,
      },
    ];
    expect(await port.accountState("cus_fake1")).toEqual({
      subscriptionId: "sub_1",
      paymentStatus: "ok",
      hasPaymentMethod: true,
    });
    subscriptions = [{ id: "sub_1", object: "subscription", status: "past_due", livemode: false }];
    paymentMethods = [{ id: "pm_1", object: "payment_method", type: "card" }];
    expect(await port.accountState("cus_fake1")).toEqual({
      subscriptionId: "sub_1",
      paymentStatus: "past_due",
      hasPaymentMethod: true,
    });
  });

  it("refuses a live object in test mode", async () => {
    subscriptions = [{ id: "sub_live", object: "subscription", status: "active", livemode: true }];
    await expect(port.accountState("cus_fake1")).rejects.toThrow(/livemode=true/);
    subscriptions = [];
  });

  it("reportUsage sends cents as a string with identifier = entry id; a resend is a duplicate", async () => {
    expect(
      await port.reportUsage({ identifier: "ue-1", customerId: "cus_fake1", cents: 200n }),
    ).toBe("sent");
    const ev = last("/v1/billing/meter_events");
    expect(ev.form.get("event_name")).toBe("anybench_usage");
    expect(ev.form.get("identifier")).toBe("ue-1");
    expect(ev.form.get("payload[stripe_customer_id]")).toBe("cus_fake1");
    expect(ev.form.get("payload[value]")).toBe("200");
    expect(
      await port.reportUsage({ identifier: "ue-1", customerId: "cus_fake1", cents: 200n }),
    ).toBe("duplicate");
    await expect(
      port.reportUsage({ identifier: "ue-2", customerId: "cus_fake1", cents: 0n }),
    ).rejects.toThrow(/positive/);
  });

  it("verifyWebhook accepts a correctly signed test event and refuses a bad signature or a live event", () => {
    const sdk = new Stripe(fakeKey);
    const event = {
      id: "evt_1",
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: 1,
      data: {
        object: {
          id: "cs_1",
          object: "checkout.session",
          customer: "cus_fake1",
          client_reference_id: "u-1",
        },
      },
    };
    const payload = JSON.stringify(event);
    const header = sdk.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const ev = port.verifyWebhook(payload, header);
    expect(ev).toMatchObject({
      id: "evt_1",
      type: "checkout.session.completed",
      customerId: "cus_fake1",
      userIdHint: "u-1",
    });
    const bad = sdk.webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong" });
    expect(() => port.verifyWebhook(payload, bad)).toThrow(StripeWebhookError);
    const livePayload = JSON.stringify({ ...event, livemode: true });
    const liveHeader = sdk.webhooks.generateTestHeaderString({
      payload: livePayload,
      secret: WEBHOOK_SECRET,
    });
    expect(() => port.verifyWebhook(livePayload, liveHeader)).toThrow(/livemode=true/);
  });
});

describe("pure helpers (stripe-onboarding)", () => {
  it("meterCents carries fractional cents so the sum equals floor(total / 10_000)", () => {
    const amounts = [2_000_000n, 1_234_567n, 2_000_005n, 2_265_428n]; // the TDM-21 spike's $7.50
    let reported = 0n;
    const cents = amounts.map((a) => {
      const c = meterCents(reported, a);
      reported += a;
      return c;
    });
    expect(cents).toEqual([200n, 123n, 200n, 227n]);
    expect(cents.reduce((x, y) => x + y, 0n)).toBe(750n);
    expect(meterCents(0n, 9_999n)).toBe(0n);
    expect(meterCents(9_999n, 1n)).toBe(1n);
  });

  it("maps subscription statuses to payment_status", () => {
    expect(paymentStatusForSubscription("active")).toBe("ok");
    expect(paymentStatusForSubscription("trialing")).toBe("ok");
    expect(paymentStatusForSubscription("past_due")).toBe("past_due");
    expect(paymentStatusForSubscription("unpaid")).toBe("past_due");
    expect(paymentStatusForSubscription("canceled")).toBe("none");
    expect(paymentStatusForSubscription(undefined)).toBe("none");
  });
});
