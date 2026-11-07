import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { CREDIT_GRANT_CATEGORIES, CREDIT_GRANT_SOURCES } from "./_enums.js";
import { createdAt, idPk, inList, microUsd, tstz } from "./_shared.js";
import { interventions } from "./interventions.js";
import { users } from "./users.js";

/**
 * Credit grants mirrored from Stripe. `admin` grants need intervention_id pointing at an
 * interventions row for the same user (DB trigger); `signup` grants happen at most once per user.
 */
export const creditGrants = pgTable(
  "credit_grants",
  {
    id: idPk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stripeCreditGrantId: text("stripe_credit_grant_id").unique(),
    amountMicroUsd: microUsd("amount_micro_usd").notNull(),
    category: text("category", { enum: CREDIT_GRANT_CATEGORIES }).notNull(),
    source: text("source", { enum: CREDIT_GRANT_SOURCES }).notNull(),
    reason: text("reason").notNull(),
    interventionId: uuid("intervention_id").references(() => interventions.id),
    expiresAt: tstz("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("credit_grants_user_id_idx").on(t.userId),
    uniqueIndex("credit_grants_one_signup_per_user_uq")
      .on(t.userId)
      .where(sql`${t.source} = 'signup'`),
    check("credit_grants_amount_positive", sql`${t.amountMicroUsd} > 0`),
    check("credit_grants_category_check", inList(t.category, CREDIT_GRANT_CATEGORIES)),
    check("credit_grants_source_check", inList(t.source, CREDIT_GRANT_SOURCES)),
  ],
);
