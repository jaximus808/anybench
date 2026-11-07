// Live smoke test. Runs ONLY with NAIVE_LIVE=1 and NAIVE_API_KEY set; read-only (balance, plan),
// so it spends nothing. `NAIVE_LIVE=1 pnpm --filter @anybench/naive test`.

import { describe, expect, it } from "vitest";
import { createNaiveClientFromEnv } from "../src/index.js";

const live = process.env.NAIVE_LIVE === "1" && !!process.env.NAIVE_API_KEY;

describe.skipIf(!live)("Naïve live smoke (NAIVE_LIVE=1)", () => {
  it("reads the credit balance and the plan", async () => {
    const client = createNaiveClientFromEnv();
    const balance = await client.credits.show();
    expect(typeof balance.balanceMicroUsd).toBe("bigint");
    const sub = await client.credits.subscription();
    expect(["active", "none", "past_due", "canceled"]).toContain(sub.status);
  });
});
