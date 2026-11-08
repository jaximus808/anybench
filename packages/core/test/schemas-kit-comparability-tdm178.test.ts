// TDM-178 [16.7]: the KitSpec fields the comparability rules read (versions, assists, explicit
// cap units, unequal_caps_reason, schedule.order_seed). The rules themselves live in the kit
// validator (packages/kit/src/comparability.ts); here: parsing, units and backward compatibility.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { driverTokenCapTokens, KitSpecSchema, safeParseKitSpec } from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawTdm178(): any {
  const url = new URL("./fixtures/kits/kit-harness-tandem.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("KitSpec comparability fields", () => {
  it("an existing kit without the new fields still parses unchanged", () => {
    const kit = KitSpecSchema.parse(rawTdm178());
    expect(kit.unequal_caps_reason).toBeUndefined();
    expect(kit.schedule.order_seed).toBeUndefined();
    for (const c of kit.contenders) {
      expect(c.versions).toBeUndefined();
      expect(c.assists).toBeUndefined();
    }
  });

  it("parses versions, assists, explicit token caps, unequal_caps_reason and order_seed", () => {
    const raw = rawTdm178();
    const c = raw.contenders[0];
    c.versions = { CLAUDE_CODE_VERSION: "2.0.14" };
    c.assists = ["llm-reviewer"];
    c.driver.model = "claude-sonnet-4-5-20250929";
    delete c.driver.token_cap;
    c.driver.token_cap_tokens = 5_000_000;
    c.driver.token_cap_micro_usd = 2_500_000;
    raw.unequal_caps_reason = "planner plus workers";
    raw.schedule = { order_seed: 42 };
    const kit = KitSpecSchema.parse(raw);
    const k = kit.contenders[0]!;
    expect(k.versions).toEqual({ CLAUDE_CODE_VERSION: "2.0.14" });
    expect(k.assists).toEqual(["llm-reviewer"]);
    expect(driverTokenCapTokens(k.driver)).toBe(5_000_000);
    expect("token_cap_micro_usd" in k.driver && k.driver.token_cap_micro_usd).toBe(2_500_000n);
    expect(kit.unequal_caps_reason).toBe("planner plus workers");
    expect(kit.schedule).toMatchObject({ order_seed: 42, warmups: 1, packing: false });
  });

  it("token_cap_micro_usd is integer micro-USD: a YAML integer or decimal string, never a float", () => {
    const withCap = (v: unknown) => {
      const raw = rawTdm178();
      raw.contenders[0].driver.token_cap_micro_usd = v;
      return safeParseKitSpec(raw);
    };
    const ok = withCap("12000000");
    expect(ok.success && "token_cap_micro_usd" in ok.data.contenders[0]!.driver).toBe(true);
    for (const bad of [1.5, -1, 0, "1.5", "abc"]) {
      const r = withCap(bad);
      expect(r.success, String(bad)).toBe(false);
    }
  });

  it("the deprecated token_cap is read as tokens", () => {
    const kit = KitSpecSchema.parse(rawTdm178());
    expect(kit.contenders[0]!.driver).toMatchObject({ type: "harness", token_cap: 5_000_000 });
    expect(driverTokenCapTokens(kit.contenders[0]!.driver)).toBe(5_000_000);
    const cli = KitSpecSchema.parse(
      JSON.parse(
        readFileSync(new URL("./fixtures/kits/kit-software-cli.json", import.meta.url), "utf8"),
      ),
    );
    expect(driverTokenCapTokens(cli.contenders[0]!.driver)).toBeUndefined();
  });

  it("refuses a bad order_seed, an empty unequal_caps_reason and a non-env versions key", () => {
    const raw = rawTdm178();
    raw.schedule = { order_seed: -1 };
    raw.unequal_caps_reason = "  ";
    raw.contenders[0].versions = { "claude-code": "2.0.14" };
    const r = safeParseKitSpec(raw);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.errors.join("\n")).toMatch(/schedule\.order_seed/);
      expect(r.errors.join("\n")).toMatch(/unequal_caps_reason/);
      expect(r.errors.join("\n")).toMatch(/contenders\[0\]\.versions/);
    }
  });
});
