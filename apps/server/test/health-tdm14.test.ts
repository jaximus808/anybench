// TDM-14: /health, /health/worker, 404 and error shapes against a fresh local Postgres.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerHeartbeats } from "../src/db/schema/worker_heartbeats.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { appTdm14 } from "./helpers/server-tdm14.js";

const hasDb = await pgAvailableTdm11();

describe("health routes without a database (TDM-14)", () => {
  it("GET /health is 503 when the DB is unreachable", async () => {
    const { app, dbh } = appTdm14("postgres://anybench:anybench@127.0.0.1:1/none");
    try {
      const res = await app.request("/health");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, db: { ok: false } });
      const w = await app.request("/health/worker");
      expect(w.status).toBe(503);
      expect(await w.json()).toMatchObject({ ok: false, reason: "db unreachable" });
    } finally {
      await dbh.close();
    }
  });

  it("unknown routes are a JSON 404 and thrown errors a JSON 500 reported to Sentry", async () => {
    const { app, dbh, sentry } = appTdm14("postgres://anybench:anybench@127.0.0.1:1/none");
    try {
      app.get("/boom-tdm14", () => {
        throw new Error("kaboom");
      });
      const nf = await app.request("/nope");
      expect(nf.status).toBe(404);
      expect(await nf.json()).toMatchObject({ error: { code: "not_found" } });
      const res = await app.request("/boom-tdm14");
      expect(res.status).toBe(500);
      const body = (await res.json()) as {
        error: { code: string; message: string; requestId: string };
      };
      expect(body.error.code).toBe("internal");
      expect(body.error.message).not.toContain("kaboom");
      expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
      expect(sentry.captured).toHaveLength(1);
    } finally {
      await dbh.close();
    }
  });
});

describe.skipIf(!hasDb)("health routes with Postgres (TDM-14)", () => {
  let fresh: FreshDbTdm11;
  let h: ReturnType<typeof appTdm14>;

  beforeAll(async () => {
    fresh = await freshMigratedDbTdm11();
    h = appTdm14(fresh.url);
  });
  afterAll(async () => {
    await h?.dbh.close();
    await fresh?.drop();
  });

  it("GET /health is 200 with a DB ping", async () => {
    const res = await h.app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      env: "local",
      paused: false,
      db: { ok: true },
    });
  });

  it("GET /health/worker is 503 before any heartbeat, 200 when fresh, 503 when stale", async () => {
    const none = await h.app.request("/health/worker");
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ ok: false, reason: "no worker heartbeat yet" });

    const startedAt = new Date();
    await fresh.db.insert(workerHeartbeats).values({
      workerId: "tdm14-stale",
      host: "h",
      pid: 1,
      startedAt,
      lastTickAt: sql`now() - interval '5 minutes'`,
    });
    const stale = await h.app.request("/health/worker");
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({
      ok: false,
      reason: "worker heartbeat is stale",
      workerId: "tdm14-stale",
    });

    await fresh.db
      .insert(workerHeartbeats)
      .values({ workerId: "tdm14-live", host: "h", pid: 2, startedAt });
    const ok = await h.app.request("/health/worker");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      ok: boolean;
      workerId: string;
      ageSec: number;
      maxAgeSec: number;
    };
    expect(body).toMatchObject({ ok: true, workerId: "tdm14-live", maxAgeSec: 60 });
    expect(body.ageSec).toBeLessThan(5);
  });
});
