# Postgres RLS and the local dev database (TDM-11)

## Host port 5432 was taken

```
$ lsof -iTCP:5432 -sTCP:LISTEN
com.docke 7103 jaxon ... TCP localhost:postgresql (LISTEN)
$ docker ps --format '{{.Names}} {{.Ports}}'
cp-test-pg 127.0.0.1:5432->5432/tcp
```

So `docker-compose.dev.yml` publishes Postgres on **55432** (override with `ANYBENCH_PG_PORT`), and
`LOCAL_DATABASE_URL` defaults to `postgres://anybench:anybench@localhost:55432/anybench`.

## Table owners bypass RLS

The app connects as the table owner (`anybench` locally, `neondb_owner` on Neon), and owners skip
RLS unless `FORCE ROW LEVEL SECURITY`. We use a non-owner role instead: migration 0001 creates
`anybench_app` (NOLOGIN), grants it to the migrating user, and `scopedDb` does
`SET LOCAL ROLE anybench_app` + `set_config('app.actor_id', $1, true)` per transaction.

Mutation check: with the `SET LOCAL ROLE` line removed from `scoped.ts`,

```
$ LOCAL_DATABASE_URL=... npx vitest run test/db-rls-tdm11.test.ts
      Tests  6 failed | 4 passed (10)
```

(actor A then sees B's run), so the tests do catch an owner-bypass regression. With it restored all 10 pass.

## Fresh-database migrate

```
$ docker exec anybench-dev-postgres-1 psql -U anybench -d anybench -c "create database anybench_tdm11_fresh"
$ DATABASE_URL_DIRECT=postgres://anybench:anybench@localhost:55432/anybench_tdm11_fresh pnpm --filter server db:migrate
[✓] migrations applied successfully!
$ psql ... -c "select tablename, rowsecurity from pg_tables where rowsecurity"
 runs | kits | trials | reviews | reports | events | user_secrets   (all t)
```

## drizzle-kit cannot load ESM-only workspace packages

Importing `@anybench/core` from a schema file broke `drizzle-kit generate` with
`ERR_PACKAGE_PATH_NOT_EXPORTED`: drizzle-kit loads the schema through CJS `require`, and
`@anybench/*` packages export only the `import` condition. Schema files stay self-contained.

## Not yet verified on Neon

Untested on Neon: `CREATE ROLE` + `GRANT anybench_app TO neondb_owner` as `neondb_owner`. It should
work (Neon's owner role has CREATEROLE and gets ADMIN on roles it creates), but check it when the
Neon dev branch is wired (TDM-151).
