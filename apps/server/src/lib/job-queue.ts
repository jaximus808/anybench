// Enqueue graphile-worker jobs from the API (TDM-67).
//
// The default queue calls graphile-worker's own `graphile_worker.add_job(...)` SQL function on the
// pooled connection (one statement, no extra pool, fine through PgBouncer transaction mode; the
// function's NOTIFY wakes the worker). It runs as the table owner, outside the caller's tenant
// transaction (anybench_app has no grants on the graphile_worker schema), so callers enqueue AFTER
// their write commits. The graphile_worker schema is installed by the worker on startup.
// Every job carries a job key (`<table>:<id>:<attempt>`, plan.md section 5) so duplicates collapse.
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";

export interface EnqueueOptions {
  /** Required: retries and duplicate enqueues collapse on it. */
  jobKey: string;
  maxAttempts?: number;
}

export interface JobQueue {
  add(task: string, payload: Record<string, unknown>, options: EnqueueOptions): Promise<void>;
}

export function graphileJobQueue(db: Database): JobQueue {
  return {
    async add(task, payload, options) {
      await db.execute(sql`
        select graphile_worker.add_job(
          identifier => ${task}::text,
          payload => ${JSON.stringify(payload)}::json,
          job_key => ${options.jobKey}::text,
          max_attempts => ${options.maxAttempts ?? null}::int
        )`);
    },
  };
}
