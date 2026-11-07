// TDM-72 [8.1]: event writer, NOTIFY, readEvents, GET /runs/:id/events and the SSE stream in both
// modes (poll for Vercel Functions, listen for long-lived Node). Local Postgres; skips without it.
import { serve } from "@hono/node-server";
import { apiRoutes, createApiClient, type AnybenchEvent, type RunId } from "@anybench/core";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, runs } from "../src/db/schema/index.js";
import {
  appendEvents,
  EventFanout,
  EventValidationError,
  EVENTS_CHANNEL,
  parseEventNotification,
  readEvents,
  RunNotFoundError,
} from "../src/lib/events.js";
import {
  eventsAppTdm72,
  messageEventTdm72,
  seedRunTdm72,
  stateChangedEventTdm72,
  writeEventsInChildTdm72,
} from "./helpers/events-tdm72.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const available = await pgAvailableTdm11();

function rid(id: string): RunId {
  return id as RunId;
}

function expectSeqs(evs: readonly AnybenchEvent[], from: number, to: number) {
  expect(evs.map((e) => e.seq)).toEqual(Array.from({ length: to - from + 1 }, (_, i) => from + i));
}

/** Wait until `fn` is true (polling), or fail after `ms`. */
async function until(fn: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe.skipIf(!available)("event writer (TDM-72)", () => {
  let h: FreshDbTdm11;
  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 8 });
  }, 60_000);
  afterAll(async () => {
    await h?.drop();
  });

  it("assigns contiguous per-run seqs from runs.next_seq, copies owner_id, overrides run_id/seq", async () => {
    const { runId, userId } = await seedRunTdm72(h.db, "writer");
    const other = await seedRunTdm72(h.db, "writer-other");
    const ev = { ...messageEventTdm72(other.runId, 1), seq: 999, cost_delta_micro_usd: 1_250_000n };
    const a = await appendEvents(h.db, rid(runId), [ev, messageEventTdm72(runId, 2)]);
    const b = await appendEvents(h.db, rid(runId), [messageEventTdm72(runId, 3)]);
    expect(a).toEqual({ firstSeq: 1, lastSeq: 2 });
    expect(b).toEqual({ firstSeq: 3, lastSeq: 3 });

    const rows = await h.db
      .select()
      .from(events)
      .where(eq(events.runId, runId))
      .orderBy(events.seq);
    expect(rows.map((r) => [r.seq, r.ownerId, r.runId])).toEqual([
      [1, userId, runId],
      [2, userId, runId],
      [3, userId, runId],
    ]);
    const [run] = await h.db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.nextSeq).toBe(4);

    const back = await readEvents(h.db, rid(runId));
    expectSeqs(back, 1, 3);
    expect(back[0]!.run_id).toBe(runId);
    expect(back[0]!.cost_delta_micro_usd).toBe(1_250_000n);
    expect(back[0]!.actor).toEqual({ kind: "worker", id: "worker-1" });
    expect(back[0]!.type).toBe("agent.message");
  });

  it("keeps seqs unique and gap-free under concurrent appends", async () => {
    const { runId } = await seedRunTdm72(h.db, "concurrent");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, k) =>
        appendEvents(
          h.db,
          rid(runId),
          Array.from({ length: 5 }, (_, i) => messageEventTdm72(runId, k * 5 + i)),
        ),
      ),
    );
    for (const r of results) expect(r.lastSeq - r.firstSeq).toBe(4);
    const all = await readEvents(h.db, rid(runId), { limit: 1000 });
    expectSeqs(all, 1, 100);
  });

  it("redacts key patterns and exact secrets before insert", async () => {
    const { runId } = await seedRunTdm72(h.db, "redact");
    const leaked = messageEventTdm72(
      runId,
      1,
      "key sk-ant-api03-abcdefghijklmnop and token hunter2-super-secret-value",
    );
    await appendEvents(h.db, rid(runId), [leaked], {
      secrets: { MY_TOKEN: "hunter2-super-secret-value" },
    });
    const raw = await h.db.execute(
      sql`select payload::text as p from events where run_id = ${runId}`,
    );
    const text = String((raw as unknown as { rows: { p: string }[] }).rows[0]!.p);
    expect(text).not.toContain("sk-ant-api03");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[REDACTED:ANTHROPIC_API_KEY]");
    expect(text).toContain("[REDACTED:MY_TOKEN]");
  });

  it("writes nothing when any event is invalid, and rejects unknown runs", async () => {
    const { runId } = await seedRunTdm72(h.db, "invalid");
    const bad = {
      ...messageEventTdm72(runId, 2),
      payload: { nope: true },
    } as unknown as AnybenchEvent;
    await expect(
      appendEvents(h.db, rid(runId), [messageEventTdm72(runId, 1), bad]),
    ).rejects.toThrow(EventValidationError);
    expect(await readEvents(h.db, rid(runId))).toEqual([]);
    await expect(
      appendEvents(h.db, rid("01900000-0000-7000-8000-000000000000"), [messageEventTdm72(null, 1)]),
    ).rejects.toThrow(RunNotFoundError);
  });

  it("writes runless events with NULL owner and increasing seqs", async () => {
    const a = await appendEvents(h.db, null, [
      messageEventTdm72(null, 1),
      messageEventTdm72(null, 2),
    ]);
    const b = await appendEvents(h.db, null, [messageEventTdm72(null, 3)]);
    expect(a.lastSeq).toBe(a.firstSeq + 1);
    expect(b.firstSeq).toBeGreaterThan(a.lastSeq);
    const back = await readEvents(h.db, null, { after: a.firstSeq - 1 });
    expect(back.map((e) => e.seq)).toEqual([a.firstSeq, a.lastSeq, b.firstSeq]);
    expect(back.every((e) => e.run_id === null)).toBe(true);
    const owners = await h.db.execute(
      sql`select count(*)::int as n from events where run_id is null and owner_id is not null`,
    );
    expect((owners as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
  });

  it("NOTIFYs '<run_id>:<last_seq>' on commit only, and joins the caller's transaction", async () => {
    const { runId } = await seedRunTdm72(h.db, "notify");
    const listener = new pg.Client({ connectionString: h.url });
    await listener.connect();
    const got: string[] = [];
    listener.on("notification", (m) => got.push(m.payload ?? ""));
    await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
    try {
      // Rolled back: no rows, no seq consumed, no notification.
      await h.db
        .transaction(async (tx) => {
          await appendEvents(tx, rid(runId), [messageEventTdm72(runId, 1)]);
          throw new Error("rollback");
        })
        .catch(() => {});
      await appendEvents(h.db, rid(runId), [
        messageEventTdm72(runId, 1),
        messageEventTdm72(runId, 2),
      ]);
      await until(() => got.length >= 1);
      await new Promise((r) => setTimeout(r, 100));
      expect(got).toEqual([`${runId}:2`]);
      expect(parseEventNotification(got[0]!)).toEqual({ runId, seq: 2 });
      expectSeqs(await readEvents(h.db, rid(runId)), 1, 2);
    } finally {
      await listener.end();
    }
  });

  it("readEvents filters by type, source, severity and trial", async () => {
    const { runId } = await seedRunTdm72(h.db, "filters");
    const trialId = "01900000-0000-7000-8000-0000000000aa";
    await appendEvents(h.db, rid(runId), [
      messageEventTdm72(runId, 1),
      { ...messageEventTdm72(runId, 2), severity: "warn" },
      {
        run_id: runId,
        seq: 0,
        type: "trial.gate",
        source: "trial",
        source_id: trialId,
        severity: "info",
        actor: { kind: "runner", id: "r" },
        cost_delta_micro_usd: 0n,
        at: new Date().toISOString(),
        payload: { gate: "hidden-tests", passed: true },
      },
    ]);
    expect(
      (await readEvents(h.db, rid(runId), { types: ["trial.gate"] })).map((e) => e.seq),
    ).toEqual([3]);
    expect(
      (await readEvents(h.db, rid(runId), { sources: ["agent_session"] })).map((e) => e.seq),
    ).toEqual([1, 2]);
    expect(
      (await readEvents(h.db, rid(runId), { severities: ["warn"] })).map((e) => e.seq),
    ).toEqual([2]);
    expect((await readEvents(h.db, rid(runId), { trialId })).map((e) => e.seq)).toEqual([3]);
    expect((await readEvents(h.db, rid(runId), { after: 1, limit: 1 })).map((e) => e.seq)).toEqual([
      2,
    ]);
  });
});

