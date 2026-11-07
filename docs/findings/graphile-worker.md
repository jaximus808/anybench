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
