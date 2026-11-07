// Job definition contract (TDM-14). See jobs/index.ts for how to add one.
import type { JobHelpers } from "graphile-worker";
import type { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import type { Logger } from "../lib/logger.js";
import type { SentryHandle } from "../lib/sentry.js";

/** What every job gets besides its payload. `db` is on the DIRECT url (worker process only). */
export interface JobContext {
  config: Config;
  logger: Logger;
  db: Database;
  sentry: SentryHandle;
  workerId: string;
  workerStartedAt: Date;
}

export interface JobDef<P extends z.ZodType = z.ZodType> {
  /** Dotted task name from plan.md section 5, e.g. "run.advance". */
  name: string;
  /** Payload schema, validated before `run`; an invalid payload is logged, sent to Sentry and dropped
   *  (never retried). Throwing from `run` makes graphile-worker retry with backoff. */
  payload: P;
  run(payload: z.infer<P>, ctx: JobContext, helpers: JobHelpers): Promise<void>;
  /** graphile-worker crontab schedule (minute granularity), e.g. "*\/5 * * * *". */
  cron?: string;
  /**
   * Sub-minute schedule: the worker enqueues this job every `everyMs` with `jobKey(ctx)` and
   * jobKeyMode "replace", so a slow worker never builds a backlog. Payload is `{}`.
   */
  everyMs?: number;
  /** job_key convention (plan.md section 5): `<table>:<id>:<attempt>`. */
  jobKey?: (ctx: JobContext) => string;
}

/** Identity helper that keeps the payload type tied to the schema. */
export function defineJob<P extends z.ZodType>(def: JobDef<P>): JobDef<P> {
  return def;
}
