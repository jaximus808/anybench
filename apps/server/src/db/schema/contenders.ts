import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { CONTENDER_STATUSES } from "./_enums.js";
import { createdAt, idPk, inList } from "./_shared.js";
import { kits } from "./kits.js";
import { runs } from "./runs.js";

export const contenders = pgTable(
  "contenders",
  {
    id: idPk(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    kitId: uuid("kit_id").references(() => kits.id, { onDelete: "set null" }),
    source: text("source").notNull(),
    role: text("role").notNull(),
    status: text("status", { enum: CONTENDER_STATUSES }).notNull().default("candidate"),
    reason: text("reason"),
    /** Which agent role or person found it (e.g. "researcher", "user"). */
    foundBy: text("found_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("contenders_run_id_idx").on(t.runId),
    check("contenders_status_check", inList(t.status, CONTENDER_STATUSES)),
  ],
);
