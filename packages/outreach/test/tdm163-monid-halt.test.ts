// TDM-163 review fix: a Monid run whose charge we never saw is booked at maxCost and halts the client.
import { describe, expect, it } from "vitest";
import { createMonidClient, MonidError } from "../src/index.js";
import { routerFetch } from "./tdm163-router-fetch.js";

const running = {
  runId: "01RUNNING00000000000000001",
  provider: "hunterio",
  endpoint: "/email-finder",
  status: "RUNNING",
};
const req = { provider: "hunterio", endpoint: "/email-finder", maxCostMicroUsd: 24_500n } as const;

describe("Monid unknown charges", () => {
  it("POLL_TIMEOUT books maxCost, halts, and refuses the next run without calling", async () => {
    const { fetchFn, calls } = routerFetch([
      [/POST api\.monid\.ai\/v1\/run$/, () => ({ status: 202, body: running })],
      [/GET api\.monid\.ai\/v1\/runs\//, () => ({ status: 200, body: running })],
    ]);
    let t = 0;
    const realNow = Date.now;
    Date.now = () => t;
    try {
      const m = createMonidClient({
        apiKey: "k",
        fetch: fetchFn,
        pollIntervalMs: 1,
        pollTimeoutMs: 5,
        sleep: async () => void (t += 10),
      });
      const err = await m.run(req).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MonidError);
      expect(err).toMatchObject({ code: "POLL_TIMEOUT", chargeUnknown: true });
      expect(m.spentMicroUsd()).toBe(24_500n);
      expect(m.halted()).toMatch(/POLL_TIMEOUT/);
      const n = calls.length;
      await expect(m.run({ ...req, maxCostMicroUsd: 0n })).rejects.toMatchObject({
        code: "HALTED",
      });
      expect(calls).toHaveLength(n);
    } finally {
      Date.now = realNow;
    }
  });

  it("a transport error or a 5xx without a run body is unknown; a documented 4xx is not", async () => {
    const transport = createMonidClient({
      apiKey: "k",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(transport.run(req)).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      chargeUnknown: true,
    });
    expect(transport.spentMicroUsd()).toBe(24_500n);

    const gateway = routerFetch([[/v1\/run$/, () => ({ status: 502, body: "<html>bad gateway" })]]);
    const g = createMonidClient({ apiKey: "k", fetch: gateway.fetchFn });
    await expect(g.run(req)).rejects.toMatchObject({ chargeUnknown: true });
    expect(g.spentMicroUsd()).toBe(24_500n);
    expect(g.halted()).toBeDefined();

    const capped = routerFetch([
      [
        /v1\/run$/,
        () => ({
          status: 400,
          body: { code: 400, errorCode: "MAX_COST_EXCEEDED", message: "too low" },
        }),
      ],
    ]);
    const c = createMonidClient({ apiKey: "k", fetch: capped.fetchFn });
    await expect(c.run(req)).rejects.toMatchObject({
      code: "MAX_COST_EXCEEDED",
      chargeUnknown: false,
    });
    expect(c.spentMicroUsd()).toBe(0n);
    expect(c.halted()).toBeUndefined();
  });

  it("haltOnUnknownCharge: false still books maxCost but keeps running", async () => {
    let n = 0;
    const { fetchFn } = routerFetch([
      [
        /v1\/run$/,
        () => {
          if (n++ === 0) throw new TypeError("fetch failed");
          return {
            status: 200,
            body: {
              ...running,
              status: "COMPLETED",
              output: { email: null },
              providerResponse: { httpStatus: 200 },
              billing: { reportedCost: { currency: "USD", value: 0, unit: "MICRO_DOLLAR" } },
            },
          };
        },
      ],
    ]);
    const m = createMonidClient({ apiKey: "k", fetch: fetchFn, haltOnUnknownCharge: false });
    await expect(m.run(req)).rejects.toMatchObject({ chargeUnknown: true });
    expect((await m.run(req)).status).toBe("COMPLETED");
    expect(m.spentMicroUsd()).toBe(24_500n);
  });
});
