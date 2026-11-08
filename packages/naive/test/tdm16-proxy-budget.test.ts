// TDM-16 review fixes: the trial key's secret never serialises, per-key spend is summed as bigint,
// and enforceTrialProxyBudget revokes the key at the cap. Offline: fakes plus a mocked fetch that
// replays the ledger shape recorded live on 2026-11-08.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  enforceTrialProxyBudget,
  FakeProxyKeys,
  FakeProxySpend,
  liveLedgerSpend,
  makeTrialProxyCredential,
  mintTrialProxyCredential,
  REDACTED_SECRET,
  trialProxySecret,
  trialProxySpend,
} from "../src/index.js";

const KEY = "key_hqtk82tywkhx4sfhze4bjdm6g3";
const OTHER = "key_tv66nygde2vxhgp4bs7patwbky";

describe("TDM-16 credential hardening", () => {
  it("keeps the secret out of JSON, spread, keys and inspect, but readable by trialProxySecret", async () => {
    const cred = await mintTrialProxyCredential(new FakeProxyKeys(), { trialId: "t1" });
    const secret = trialProxySecret(cred);
    expect(secret).toMatch(/^sk_test_fake/);
    expect(cred.secret).toBe(secret);
    expect(JSON.stringify(cred)).not.toContain(secret);
    expect(JSON.parse(JSON.stringify(cred))).toMatchObject({
      keyId: cred.keyId,
      secret: REDACTED_SECRET,
    });
    expect(JSON.stringify({ trial: { cred } })).not.toContain(secret);
    expect(Object.keys(cred)).not.toContain("secret");
    expect({ ...cred }).not.toHaveProperty("secret");
    expect(inspect(cred, { depth: 5 })).not.toContain(secret);
    expect(String(Object.values(cred))).not.toContain(secret);
  });

  it("makeTrialProxyCredential makes the secret read-only", () => {
    const cred = makeTrialProxyCredential({
      trialId: "t",
      keyId: KEY,
      secret: "sk_test_abc12345",
      createdAt: "2026-11-08T00:00:00.000Z",
      baseUrl: "https://api.vetta.sh",
      anthropicBaseUrl: "https://api.vetta.sh/v1/proxy/anthropic",
    });
    expect(() => {
      (cred as { secret: string }).secret = "x";
    }).toThrow();
    expect(trialProxySecret(cred)).toBe("sk_test_abc12345");
  });
});

function spendRows() {
  return new FakeProxySpend()
    .add({ actorKeyId: KEY, billedMicroUsd: 32_882n, createdAt: "2026-11-08T03:11:52.449Z" })
    .add({ actorKeyId: KEY, billedMicroUsd: 2_831n, createdAt: "2026-11-08T03:11:53.401Z" })
    .add({ actorKeyId: OTHER, billedMicroUsd: 110_481n, createdAt: "2026-11-08T03:19:23.478Z" })
    .add({ actorKeyId: KEY, billedMicroUsd: null, createdAt: "2026-11-08T03:12:00.000Z" })
    .add({ actorKeyId: null, billedMicroUsd: 27_600n, createdAt: "2026-11-08T03:20:00.000Z" })
    .add({ actorKeyId: KEY, billedMicroUsd: 999n, createdAt: "2026-11-08T03:00:00.000Z" });
}

describe("TDM-16 trialProxySpend", () => {
  it("sums only the key's entries since the key was created, as bigint", async () => {
    const s = await trialProxySpend(spendRows(), { keyId: KEY, since: "2026-11-08T03:09:14.047Z" });
    expect(s).toEqual({ keyId: KEY, spentMicroUsd: 35_713n, calls: 3, unpricedCalls: 1 });
    expect(typeof s.spentMicroUsd).toBe("bigint");
  });

  it("without since it counts every entry for the key", async () => {
    const s = await trialProxySpend(spendRows(), { keyId: KEY });
    expect(s.spentMicroUsd).toBe(36_712n);
  });

  it("refuses something that is not a key id", async () => {
    await expect(trialProxySpend(spendRows(), { keyId: "sk_test_oops" })).rejects.toThrow(/key_/);
  });
});

