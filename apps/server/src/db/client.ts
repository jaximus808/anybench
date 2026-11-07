// Postgres pool + Drizzle client (TDM-11).
// DATABASE_URL is Neon's pooled URL (PgBouncer, transaction mode): API queries only, and anything
// session-scoped must use SET LOCAL inside a transaction (scopedDb does).
// DATABASE_URL_DIRECT is for migrations, graphile-worker and LISTEN/NOTIFY.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
/** A transaction handle as passed to `db.transaction(fn)`. */
export type DbTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Default for local Docker Postgres from docker-compose.dev.yml (host port 55432). */
export const DEFAULT_LOCAL_DATABASE_URL = "postgres://anybench:anybench@localhost:55432/anybench";

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(url: string, options: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

let shared: DbHandle | undefined;

/** Lazily created app pool from DATABASE_URL. */
export function getDb(): Database {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    shared = createDb(url);
  }
  return shared.db;
}

export async function closeSharedDb(): Promise<void> {
  const h = shared;
  shared = undefined;
  await h?.close();
}
