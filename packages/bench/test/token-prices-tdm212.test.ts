// TDM-212: the runner's BYOK spend cap prices a first-party model at its own list price. Without
// `token_prices` the runner's estimate uses Sonnet list prices and a $25 cap on Claude Opus 5.5
// would stop late; with them, A and Tandem of kits/tandem-long-horizon are capped at Opus 5.5
// prices. A Naïve proxy id (kits/tandem-vs-claude-code) keeps the runner's default.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeParseKitSpec, type KitSpec } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FIRST_PARTY_TOKEN_PRICES, trialJobFromKit } from "../src/index.js";

const KITS_TDM212 = join(dirname(fileURLToPath(import.meta.url)), "../../../kits");
function kitTdm212(name: string): KitSpec {
  const r = safeParseKitSpec(parse(readFileSync(join(KITS_TDM212, name, "anybench.yaml"), "utf8")));
  if (!r.success) throw new Error(r.errors.join("\n"));
  return r.data;
}

describe("trialJobFromKit token prices (TDM-212)", () => {
  it("Opus 5.5 list prices, in micro-USD per million tokens", () => {
    expect(FIRST_PARTY_TOKEN_PRICES["claude-opus-5-5"]).toEqual({
      input: 4_000_000n,
      output: 20_000_000n,
      cache_read: 200_000n,
      cache_creation: 5_000_000n,
    });
  });

  it("the long-horizon kit: both setups carry the $25 cap, Opus 5.5 prices and the 3 h cap", () => {
    const kit = kitTdm212("tandem-long-horizon");
    for (const c of ["claude-code-solo", "tandem"]) {
      const job = trialJobFromKit(kit, c, "project-tracker");
      expect(job.token_cap_micro_usd, c).toBe(25_000_000n);
      expect(job.token_prices, c).toEqual(FIRST_PARTY_TOKEN_PRICES["claude-opus-5-5"]);
      expect(job.wall_clock_s, c).toBe(10_800);
      expect(job.env?.AB_TOKEN_SOURCE, c).toBe("anthropic_key");
    }
  });

  it("no spend cap, or a model without a price: no token_prices (the runner's default)", () => {
    const kit = kitTdm212("tandem-vs-claude-code");
    const job = trialJobFromKit(kit, "claude-code-solo", "todo-api");
    expect(job).not.toHaveProperty("token_prices");
  });
});
