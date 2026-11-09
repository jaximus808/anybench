// Area `webhooks`: instruction.md section 8 (Webhooks): secrets, events, signed deliveries, retries.
// Receivers listen on 127.0.0.1 ephemeral ports; retry delays and timeouts are small (real timers,
// as the spec says); waits poll the deliveries route with a deadline.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addMember,
  assertError,
  assertStatus,
  Clock,
  createCard,
  deadUrl,
  ok,
  setupBoard,
  setupTeam,
  sign,
  signUp,
  startApp,
  startReceiver,
  waitDeliveries,
} from "./helpers.ts";

const FAST = { retryDelaysMs: [30, 30], timeoutMs: 2000 };

test("create returns the secret; no other route does; a generated secret has at least 32 chars", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, webhooks: FAST });
  const w = await setupTeam(api, clock);
  const path = `/teams/${w.team.id}/webhooks`;
  const res = await api.call("POST", path, { url: "http://127.0.0.1:9/a", events: ["card.created"] }, w.admin.token);
  assertStatus(res, 201);
  const h = res.body;
  assert.equal(typeof h.secret, "string");
  assert.ok(h.secret.length >= 32, "generated secret is at least 32 chars");
  assert.equal(typeof h.id, "string");
  assert.equal(h.teamId, w.team.id);
  assert.equal(h.url, "http://127.0.0.1:9/a");
  assert.deepEqual(h.events, ["card.created"]);
  assert.equal(h.active, true);
  assert.equal(h.createdAt, clock.iso());
  assert.equal(h.updatedAt, clock.iso());
  const given = await ok(api, 201, "POST", path, { url: "https://example.test/hook", events: ["*"], secret: "s".repeat(16), active: false }, w.owner.token);
  assert.equal(given.secret, "s".repeat(16));
  assert.equal(given.active, false);
  const one = await ok(api, 200, "GET", `/webhooks/${h.id}`, undefined, w.admin.token);
  const { secret: _s, ...withoutSecret } = h;
  assert.deepEqual(one, withoutSecret);
  const list = await ok(api, 200, "GET", path, undefined, w.admin.token);
  assert.deepEqual(list.items.map((x: any) => x.id), [h.id, given.id], "oldest first");
  for (const x of list.items) assert.equal(x.secret, undefined, "list never shows a secret");
  const patched = await ok(api, 200, "PATCH", `/webhooks/${h.id}`, { active: false }, w.admin.token);
  assert.equal(patched.secret, undefined, "PATCH never shows a secret");
  assert.ok(!JSON.stringify([one, list, patched]).includes(h.secret));
  assertError(await api.call("POST", path, { url: "http://127.0.0.1:9/a", events: ["*"], secret: "s".repeat(15) }, w.admin.token), 400, "invalid_body", "15-char secret");
  assertError(await api.call("POST", path, { url: "http://127.0.0.1:9/a", events: ["*"], secret: "s".repeat(201) }, w.admin.token), 400, "invalid_body", "201-char secret");
});

