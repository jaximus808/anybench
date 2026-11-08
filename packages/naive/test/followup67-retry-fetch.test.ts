// Follow-up 67: every live Naïve client retries 429 "at capacity" (any method), and 502/503/504
// or a dropped connection on reads only, with bounded backoff + jitter.
import { describe, expect, it } from "vitest";
import {
  createNaiveClient,
  isNaiveReadRequest,
  naiveRetryFetch,
  NaiveError,
  type NaiveRetryInfo,
} from "../src/index.js";

const capacity = () =>
  new Response(
    JSON.stringify({
      error: {
        type: "rate_limit_error",
        code: "rate_limited",
        message: "the service is at capacity",
        request_id: "req_f67",
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );

function scripted(answers: Array<Response | Error>) {
  const calls: Array<{ method: string; url: string; idem: string | null }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      idem: new Headers(init?.headers).get("idempotency-key"),
    });
    const next = answers.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const fast = (retries: NaiveRetryInfo[] = []) => ({
  sleep: async () => {},
  random: () => 0,
  onRetry: (r: NaiveRetryInfo) => void retries.push(r),
});

describe("naiveRetryFetch", () => {
  it("classifies reads: GET/HEAD and the POST fs/read + fs/list", () => {
    expect(isNaiveReadRequest("GET", "/v1/sessions/s_1")).toBe(true);
    expect(isNaiveReadRequest("POST", "/v1/computers/cmp_1/fs/read")).toBe(true);
    expect(isNaiveReadRequest("POST", "/v1/computers/cmp_1/fs/list")).toBe(true);
    expect(isNaiveReadRequest("POST", "/v1/computers/cmp_1/fs/write")).toBe(false);
    expect(isNaiveReadRequest("POST", "/v1/computers/cmp_1/exec")).toBe(false);
    expect(isNaiveReadRequest("DELETE", "/v1/computers/cmp_1")).toBe(false);
  });

  it("retries a read on 429 / 503 / dropped connection, with exponential backoff", async () => {
    const dropped = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ETIMEDOUT" },
    });
    const { fetch, calls } = scripted([
      capacity(),
      new Response("", { status: 503 }),
      dropped,
      new Response("ok", { status: 200 }),
    ]);
    const retries: NaiveRetryInfo[] = [];
    const f = naiveRetryFetch(fetch, { ...fast(retries), baseMs: 100 });
    const res = await f("https://naive.test/v1/sessions/s_1", { method: "GET" });
    expect(await res.text()).toBe("ok");
    expect(calls).toHaveLength(4);
    expect(retries.map((r) => [r.status, r.waitMs])).toEqual([
      [429, 100],
      [503, 200],
      [null, 400],
    ]);
    expect(retries[2]?.error).toBe("ETIMEDOUT");
  });

  it("retries a write only on 429 (refused), replaying the same Idempotency-Key", async () => {
    const { fetch, calls } = scripted([capacity(), new Response("{}", { status: 200 })]);
    const f = naiveRetryFetch(fetch, fast());
    const init = { method: "POST", headers: { "idempotency-key": "k1" }, body: "{}" };
    expect((await f("https://naive.test/v1/computers/c/exec", init)).status).toBe(200);
    expect(calls.map((c) => c.idem)).toEqual(["k1", "k1"]);

    const w = scripted([new Response("", { status: 503 })]);
    const g = naiveRetryFetch(w.fetch, fast());
    expect((await g("https://naive.test/v1/computers/c/exec", init)).status).toBe(503);
    expect(w.calls).toHaveLength(1);

    const n = scripted([new TypeError("fetch failed")]);
    const h = naiveRetryFetch(n.fetch, fast());
    await expect(h("https://naive.test/v1/computers/c/fs/write", init)).rejects.toThrow(
      "fetch failed",
    );
    expect(n.calls).toHaveLength(1);
  });

  it("is bounded: after `attempts` tries the last 429 is returned", async () => {
    const { fetch, calls } = scripted([capacity(), capacity(), capacity()]);
    const f = naiveRetryFetch(fetch, { ...fast(), attempts: 3 });
    expect((await f("https://naive.test/v1/credits/balance")).status).toBe(429);
    expect(calls).toHaveLength(3);
  });

  it("honours Retry-After, capped at maxMs, plus jitter", async () => {
    const retries: NaiveRetryInfo[] = [];
    const ra = new Response("", { status: 429, headers: { "retry-after": "5" } });
    const big = new Response("", { status: 429, headers: { "retry-after": "999" } });
    const { fetch } = scripted([ra, big, new Response("ok")]);
    const f = naiveRetryFetch(fetch, { ...fast(retries), baseMs: 100, maxMs: 10_000 });
    await f("https://naive.test/v1/sessions/s_1");
    expect(retries.map((r) => r.waitMs)).toEqual([5_000, 10_000]);
    const j: NaiveRetryInfo[] = [];
    const s = scripted([capacity(), new Response("ok")]);
    await naiveRetryFetch(s.fetch, { ...fast(j), random: () => 1, baseMs: 100 })(
      "https://naive.test/x",
    );
    expect(j[0]?.waitMs).toBe(150);
  });
});

describe("createNaiveClient retries by default", () => {
  it("a session read gets through a 429 storm; retry:false surfaces the 429", async () => {
    // The third answer is a 200 the SDK cannot parse: reaching it proves both 429s were retried.
    const { fetch, calls } = scripted([capacity(), capacity(), new Response("{}")]);
    const client = createNaiveClient({
      apiKey: "k",
      baseUrl: "https://naive.test",
      fetch,
      retry: fast(),
    });
    const got = await client.sessions.get("ses_1").catch((e: unknown) => e);
    expect((got as NaiveError).code).toBe("response_unreadable");
    expect(calls).toHaveLength(3);

    const raw = scripted([capacity()]);
    const off = createNaiveClient({
      apiKey: "k",
      baseUrl: "https://naive.test",
      fetch: raw.fetch,
      retry: false,
    });
    const e = await off.sessions.get("ses_1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NaiveError);
    expect((e as NaiveError).status).toBe(429);
    expect(raw.calls).toHaveLength(1);
  });
});
