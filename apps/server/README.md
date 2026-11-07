# apps/server

Hono API + orchestrator worker + Drizzle/Postgres. The API runs on Vercel Functions, the worker on the Oracle VM.

See plan.md, sections 4, 6 and E1.4, E6.1, E8.2.

## Database (TDM-11)

- Schema: `src/db/schema/<table>.ts`, one file per table (plan.md section 10), barrel `src/db/schema/index.ts`. Money columns are `bigint` (TS `bigint`, micro-USD). Text enums are `text` + `CHECK`, values in `src/db/schema/_enums.ts`. Schema files must not import `@anybench/*` (drizzle-kit loads them via CJS).
- Migrations: `drizzle/`. `0000_init` is generated; `0001_rls_and_intervention_guards` is hand-written (role, RLS, triggers). New migrations: edit the schema, then `pnpm --filter server db:generate --name <what>`; hand-written SQL: `pnpm exec drizzle-kit generate --custom --name <what>`.
- `pnpm --filter server db:up` starts local Postgres 16 (`docker-compose.dev.yml`, host port 55432). `db:migrate` applies migrations to `DATABASE_URL_DIRECT` (Neon unpooled), else `LOCAL_DATABASE_URL`, else the local default.
- Tenancy: tenant code goes through `scopedDb(actor).transaction(tx => ...)` (`src/db/scoped.ts`). A `{kind: "user", userId}` actor runs as the non-owner role `anybench_app` with `app.actor_id` set (both `SET LOCAL`, so PgBouncer-safe), and RLS on `runs, kits, trials, reviews, reports, events, user_secrets` filters by `owner_id` even without a WHERE. `{kind: "system", reason}` is the table owner and sees everything. RLS tenant rows carry their own `owner_id` (copy it from the run).
- Triggers: an `admin` credit grant needs `intervention_id` for the same user; comping a run (`comped_by`) needs `comp_intervention_id` for that run; comped `usage_entries` need an intervention for their run. `signup` grants are free of that but unique per user.
- Tests: `test/db-*-tdm11.test.ts` create a fresh migrated database per file on `LOCAL_DATABASE_URL`; they skip without Postgres unless `ANYBENCH_REQUIRE_DB=1` (CI).

## Server skeleton (TDM-14)

- `pnpm --filter server dev` serves the API (`src/main.ts`, @hono/node-server, port `PORT`, default 8787). `pnpm --filter server dev:worker` runs graphile-worker (`src/worker.ts`) on `DATABASE_URL_DIRECT`. Both load `apps/server/.env` if present; real env vars win. Without DB vars they use the local Docker Postgres.
- `src/app.ts` `createApp(deps)` is pure (no listen, no env reads, no module state). `deps` (`src/types.ts`): `config`, `logger`, `db` (pooled), `sentry`. `src/entry-vercel.ts` is the Vercel stub (TDM-154).
- `src/config.ts` `loadConfig()` validates env with zod and throws one `ConfigError` listing every bad var; entries print it and exit 1. Add new vars there and to `.env.example`.
- Routes: `src/routes/<resource>.ts` exporting `<resource>Routes(deps)`, mounted with one line in `src/routes/index.ts`. Errors are `{ error: { code, message, requestId } }`; every response carries `X-Request-Id`.
- Jobs: `src/jobs/<name>.ts` with `defineJob({ name, payload, run, cron?, everyMs?, jobKey? })`, one line in `src/jobs/index.ts`.
- `GET /health` (DB ping on the pooled URL) and `GET /health/worker` (newest `worker_heartbeats.last_tick_at`, stale after 60 s; the worker enqueues `worker.heartbeat` every 15 s). Both 503 when unhealthy.
- Logs: pino JSON (`src/lib/logger.ts`), auth/cookie headers blanked, every line passed through core `createRedactor`. Sentry (`src/lib/sentry.ts`) is a no-op without `SENTRY_DSN`.
