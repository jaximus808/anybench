// The run gate's billing port (TDM-67, plan.md section 8). POST /runs/:id/go and the orchestrator's
// auto-go call `deps.billingGate(actor, estimate)` before a run may leave `awaiting_go`.
//
// Default implementation:
//   - BILLING_MODE=off (local dev only; config refuses it in production): always allowed.
//   - BILLING_MODE=test or live, in this order:
//       1. a run that is already comped (runs.comped_by) is allowed: it bills nothing;
//       2. founder demo bypass (plan.md section 8): when the run's owner is an admin (their GitHub
//          login is in ADMIN_GITHUB_LOGINS, the TDM-65 rule in lib/admin.ts), the gate COMPS the
//          run and allows it. The comp writes an `interventions` row and sets runs.comped_by,
//          comped_reason and comp_intervention_id in one transaction (the DB trigger rejects a comp
//          without its intervention). The ledger then records the run's usage as comped and never
//          counts it or sends it to Stripe;
//       3. card on file (stripe-onboarding): billing_accounts says payment_status `ok` and
//          has_payment_method (written by the Stripe webhook / billing page sync after Checkout),
//          or credit grants left cover the estimate; and, until the first paid invoice, unbilled
//          usage + the estimate stays under the spend limit (the account's spend_limit_micro_usd,
//          else NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD). `blocked` and `past_due` refuse with their
//          own reason;
//       4. everyone else is refused with a link to the web app's billing page (`?run=<id>` so the
//          page can press Go after the card is saved): the route answers the contract's 402
//          `{reason, link_card_url}` and the run waits in `awaiting_go` (an auto-go run starts on
//          the next sweep once the card lands).
//     Without the database the gate only refuses.
// [10.6] replaces it by passing its own `billingGate` in AppDeps; the route does not change.
import type { PaymentRequired } from "@anybench/core";
import { and, eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { billingAccounts, interventions, runs, users } from "../db/schema/index.js";
import { isAdminLogin } from "./admin.js";

export interface BillingActor {
  userId: string;
  /** The run asking to Go. Needed for the admin auto-comp; without it the default gate refuses. */
  runId?: string;
}

export type BillingGateResult = { allowed: true } | ({ allowed: false } & PaymentRequired);

/** Decide whether `actor` may start a run whose estimate is `estimateMicroUsd` (integer micro-USD). */
export type BillingGate = (
  actor: BillingActor,
  estimateMicroUsd: bigint,
) => Promise<BillingGateResult>;

const FALLBACK_WEB_ORIGIN = "https://anybench.jaxonp.com";

/** The comped_reason and interventions.why of the founder demo bypass. */
export const ADMIN_AUTO_COMP_REASON = "founder demo (admin auto-comp)";

type GateConfig = Pick<
  Config,
  "BILLING_MODE" | "PUBLIC_WEB_URL" | "allowedOrigins" | "adminGithubLogins"
> &
  Partial<Pick<Config, "NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD">>;

/** $100: NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD's default (config.ts). */
const DEFAULT_NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD = 100_000_000n;

/**
 * Where the 402 sends the user to link a card: `<web origin>/settings/billing`, plus `?run=<id>`
 * when a run is waiting, so the billing page can offer to start it once the card is saved.
 */
export function linkCardUrl(
  config: Pick<Config, "PUBLIC_WEB_URL" | "allowedOrigins">,
  runId?: string,
): string {
  const base = config.PUBLIC_WEB_URL ?? config.allowedOrigins[0] ?? FALLBACK_WEB_ORIGIN;
  const url = new URL("/settings/billing", new URL(base).origin);
  if (runId) url.searchParams.set("run", runId);
  return url.toString();
}

type AccountGateRow = Pick<
  typeof billingAccounts.$inferSelect,
  | "paymentStatus"
  | "hasPaymentMethod"
  | "unbilledMicroUsd"
  | "grantedRemainingMicroUsd"
  | "spendLimitMicroUsd"
  | "firstPaidInvoiceAt"
>;

/**
 * Rule 3 above as a pure function: may this account start a run of `estimate` (micro-USD)?
 * Returns null when allowed, else the 402 reason.
 */
export function accountGateDecision(
  account: AccountGateRow | undefined,
  estimate: bigint,
  newAccountLimit: bigint = DEFAULT_NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD,
): PaymentRequired["reason"] | null {
  if (!account) return "no_payment_method";
  if (account.paymentStatus === "blocked") return "account_blocked";
  if (account.paymentStatus === "past_due") return "payment_past_due";
  const card = account.paymentStatus === "ok" && account.hasPaymentMethod;
  if (!card) {
    if (account.grantedRemainingMicroUsd > 0n && account.grantedRemainingMicroUsd >= estimate) {
      return null;
    }
    return account.grantedRemainingMicroUsd > 0n ? "insufficient_credit" : "no_payment_method";
  }
  if (account.firstPaidInvoiceAt === null) {
    const limit = account.spendLimitMicroUsd ?? newAccountLimit;
    if (account.unbilledMicroUsd + estimate > limit) return "spend_limit";
  }
  return null;
}

export type AdminAutoCompResult =
  { comped: true; already: boolean; interventionId: string } | { comped: false };

/**
 * Comp `runId` if its owner (`userId`) is an admin right now, or report that it is already comped.
 * One transaction: lock the run, insert the interventions row, set comped_by (the admin's login),
 * comped_reason and comp_intervention_id. Idempotent: a comped run is left as it is.
 * Runs as the privileged pool role (interventions are not tenant-writable).
 */
export async function adminAutoComp(
  db: Database,
  config: Pick<Config, "adminGithubLogins">,
  actor: { userId: string; runId: string },
): Promise<AdminAutoCompResult> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ compedBy: runs.compedBy, compInterventionId: runs.compInterventionId })
      .from(runs)
      .where(and(eq(runs.id, actor.runId), eq(runs.ownerId, actor.userId)))
      .for("update")
      .limit(1);
    if (!run) return { comped: false };
    if (run.compedBy !== null && run.compInterventionId !== null) {
      return { comped: true, already: true, interventionId: run.compInterventionId };
    }
    const [owner] = await tx
      .select({ githubLogin: users.githubLogin })
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1);
    if (!owner || !isAdminLogin(config, owner.githubLogin)) return { comped: false };
    const [iv] = await tx
      .insert(interventions)
      .values({
        runId: actor.runId,
        userId: actor.userId,
        who: owner.githubLogin,
        what: "comp",
        why: ADMIN_AUTO_COMP_REASON,
      })
      .returning({ id: interventions.id });
    await tx
      .update(runs)
      .set({
        compedBy: owner.githubLogin,
        compedReason: ADMIN_AUTO_COMP_REASON,
        compInterventionId: iv!.id,
      })
      .where(eq(runs.id, actor.runId));
    return { comped: true, already: false, interventionId: iv!.id };
  });
}

/** The default gate described above. Pass `db` to enable the comped-run and admin auto-comp path. */
export function defaultBillingGate(config: GateConfig, db?: Database): BillingGate {
  return async (actor, estimateMicroUsd) => {
    if (config.BILLING_MODE === "off") return { allowed: true };
    if (db && actor.runId) {
      const comp = await adminAutoComp(db, config, { userId: actor.userId, runId: actor.runId });
      if (comp.comped) return { allowed: true };
    }
    let reason: PaymentRequired["reason"] = "no_payment_method";
    if (db) {
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.userId, actor.userId))
        .limit(1);
      const decision = accountGateDecision(
        account,
        estimateMicroUsd,
        config.NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD,
      );
      if (decision === null) return { allowed: true };
      reason = decision;
    }
    return { allowed: false, reason, link_card_url: linkCardUrl(config, actor.runId) };
  };
}
