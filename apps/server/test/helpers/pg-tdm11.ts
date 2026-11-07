// Local Postgres test fixture for TDM-11: a fresh, migrated database per test file.
// Uses LOCAL_DATABASE_URL (docker-compose.dev.yml; `pnpm --filter server db:up`).
// Without a reachable Postgres the DB suites skip, unless ANYBENCH_REQUIRE_DB=1 (CI), then they fail.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, DEFAULT_LOCAL_DATABASE_URL, type DbHandle } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

export const LOCAL_URL_TDM11 = process.env.LOCAL_DATABASE_URL || DEFAULT_LOCAL_DATABASE_URL;
export const REQUIRE_DB_TDM11 = process.env.ANYBENCH_REQUIRE_DB === "1";

export async function pgAvailableTdm11(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: LOCAL_URL_TDM11,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch (err) {
    if (REQUIRE_DB_TDM11) throw err;
    console.warn(
      `[db tests] skipped: no Postgres at LOCAL_DATABASE_URL (run \`pnpm --filter server db:up\`): ${String(err)}`,
    );
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export interface FreshDbTdm11 extends DbHandle {
  url: string;
  name: string;
  drop(): Promise<void>;
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: LOCAL_URL_TDM11 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Create an empty database, apply every migration in apps/server/drizzle, return a pool to it. */
export async function freshMigratedDbTdm11(options: { max?: number } = {}): Promise<FreshDbTdm11> {
  const name = `anybench_tdm11_${randomBytes(6).toString("hex")}`;
  await admin((c) => c.query(`create database "${name}"`));
  const url = withDatabase(LOCAL_URL_TDM11, name);
  await runMigrations(url);
  const handle = createDb(url, options);
  return {
    ...handle,
    url,
    name,
    async drop() {
      await handle.close();
      await admin((c) => c.query(`drop database if exists "${name}" with (force)`));
    },
  };
}

/** The Postgres SQLSTATE of an error, looking through Drizzle's DrizzleQueryError wrapper. */
export function pgCodeTdm11(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    if (typeof e === "object" && e !== null && "code" in e && typeof e.code === "string")
      return e.code;
    e = typeof e === "object" && e !== null && "cause" in e ? e.cause : undefined;
  }
  return undefined;
}

/** Resolve to the SQLSTATE the promise rejected with; fail if it resolved. */
export async function rejectsWithCodeTdm11(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return pgCodeTdm11(err);
  }
  throw new Error("expected the query to be rejected");
}
