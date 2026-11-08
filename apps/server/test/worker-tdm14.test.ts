// TDM-14: the graphile-worker runner runs worker.heartbeat against local Postgres.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { workerHeartbeats } from "../src/db/schema/worker_heartbeats.js";
import { JOBS } from "../src/jobs/index.js";
import { buildCrontab, buildTaskList, startWorker, type WorkerHandle } from "../src/jobs/runner.js";
import { defineJob, type JobContext } from "../src/jobs/types.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import {
  appTdm14,
  configTdm14,
  recordingSentryTdm14,
  silentLoggerTdm14,
} from "./helpers/server-tdm14.js";

const hasDb = await pgAvailableTdm11();

describe("job registry (TDM-14)", () => {
  it("registers worker.heartbeat on a 15 s schedule with a per-worker job key", () => {
    const hb = JOBS.find((j) => j.name === "worker.heartbeat");
    expect(hb?.everyMs).toBe(15_000);
    expect(new Set(JOBS.map((j) => j.name)).size).toBe(JOBS.length);
    expect(
      buildCrontab([
        defineJob({ name: "a.b", payload: z.object({}), cron: "*/5 * * * *", run: async () => {} }),
      ]),
    ).toBe("*/5 * * * * a.b");
  });

  it("drops a job with an invalid payload and reports it, without running it", async () => {
    let ran = false;
    const sentry = recordingSentryTdm14();
    const job = defineJob({
      name: "tdm14.strict",
      payload: z.object({ runId: z.string() }),
      run: async () => {
        ran = true;
      },
    });
    const ctx = { logger: silentLoggerTdm14(), sentry } as unknown as JobContext;
    const list = buildTaskList([job], ctx);
    await list["tdm14.strict"]!({ runId: 5 }, {} as never);
    expect(ran).toBe(false);
    expect(sentry.captured).toHaveLength(1);
  });
});

describe.skipIf(!hasDb)("worker runner (TDM-14)", () => {
  let fresh: FreshDbTdm11;
  let worker: WorkerHandle | undefined;

  beforeAll(async () => {
    fresh = await freshMigratedDbTdm11();
  }, 120_000);
  afterAll(async () => {
    await worker?.stop();
    // worker.stop() now awaits graphile-worker's pool.end() (startWorker passes its own pgPool);
    // the wait below stays as a belt-and-braces guard against 57P01 at `drop ... with (force)`.
    if (fresh) await waitForOnlyOwnBackendsTdm169(fresh);
    await fresh?.drop();
  }, 60_000);

  it("writes a heartbeat row that /health/worker reports as healthy", async () => {
    const workerId = `tdm14-${randomBytes(4).toString("hex")}`;
    worker = await startWorker({
      config: configTdm14(fresh.url),
      logger: silentLoggerTdm14(),
      sentry: recordingSentryTdm14(),
      workerId,
      pollIntervalMs: 200,
    });

    let row: { ticks: number } | undefined;
    for (let i = 0; i < 100 && !row; i++) {
      [row] = await fresh.db
        .select({ ticks: workerHeartbeats.ticks })
        .from(workerHeartbeats)
        .where(eq(workerHeartbeats.workerId, workerId));
      if (!row) await new Promise((r) => setTimeout(r, 200));
    }
    expect(row?.ticks).toBe(1);

    const h = appTdm14(fresh.url);
    try {
      const res = await h.app.request("/health/worker");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, workerId });
    } finally {
      await h.dbh.close();
    }

    await worker.stop();
    worker = undefined;
  });
});

/** Poll pg_stat_activity until the fresh DB has no client backends beyond `fresh`'s own pool. */
async function waitForOnlyOwnBackendsTdm169(fresh: FreshDbTdm11, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await fresh.pool.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and backend_type = 'client backend'",
    );
    if ((rows[0]?.n ?? 0) <= fresh.pool.totalCount || Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
