import { boolean, check, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { PAYMENT_STATUSES } from "./_enums.js";
import { createdAt, inList, microUsd, microUsdZero, tstz, updatedAt } from "./_shared.js";
import { users } from "./users.js";

/** One Stripe customer + subscription per user, and the cached balances the run gate reads. */
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").unique(),
    subscriptionId: text("subscription_id"),
    paymentStatus: text("payment_status", { enum: PAYMENT_STATUSES }).notNull().default("none"),
    hasPaymentMethod: boolean("has_payment_method").notNull().default(false),
    unbilledMicroUsd: microUsdZero("unbilled_micro_usd"),
    grantedRemainingMicroUsd: microUsdZero("granted_remaining_micro_usd"),
    /** Per-account override of NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD; NULL = use the default. */
    spendLimitMicroUsd: microUsd("spend_limit_micro_usd"),
    firstPaidInvoiceAt: tstz("first_paid_invoice_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("billing_accounts_payment_status_check", inList(t.paymentStatus, PAYMENT_STATUSES)),
  ],
);
