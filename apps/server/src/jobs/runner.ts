// graphile-worker runner (TDM-14): builds the task list and crontab from JOBS, connects on
// DATABASE_URL_DIRECT (graphile-worker uses LISTEN/NOTIFY, which PgBouncer would break), and
// drives the sub-minute `everyMs` schedules.
import { hostname } from "node:os";
import pg from "pg";
import {
  Logger as GraphileLogger,
  parseCrontab,
  run,
  type Runner,
  type Task,
  type TaskList,
} from "graphile-worker";
import type { Config } from "../config.js";
import { createDb, guardPgPool, type DbHandle, type PgErrorSink } from "../db/client.js";
import type { Logger } from "../lib/logger.js";
import type { SentryHandle } from "../lib/sentry.js";
import { JOBS } from "./index.js";
import type { JobContext, JobDef } from "./types.js";

/** Jobs that hold a slot for a whole trial: they get WORKER_CONCURRENCY slots of their own. */
const LONG_TASKS = new Set(["trial.execute"]);
/** Slots for everything else (gates, run.advance, heartbeats, reaper, billing). Each gate holds a
 * fresh scoring computer, so this also bounds scoring computers alive at once. */
const CONTROL_CONCURRENCY = Math.max(
  1,
  Math.min(16, Number(process.env.WORKER_CONTROL_CONCURRENCY ?? "") || 2),
);
export interface StartWorkerOptions {
  config: Config;
  logger: Logger;
  sentry: SentryHandle;
  /** Override the job list (tests). */
  jobs?: readonly JobDef[];
  /** Override the worker id (tests); default WORKER_ID or `<hostname>:<pid>`. */
  workerId?: string;
  /** graphile-worker poll fallback (LISTEN/NOTIFY wakes it immediately anyway). */
  pollIntervalMs?: number;
}

export interface WorkerHandle {
  workerId: string;
  runner: Runner;
  /** Resolves when the runner stops. */
  done: Promise<void>;
  stop(): Promise<void>;
}

function graphileLogger(logger: Logger): GraphileLogger {
  return new GraphileLogger((scope) => (level, message, meta) => {
    const log = logger.child({ graphile: scope.label ?? "worker", ...(meta ?? {}) });
    if (level === "error") log.error(message);
    else if (level === "warning") log.warn(message);
    // Per-job "Completed task" lines are debug: the heartbeat alone would add 4 info lines a minute.
    else if (level === "info" && !message.startsWith("Completed task")) log.info(message);
    else log.debug(message);
  });
}

export function buildTaskList(jobs: readonly JobDef[], ctx: JobContext): TaskList {
  const list: TaskList = {};
  for (const job of jobs) {
    if (list[job.name]) throw new Error(`duplicate job name: ${job.name}`);
    const task: Task = async (raw, helpers) => {
      const parsed = job.payload.safeParse(raw ?? {});
      if (!parsed.success) {
        // Retrying an invalid payload cannot succeed: report it and drop the job.
        const err = new Error(`invalid payload for job ${job.name}`);
        ctx.logger.error({ job: job.name, issues: parsed.error.issues }, err.message);
        ctx.sentry.captureException(err, { job: job.name, issues: parsed.error.issues });
        return;
      }
      await job.run(parsed.data, ctx, helpers);
    };
    list[job.name] = task;
  }
  return list;
}

export function buildCrontab(jobs: readonly JobDef[]): string {
  return jobs
    .filter((j) => j.cron)
    .map((j) => `${j.cron} ${j.name}`)
    .join("\n");
}

