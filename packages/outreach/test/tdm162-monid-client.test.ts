import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MonidError, createMonidClient, createMonidClientFromEnv } from "../src/monid.js";
import { scriptedFetch } from "./tdm162-fake-fetch.js";
import * as fx from "./tdm162-fixtures.js";

const KEY = "monid_live_test_not_a_real_key";

function client(responses: { status: number; body: unknown }[], extra = {}) {
  const f = scriptedFetch(responses);
  const c = createMonidClient({
    apiKey: KEY,
    fetch: f.fetchFn,
    sleep: async () => {},
    pollIntervalMs: 1,
    ...extra,
  });
  return { c, calls: f.calls };
}

describe("MonidClient", () => {
  it("inspect returns the live price as micro-USD", async () => {
    const { c, calls } = client([{ status: 200, body: fx.inspectSend }]);
    const info = await c.inspect("agentmail", "/send-messages");
    expect(info.price.amount).toBe(1_000n);
    expect(calls[0]!.url).toBe("https://api.monid.ai/v1/inspect");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toEqual({ provider: "agentmail", endpoint: "/send-messages" });
  });

  it("run always sends maxCost as Monid's USD number and reports settled cost in micro-USD", async () => {
    const { c, calls } = client([{ status: 200, body: fx.createInboxRun }]);
    const run = await c.run({
      provider: "agentmail",
      endpoint: "/create-inboxes",
      input: { body: { username: "x" } },
      maxCostMicroUsd: 1_000_000n,
    });
    expect(calls[0]!.body).toEqual({
      provider: "agentmail",
      endpoint: "/create-inboxes",
      input: { body: { username: "x" } },
      maxCost: 1,
    });
    expect(run.costMicroUsd).toBe(1_000_000n);
    expect(c.spentMicroUsd()).toBe(1_000_000n);
  });

  it("refuses a run without a bigint maxCost", async () => {
    const { c, calls } = client([]);
    await expect(
      // @ts-expect-error maxCostMicroUsd is required
      c.run({ provider: "agentmail", endpoint: "/list-inboxes" }),
    ).rejects.toThrow(TypeError);
    await expect(
      c.run({
        provider: "agentmail",
        endpoint: "/list-inboxes",
        // @ts-expect-error a float is not micro-USD
        maxCostMicroUsd: 0.5,
      }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("maps MAX_COST_EXCEEDED", async () => {
    const { c } = client([{ status: 400, body: fx.maxCostExceeded }]);
    const err = await c
      .run({ provider: "agentmail", endpoint: "/create-inboxes", maxCostMicroUsd: 500_000n })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MonidError);
    expect((err as MonidError).code).toBe("MAX_COST_EXCEEDED");
    expect((err as MonidError).requestId).toBe("req-test");
  });

  it("maps 402 to WALLET_INSUFFICIENT_FUNDS and BLOCKED runs to BLOCKED", async () => {
    const a = client([{ status: 402, body: { code: 402, message: "low balance" } }]);
    await expect(
      a.c.run({ provider: "p", endpoint: "/e", maxCostMicroUsd: 1n }),
    ).rejects.toMatchObject({ code: "WALLET_INSUFFICIENT_FUNDS" });
    const b = client([{ status: 200, body: fx.blockedRun }]);
    await expect(
      b.c.run({ provider: "agentmail", endpoint: "/send-messages", maxCostMicroUsd: 1_000n }),
    ).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("surfaces a provider error with the run attached, not as a schema failure", async () => {
    const providerFail = {
      ...fx.createInboxRun,
      output: null,
      providerResponse: { httpStatus: 409, error: { name: "AlreadyExists" } },
      billing: { reportedCost: { currency: "USD", value: 0, unit: "MICRO_DOLLAR" } },
    };
    const { c } = client([{ status: 409, body: providerFail }]);
    const err = (await c
      .run(
        { provider: "agentmail", endpoint: "/create-inboxes", maxCostMicroUsd: 1_000_000n },
        z.object({ inbox_id: z.string() }),
      )
      .catch((e: unknown) => e)) as MonidError;
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(err.status).toBe(409);
    expect(err.run?.runId).toBe(fx.createInboxRun.runId);
  });

  it("polls an async (202) run until it is terminal", async () => {
    const accepted = {
      runId: "01ASYNC",
      provider: "x",
      endpoint: "/slow",
      status: "RUNNING",
      price: { type: "PER_CALL", amount: { value: 0.01, currency: "USD" } },
      createdAt: "2026-11-08T00:00:00Z",
    };
    const done = {
      ...accepted,
      status: "COMPLETED",
      output: { ok: true },
      providerResponse: { httpStatus: 200 },
      cost: { value: 0.01, currency: "USD" },
    };
    const { c, calls } = client([
      { status: 202, body: accepted },
      { status: 200, body: accepted },
      { status: 200, body: done },
    ]);
    const run = await c.run(
      { provider: "x", endpoint: "/slow", maxCostMicroUsd: 10_000n },
      z.object({ ok: z.boolean() }),
    );
    expect(run.output.ok).toBe(true);
    expect(run.costMicroUsd).toBe(10_000n);
    expect(calls.map((x) => x.url)).toEqual([
      "https://api.monid.ai/v1/run",
      "https://api.monid.ai/v1/runs/01ASYNC",
      "https://api.monid.ai/v1/runs/01ASYNC",
    ]);
  });

  it("enforces the spend cap before calling Monid", async () => {
    const { c, calls } = client([{ status: 200, body: fx.createInboxRun }], {
      spendCapMicroUsd: 1_500_000n,
    });
    await c.run({
      provider: "agentmail",
      endpoint: "/create-inboxes",
      maxCostMicroUsd: 1_000_000n,
    });
    await expect(
      c.run({ provider: "agentmail", endpoint: "/create-inboxes", maxCostMicroUsd: 1_000_000n }),
    ).rejects.toMatchObject({ code: "SPEND_CAP" });
    expect(calls).toHaveLength(1);
  });

  it("balance rounds down and held rounds up", async () => {
    const { c } = client([{ status: 200, body: fx.balance }]);
    expect(await c.balance()).toEqual({ balanceMicroUsd: 18_898_000n, heldMicroUsd: 100_000n });
  });

  it("from env: strips quotes and whitespace from MONID_API_KEY; empty key is refused", () => {
    expect(() => createMonidClientFromEnv({ MONID_API_KEY: "" })).toThrow();
    expect(() => createMonidClientFromEnv({ MONID_API_KEY: ' "monid_live_x" ' })).not.toThrow();
  });
});
