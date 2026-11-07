import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk, updatedAt } from "./_shared.js";
import { runs } from "./runs.js";
import { users } from "./users.js";

/** The delivered report for a run. RLS: owner only. */
export const reports = pgTable("reports", {
  id: idPk(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  runId: uuid("run_id")
    .notNull()
    .unique()
    .references(() => runs.id, { onDelete: "cascade" }),
  json: jsonb("json").notNull(),
  md: text("md").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
