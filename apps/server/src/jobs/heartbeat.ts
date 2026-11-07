// worker.heartbeat (TDM-14): proves the worker is alive AND draining its queue. The worker enqueues
// it every 15 s; running it upserts this process's worker_heartbeats row, read by /health/worker.
import { sql } from "drizzle-orm";
import { z } from "zod";
import { workerHeartbeats } from "../db/schema/worker_heartbeats.js";
import { WORKER_TICK_INTERVAL_MS } from "../lib/worker-health.js";
import { defineJob, type JobContext } from "./types.js";

export async function writeHeartbeat(ctx: JobContext): Promise<void> {
  const [host = ctx.workerId] = ctx.workerId.split(":");
  await ctx.db
    .insert(workerHeartbeats)
    .values({
      workerId: ctx.workerId,
      host,
      pid: process.pid,
      startedAt: ctx.workerStartedAt,
      lastTickAt: sql`now()`,
      ticks: 1,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        lastTickAt: sql`now()`,
        pid: process.pid,
        startedAt: ctx.workerStartedAt,
        // Reset the counter when a new process reuses the id (e.g. WORKER_ID set on the VM).
        ticks: sql`case when ${workerHeartbeats.startedAt} = ${ctx.workerStartedAt.toISOString()}::timestamptz then ${workerHeartbeats.ticks} + 1 else 1 end`,
      },
    });
}

export const heartbeatJob = defineJob({
  name: "worker.heartbeat",
  payload: z.object({}),
  everyMs: WORKER_TICK_INTERVAL_MS,
  jobKey: (ctx) => `worker_heartbeats:${ctx.workerId}`,
  async run(_payload, ctx) {
    await writeHeartbeat(ctx);
    ctx.logger.debug({ job: "worker.heartbeat" }, "tick");
  },
});
