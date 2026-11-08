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

/** Where a pool reports a connection error it survived. */
export type PgErrorSink = (err: Error) => void;

const stderrSink: PgErrorSink = (err) => {
  const code = (err as { code?: unknown }).code;
  process.stderr.write(
    `db: connection error (${typeof code === "string" ? code : err.message}); client dropped\n`,
  );
};

/**
 * Follow-up 68: a Neon `read ETIMEDOUT` (or reset, or 57P01) on a pooled connection is emitted as
 * an 'error' event; with no listener Node turns it into an uncaught exception and the process
 * exits. pg-pool listens only while a client is idle and emits that on the pool; a checked-out
 * client (in a transaction, or held by graphile-worker between queries) has no listener at all.
 * This gives the pool a listener and every client a permanent one. The broken client is not lost
 * work: its pending queries reject (so the job fails and graphile retries it, and its transaction
 * never committed) and pg-pool discards it on release instead of reusing it.
 */
export function guardPgPool(pool: pg.Pool, onError: PgErrorSink = stderrSink): pg.Pool {
  pool.on("connect", (client) => {
    client.on("error", (err) => onError(err));
  });
  // pg-pool re-emits an idle client's error here; the client listener above has logged it.
  pool.on("error", () => undefined);
  return pool;
}

export function createDb(
  url: string,
  options: { max?: number; onError?: PgErrorSink } = {},
): DbHandle {
  // keepAlive: Neon drops idle TCP connections; keepalives surface that early, not mid-query.
  const pool = guardPgPool(
    new pg.Pool({ connectionString: url, max: options.max ?? 10, keepAlive: true }),
    options.onError,
  );
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
