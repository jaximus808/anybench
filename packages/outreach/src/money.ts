// Money crosses the Monid boundary here. Monid's API speaks US dollars as JSON *floats*
// (`price.amount.value: 0.0245`, `wallet.balance.value: 18.898`, `maxCost: 0.05`). Inside Anybench
// money is integer micro-USD as bigint. The conversion never does float arithmetic: it reads the
// number's shortest round-trip decimal string (what `String(n)` gives, which is exactly the digits
// Monid sent for any value with <= 15 significant digits) and parses that as a decimal.
//
// Rounding: a price or cost with more than 6 decimals is rounded UP to the next micro-USD, so a
// budget computed from it is never smaller than the real charge. A balance is rounded DOWN, so we
// never think we have more than we do.

import { z } from "zod";
import type { MicroUsd } from "@anybench/core";

export type { MicroUsd };

export type Rounding = "up" | "down";

const DECIMAL = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;

/** USD float from Monid's wire → integer micro-USD. Rejects NaN, Infinity and negatives. */
export function usdToMicroUsd(usd: number, rounding: Rounding = "up"): MicroUsd {
  if (typeof usd !== "number" || !Number.isFinite(usd)) {
    throw new RangeError(`Monid sent a non-finite USD amount: ${String(usd)}`);
  }
  if (usd < 0) throw new RangeError(`Monid sent a negative USD amount: ${usd}`);
  const m = DECIMAL.exec(String(usd));
  if (!m) throw new RangeError(`cannot parse USD amount ${String(usd)}`);
  const intPart = m[1] ?? "0";
  const fracPart = m[2] ?? "";
  const exp = Number(m[3] ?? "0");
  // digits * 10^(exp - fracLen) USD = digits * 10^(exp - fracLen + 6) micro-USD
  const digits = BigInt(intPart + fracPart);
  const shift = exp - fracPart.length + 6;
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const div = 10n ** BigInt(-shift);
  const q = digits / div;
  return rounding === "up" && digits % div !== 0n ? q + 1n : q;
}

/**
 * Integer micro-USD → the USD number Monid's `maxCost` takes ("at most 6 decimals"). Built from a
 * decimal string, so 24_500n becomes exactly 0.0245, never 0.024499999.
 */
export function microUsdToUsdWire(amount: MicroUsd): number {
  if (typeof amount !== "bigint") throw new TypeError("micro-USD must be a bigint");
  if (amount < 0n) throw new RangeError(`micro-USD must be non-negative, got ${amount}`);
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0");
  const n = Number(`${whole}.${frac}`);
  if (!Number.isFinite(n) || whole > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`micro-USD ${amount} is too large for the wire`);
  }
  return n;
}

/** `{ value: <USD float>, currency: "USD" }` → micro-USD bigint (rounded up: prices and costs). */
export const MonidUsdSchema = z
  .object({ value: z.number(), currency: z.literal("USD") })
  .transform((v, ctx): MicroUsd => {
    try {
      return usdToMicroUsd(v.value, "up");
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
      return z.NEVER;
    }
  });

/** Same shape, rounded down: for balances. */
export const MonidBalanceUsdSchema = z
  .object({ value: z.number(), currency: z.literal("USD") })
  .transform((v, ctx): MicroUsd => {
    try {
      return usdToMicroUsd(v.value, "down");
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
      return z.NEVER;
    }
  });

const UNIT_TO_MICRO: Record<"MICRO_DOLLAR" | "CENT" | "DOLLAR", bigint> = {
  MICRO_DOLLAR: 1n,
  CENT: 10_000n,
  DOLLAR: 1_000_000n,
};

/** `billing.reportedCost` on a run: already an integer with a unit (observed: MICRO_DOLLAR). */
export const MonidReportedCostSchema = z
  .object({
    currency: z.literal("USD"),
    value: z.number().int().nonnegative(),
    unit: z.enum(["MICRO_DOLLAR", "CENT", "DOLLAR"]),
  })
  .transform((v): MicroUsd => BigInt(v.value) * UNIT_TO_MICRO[v.unit]);
