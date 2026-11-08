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
  /**
   * worker-hardening: the graphile-worker worker ids this process runs (graphile picks them at
   * random). A lock held by an id no live process claims is stale (jobs/stale-locks.ts).
   */
  graphileWorkerIds: text("graphile_worker_ids").array(),
});
