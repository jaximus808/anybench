import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { COST_SOURCES } from "./_enums.js";
import { idPk, inList, microUsd, tstz } from "./_shared.js";
import { runs } from "./runs.js";

/** Our COGS: what Naïve, Vultr and storage cost us, per run where known. */
export const costEntries = pgTable(
  "cost_entries",
  {
    id: idPk(),
    source: text("source", { enum: COST_SOURCES }).notNull(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    amountMicroUsd: microUsd("amount_micro_usd").notNull(),
    /** External reference (Naïve session id, Vultr instance id, ...). */
    ref: text("ref"),
    at: tstz("at").notNull().defaultNow(),
  },
  (t) => [
    index("cost_entries_run_id_idx").on(t.runId),
    index("cost_entries_at_idx").on(t.at),
    check("cost_entries_source_check", inList(t.source, COST_SOURCES)),
  ],
);
