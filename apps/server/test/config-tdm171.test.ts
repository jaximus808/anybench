// TDM-171: cost-plus billing config (RUN_FEE_MICRO_USD, COMPUTE_MARKUP_BPS) parses to bigint.
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("cost-plus billing config (TDM-171)", () => {
  it("defaults to $2 per run and +50% on compute, as bigint", () => {
    const c = loadConfig({});
    expect(c.RUN_FEE_MICRO_USD).toBe(2_000_000n);
    expect(c.COMPUTE_MARKUP_BPS).toBe(5000n);
    expect(loadConfig({ RUN_FEE_MICRO_USD: "", COMPUTE_MARKUP_BPS: "" }).RUN_FEE_MICRO_USD).toBe(
      2_000_000n,
    );
  });

  it("reads overrides exactly (up to 15 digits), and rejects longer", () => {
    const c = loadConfig({ RUN_FEE_MICRO_USD: "999999999999999", COMPUTE_MARKUP_BPS: "0" });
    expect(c.RUN_FEE_MICRO_USD).toBe(999_999_999_999_999n);
    expect(c.COMPUTE_MARKUP_BPS).toBe(0n);
    expect(() => loadConfig({ RUN_FEE_MICRO_USD: "9007199254740993" })).toThrow(ConfigError);
  });

  it("rejects floats, negatives and dollar strings", () => {
    for (const env of [
      { RUN_FEE_MICRO_USD: "2.5" },
      { RUN_FEE_MICRO_USD: "-1" },
      { RUN_FEE_MICRO_USD: "$2" },
      { COMPUTE_MARKUP_BPS: "50.5" },
      { COMPUTE_MARKUP_BPS: "1e4" },
    ]) {
      expect(() => loadConfig(env), JSON.stringify(env)).toThrow(ConfigError);
    }
  });

  it("has no TRIAL_FEE_MICRO_USD any more", () => {
    expect("TRIAL_FEE_MICRO_USD" in loadConfig({})).toBe(false);
  });
});