test("url and events are validated; events are de-duplicated and sorted, and any list with * is stored as [*]", async (t) => {
  const api = await startApp(t, { webhooks: FAST });
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/webhooks`;
  const url = "http://127.0.0.1:9/h";
  const bad: [string, unknown][] = [
    ["ftp url", { url: "ftp://127.0.0.1/h", events: ["*"] }],
    ["not a url", { url: "not a url", events: ["*"] }],
    ["relative url", { url: "/hooks", events: ["*"] }],
    ["missing url", { events: ["*"] }],
    ["empty events", { url, events: [] }],
    ["unknown event", { url, events: ["card.exploded"] }],
    ["ping is not an event", { url, events: ["ping"] }],
    ["events not an array", { url, events: "*" }],
    ["active not boolean", { url, events: ["*"], active: "yes" }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", path, body, w.owner.token), 400, "invalid_body", what);
  const sortedEvents = await ok(api, 201, "POST", path, { url, events: ["member.removed", "card.moved", "card.created", "card.moved"] }, w.owner.token);
  assert.deepEqual(sortedEvents.events, ["card.created", "card.moved", "member.removed"]);
  const star = await ok(api, 201, "POST", path, { url, events: ["comment.created", "*"] }, w.owner.token);
  assert.deepEqual(star.events, ["*"]);
  const all = ["card.created", "card.updated", "card.moved", "card.deleted", "comment.created", "member.added", "member.removed"];
  assert.deepEqual((await ok(api, 201, "POST", path, { url, events: all }, w.owner.token)).events, [...all].sort());
  const patched = await ok(api, 200, "PATCH", `/webhooks/${sortedEvents.id}`, { events: ["comment.created", "card.deleted"] }, w.owner.token);
  assert.deepEqual(patched.events, ["card.deleted", "comment.created"]);
  assertError(await api.call("PATCH", `/webhooks/${sortedEvents.id}`, { events: ["ping"] }, w.owner.token), 400, "invalid_body", "PATCH ping");
  assertError(await api.call("PATCH", `/webhooks/${sortedEvents.id}`, { url: "mailto:x@y" }, w.owner.token), 400, "invalid_body", "PATCH url");
});

test("PATCH and rotate-secret move updatedAt; rotate returns a new secret; DELETE removes the webhook", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, webhooks: FAST });
  const w = await setupTeam(api, clock);
  const h = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: "http://127.0.0.1:9/h", events: ["*"] }, w.owner.token);
  clock.advance(1000);
  const p = await ok(api, 200, "PATCH", `/webhooks/${h.id}`, { url: "http://127.0.0.1:9/new", active: false }, w.admin.token);
  assert.equal(p.url, "http://127.0.0.1:9/new");
  assert.equal(p.active, false);
  assert.equal(p.updatedAt, clock.iso());
  assert.equal(p.createdAt, h.createdAt);
  clock.advance(1000);
  const r = await api.call("POST", `/webhooks/${h.id}/rotate-secret`, undefined, w.admin.token);
  assertStatus(r, 200);
  assert.equal(typeof r.body.secret, "string");
  assert.ok(r.body.secret.length >= 32);
  assert.notEqual(r.body.secret, h.secret);
  assert.equal(r.body.updatedAt, clock.iso());
  assert.equal(r.body.url, "http://127.0.0.1:9/new");
  assertError(await api.call("PATCH", `/webhooks/${h.id}`, {}, w.admin.token), 400, "invalid_body", "empty PATCH");
  assertError(await api.call("PATCH", `/webhooks/${h.id}`, { secret: "x".repeat(20) }, w.admin.token), 400, "invalid_body", "secret is not updatable by PATCH");
  const del = await api.call("DELETE", `/webhooks/${h.id}`, undefined, w.admin.token);
  assertStatus(del, 204);
  assert.equal(del.text, "");
  assertError(await api.call("GET", `/webhooks/${h.id}`, undefined, w.admin.token), 404, "not_found");
  assert.deepEqual((await ok(api, 200, "GET", `/teams/${w.team.id}/webhooks`, undefined, w.admin.token)).items, []);
});

test("a delivery POSTs the documented body and headers, signed with HMAC-SHA256 of the exact body", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, webhooks: FAST });
  const w = await setupBoard(api, clock);
  const rx = await startReceiver(t);
  const h = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rx.url, events: ["card.created"], secret: "a-very-secret-key-1234" }, w.admin.token);
  clock.advance(5000);
  const card = await createCard(api, w.cols[0], w.member, { title: "Hook me", labels: ["x"] });
  const [req] = await rx.waitForCount(1);
  assert.equal(req!.path, "/hook");
  assert.match(String(req!.headers["content-type"]), /^application\/json/);
  assert.equal(req!.headers["x-tracker-event"], "card.created");
  assert.equal(req!.headers["x-tracker-attempt"], "1");
  assert.equal(req!.headers["x-tracker-signature"], sign("a-very-secret-key-1234", req!.raw), "signature over the raw body");
  const body = req!.body;
  assert.equal(req!.headers["x-tracker-delivery"], body.id);
  assert.deepEqual(body, { id: body.id, event: "card.created", teamId: w.team.id, actorId: w.member.id, occurredAt: clock.iso(), data: { card } });
  const items = await waitDeliveries(api, w.admin.token, h.id, "a succeeded delivery", (d) => d.length === 1 && d[0].status === "succeeded");
  assert.deepEqual(items[0], { id: body.id, webhookId: h.id, event: "card.created", status: "succeeded", attempts: 1, lastStatusCode: 200, lastError: null, createdAt: clock.iso() });
});

test("every documented event fires exactly once with its data, and cascades emit nothing", async (t) => {
  const api = await startApp(t, { webhooks: FAST });
  const w = await setupBoard(api);
  const rx = await startReceiver(t);
  const h = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rx.url, events: ["*"] }, w.owner.token);
  const late = await signUp(api);
  const member = await addMember(api, w.team.id, w.admin, late, "member");
  const card = await createCard(api, w.cols[0], late, { title: "evt", assigneeId: late.id });
  const updated = await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "evt2", labels: ["a"], unknown: true }, late.token);
  const moved = await ok(api, 200, "POST", `/cards/${card.id}/move`, { columnId: w.cols[1] }, late.token);
  const comment = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "hi" }, w.member.token);
  const doomed = await createCard(api, w.cols[2], w.member, { title: "doomed" });
  assertStatus(await api.call("DELETE", `/cards/${doomed.id}`, undefined, w.member.token), 204);
  // Removing `late` unassigns `card` (a cascade: no card.updated).
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}/members/${late.id}`, undefined, w.admin.token), 204);
  // Reads and failed writes emit nothing.
  await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.owner.token);
  assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "" }, w.member.token), 400, "invalid_body");
  const reqs = await rx.waitForCount(8);
  const byEvent = new Map<string, any[]>();
  for (const r of reqs) byEvent.set(r.body.event, [...(byEvent.get(r.body.event) ?? []), r.body]);
  const one = (e: string) => {
    assert.equal(byEvent.get(e)?.length, 1, `exactly one ${e}`);
    return byEvent.get(e)![0];
  };
  assert.deepEqual(one("member.added").data, { member });
  assert.equal(one("member.added").actorId, w.admin.id);
  const created = byEvent.get("card.created") ?? [];
  assert.equal(created.length, 2, "two cards were created");
  assert.deepEqual(created.find((e) => e.data?.card?.id === card.id)?.data, { card });
  assert.deepEqual(created.find((e) => e.data?.card?.id === doomed.id)?.data, { card: doomed });
  assert.deepEqual(one("card.updated").data, { card: updated, fields: ["labels", "title"] });
  assert.deepEqual(one("card.moved").data, { card: moved, fromColumnId: w.cols[0], toColumnId: w.cols[1] });
  assert.deepEqual(one("comment.created").data, { comment });
  assert.equal(one("comment.created").actorId, w.member.id);
  assert.deepEqual(one("card.deleted").data, { card: doomed });
  assert.deepEqual(one("member.removed").data, { userId: late.id });
  assert.equal(byEvent.get("card.updated")?.length, 1, "the unassign cascade emits nothing");
  assert.equal(byEvent.size, 7, "only the documented events");
  const all = await waitDeliveries(api, w.owner.token, h.id, "8 deliveries", (d) => d.length >= 8);
  assert.equal(all.length, 8, "exactly 8 events: 2 created, updated, moved, deleted, comment, member added and removed");
});

