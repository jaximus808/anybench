// TDM-39 [4.7]: Naïve 429 "at capacity" is retried with backoff on create / exec / file writes,
// and nothing else is retried (a 5xx write may have landed).
import { describe, expect, it } from "vitest";
import {
  isNaiveCapacityError,
  NaiveError,
  retryOnNaiveCapacity,
  withCapacityRetry,
  type NaiveComputersApi,
} from "../src/index.js";

const capacity = () =>
  new NaiveError("the service is at capacity", { code: "rate_limited", status: 429 });

describe("retryOnNaiveCapacity", () => {
  it("retries a 429 with doubling backoff, then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const r = await retryOnNaiveCapacity(
      "create",
      async () => {
        calls++;
        if (calls < 3) throw capacity();
        return "ok";
      },
      { baseMs: 100, sleep: async (ms) => void waits.push(ms), random: () => 0 },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it("gives up after the last attempt and rethrows the 429", async () => {
    let calls = 0;
    await expect(
      retryOnNaiveCapacity(
        "exec",
        async () => {
          calls++;
          throw capacity();
        },
        { attempts: 3, baseMs: 1, sleep: async () => {} },
      ),
    ).rejects.toSatisfy(isNaiveCapacityError);
    expect(calls).toBe(3);
  });

  it("never retries a 5xx or a 4xx other than 429", async () => {
    for (const status of [500, 503, 400, 409]) {
      let calls = 0;
      await expect(
        retryOnNaiveCapacity(
          "writeFile",
          async () => {
            calls++;
            throw new NaiveError("no", { code: "x", status });
          },
          { sleep: async () => {} },
        ),
      ).rejects.toBeInstanceOf(NaiveError);
      expect(calls).toBe(1);
    }
  });
});

describe("withCapacityRetry", () => {
  it("retries create, exec, writeFile and mkdir; passes the rest through untouched", async () => {
    const calls: Record<string, number> = {};
    const flaky = (op: string, value: unknown) => async (): Promise<never> => {
      calls[op] = (calls[op] ?? 0) + 1;
      if (calls[op] === 1) throw capacity();
      return value as never;
    };
    const base = {
      create: flaky("create", { id: "cmp_1" }),
      exec: flaky("exec", { exitCode: 0 }),
      writeFile: flaky("writeFile", undefined),
      mkdir: flaky("mkdir", undefined),
      get: async () => {
        calls.get = (calls.get ?? 0) + 1;
        throw capacity();
      },
    } as unknown as NaiveComputersApi;
    const c = withCapacityRetry(base, { sleep: async () => {} });
    await expect(c.create({})).resolves.toEqual({ id: "cmp_1" });
    await expect(c.exec("cmp_1", "true")).resolves.toEqual({ exitCode: 0 });
    await c.writeFile("cmp_1", "/home/naive/x", new Uint8Array());
    await c.mkdir("cmp_1", "/home/naive/d");
    await expect(c.get("cmp_1")).rejects.toSatisfy(isNaiveCapacityError);
    expect(calls).toEqual({ create: 2, exec: 2, writeFile: 2, mkdir: 2, get: 1 });
  });
});
