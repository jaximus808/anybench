import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { EVENT_SEVERITIES, EVENT_SOURCES } from "./_enums.js";
import { inList, microUsdZero, tstz } from "./_shared.js";
import { runs } from "./runs.js";
import { users } from "./users.js";

/**
 * The one event model (plan.md section 6), validated by the zod AnybenchEvent union in packages/core.
 * RLS: owner only. System events with no run have NULL owner_id and are invisible to tenants.
 * Retention 90 days.
 */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    source: text("source", { enum: EVENT_SOURCES }).notNull(),
    sourceId: text("source_id"),
    type: text("type").notNull(),
    severity: text("severity", { enum: EVENT_SEVERITIES }).notNull().default("info"),
    actor: text("actor"),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    costDeltaMicroUsd: microUsdZero("cost_delta_micro_usd"),
    at: tstz("at").notNull().defaultNow(),
  },
  (t) => [
    unique("events_run_seq_uq").on(t.runId, t.seq),
    index("events_owner_id_idx").on(t.ownerId),
    index("events_at_idx").on(t.at),
    check("events_source_check", inList(t.source, EVENT_SOURCES)),
    check("events_severity_check", inList(t.severity, EVENT_SEVERITIES)),
  ],
);
