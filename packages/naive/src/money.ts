// Money crosses the Naïve boundary here. Inside Anybench money is integer micro-USD as `bigint`;
// the Naïve SDK speaks integer micro-USD as `number`. Never a float on either side.

import type { MicroUsd } from "@anybench/core";

/** Integer micro-USD (bigint), the same type as `@anybench/core`. 1_000_000n is one US dollar. */
export type { MicroUsd };

/** bigint micro-USD → the SDK's `number`. Refuses anything that is not a safe, non-negative integer. */
export function toWireMicroUsd(amount: MicroUsd): number {
  if (typeof amount !== "bigint") throw new TypeError("micro-USD must be a bigint");
  if (amount < 0n) throw new RangeError(`micro-USD must be non-negative, got ${amount}`);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`micro-USD ${amount} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(amount);
}

/** The SDK's `number` micro-USD → bigint. Refuses floats (the API never sends one). */
export function fromWireMicroUsd(amount: number): MicroUsd {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`Naïve sent a non-integer micro-USD amount: ${amount}`);
  }
  return BigInt(amount);
}
