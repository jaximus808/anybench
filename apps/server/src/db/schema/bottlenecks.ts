import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk } from "./_shared.js";
import { runs } from "./runs.js";

/** Investigator findings: where the subject breaks and what to change. */
export const bottlenecks = pgTable(
  "bottlenecks",
  {
    id: idPk(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    cause: text("cause").notNull(),
    evidence: jsonb("evidence"),
    suggestedFix: text("suggested_fix"),
    trialIds: uuid("trial_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
  },
  (t) => [index("bottlenecks_run_id_idx").on(t.runId)],
);