test("the events filter is respected; inactive webhooks get nothing but test pings", async (t) => {
  const api = await startApp(t, { webhooks: FAST });
  const w = await setupBoard(api);
  const rxA = await startReceiver(t);
  const rxB = await startReceiver(t);
  const a = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rxA.url, events: ["comment.created"] }, w.owner.token);
  const b = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rxB.url, events: ["*"], active: false }, w.owner.token);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "only this" }, w.member.token);
  const [onlyA] = await rxA.waitForCount(1);
  assert.equal(onlyA!.body.event, "comment.created");
  assert.deepEqual(await waitDeliveries(api, w.owner.token, b.id, "no deliveries", () => true), [], "inactive: no deliveries");
  const ping = await api.call("POST", `/webhooks/${b.id}/test`, undefined, w.admin.token);
  assertStatus(ping, 202);
  assert.equal(typeof ping.body.deliveryId, "string");
  const [p] = await rxB.waitForCount(1);
  assert.equal(p!.headers["x-tracker-event"], "ping");
  assert.equal(p!.body.event, "ping");
  assert.equal(p!.body.id, ping.body.deliveryId);
  assert.deepEqual(p!.body.data, { webhookId: b.id });
  assert.equal(p!.body.actorId, w.admin.id);
  assert.equal(p!.headers["x-tracker-signature"], sign(b.secret, p!.raw));
  const pingA = await ok(api, 202, "POST", `/webhooks/${a.id}/test`, undefined, w.admin.token);
  const reqsA = await rxA.waitForCount(2);
  assert.equal(reqsA[1]!.body.event, "ping", "pings ignore the events filter");
  assert.equal(reqsA[1]!.body.id, pingA.deliveryId);
  const dA = await waitDeliveries(api, w.owner.token, a.id, "2 deliveries", (d) => d.length === 2 && d.every((x) => x.status === "succeeded"));
  assert.deepEqual(dA.map((d) => d.event), ["ping", "comment.created"], "newest first");
  assert.equal(rxA.received.length, 2, "card.created did not reach A");
});