describe("TDM-16 enforceTrialProxyBudget", () => {
  const since = "2026-11-08T03:09:14.047Z";

  it("reports and leaves the key alone under the cap", async () => {
    const keys = new FakeProxyKeys();
    const cred = await mintTrialProxyCredential(keys, { trialId: "t" });
    const spend = new FakeProxySpend().add({
      actorKeyId: cred.keyId,
      billedMicroUsd: 400_000n,
      createdAt: "2026-11-08T03:10:00.000Z",
    });
    const r = await enforceTrialProxyBudget(
      { keys, spend },
      { keyId: cred.keyId, capMicroUsd: 1_000_000n, since },
    );
    expect(r).toMatchObject({
      spentMicroUsd: 400_000n,
      remainingMicroUsd: 600_000n,
      revoked: false,
    });
    expect(await keys.list()).toHaveLength(1);
  });

  it("revokes the key once spend reaches the cap, and stays revoked on the next poll", async () => {
    const keys = new FakeProxyKeys();
    const cred = await mintTrialProxyCredential(keys, { trialId: "t" });
    const spend = new FakeProxySpend()
      .add({
        actorKeyId: cred.keyId,
        billedMicroUsd: 700_000n,
        createdAt: "2026-11-08T03:10:00.000Z",
      })
      .add({
        actorKeyId: cred.keyId,
        billedMicroUsd: 300_000n,
        createdAt: "2026-11-08T03:11:00.000Z",
      });
    const r = await enforceTrialProxyBudget(
      { keys, spend },
      { keyId: cred.keyId, capMicroUsd: 1_000_000n, since },
    );
    expect(r).toMatchObject({ spentMicroUsd: 1_000_000n, remainingMicroUsd: 0n, revoked: true });
    expect(await keys.list()).toEqual([]);
    spend.add({
      actorKeyId: cred.keyId,
      billedMicroUsd: 50_000n,
      createdAt: "2026-11-08T03:12:00.000Z",
    });
    const again = await enforceTrialProxyBudget(
      { keys, spend },
      { keyId: cred.keyId, capMicroUsd: 1_000_000n, since },
    );
    expect(again).toMatchObject({
      spentMicroUsd: 1_050_000n,
      remainingMicroUsd: 0n,
      revoked: true,
    });
  });

  it("a zero cap revokes at once; a negative or non-bigint cap is refused", async () => {
    const keys = new FakeProxyKeys();
    const cred = await mintTrialProxyCredential(keys, { trialId: "t" });
    const spend = new FakeProxySpend();
    expect(
      (await enforceTrialProxyBudget({ keys, spend }, { keyId: cred.keyId, capMicroUsd: 0n }))
        .revoked,
    ).toBe(true);
    await expect(
      enforceTrialProxyBudget({ keys, spend }, { keyId: cred.keyId, capMicroUsd: -1n }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      enforceTrialProxyBudget(
        { keys, spend },
        { keyId: cred.keyId, capMicroUsd: 5 as unknown as bigint },
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("TDM-16 liveLedgerSpend (recorded shape, mocked fetch)", () => {
  const entry = (id: string, actor: string, amount: number, at: string) => ({
    id,
    type: "debit",
    amount_micro_usd: amount,
    balance_after_micro_usd: 250_881_713,
    actor: { type: "key", id: actor },
    session_id: null,
    agent_id: null,
    deployment_id: null,
    resource_id: null,
    line_items: [
      { tier: "input", amount_micro_usd: -13 },
      { tier: "output", amount_micro_usd: amount + 13 },
    ],
    created_at: at,
  });

  it("asks for debits from the key's creation, pages, and turns negative debits into spend", async () => {
    const urls: URL[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      urls.push(url);
      const page2 = url.searchParams.get("after") === "led_ynaydcf11fhkfhjxq1kq28wm12";
      const body = page2
        ? {
            data: [entry("led_95j8dmhd2gyy7fs039kgycpknj", KEY, -40, "2026-11-08T03:09:26.462Z")],
            has_more: false,
            next_cursor: null,
          }
        : {
            data: [
              entry("led_7pbtjs7a3zjt058dkabfq9at5w", OTHER, -500, "2026-11-08T03:09:30.000Z"),
              entry("led_ynaydcf11fhkfhjxq1kq28wm12", KEY, -33, "2026-11-08T03:09:28.138Z"),
            ],
            has_more: true,
            next_cursor: "led_ynaydcf11fhkfhjxq1kq28wm12",
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const s = await trialProxySpend(liveLedgerSpend({ apiKey: "sk_test_admin", fetch }), {
      keyId: KEY,
      since: "2026-11-08T03:09:14.047Z",
    });
    expect(s).toEqual({ keyId: KEY, spentMicroUsd: 73n, calls: 2, unpricedCalls: 0 });
    expect(urls[0]!.pathname).toBe("/v1/credits/ledger");
    expect(urls[0]!.searchParams.get("type")).toBe("debit");
    expect(urls[0]!.searchParams.get("from")).toBe("2026-11-08T03:09:14.047Z");
    expect(urls).toHaveLength(2);
  });
});
