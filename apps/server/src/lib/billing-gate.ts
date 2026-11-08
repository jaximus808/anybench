// The run gate's billing port (TDM-67, plan.md section 8). POST /runs/:id/go calls
// `deps.billingGate(actor, estimate)` before it lets a run leave `awaiting_go`.
//
// Default implementation (until [10.6] wires the real gate over billing_accounts, credit grants,
// the new-account spend limit and the daily cap):
//   - BILLING_MODE=off (local dev only; config refuses it in production): always allowed.
//   - BILLING_MODE=test or live: always refused with `no_payment_method` and a link to the web
//     app's billing page, so the route answers the contract's 402 `{reason, link_card_url}` and the
//     run waits in `awaiting_go`. Nothing is billed while this stub is in place.
// [10.6] replaces it by passing its own `billingGate` in AppDeps; the route does not change.
import type { PaymentRequired } from "@anybench/core";
import type { Config } from "../config.js";

export interface BillingActor {
  userId: string;
}

export type BillingGateResult = { allowed: true } | ({ allowed: false } & PaymentRequired);

/** Decide whether `actor` may start a run whose estimate is `estimateMicroUsd` (integer micro-USD). */
export type BillingGate = (
  actor: BillingActor,
  estimateMicroUsd: bigint,
) => Promise<BillingGateResult>;

const FALLBACK_WEB_ORIGIN = "https://anybench.jaxonp.com";

/** Where the 402 sends the user to link a card: `<web origin>/settings/billing`. */
export function linkCardUrl(config: Pick<Config, "PUBLIC_WEB_URL" | "allowedOrigins">): string {
  const base = config.PUBLIC_WEB_URL ?? config.allowedOrigins[0] ?? FALLBACK_WEB_ORIGIN;
  return new URL("/settings/billing", new URL(base).origin).toString();
}

/** The stub gate described above. */
export function defaultBillingGate(
  config: Pick<Config, "BILLING_MODE" | "PUBLIC_WEB_URL" | "allowedOrigins">,
): BillingGate {
  return async () => {
    if (config.BILLING_MODE === "off") return { allowed: true };
    return { allowed: false, reason: "no_payment_method", link_card_url: linkCardUrl(config) };
  };
}
