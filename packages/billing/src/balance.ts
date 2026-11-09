// The cached balance arithmetic of the ledger (TDM-87), shared by ledger.ts and free-run.ts.
import type { MicroUsd } from "@anybench/core";

export interface Balance {
  unbilled: MicroUsd;
  granted_remaining: MicroUsd;
}

/** Split a net position (usage minus grants) into the two cached columns. */
export function balanceFromNet(net: MicroUsd): Balance {
  return net >= 0n
    ? { unbilled: net, granted_remaining: 0n }
    : { unbilled: 0n, granted_remaining: -net };
}

/** Add `delta` (usage > 0, grant < 0) to a balance. Grants are spent first, both ways. */
export function applyNetDelta(balance: Balance, delta: MicroUsd): Balance {
  return balanceFromNet(balance.unbilled - balance.granted_remaining + delta);
}