describe.skipIf(!available)("GET /runs/:id/events and /runs/:id/stream (TDM-72)", () => {
  let h: FreshDbTdm11;
  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 8 });
  }, 60_000);
  afterAll(async () => {
    await h?.drop();
  });

  it("pages with ?after= and next_after; enforces auth, ownership and limits", async () => {
    const { app, dbh } = eventsAppTdm72(h.url);
    try {
      const { runId, userId } = await seedRunTdm72(h.db, "pager");
      const stranger = await seedRunTdm72(h.db, "stranger");
      await appendEvents(
        h.db,
        rid(runId),
        Array.from({ length: 650 }, (_, i) => messageEventTdm72(runId, i + 1)),
      );
      const api = createApiClient(
        "http://api.test",
        { kind: "apiKey", key: userId },
        {
          fetch: async (url, init) => app.fetch(new Request(url, init)),
        },
      );
      const seen: number[] = [];
      let after = 0;
      const pages: (number | null)[] = [];
      for (;;) {
        const page = await api.events.list({ params: { id: runId }, query: { after, limit: 300 } });
        seen.push(...page.items.map((e) => e.seq));
        pages.push(page.next_after);
        if (page.next_after === null) break;
        after = page.next_after;
      }
      expect(pages).toEqual([300, 600, null]);
      expect(seen).toEqual(Array.from({ length: 650 }, (_, i) => i + 1));

      const exact = await api.events.list({
        params: { id: runId },
        query: { after: 350, limit: 300 },
      });
      expect(exact.items).toHaveLength(300);
      expect(exact.next_after).toBeNull();

      const noAuth = await app.request(`/runs/${runId}/events`);
      expect(noAuth.status).toBe(401);
      const foreign = await app.request(`/runs/${runId}/events`, {
        headers: { authorization: `Bearer ${stranger.userId}` },
      });
      expect(foreign.status).toBe(404);
      const foreignStream = await app.request(`/runs/${runId}/stream`, {
        headers: { authorization: `Bearer ${stranger.userId}` },
      });
      expect(foreignStream.status).toBe(404);
      const tooMany = await app.request(`/runs/${runId}/events?limit=5000`, {
        headers: { authorization: `Bearer ${userId}` },
      });
      expect(tooMany.status).toBe(400);
      const body = (await tooMany.json()) as { error: { code: string; issues: string[] } };
      expect(body.error.code).toBe("validation_failed");
    } finally {
      await dbh.close();
    }
  });

  it("poll mode: ends the response at max duration without `end`; Last-Event-ID resumes with no gaps or dupes", async () => {
    const { app, dbh } = eventsAppTdm72(h.url, { EVENTS_STREAM_MAX_DURATION_MS: "300" });
    try {
      const { runId, userId } = await seedRunTdm72(h.db, "poll");
      await appendEvents(h.db, rid(runId), [
        messageEventTdm72(runId, 1),
        messageEventTdm72(runId, 2),
      ]);

      // A raw response on a live run: retry frame, both events, then it closes with no end frame.
      const res = await app.request(`/runs/${runId}/stream`, {
        headers: { authorization: `Bearer ${userId}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
      const text = await res.text();
      expect(text.startsWith("retry: 1000\n")).toBe(true);
      expect(text).toContain("id: 1\n");
      expect(text).toContain("id: 2\n");
      expect(text).not.toContain("event: end");

      // ?after= works, and Last-Event-ID beats it.
      const both = await app.request(`/runs/${runId}/stream?after=0`, {
        headers: { authorization: `Bearer ${userId}`, "last-event-id": "1" },
      });
      const bothText = await both.text();
      expect(bothText).not.toContain("id: 1\n");
      expect(bothText).toContain("id: 2\n");

      // 1,000 events from another process while the client reconnects every ~300 ms.
      const { runId: liveRun, userId: liveUser } = await seedRunTdm72(h.db, "poll-live", "running");
      let requests = 0;
      const api = createApiClient(
        "http://api.test",
        { kind: "apiKey", key: liveUser },
        {
          fetch: async (url, init) => {
            requests++;
            return app.fetch(new Request(url, init));
          },
        },
      );
      const writer = writeEventsInChildTdm72(h.url, liveRun, 1000);
      const got: AnybenchEvent[] = [];
      const it = api.stream(apiRoutes.events.stream, { params: { id: liveRun } });
      let end: unknown;
      for (;;) {
        const step = await it.next();
        if (step.done) {
          end = step.value;
          break;
        }
        got.push(step.value);
      }
      await writer;
      expectSeqs(got, 1, 1000);
      expect(end).toEqual({ state: "cancelled", last_seq: 1000 });
      expect(requests).toBeGreaterThan(1);
    } finally {
      await dbh.close();
    }
  }, 90_000);

  it("listen mode: 1,000 events from another process arrive in order over HTTP; Last-Event-ID: 500 replays 501–1000", async () => {
    const fanout = new EventFanout({ url: h.url }).start();
    await fanout.ready();
    const { app, dbh } = eventsAppTdm72(h.url, { EVENTS_STREAM_MODE: "listen" }, fanout);
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const { runId, userId } = await seedRunTdm72(h.db, "listen");
      const api = createApiClient(`http://127.0.0.1:${port}`, { kind: "apiKey", key: userId });

      const got: AnybenchEvent[] = [];
      const it = api.stream(
        apiRoutes.events.stream,
        { params: { id: runId } },
        { reconnect: false },
      );
      // Open the stream first (nothing to replay), then start the writer: everything arrives live.
      const first = it.next();
      await until(() => fanout.subscriberCount === 1);
      const startedAt = Date.now();
      const writer = writeEventsInChildTdm72(h.url, runId, 1000);
      let step = await first;
      let end: unknown;
      for (;;) {
        if (step.done) {
          end = step.value;
          break;
        }
        got.push(step.value);
        step = await it.next();
      }
      await writer;
      expectSeqs(got, 1, 1000);
      expect(new Set(got.map((e) => e.seq)).size).toBe(1000);
      expect(end).toEqual({ state: "cancelled", last_seq: 1000 });
      // Far below the 10 s fallback re-read: the stream was woken by NOTIFY.
      expect(Date.now() - startedAt).toBeLessThan(9_000);
      await until(() => fanout.subscriberCount === 0);

      // Reconnect with Last-Event-ID: 500.
      const replay: AnybenchEvent[] = [];
      const again = api.stream(
        apiRoutes.events.stream,
        { params: { id: runId } },
        { lastEventId: 500 },
      );
      let replayEnd: unknown;
      for (;;) {
        const s = await again.next();
        if (s.done) {
          replayEnd = s.value;
          break;
        }
        replay.push(s.value);
      }
      expectSeqs(replay, 501, 1000);
      expect(replayEnd).toEqual({ state: "cancelled", last_seq: 1000 });

      // A client that disconnects mid-stream releases its subscription.
      const ac = new AbortController();
      const { runId: own, userId: ownUser } = await seedRunTdm72(h.db, "listen-own");
      const res2 = await fetch(`http://127.0.0.1:${port}/runs/${own}/stream`, {
        headers: { authorization: `Bearer ${ownUser}` },
        signal: ac.signal,
      });
      expect(res2.status).toBe(200);
      await until(() => fanout.subscriberCount === 1);
      ac.abort();
      await until(() => fanout.subscriberCount === 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fanout.close();
      await dbh.close();
    }
  }, 90_000);

  it("fanout reconnects after its connection is killed and wakes open streams", async () => {
    const fanout = new EventFanout({ url: h.url, reconnectMs: 50 }).start();
    await fanout.ready();
    const wakes: number[] = [];
    const runId = "01900000-0000-7000-8000-0000000000bb";
    const unsub = fanout.subscribe(runId, (seq) => wakes.push(seq));
    try {
      await h.db.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity
            where datname = current_database() and query ilike ${`LISTEN ${EVENTS_CHANNEL}%`}`,
      );
      await until(() => wakes.includes(Number.POSITIVE_INFINITY), 10_000);
      await until(() => fanout.listening, 10_000);
      await h.db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${`${runId}:7`})`);
      await until(() => wakes.includes(7));
    } finally {
      unsub();
      await fanout.close();
    }
  }, 30_000);

  it("state change and its event commit together (end frame carries the terminal state)", async () => {
    const { app, dbh } = eventsAppTdm72(h.url);
    try {
      const { runId, userId } = await seedRunTdm72(h.db, "terminal");
      await h.db.transaction(async (tx) => {
        await tx.update(runs).set({ state: "cancelled" }).where(eq(runs.id, runId));
        await appendEvents(tx, rid(runId), [stateChangedEventTdm72(runId, "running", "cancelled")]);
      });
      const res = await app.request(`/runs/${runId}/stream`, {
        headers: { authorization: `Bearer ${userId}` },
      });
      const text = await res.text();
      expect(text).toContain("id: 1\n");
      expect(text).toContain('event: end\ndata: {"state":"cancelled","last_seq":1}\n\n');
    } finally {
      await dbh.close();
    }
  });
});
