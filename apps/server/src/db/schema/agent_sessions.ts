import { bigint, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk, microUsd, microUsdZero, updatedAt } from "./_shared.js";
import { runs } from "./runs.js";

/** One Naïve session for one of our agent roles. id doubles as the Naïve idempotencyKey. */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: idPk(),
    /** NULL for company agents (scout, account manager) that are not tied to a run. */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    naiveSessionId: text("naive_session_id").unique(),
    budgetMicroUsd: microUsd("budget_micro_usd").notNull(),
    costMicroUsd: microUsdZero("cost_micro_usd"),
    status: text("status").notNull().default("pending"),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    stopReason: text("stop_reason"),
    /** Pending confirmTool / answer request, if any. */
    pendingAction: jsonb("pending_action"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("agent_sessions_run_id_idx").on(t.runId)],
);
