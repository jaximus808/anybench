import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { FREE_STARTER_RUN_STATES } from "./_enums.js";
import { createdAt, idPk, inList, microUsd, microUsdZero, tstz, updatedAt } from "./_shared.js";
import { runs } from "./runs.js";
import { users } from "./users.js";

/**
 * The free starter run entitlement (TDM-223, E20): one per eligible account (GitHub account older
 * than 90 days), recorded when Go reserves it for a run. At most one `reserved` or `consumed` row
 * per user and per run (partial unique indexes), so the entitlement is used once; a `released` row (infra
 * failure, our cancel, Go abandoned) gives it back and stays as history. The run's charges are
 * covered by `free_run` credit grants, so the ledger stays auditable. packages/billing free-run.ts
 * owns every write. Not tenant data (no RLS): read through the billing functions.
 */
export const freeStarterRuns = pgTable(
  "free_starter_runs",
  {
    id: idPk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    state: text("state", { enum: FREE_STARTER_RUN_STATES }).notNull().default("reserved"),
    /** Taken from the pool at Go: projected compute at our cost + agent allowance. */
    reservedMicroUsd: microUsd("reserved_micro_usd").notNull(),
    /** Our kit agents' share, charged to the pool on settle (the run fee for the kit's origin). */
    agentAllowanceMicroUsd: microUsdZero("agent_allowance_micro_usd"),
    /** What the run actually cost us so far, as charged to the pool (computers + allowance). */
    poolSpentMicroUsd: microUsdZero("pool_spent_micro_usd"),
    /** User charges (run fee + compute) covered by free_run grants so far. */
    coveredMicroUsd: microUsdZero("covered_micro_usd"),
    /** Why it was released (`failed_not_subject`, `cancelled_by_us`, `go_abandoned`, ...). */
    releaseReason: text("release_reason"),
    settledAt: tstz("settled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("free_starter_runs_one_per_user_uq")
      .on(t.userId)
      .where(sql`${t.state} in ('reserved', 'consumed')`),
    uniqueIndex("free_starter_runs_one_per_run_uq")
      .on(t.runId)
      .where(sql`${t.state} in ('reserved', 'consumed')`),
    index("free_starter_runs_user_idx").on(t.userId),
    check("free_starter_runs_state_check", inList(t.state, FREE_STARTER_RUN_STATES)),
    check("free_starter_runs_reserved_nonneg", sql`${t.reservedMicroUsd} >= 0`),
  ],
);
