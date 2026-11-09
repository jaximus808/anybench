// League run 01a1c1e7: every BYOK trial failed at install with "Do not know how to serialize a
// BigInt", because trial.json was written with a plain JSON.stringify and the job carries the
// token cap and token prices as bigint micro-USD. trialJobJson must write them as decimal strings
// the runner's TrialJobSchema parses back to the same bigints.
import { TrialJobSchema } from "@anybench/runner";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_TOKEN_PRICES, trialJobJson } from "../src/executor.js";

describe("trialJobJson (BYOK money in trial.json)", () => {
  it("plain JSON.stringify throws on the bigint cap: the bug this guards", () => {
    expect(() => JSON.stringify({ token_cap_micro_usd: 25_000_000n })).toThrow(/BigInt/);
  });

  it("writes bigint micro-USD as decimal strings and nothing else changes", () => {
    const prices = Object.values(FIRST_PARTY_TOKEN_PRICES)[0]!;
    const text = trialJobJson({ a: 1, s: "x", token_cap_micro_usd: 25_000_000n, token_prices: { ...prices } });
    const back = JSON.parse(text) as Record<string, unknown>;
    expect(back.token_cap_micro_usd).toBe("25000000");
    expect(back.a).toBe(1);
    expect(back.s).toBe("x");
    for (const v of Object.values(back.token_prices as Record<string, unknown>)) expect(typeof v).toBe("string");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("the runner's schema parses the written money back to the same bigints", () => {
    const prices = Object.values(FIRST_PARTY_TOKEN_PRICES)[0]!;
    const shape = TrialJobSchema.pick({ token_cap_micro_usd: true, token_prices: true });
    const parsed = shape.parse(JSON.parse(trialJobJson({ token_cap_micro_usd: 25_000_000n, token_prices: { ...prices } })));
    expect(parsed.token_cap_micro_usd).toBe(25_000_000n);
    expect(parsed.token_prices).toEqual(prices);
  });
});