test("a failed attempt is retried after retryDelaysMs with the same body bytes and an incremented attempt header", async (t) => {
  const api = await startApp(t, { webhooks: { retryDelaysMs: [40, 40], timeoutMs: 2000 } });
  const w = await setupTeam(api);
  const rx = await startReceiver(t, (_r, n) => (n === 1 ? 500 : 204));
  const h = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rx.url, events: ["member.added"] }, w.owner.token);
  const late = await signUp(api);
  await addMember(api, w.team.id, w.owner, late, "viewer");
  const items = await waitDeliveries(api, w.owner.token, h.id, "a succeeded retry", (d) => d.length === 1 && d[0].status === "succeeded");
  assert.equal(items[0].attempts, 2);
  assert.equal(items[0].lastStatusCode, 204);
  assert.equal(items[0].lastError, null);
  const [first, second] = rx.received;
  assert.equal(rx.received.length, 2);
  assert.equal(first!.headers["x-tracker-attempt"], "1");
  assert.equal(second!.headers["x-tracker-attempt"], "2");
  assert.equal(second!.raw, first!.raw, "same body bytes");
  assert.equal(second!.headers["x-tracker-signature"], first!.headers["x-tracker-signature"]);
  assert.equal(second!.headers["x-tracker-delivery"], items[0].id);
  assert.equal(first!.headers["x-tracker-delivery"], items[0].id);
});

test("exhausted retries mark the delivery failed after 1 + retryDelaysMs.length attempts", async (t) => {
  const api = await startApp(t, { webhooks: { retryDelaysMs: [20, 20], timeoutMs: 2000 } });
  const w = await setupTeam(api);
  const rx = await startReceiver(t, () => 503);
  const h = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rx.url, events: ["*"] }, w.owner.token);
  const ping = await ok(api, 202, "POST", `/webhooks/${h.id}/test`, undefined, w.owner.token);
  const items = await waitDeliveries(api, w.owner.token, h.id, "a failed delivery", (d) => d.length === 1 && d[0].status === "failed");
  assert.deepEqual(
    { id: items[0].id, status: items[0].status, attempts: items[0].attempts, lastStatusCode: items[0].lastStatusCode, lastError: items[0].lastError, event: items[0].event },
    { id: ping.deliveryId, status: "failed", attempts: 3, lastStatusCode: 503, lastError: null, event: "ping" },
  );
  assert.equal(rx.received.length, 3);
  assert.deepEqual(rx.received.map((r) => r.headers["x-tracker-attempt"]), ["1", "2", "3"]);
});

test("a timeout or a connection error fails the attempt with lastStatusCode null and a non-empty lastError", async (t) => {
  const api = await startApp(t, { webhooks: { retryDelaysMs: [], timeoutMs: 150 } });
  const w = await setupTeam(api);
  const rx = await startReceiver(t, () => "hang");
  const slow = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rx.url, events: ["*"] }, w.owner.token);
  const gone = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: await deadUrl(), events: ["*"] }, w.owner.token);
  const triggered = await ok(api, 202, "POST", `/webhooks/${slow.id}/test`, undefined, w.owner.token);
  const pending = await ok(api, 200, "GET", `/webhooks/${slow.id}/deliveries`, undefined, w.owner.token);
  assert.equal(pending.items[0].id, triggered.deliveryId);
  if (pending.items[0].status === "pending") {
    assert.equal(pending.items[0].attempts, 0, "an attempt in flight is not counted");
    assert.equal(pending.items[0].lastStatusCode, null);
  }
  await ok(api, 202, "POST", `/webhooks/${gone.id}/test`, undefined, w.owner.token);
  for (const h of [slow, gone]) {
    const [d] = await waitDeliveries(api, w.owner.token, h.id, `failure of ${h.url}`, (items) => items.length === 1 && items[0].status === "failed");
    assert.equal(d.attempts, 1, h.url);
    assert.equal(d.lastStatusCode, null, h.url);
    assert.equal(typeof d.lastError, "string", h.url);
    assert.ok(d.lastError.length > 0, `${h.url}: lastError is non-empty`);
  }
  assert.equal(rx.received.length, 1, "no retry when retryDelaysMs is empty");
});

