import { index, pgTable, text, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { idPk, tstz } from "./_shared.js";
import { runs } from "./runs.js";
import { users } from "./users.js";

/** Every founder/admin action that bends the rules (grants, comps). Shown on /company. */
export const interventions = pgTable(
  "interventions",
  {
    id: idPk(),
    runId: uuid("run_id").references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    who: text("who").notNull(),
    what: text("what").notNull(),
    why: text("why").notNull(),
    at: tstz("at").notNull().defaultNow(),
  },
  (t) => [
    index("interventions_run_id_idx").on(t.runId),
    index("interventions_user_id_idx").on(t.userId),
  ],
);
