// Follow-up 68: a dropped Postgres connection (Neon `read ETIMEDOUT`, reset, 57P01) must never be
// an uncaught exception that kills the worker. Proven against local Postgres by killing backends
// with pg_terminate_backend: on a checked-out client (no pg-pool listener) and on an idle one.
import pg from "pg";
import { describe, expect, it } from "vitest";
import { isTransientNetworkError } from "../src/boot.js";
import { createDb } from "../src/db/client.js";
import { LOCAL_URL_TDM11, pgAvailableTdm11 } from "./helpers/pg-tdm11.js";

const hasDb = await pgAvailableTdm11();

async function terminate(pid: number): Promise<void> {
  const admin = new pg.Client({ connectionString: LOCAL_URL_TDM11 });
  await admin.connect();
  try {
    await admin.query("select pg_terminate_backend($1)", [pid]);
  } finally {
    await admin.end();
  }
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("isTransientNetworkError (follow-up 68)", () => {
  it("recognises dropped connections, not bugs", () => {
    const e = (code: string) => Object.assign(new Error(`read ${code}`), { code });
    expect(isTransientNetworkError(e("ETIMEDOUT"))).toBe(true);
    expect(isTransientNetworkError(e("ECONNRESET"))).toBe(true);
    expect(isTransientNetworkError(e("57P01"))).toBe(true);
    expect(isTransientNetworkError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientNetworkError(new TypeError("x is undefined"))).toBe(false);
    expect(isTransientNetworkError(e("23505"))).toBe(false);
    expect(isTransientNetworkError("ETIMEDOUT")).toBe(false);
  });
});

describe.skipIf(!hasDb)("guarded pg pool (follow-up 68)", () => {
  it("a checked-out client's connection error is reported, not thrown, and the pool recovers", async () => {
    const seen: Error[] = [];
    const dbh = createDb(LOCAL_URL_TDM11, { max: 2, onError: (err) => void seen.push(err) });
    try {
      const client = await dbh.pool.connect();
      const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      // Without the guard this client has no 'error' listener while checked out: the event
      // below would be thrown from the socket callback as an uncaught exception.
      expect(client.listenerCount("error")).toBeGreaterThan(0);
      await terminate(rows[0]!.pid);
      await until(() => seen.length > 0);
      await expect(client.query("select 1")).rejects.toThrow();
      client.release(true);
      const again = await dbh.pool.query<{ one: number }>("select 1 as one");
      expect(again.rows[0]!.one).toBe(1);
    } finally {
      await dbh.close();
    }
  });

  it("an idle client's connection error is reported, and the pool hands out a fresh one", async () => {
    const seen: Error[] = [];
    const dbh = createDb(LOCAL_URL_TDM11, { max: 2, onError: (err) => void seen.push(err) });
    try {
      const { rows } = await dbh.pool.query<{ pid: number }>("select pg_backend_pid() as pid");
      expect(dbh.pool.idleCount).toBe(1);
      await terminate(rows[0]!.pid);
      await until(() => seen.length > 0);
      const again = await dbh.pool.query<{ pid: number }>("select pg_backend_pid() as pid");
      expect(again.rows[0]!.pid).not.toBe(rows[0]!.pid);
    } finally {
      await dbh.close();
    }
  });
});
