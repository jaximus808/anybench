import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uuid,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { RUN_STATES } from "./_enums.js";
import { createdAt, idPk, inList, microUsd, microUsdZero, tstz, updatedAt } from "./_shared.js";
import { interventions } from "./interventions.js";
import { kits } from "./kits.js";
import { projects } from "./projects.js";
import { users } from "./users.js";

/** One run per (owner, Idempotency-Key) on POST /runs (TDM-67). */
export const RUNS_IDEMPOTENCY_INDEX = "runs_owner_idempotency_key_uq";

/**
 * One benchmark run. RLS: owner only.
 * Comping (comped_by set) requires comp_intervention_id pointing at an interventions row for this
 * run; a trigger enforces it.
 */
export const runs = pgTable(
  "runs",
  {
    id: idPk(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    question: text("question").notNull(),
    /**
     * What POST /runs asked for (TDM-67): `{source, contenders, auto_go}` with the core RunSource
     * and Contender shapes. The orchestrator ([5.9]) reads it to ingest and to decide auto-go.
     */
    intake: jsonb("intake"),
    state: text("state", { enum: RUN_STATES }).notNull().default("intake"),
    budgetMicroUsd: microUsd("budget_micro_usd").notNull(),
    spentMicroUsd: microUsdZero("spent_micro_usd"),
    estimateMicroUsd: microUsd("estimate_micro_usd"),
    kitId: uuid("kit_id").references((): AnyPgColumn => kits.id, { onDelete: "set null" }),
    /** Next events.seq for this run; bumped atomically by the event writer. */
    nextSeq: bigint("next_seq", { mode: "number" }).notNull().default(1),
    cancelRequestedAt: tstz("cancel_requested_at"),
    pausedReason: text("paused_reason"),
    compedBy: text("comped_by"),
    compedReason: text("comped_reason"),
    compInterventionId: uuid("comp_intervention_id").references(
      (): AnyPgColumn => interventions.id,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("runs_owner_id_idx").on(t.ownerId),
    index("runs_state_idx").on(t.state),
    uniqueIndex(RUNS_IDEMPOTENCY_INDEX)
      .on(t.ownerId, sql`(${t.intake}->>'idempotency_key')`)
      .where(sql`${t.intake} ? 'idempotency_key'`),
    check("runs_state_check", inList(t.state, RUN_STATES)),
    check("runs_budget_nonneg", sql`${t.budgetMicroUsd} >= 0`),
  ],
);
