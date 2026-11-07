import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MicroUsdSchema,
  NonNegativeMicroUsdSchema,
  addMicro,
  bpsOf,
  formatUsd,
  fromCents,
  mulMicro,
  toCents,
  withMarkupBps,
} from "../src/money.js";

// Amounts well beyond Number.MAX_SAFE_INTEGER, so any accidental float path loses precision.
const BIG = 10n ** 24n;
const micro = fc.bigInt({ min: -BIG, max: BIG });
const nonNeg = fc.bigInt({ min: 0n, max: BIG });

/** Reference formatter built from string slicing only, to check formatUsd against. */
function refFormat(m: bigint): string {
  const neg = m < 0n;
  let abs = neg ? -m : m;
  // round half away from zero to cents
  const rem = abs % 10_000n;
  abs = abs - rem + (rem >= 5_000n ? 10_000n : 0n);
  const s = (abs / 10_000n).toString().padStart(3, "0");
  const whole = s.slice(0, -2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const zero = abs === 0n;
  return `${neg && !zero ? "-" : ""}$${grouped}.${s.slice(-2)}`;
}

describe("money: micro-USD (TDM-9)", () => {
  it("cents -> micro is exactly x 10_000", () => {
    fc.assert(fc.property(fc.bigInt({ min: -BIG, max: BIG }), (c) => fromCents(c) === c * 10_000n));
    expect(fromCents(25)).toBe(250_000n);
    expect(() => fromCents(0.5)).toThrow(TypeError);
  });

  it("toCents floors and carries the remainder (invariant holds for any carry-in)", () => {
    fc.assert(
      fc.property(micro, fc.bigInt({ min: 0n, max: 9_999n }), (m, carryIn) => {
        const { cents, carry } = toCents(m, carryIn);
        expect(cents * 10_000n + carry).toBe(m + carryIn);
        expect(carry >= 0n && carry < 10_000n).toBe(true);
      }),
    );
    expect(toCents(12_345n)).toEqual({ cents: 1n, carry: 2_345n });
    expect(toCents(-1n)).toEqual({ cents: -1n, carry: 9_999n });
  });

  it("cents round-trip: fromCents then toCents is lossless", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -BIG, max: BIG }), (c) => {
        expect(toCents(fromCents(c))).toEqual({ cents: c, carry: 0n });
      }),
    );
  });

  it("carrying across a series of meter events loses nothing", () => {
    fc.assert(
      fc.property(
        fc.array(
          nonNeg.map((x) => x % 1_000_000n),
          { maxLength: 200 },
        ),
        (events) => {
          let carry = 0n;
          let reported = 0n;
          for (const e of events) {
            const r = toCents(e, carry);
            reported += r.cents;
            carry = r.carry;
          }
          const total = events.reduce((a, b) => a + b, 0n);
          expect(reported * 10_000n + carry).toBe(total);
          expect(reported).toBe(total / 10_000n);
        },
      ),
    );
  });

  it("add / mul / bps are exact bigint arithmetic", () => {
    fc.assert(
      fc.property(fc.array(micro, { maxLength: 20 }), (xs) => {
        expect(addMicro(...xs)).toBe(xs.reduce((a, b) => a + b, 0n));
      }),
    );
    fc.assert(
      fc.property(micro, fc.integer({ min: -1_000_000, max: 1_000_000 }), (m, k) => {
        expect(mulMicro(m, k)).toBe(m * BigInt(k));
      }),
    );
    fc.assert(
      fc.property(micro, fc.integer({ min: 0, max: 100_000 }), (m, bps) => {
        const got = bpsOf(m, bps);
        // floor: got <= exact < got + 1 (in micro), compared scaled by 10_000
        expect(got * 10_000n <= m * BigInt(bps)).toBe(true);
        expect((got + 1n) * 10_000n > m * BigInt(bps)).toBe(true);
      }),
    );
    expect(bpsOf(1_000_000n, 1_500)).toBe(150_000n);
    expect(withMarkupBps(1_000_000n, 1_500)).toBe(1_150_000n);
  });

  it("rejects JS numbers where money is expected (no float path in)", () => {
    const anyFn = (f: unknown) => f as (...a: unknown[]) => unknown;
    expect(() => anyFn(addMicro)(1, 2)).toThrow(TypeError);
    expect(() => anyFn(formatUsd)(12.34)).toThrow(TypeError);
    expect(() => anyFn(toCents)(100)).toThrow(TypeError);
    expect(() => mulMicro(10n, 1.5)).toThrow(TypeError);
    expect(() => bpsOf(10n, 0.5)).toThrow(TypeError);
    fc.assert(
      fc.property(fc.double({ noInteger: true, noNaN: true }), (d) => {
        expect(() => mulMicro(1n, d)).toThrow(TypeError);
      }),
    );
  });

  it("formatUsd matches a string-only reference for huge amounts", () => {
    fc.assert(
      fc.property(micro, (m) => {
        expect(formatUsd(m)).toBe(refFormat(m));
      }),
    );
    expect(formatUsd(12_340_000n)).toBe("$12.34");
    expect(formatUsd(250_000n)).toBe("$0.25");
    expect(formatUsd(-1_234_560_000n)).toBe("-$1,234.56");
    expect(formatUsd(4_999n)).toBe("$0.00");
    expect(formatUsd(-4_999n)).toBe("$0.00");
    expect(formatUsd(5_000n)).toBe("$0.01");
    expect(formatUsd(9_007_199_254_740_993_000_000n)).toBe("$9,007,199,254,740,993.00");
    expect(formatUsd(1_234_567n, { decimals: 6 })).toBe("$1.234567");
    expect(formatUsd(1_500_000n, { decimals: 0 })).toBe("$2");
    expect(formatUsd(1_234_000_000_000n, { grouping: false })).toBe("$1234000.00");
    expect(() => formatUsd(1n, { decimals: 7 })).toThrow(RangeError);
  });

  it("MicroUsdSchema accepts bigint or a decimal string and outputs bigint", () => {
    expect(MicroUsdSchema.parse(5n)).toBe(5n);
    expect(MicroUsdSchema.parse("250000")).toBe(250_000n);
    expect(MicroUsdSchema.parse("-40")).toBe(-40n);
    expect(MicroUsdSchema.parse("123456789012345678901234567890")).toBe(
      123456789012345678901234567890n,
    );
    for (const bad of [
      12.5,
      100,
      "1.5",
      "1e6",
      "",
      " 1",
      "0x10",
      null,
      undefined,
      "1".repeat(31),
    ]) {
      expect(MicroUsdSchema.safeParse(bad).success).toBe(false);
    }
    fc.assert(
      fc.property(micro, (m) => {
        expect(MicroUsdSchema.parse(m.toString())).toBe(m);
      }),
    );
    expect(NonNegativeMicroUsdSchema.parse("0")).toBe(0n);
    expect(NonNegativeMicroUsdSchema.safeParse(-1n).success).toBe(false);
  });

  it("money.ts source has no float conversions", () => {
    const src = readFileSync(new URL("../src/money.ts", import.meta.url), "utf8");
    for (const banned of [
      "parseFloat",
      "toFixed",
      "Math.",
      "Number(",
      "parseInt",
      "toLocaleString",
    ]) {
      expect(src.includes(banned), `money.ts must not use ${banned}`).toBe(false);
    }
  });
});
