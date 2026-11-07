import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { USAGE_TYPES } from "./_enums.js";
import { createdAt, idPk, inList, microUsd, tstz } from "./_shared.js";
import { interventions } from "./interventions.js";
import { runs } from "./runs.js";
import { trials } from "./trials.js";
import { users } from "./users.js";

/**
 * Our usage ledger in micro-USD. Each row is one Stripe meter event (identifier = id), unless comped.
 * Comped rows (comped_by set) need intervention_id for the same run; a trigger enforces it.
 */
export const usageEntries = pgTable(
  "usage_entries",
  {
    id: idPk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    trialId: uuid("trial_id").references(() => trials.id, { onDelete: "set null" }),
    type: text("type", { enum: USAGE_TYPES }).notNull(),
    amountMicroUsd: microUsd("amount_micro_usd").notNull(),
    stripeMeterEventId: text("stripe_meter_event_id"),
    reportedAt: tstz("reported_at"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    compedBy: text("comped_by"),
    interventionId: uuid("intervention_id").references(() => interventions.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_entries_user_id_idx").on(t.userId),
    index("usage_entries_run_id_idx").on(t.runId),
    check("usage_entries_type_check", inList(t.type, USAGE_TYPES)),
  ],
);
