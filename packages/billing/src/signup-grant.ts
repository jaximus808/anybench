// The signup credit grant (plan.md section 8, 10.7), kept working after TDM-223. The free starter
// run (free-run.ts) replaced the $5 grant as the way a new user gets a first benchmark free, so
// SIGNUP_GRANT_MICRO_USD now defaults to 0 (off). Set it above 0 and every eligible account (a
// GitHub account older than 90 days, the same rule as the free run) gets that much once, on
// sign-in; the one-signup-grant-per-user index makes repeats a no-op.
//
// Note: this is our ledger's grant only. The Stripe credit grant that makes Stripe apply it to the
// invoice is 10.7's (billing.credit_grants.create); until that lands, keep it at 0 in production.
import { NonNegativeMicroUsdSchema, UserIdSchema, type MicroUsd } from "@anybench/core";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { FREE_RUN_MIN_GITHUB_AGE_DAYS, githubAgeEligible } from "./free-run.js";
import { createLedger, type ApplyGrantResult, type LedgerDb } from "./ledger.js";
import { users } from "./tables.js";

export const SIGNUP_GRANT_REASON = "signup grant";

export const ApplySignupGrantInputSchema = z.object({
  userId: UserIdSchema,
  /** SIGNUP_GRANT_MICRO_USD. 0 = off. */
  amount: NonNegativeMicroUsdSchema,
  now: z.date().optional(),
  minGithubAgeDays: z.int().nonnegative().default(FREE_RUN_MIN_GITHUB_AGE_DAYS),
});
export type ApplySignupGrantInput = z.input<typeof ApplySignupGrantInputSchema>;

export type SignupGrantResult =
  | { status: "off" }
  | { status: "not_eligible"; reason: "unknown_user" | "github_account_too_new" }
  | ApplyGrantResult;

/** Apply the signup grant to `userId` if it is on and the account is eligible. Idempotent. */
export async function applySignupGrant(
  db: LedgerDb,
  raw: ApplySignupGrantInput,
): Promise<SignupGrantResult> {
  const input = ApplySignupGrantInputSchema.parse(raw);
  const amount: MicroUsd = input.amount;
  if (amount === 0n) return { status: "off" };
  const [user] = await db
    .select({ githubCreatedAt: users.githubCreatedAt })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!user) return { status: "not_eligible", reason: "unknown_user" };
  if (!githubAgeEligible(user.githubCreatedAt, input.now ?? new Date(), input.minGithubAgeDays)) {
    return { status: "not_eligible", reason: "github_account_too_new" };
  }
  return createLedger(db).applyGrant({
    userId: input.userId,
    amount,
    category: "promotional",
    source: "signup",
    reason: SIGNUP_GRANT_REASON,
  });
}
