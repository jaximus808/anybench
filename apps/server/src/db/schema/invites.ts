import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, tstz } from "./_shared.js";
import { leads } from "./leads.js";
import { runs } from "./runs.js";
import { users } from "./users.js";

/** Invite links from outreach; the token is stored only as a hash. */
export const invites = pgTable("invites", {
  tokenHash: text("token_hash").primaryKey(),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  expiresAt: tstz("expires_at").notNull(),
  clickedAt: tstz("clicked_at"),
  claimedBy: uuid("claimed_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});
