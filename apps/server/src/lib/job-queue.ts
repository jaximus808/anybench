// Enqueue graphile-worker jobs from the API (TDM-67), inside the caller's transaction.
//
// `add(tx, ...)` calls graphile-worker's own `graphile_worker.add_job(...)` SQL function on the
// caller's transaction, so the job commits or rolls back with the write that needs it: a run is
// never created (or moved by Go, a kit edit or a cancel) without its `run.advance` job. It is one
// statement on the pooled connection, which is fine through PgBouncer transaction mode. add_job's
// NOTIFY fires on commit and wakes the worker.
//
// Tenant transactions run as anybench_app (scopedDb), which has no grants on the graphile_worker
// schema. So the queue switches back to the session role (the owner) only for add_job, then
// restores the tenant role, so RLS stays in force for anything the caller does afterwards. Callers
// still enqueue as the last step of the transaction.
//
// The worker installs the graphile_worker schema on startup (graphile-worker migrations). Without
// it add_job fails, and so does the request; that is intended.
// Every job carries a job key (`<table>:<id>:<attempt>`, plan.md section 5) so duplicates collapse.
import { sql } from "drizzle-orm";
import type { DbTx } from "../db/client.js";
import { APP_ROLE } from "../db/scoped.js";

export interface EnqueueOptions {
  /** Required: retries and duplicate enqueues collapse on it. */
  jobKey: string;
  maxAttempts?: number;
}

export interface JobQueue {
  /** Enqueue `task` in transaction `tx`; the job commits (or rolls back) with it. */
  add(
    tx: DbTx,
    task: string,
    payload: Record<string, unknown>,
    options: EnqueueOptions,
  ): Promise<void>;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return (result as { rows: Record<string, unknown>[] }).rows;
}

export function graphileJobQueue(): JobQueue {
  return {
    async add(tx, task, payload, options) {
      const [row] = rowsOf(await tx.execute(sql`select current_setting('role') as role`));
      const tenant = row?.role === APP_ROLE;
      if (tenant) await tx.execute(sql`reset role`);
      await tx.execute(sql`
        select graphile_worker.add_job(
          identifier => ${task}::text,
          payload => ${JSON.stringify(payload)}::json,
          job_key => ${options.jobKey}::text,
          max_attempts => ${options.maxAttempts ?? null}::int
        )`);
      if (tenant) await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    },
  };
}