test("after rotate-secret, deliveries are signed with the new secret", async (t) => {
  const api = await startApp(t, { webhooks: FAST });
  const w = await setupTeam(api);
  const rx = await startReceiver(t);
  const h = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rx.url, events: ["*"], secret: "old-secret-0123456789" }, w.owner.token);
  await ok(api, 202, "POST", `/webhooks/${h.id}/test`, undefined, w.owner.token);
  const [first] = await rx.waitForCount(1);
  assert.equal(first!.headers["x-tracker-signature"], sign("old-secret-0123456789", first!.raw));
  const rotated = await ok(api, 200, "POST", `/webhooks/${h.id}/rotate-secret`, undefined, w.owner.token);
  await ok(api, 202, "POST", `/webhooks/${h.id}/test`, undefined, w.owner.token);
  const reqs = await rx.waitForCount(2);
  assert.equal(reqs[1]!.headers["x-tracker-signature"], sign(rotated.secret, reqs[1]!.raw));
  assert.notEqual(reqs[1]!.headers["x-tracker-signature"], sign("old-secret-0123456789", reqs[1]!.raw));
});

test("deliveries are listed newest first with cursor pages; members and viewers get 403 on every webhook route", async (t) => {
  const api = await startApp(t, { webhooks: FAST });
  const w = await setupTeam(api);
  const rx = await startReceiver(t);
  const h = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rx.url, events: ["*"] }, w.owner.token);
  const sent: string[] = [];
  for (let i = 0; i < 3; i++) sent.push((await ok(api, 202, "POST", `/webhooks/${h.id}/test`, undefined, w.owner.token)).deliveryId);
  const p1 = await ok(api, 200, "GET", `/webhooks/${h.id}/deliveries?limit=2`, undefined, w.admin.token);
  assert.deepEqual(p1.items.map((d: any) => d.id), [sent[2], sent[1]]);
  assert.equal(typeof p1.nextCursor, "string");
  const p2 = await ok(api, 200, "GET", `/webhooks/${h.id}/deliveries?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`, undefined, w.admin.token);
  assert.deepEqual(p2.items.map((d: any) => d.id), [sent[0]]);
  assert.equal(p2.nextCursor, null);
  for (const q of ["limit=0", "limit=101", "cursor=zzz"]) {
    assertError(await api.call("GET", `/webhooks/${h.id}/deliveries?${q}`, undefined, w.admin.token), 400, "invalid_query", q);
  }
  for (const u of [w.member, w.viewer]) {
    const calls: [string, string, unknown?][] = [
      ["POST", `/teams/${w.team.id}/webhooks`, { url: rx.url, events: ["*"] }],
      ["GET", `/teams/${w.team.id}/webhooks`],
      ["GET", `/webhooks/${h.id}`],
      ["PATCH", `/webhooks/${h.id}`, { active: false }],
      ["DELETE", `/webhooks/${h.id}`],
      ["POST", `/webhooks/${h.id}/rotate-secret`],
      ["POST", `/webhooks/${h.id}/test`],
      ["GET", `/webhooks/${h.id}/deliveries`],
    ];
    for (const [method, path, body] of calls) assertError(await api.call(method, path, body, u.token), 403, "forbidden", `${u.handle} ${method} ${path}`);
  }
  assertError(await api.call("GET", `/webhooks/${h.id}`, undefined, w.outsider.token), 404, "not_found", "outsider");
  assertError(await api.call("POST", `/webhooks/${h.id}/test`, undefined, w.outsider.token), 404, "not_found", "outsider");
  await rx.waitForCount(3);
  assert.equal((await ok(api, 200, "GET", `/webhooks/${h.id}`, undefined, w.owner.token)).active, true, "nothing changed");
});
