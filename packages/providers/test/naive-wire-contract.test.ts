// TDM-22: the shared contract through the LIVE path — NaiveProvider → createNaiveClient →
// @usenaive-sdk/managed-agents → fetch — with the fetch answered offline from FakeNaive in the
// API's wire shapes. Proves the snake_case mapping, base64 fs and error envelopes end to end.
import { createNaiveClient, FakeNaive, fakeNaiveError } from "@anybench/naive";
import { describe, expect, it } from "vitest";
import { runProviderContract } from "../src/contract.js";
import { NaiveProvider } from "../src/naive.js";
import { tdm22NaiveWireFetch } from "./tdm22-naive-wire.js";

function wired(provisionDelayMs = 20, retry = false) {
  const naive = new FakeNaive({
    computers: { timeScale: 0.01, provisionDelayMs, fsVisibilityDelayMs: 10 },
  });
  const { fetch, requests } = tdm22NaiveWireFetch(naive);
  const client = createNaiveClient({
    apiKey: "sk_test_tdm22_offline",
    baseUrl: "https://naive.invalid",
    fetch,
    // Off by default here so the error-mapping tests see Naïve's raw answers; one test turns it on.
    ...(retry
      ? { retry: { sleep: async () => {}, onRetry: () => {} } }
      : { retry: false as const }),
  });
  const p = new NaiveProvider({
    client,
    readyIntervalMs: 10,
    putFileCheck: { attempts: 20, intervalMs: 10 },
  });
  return { naive, p, requests };
}

runProviderContract("naive (live client over the SDK, offline wire)", () => wired().p, {
  readyTimeoutMs: 5_000,
  testTimeoutMs: 15_000,
  detachedWaitMs: 5_000,
  missingId: "cmp_00000000000000000000000000000000",
  missingSnapshotId: "snp_00000000000000000000000000000000",
});

describe("naive wire details", () => {
  it("sends Naïve's field names and base64 file bodies", async () => {
    const { p, requests } = wired();
    const c = await p.waitReady(
      (await p.create({ name: "w", vcpu: 1, memoryMb: 512, diskGb: 7, tags: ["ab-x-y"] })).id,
    );
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/computers",
      body: { name: "ab-x-y :: w", vcpu: 1, memory_mb: 512, disk_gb: 7 },
    });
    const bytes = Uint8Array.from([0, 255, 10, 13, 128]);
    await p.putFile(c.id, "bin/raw", bytes);
    const write = requests.find((r) => r.path.endsWith("/fs/write"));
    expect(write?.body).toEqual({
      path: "/home/naive/bin/raw",
      encoding: "base64",
      content: "AP8KDYA=",
    });
    expect(Array.from(await p.getFile(c.id, "bin/raw"))).toEqual(Array.from(bytes));
    const read = requests.find((r) => r.path.endsWith("/fs/read"));
    expect(read?.body).toEqual({ path: "/home/naive/bin/raw", encoding: "base64" });
    const exec = requests.find((r) => r.path.endsWith("/exec"));
    expect(exec?.body).toMatchObject({ timeout_ms: 30_000 });
  });

  it("follow-up 67: with retry on, a 429 on create and on fs/read is retried transparently", async () => {
    const { p, naive, requests } = wired(20, true);
    naive.failNext("computers.create", fakeNaiveError("rate_limited", 429));
    const c = await p.create({});
    expect(requests.filter((r) => r.method === "POST" && r.path === "/v1/computers")).toHaveLength(
      2,
    );
    await p.waitReady(c.id, { timeoutMs: 5_000 });
    await p.putFile(c.id, "f.txt", new TextEncoder().encode("hi"));
    naive.failNext("computers.fs.read", fakeNaiveError("rate_limited", 429));
    expect(new TextDecoder().decode(await p.getFile(c.id, "f.txt"))).toBe("hi");
  });

  it("maps 402 / 409 / 429 envelopes from the API to typed provider errors", async () => {
    const { p, naive } = wired(60_000);
    naive.setBalance(0n);
    await expect(p.create({})).rejects.toMatchObject({ code: "billing" });
    naive.setBalance(1_000_000n);
    naive.failNext("computers.create", fakeNaiveError("rate_limited", 429));
    await expect(p.create({})).rejects.toMatchObject({ code: "capacity", retryable: true });
    const c = await p.create({});
    await expect(p.exec(c.id, "echo early")).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });
});
