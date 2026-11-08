# graphile-worker 0.18 notes (TDM-14)

- **Cron is minute-granular.** A 15 s heartbeat cannot be a crontab line. `src/jobs/runner.ts` handles `everyMs` jobs itself: `runner.addJob(name, {}, { jobKey, jobKeyMode: "replace" })` on a `setInterval`, so a slow worker collapses to one pending job instead of a backlog.
- **An empty `crontab: ""` is ignored and graphile reads `./crontab` from cwd.** Seen when running `pnpm --filter server dev:worker`:
  `Failed to read crontab file '/Users/jaxon/coding-project/anybench-wt/TDM-14/apps/server/crontab'; cron is disabled`.
  The fix is to pass `parsedCronItems: parseCrontab(text)`, which is `[]` for empty text.
- Every completed job logs at `info` with the full job row (`Completed task 1 (worker.heartbeat, 35.49ms) with success`). The pino adapter downgrades these to `debug`.
- It runs its own migrations into the `graphile_worker` schema the first time `run()` connects, and uses LISTEN/NOTIFY. That is why it needs `DATABASE_URL_DIRECT`, not the PgBouncer pooled URL.
- Smoke run (local Postgres on 55432, a scratch database): `PORT=18787 pnpm dev` + `pnpm dev:worker`, then
  `curl localhost:18787/health` → `{"ok":true,"env":"local","paused":false,"uptimeSec":6,"db":{"ok":true,"latencyMs":4}} 200`,
  `curl localhost:18787/health/worker` → `{"ok":true,"workerId":"Jaxons-MacBook-Air.local:67879","lastTickAt":"2026-11-07T21:51:06.259Z","ageSec":2,"maxAgeSec":60} 200`;
  `worker_heartbeats.ticks` reached 2 after about 17 s.

## Stale locks after a kill, and keys held by a locked job (worker-hardening, 2026-11-08)

- A killed worker's jobs stay locked (`locked_by = worker-<random hex>`, `locked_at`) until
  graphile's 4 h lock timeout. `graphile_worker.force_unlock_workers(text[])` clears `locked_by` /
  `locked_at` on `_private_jobs` and `_private_job_queues` for those ids (sql/000016.sql).
- graphile picks worker ids at random and refuses `workerId` when `concurrency > 1`
  (dist/main.js: "You must not set workerId when concurrency > 1"). The ids are only visible on the
  `worker:create` event; `run({ events })` takes an EventEmitter before start, so we collect them
  there and store them in `worker_heartbeats.graphile_worker_ids` (apps/server/src/jobs/stale-locks.ts).
- `add_job` with a key held by a LOCKED job (sql/000020.sql, add_jobs): "Ensure any locked jobs have
  their key cleared ... create a new job instead". The locked job gets `key = null,
  attempts = max_attempts`, and a new job is inserted. So a running job can re-enqueue itself under
  its own key (a paused trial.execute / trial.gate during a provider outage) and the new job starts
  at attempts 0.
- Evidence: `pnpm --filter server exec vitest run test/worker-hardening.test.ts` (6 passed): a job
  locked by a dead worker's id is freed on the next worker start and the trial re-attaches to the
  live runner with no second `execDetached`.
