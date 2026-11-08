import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { TRIAL_STATES } from "./_enums.js";
import { createdAt, idPk, inList, microUsdZero, tstz, updatedAt } from "./_shared.js";
import { computers } from "./computers.js";
import { contenders } from "./contenders.js";
import { runs } from "./runs.js";
import { users } from "./users.js";

/** One contender × workload × repeat. RLS: owner only (owner_id mirrors runs.owner_id). */
export const trials = pgTable(
  "trials",
  {
    id: idPk(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    contenderId: uuid("contender_id")
      .notNull()
      .references(() => contenders.id, { onDelete: "cascade" }),
    workloadId: text("workload_id").notNull(),
    repeat: integer("repeat").notNull(),
    /** Only failed_infra retries; max 3. */
    attempt: integer("attempt").notNull().default(1),
    state: text("state", { enum: TRIAL_STATES }).notNull().default("queued"),
    leaseOwner: text("lease_owner"),
    leaseUntil: tstz("lease_until"),
    /** Written before install and checked before any create (computers have no idempotency key). */
    computerId: uuid("computer_id").references((): AnyPgColumn => computers.id, {
      onDelete: "set null",
    }),
    provider: text("provider"),
    startedAt: tstz("started_at"),
    endedAt: tstz("ended_at"),
    machine: jsonb("machine"),
    metrics: jsonb("metrics"),
    gate: jsonb("gate"),
    failureClass: text("failure_class"),
    exitCode: integer("exit_code"),
    logOffset: bigint("log_offset", { mode: "number" }).notNull().default(0),
    costMicroUsd: microUsdZero("cost_micro_usd"),
    logsUrl: text("logs_url"),
    /** The attempt's Naïve proxy:write key (TDM-16): its id, never the secret. */
    proxyKeyId: text("proxy_key_id"),
    proxyKeyCreatedAt: tstz("proxy_key_created_at"),
    /** Which attempt the key belongs to (a re-attach reuses it, a retry mints a new one). */
    proxyKeyAttempt: integer("proxy_key_attempt"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("trials_slot_uq").on(t.runId, t.contenderId, t.workloadId, t.repeat),
    index("trials_owner_id_idx").on(t.ownerId),
    index("trials_run_state_idx").on(t.runId, t.state),
    index("trials_lease_idx")
      .on(t.leaseUntil)
      .where(sql`${t.leaseUntil} is not null`),
    check("trials_state_check", inList(t.state, TRIAL_STATES)),
    check("trials_attempt_check", sql`${t.attempt} between 1 and 3`),
  ],
);
