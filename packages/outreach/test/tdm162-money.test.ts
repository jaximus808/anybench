import { describe, expect, it } from "vitest";
import {
  MonidReportedCostSchema,
  MonidUsdSchema,
  microUsdToUsdWire,
  usdToMicroUsd,
} from "../src/money.js";

describe("Monid USD float ↔ micro-USD", () => {
  it("converts the live prices exactly", () => {
    expect(usdToMicroUsd(1)).toBe(1_000_000n); // create-inboxes
    expect(usdToMicroUsd(0.001)).toBe(1_000n); // send-messages per recipient
    expect(usdToMicroUsd(0.0245)).toBe(24_500n); // hunterio email-finder
    expect(usdToMicroUsd(0.0012)).toBe(1_200n); // anyapi github.repository
    expect(usdToMicroUsd(0)).toBe(0n);
    expect(usdToMicroUsd(18.898)).toBe(18_898_000n); // a live wallet balance
  });

  it("rounds sub-micro prices up and balances down", () => {
    expect(usdToMicroUsd(1e-7)).toBe(1n);
    expect(usdToMicroUsd(1e-7, "down")).toBe(0n);
    expect(usdToMicroUsd(0.0000015)).toBe(2n);
    expect(usdToMicroUsd(0.0000015, "down")).toBe(1n);
    expect(usdToMicroUsd(1e21)).toBe(10n ** 27n);
  });

  it("does not inherit float error (0.1 + 0.2 style)", () => {
    expect(usdToMicroUsd(0.07)).toBe(70_000n);
    expect(usdToMicroUsd(1.005)).toBe(1_005_000n);
  });

  it("rejects NaN, Infinity and negatives", () => {
    expect(() => usdToMicroUsd(Number.NaN)).toThrow(RangeError);
    expect(() => usdToMicroUsd(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => usdToMicroUsd(-0.01)).toThrow(RangeError);
  });

  it("builds maxCost from a decimal string, and round-trips", () => {
    expect(microUsdToUsdWire(24_500n)).toBe(0.0245);
    expect(microUsdToUsdWire(1_000_000n)).toBe(1);
    expect(microUsdToUsdWire(0n)).toBe(0);
    expect(microUsdToUsdWire(2_000n)).toBe(0.002);
    for (const m of [1n, 7n, 999n, 1_001n, 123_456n, 3_000_000n, 987_654_321n]) {
      expect(usdToMicroUsd(microUsdToUsdWire(m))).toBe(m);
    }
    expect(() => microUsdToUsdWire(-1n)).toThrow(RangeError);
    // @ts-expect-error floats are refused at the type and runtime level
    expect(() => microUsdToUsdWire(0.5)).toThrow(TypeError);
  });

  it("zod schemas transform to bigint", () => {
    expect(MonidUsdSchema.parse({ value: 0.001, currency: "USD" })).toBe(1_000n);
    expect(MonidUsdSchema.safeParse({ value: -1, currency: "USD" }).success).toBe(false);
    expect(MonidUsdSchema.safeParse({ value: 1, currency: "EUR" }).success).toBe(false);
    expect(
      MonidReportedCostSchema.parse({ currency: "USD", value: 1_000_000, unit: "MICRO_DOLLAR" }),
    ).toBe(1_000_000n);
    expect(MonidReportedCostSchema.parse({ currency: "USD", value: 3, unit: "CENT" })).toBe(
      30_000n,
    );
    expect(
      MonidReportedCostSchema.safeParse({ currency: "USD", value: 0.5, unit: "DOLLAR" }).success,
    ).toBe(false);
  });
});
