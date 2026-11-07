// Money is integer micro-USD (1 USD = 1_000_000 micro-USD) held as bigint, everywhere.
// No function in this file ever converts money to a JS number: there is no float path.
// Spec: plan.md section 8 (cents <-> micro-USD).
import { z } from "zod";

/** Integer micro-USD. 1 USD = 1_000_000n, 1 cent = 10_000n. */
export type MicroUsd = bigint;

export const MICRO_USD_PER_USD = 1_000_000n;
export const MICRO_USD_PER_CENT = 10_000n;
export const BPS_PER_UNIT = 10_000n;

const DECIMAL_INTEGER = /^-?\d{1,30}$/;

/**
 * Accepts a bigint or a base-10 integer string ("12500", "-40") and outputs bigint.
 * JS numbers are rejected on purpose: they are the float path. Signed, because refunds
 * and adjustments are negative; use NonNegativeMicroUsdSchema for budgets, caps and fees.
 */
export const MicroUsdSchema = z
  .union([
    z.bigint(),
    z.string().regex(DECIMAL_INTEGER, "expected a base-10 integer string of micro-USD"),
  ])
  .transform((v): MicroUsd => (typeof v === "bigint" ? v : BigInt(v)));

export const NonNegativeMicroUsdSchema = MicroUsdSchema.refine((v) => v >= 0n, {
  message: "micro-USD amount must be >= 0",
});

function assertMicro(value: unknown, what = "amount"): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${what} must be a bigint of micro-USD, got ${typeof value}`);
  }
}

/** An integer multiplier: a bigint, or a JS number that is a safe integer. */
function toIntFactor(value: bigint | number, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`${what} must be an integer (bigint or safe integer), got ${String(value)}`);
}

/** Floor division (rounds toward negative infinity), unlike bigint `/` which truncates. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** Sum any number of micro-USD amounts. */
export function addMicro(...amounts: MicroUsd[]): MicroUsd {
  let total = 0n;
  for (const a of amounts) {
    assertMicro(a);
    total += a;
  }
  return total;
}

/** Multiply an amount by an integer count (e.g. trial fee x trials). */
export function mulMicro(amount: MicroUsd, factor: bigint | number): MicroUsd {
  assertMicro(amount);
  return amount * toIntFactor(factor, "factor");
}

/** `bps` basis points of `amount`, floored (1 bps = 0.01%). Never more than the exact value. */
export function bpsOf(amount: MicroUsd, bps: bigint | number): MicroUsd {
  assertMicro(amount);
  return floorDiv(amount * toIntFactor(bps, "bps"), BPS_PER_UNIT);
}

/** `amount` plus a markup of `bps` basis points (floored), e.g. managed tokens at cost + markup. */
export function withMarkupBps(amount: MicroUsd, bps: bigint | number): MicroUsd {
  return amount + bpsOf(amount, bps);
}

/** Cents (Stripe's unit) to micro-USD: exactly cents x 10_000. */
export function fromCents(cents: bigint | number): MicroUsd {
  return toIntFactor(cents, "cents") * MICRO_USD_PER_CENT;
}

export interface CentsConversion {
  /** Whole cents to report to Stripe now. */
  cents: bigint;
  /** Leftover micro-USD (0 <= carry < 10_000) to add to the next conversion. */
  carry: MicroUsd;
}

/**
 * Micro-USD to Stripe cents: cents = floor((amount + carryIn) / 10_000), and the remainder
 * is returned as `carry` for the next event. Invariant: cents x 10_000 + carry = amount + carryIn,
 * so summing a series loses nothing.
 */
export function toCents(amount: MicroUsd, carryIn: MicroUsd = 0n): CentsConversion {
  assertMicro(amount);
  assertMicro(carryIn, "carryIn");
  const total = amount + carryIn;
  const cents = floorDiv(total, MICRO_USD_PER_CENT);
  return { cents, carry: total - cents * MICRO_USD_PER_CENT };
}

export interface FormatUsdOptions {
  /** Digits after the decimal point, 0..6. Default 2. Rounds half away from zero. */
  decimals?: number;
  /** Thousands separators ("$1,234.56"). Default true. */
  grouping?: boolean;
}

/** "$12.34", "-$0.25", "$1,234.56". Pure bigint/string arithmetic: no float path. */
export function formatUsd(amount: MicroUsd, options: FormatUsdOptions = {}): string {
  assertMicro(amount);
  const decimals = options.decimals ?? 2;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new RangeError(`decimals must be an integer 0..6, got ${String(decimals)}`);
  }
  const grouping = options.grouping ?? true;

  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const unit = 10n ** BigInt(6 - decimals);
  let q = abs / unit;
  if ((abs % unit) * 2n >= unit) q += 1n;

  const scale = 10n ** BigInt(decimals);
  const whole = (q / scale).toString();
  const wholeStr = grouping ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  const body =
    decimals > 0 ? `${wholeStr}.${(q % scale).toString().padStart(decimals, "0")}` : wholeStr;
  return `${negative && q !== 0n ? "-" : ""}$${body}`;
}
