// GET /health and GET /health/worker (TDM-14), for the uptime monitor (plan.md section 7).
import { desc, sql } from "drizzle-orm";
import { Hono } from "hono";
import { workerHeartbeats } from "../db/schema/worker_heartbeats.js";
import { WORKER_MAX_TICK_AGE_MS } from "../lib/worker-health.js";
import type { AppDeps, AppEnv } from "../types.js";

const DB_PING_TIMEOUT_MS = 2_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function healthRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    const start = performance.now();
    let db: { ok: boolean; latencyMs?: number; error?: string };
    try {
      await withTimeout(deps.db.execute(sql`select 1`), DB_PING_TIMEOUT_MS, "db ping");
      db = { ok: true, latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      c.get("log").warn({ err }, "health: db ping failed");
      db = { ok: false, error: "db unreachable" };
    }
    const body = {
      ok: db.ok,
      env: deps.config.ANYBENCH_ENV,
      paused: deps.config.ANYBENCH_PAUSE,
      uptimeSec: Math.round(process.uptime()),
      db,
    };
    return c.json(body, db.ok ? 200 : 503);
  });

  r.get("/worker", async (c) => {
    const maxAgeSec = WORKER_MAX_TICK_AGE_MS / 1000;
    try {
      // Age is computed by Postgres (now() - last_tick_at): one clock for the writer and the reader,
      // so skew between the worker VM and the API host cannot fake a healthy or a stale worker.
      const rows = await withTimeout(
        deps.db
          .select({
            workerId: workerHeartbeats.workerId,
            lastTickAt: workerHeartbeats.lastTickAt,
            ageMs:
              sql<number>`(extract(epoch from (now() - ${workerHeartbeats.lastTickAt})) * 1000)::float8`.mapWith(
                Number,
              ),
          })
          .from(workerHeartbeats)
          .orderBy(desc(workerHeartbeats.lastTickAt))
          .limit(1),
        DB_PING_TIMEOUT_MS,
        "worker heartbeat read",
      );
      const last = rows[0];
      if (!last) return c.json({ ok: false, reason: "no worker heartbeat yet", maxAgeSec }, 503);
      const ok = last.ageMs <= WORKER_MAX_TICK_AGE_MS;
      return c.json(
        {
          ok,
          ...(ok ? {} : { reason: "worker heartbeat is stale" }),
          workerId: last.workerId,
          lastTickAt: last.lastTickAt.toISOString(),
          ageSec: Math.max(0, Math.round(last.ageMs / 1000)),
          maxAgeSec,
        },
        ok ? 200 : 503,
      );
    } catch (err) {
      c.get("log").warn({ err }, "health: worker heartbeat read failed");
      return c.json({ ok: false, reason: "db unreachable", maxAgeSec }, 503);
    }
  });

  return r;
}
