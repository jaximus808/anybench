import { pgTable, text } from "drizzle-orm/pg-core";
import { tstz } from "./_shared.js";

/** Never email these addresses again. Store emails lowercased. */
export const suppressions = pgTable("suppressions", {
  email: text("email").primaryKey(),
  reason: text("reason").notNull(),
  at: tstz("at").notNull().defaultNow(),
});
