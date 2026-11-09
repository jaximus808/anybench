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
import { RUN_CANCEL_CAUSES, RUN_STATES } from "./_enums.js";
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
    /**
     * TDM-242: what the run has spent against its budget limit so far (orchestrator/budget.ts):
     * run fee + compute at billed price + managed tokens, live while the run goes (a running
     * computer counts its blocks so far), the ledger's charges once it is terminal. A free run
     * counts compute at our cost against FREE_RUN_CAP_MICRO_USD (budget_basis `free_run`).
     */
    spentMicroUsd: microUsdZero("spent_micro_usd"),
    /**
     * TDM-242: the worst case of the trials launched but not finished: each one's compute up to
     * its wall-clock cap (minus what it already spent) plus its managed-token cap where we pay.
     */
    committedMicroUsd: microUsdZero("committed_micro_usd"),
    /** TDM-242: model tokens on the user's own key (BYOK), runner-metered. Not billed by us. */
    byokTokenMicroUsd: microUsdZero("byok_token_micro_usd"),
    /**
     * TDM-245: the most the run may spend on the user's own model key (BYOK), or null for no limit.
     * Held like the budget: a trial launches only when BYOK spent + the BYOK caps of the trials in
     * flight + its own BYOK cap fit (orchestrator/budget.ts).
     */
    byokTokenLimitMicroUsd: microUsd("byok_token_limit_micro_usd"),
    /** TDM-242: `billed` (limit = budget_micro_usd) or `free_run` (limit = the free-run cap). */
    budgetBasis: text("budget_basis", { enum: ["billed", "free_run"] })
      .notNull()
      .default("billed"),
    /** TDM-242: the limit spent + committed is held to; null = budget_micro_usd. */
    budgetLimitMicroUsd: microUsd("budget_limit_micro_usd"),
    estimateMicroUsd: microUsd("estimate_micro_usd"),
    kitId: uuid("kit_id").references((): AnyPgColumn => kits.id, { onDelete: "set null" }),
    /** Next events.seq for this run; bumped atomically by the event writer. */
    nextSeq: bigint("next_seq", { mode: "number" }).notNull().default(1),
    cancelRequestedAt: tstz("cancel_requested_at"),
    /**
     * Who cancelled the run (TDM-54): `user` (POST /runs/:id/cancel) or `ours` (a kill switch,
     * ANYBENCH_PAUSE, the 9.3 auto-actions). Billing ([10.12]) bills compute only for `user`.
     */
    cancelCause: text("cancel_cause", { enum: RUN_CANCEL_CAUSES }),
    /**
     * What the orchestrator ([5.9], jobs/run-advance.ts) keeps between stages: the understander's
     * and researcher's outputs, the env build, the score, a hold's `held_from`, `finalized_at`.
     * Shape: RunStageOutputsSchema in jobs/run-advance.ts.
     */
    stageOutputs: jsonb("stage_outputs").notNull().default({}),
    /** run.advance lease (TDM-54): `<worker id>~<worker started ms>~<nonce>`, like trials. */
    advanceLeaseOwner: text("advance_lease_owner"),
    advanceLeaseUntil: tstz("advance_lease_until"),
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
    check("runs_budget_basis_check", inList(t.budgetBasis, ["billed", "free_run"])),
    check(
      "runs_cancel_cause_check",
      sql`${sql.identifier("cancel_cause")} is null or ${inList(t.cancelCause, RUN_CANCEL_CAUSES)}`,
    ),
  ],
);
