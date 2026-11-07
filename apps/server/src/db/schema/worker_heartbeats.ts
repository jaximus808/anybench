import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { tstz } from "./_shared.js";

/**
 * Worker liveness (TDM-14). The `worker.heartbeat` job upserts one row per worker process every
 * 15 s; GET /health/worker reports the age of the newest `last_tick_at`. Not tenant data (no RLS).
 */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  /** `<hostname>:<pid>` unless WORKER_ID is set. */
  workerId: text("worker_id").primaryKey(),
  host: text("host").notNull(),
  pid: integer("pid").notNull(),
  startedAt: tstz("started_at").notNull(),
  lastTickAt: tstz("last_tick_at").notNull().defaultNow(),
  /** Ticks written by this process since it started. */
  ticks: integer("ticks").notNull().default(0),
});
