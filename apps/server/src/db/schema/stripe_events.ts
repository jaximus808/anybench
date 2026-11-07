import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { tstz } from "./_shared.js";

/** Stripe webhook inbox: inserted first (id = evt_…) so redelivery is a no-op. */
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: tstz("received_at").notNull().defaultNow(),
  processedAt: tstz("processed_at"),
  lastError: text("last_error"),
});
