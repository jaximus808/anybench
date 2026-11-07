// Credit and plan helpers. All amounts are bigint micro-USD.

import { NaiveSubscriptionRequiredError } from "./errors.js";
import type { MicroUsd } from "./money.js";
import type { NaiveBalance, NaiveClient, NaiveSubscription } from "./types.js";

/** `credits.show`: the organization's balance. */
export async function showCredits(client: NaiveClient): Promise<NaiveBalance> {
  return client.credits.show();
}

/** What a session (or agent) has spent so far, as the server summed it. */
export async function spentMicroUsd(
  client: NaiveClient,
  query: { sessionId?: string; agentId?: string } = {},
): Promise<MicroUsd> {
  return (await client.credits.spend(query)).spentMicroUsd;
}

/** Throws NaiveSubscriptionRequiredError unless the plan is `active`. Call before starting agent work. */
export async function assertSubscriptionActive(client: NaiveClient): Promise<NaiveSubscription> {
  const sub = await client.credits.subscription();
  if (sub.status !== "active") {
    throw new NaiveSubscriptionRequiredError(
      `Naïve plan is ${sub.status}; an active subscription is required`,
      {
        code: "subscription_required",
        status: 402,
      },
    );
  }
  return sub;
}

export interface CreditCheck {
  balanceMicroUsd: MicroUsd;
  budgetMicroUsd: MicroUsd;
  spentMicroUsd: MicroUsd;
  remainingMicroUsd: MicroUsd;
  /** Share of the budget spent, in basis points (integer; 10_000 = 100%). */
  spentBps: bigint;
}

/**
 * Where we are against our own Naïve credit budget (`NAIVE_CREDIT_BUDGET_MICRO_USD`): the balance
 * read from Naïve against the budget we started with. Integer math only.
 */
export async function creditCheck(
  client: NaiveClient,
  budgetMicroUsd: MicroUsd,
): Promise<CreditCheck> {
  const { balanceMicroUsd } = await client.credits.show();
  const spent = budgetMicroUsd > balanceMicroUsd ? budgetMicroUsd - balanceMicroUsd : 0n;
  return {
    balanceMicroUsd,
    budgetMicroUsd,
    spentMicroUsd: spent,
    remainingMicroUsd: balanceMicroUsd,
    spentBps: budgetMicroUsd === 0n ? 0n : (spent * 10_000n) / budgetMicroUsd,
  };
}
