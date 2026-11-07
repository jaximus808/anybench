// graphile-worker runner (TDM-14): builds the task list and crontab from JOBS, connects on
// DATABASE_URL_DIRECT (graphile-worker uses LISTEN/NOTIFY, which PgBouncer would break), and
// drives the sub-minute `everyMs` schedules.
import { hostname } from "node:os";
import {
  Logger as GraphileLogger,
  parseCrontab,
  run,
  type Runner,
  type Task,
  type TaskList,
} from "graphile-worker";
import type { Config } from "../config.js";
import { createDb, type DbHandle } from "../db/client.js";
import type { Logger } from "../lib/logger.js";
import type { SentryHandle } from "../lib/sentry.js";
import { JOBS } from "./index.js";
import type { JobContext, JobDef } from "./types.js";

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
  const dbh: DbHandle = createDb(config.databaseUrlDirect, { max: 2 });
  const ctx: JobContext = {
    config,
    logger,
    db: dbh.db,
    sentry,
    workerId,
    workerStartedAt: new Date(),
  };

  const runner = await run({
    connectionString: config.databaseUrlDirect,
    concurrency: config.WORKER_CONCURRENCY,
    noHandleSignals: true,
    pollInterval: options.pollIntervalMs ?? 2000,
    taskList: buildTaskList(jobs, ctx),
    // parsedCronItems (not `crontab`): an empty crontab string makes graphile read ./crontab.
    parsedCronItems: parseCrontab(buildCrontab(jobs)),
    logger: graphileLogger(logger),
  });
  runner.events.on("job:error", ({ job, error }) => {
    sentry.captureException(error, {
      job: job.task_identifier,
      jobId: job.id,
      attempts: job.attempts,
    });
  });

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
      await runner.stop();
      await dbh.close();
    })();
    return stopped;
  };
  return { workerId, runner, done: runner.promise, stop };
}