export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const { config, sentry } = options;
  const jobs = options.jobs ?? JOBS;
  const workerId = options.workerId ?? config.WORKER_ID ?? `${hostname()}:${process.pid}`;
  const logger = options.logger.child({ workerId });
  // Follow-up 68: a dropped Neon connection is logged and survived, never a process exit.
  const onPgError: PgErrorSink = (err) =>
    logger.warn({ err }, "db: connection error; client dropped, work retries");
  const dbh: DbHandle = createDb(config.databaseUrlDirect, { max: 2, onError: onPgError });
  const ctx: JobContext = {
    config,
    logger,
    db: dbh.db,
    sentry,
    workerId,
    workerStartedAt: new Date(),
  };

  // Our own pool for graphile-worker: runner.stop() calls pgPool.end() without awaiting it when
  // graphile owns the pool, so its connections could outlive stop() and a later
  // `drop database ... with (force)` (tests) or Postgres shutdown would raise unhandled 57P01
  // errors. Passing pgPool means graphile never ends it; stop() awaits graphilePool.end() itself.
  const graphilePool = guardPgPool(
    new pg.Pool({
      connectionString: config.databaseUrlDirect,
      max: Math.max(10, config.WORKER_CONCURRENCY + CONTROL_CONCURRENCY + 2),
      keepAlive: true,
    }),
    onPgError,
  );

  // Two runners on one pool. A trial job holds its slot for the whole trial (up to an hour), so
  // with one shared pool of WORKER_CONCURRENCY slots the gates, run.advance, heartbeats and the
  // reaper queued behind every waiting trial: nothing was graded until almost every trial had run.
  // Trials get WORKER_CONCURRENCY slots; everything else gets its own CONTROL_CONCURRENCY.
  const allTasks = buildTaskList(jobs, ctx);
  const pick = (keep: (name: string) => boolean) =>
    Object.fromEntries(Object.entries(allTasks).filter(([name]) => keep(name)));
  const trialTasks = pick((n) => LONG_TASKS.has(n));
  const controlTasks = pick((n) => !LONG_TASKS.has(n));
  let runner: Runner;
  let trialRunner: Runner | null = null;
  try {
    runner = await run({
      pgPool: graphilePool,
      concurrency: CONTROL_CONCURRENCY,
      noHandleSignals: true,
      pollInterval: options.pollIntervalMs ?? 2000,
      taskList: controlTasks,
      // parsedCronItems (not `crontab`): an empty crontab string makes graphile read ./crontab.
      parsedCronItems: parseCrontab(buildCrontab(jobs)),
      logger: graphileLogger(logger),
    });
    // WORKER_ONLY_CONTROL=1: a second process that only runs the control jobs (gates, advance,
    // heartbeats), next to a worker whose slots are all held by trials.
    if (Object.keys(trialTasks).length > 0 && process.env.WORKER_ONLY_CONTROL !== "1") {
      trialRunner = await run({
        pgPool: graphilePool,
        concurrency: config.WORKER_CONCURRENCY,
        noHandleSignals: true,
        pollInterval: options.pollIntervalMs ?? 2000,
        taskList: trialTasks,
        parsedCronItems: [],
        logger: graphileLogger(logger),
      });
    }
  } catch (err) {
    await Promise.all([graphilePool.end(), dbh.close()]).catch(() => {});
    throw err;
  }
  for (const r of [runner, trialRunner]) {
    r?.events.on("job:error", ({ job, error }) => {
      sentry.captureException(error, {
        job: job.task_identifier,
        jobId: job.id,
        attempts: job.attempts,
      });
    });
  }

  const timers: NodeJS.Timeout[] = [];
  for (const job of jobs.filter((j) => j.everyMs)) {
    const enqueue = () =>
      runner
        .addJob(
          job.name,
          {},
          { jobKey: job.jobKey?.(ctx) ?? `${job.name}:${workerId}`, jobKeyMode: "replace" },
        )
        .catch((err: unknown) =>
          logger.error({ err, job: job.name }, "failed to enqueue scheduled job"),
        );
    void enqueue();
    timers.push(setInterval(enqueue, job.everyMs));
  }

  logger.info({ jobs: jobs.map((j) => j.name) }, "worker started");
  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      for (const t of timers) clearInterval(t);
      await Promise.all([runner.stop(), trialRunner?.stop()]);
      await Promise.all([graphilePool.end(), dbh.close()]);
    })();
    return stopped;
  };
  const done = Promise.all([runner.promise, trialRunner?.promise]).then(() => undefined);
  return { workerId, runner, done, stop };
}
