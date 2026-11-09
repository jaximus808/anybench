// Area `webhooks`: instruction.md section 8 (Webhooks): secrets, events, signed deliveries in
// pipeline queue order (section 0.8), rule-made events, retries and the webhooks quota.
// Receivers listen on 127.0.0.1 ephemeral ports; retry delays and timeouts are small (real timers,
// as the spec says); waits poll the deliveries route or the receiver with a deadline.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addMember,
  assertError,
  assertQuota,
  assertStatus,
  Clock,
  createApiKey,
  createCard,
  createRule,
  deadUrl,
  eventLog,
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

test("create returns the secret, no other route does, a generated secret has at least 32 chars; the webhooks quota counts inactive ones", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, webhooks: FAST });
  const w = await setupTeam(api, clock);
  const path = `/teams/${w.team.id}/webhooks`;
  const res = await api.call("POST", path, { url: "http://127.0.0.1:9/a", events: ["card.created"] }, w.admin.token);
  assertStatus(res, 201);
  const h = res.body;
  assert.deepEqual(Object.keys(h).sort(), ["active", "createdAt", "events", "id", "secret", "teamId", "updatedAt", "url"]);
  assert.equal(typeof h.secret, "string");
  assert.ok(h.secret.length >= 32, "generated secret is at least 32 chars");
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
  // Validation first, then the quota: a free team holds 2 webhooks, inactive ones included.
  assertError(await api.call("POST", path, { url: "http://127.0.0.1:9/a", events: ["*"], secret: "s".repeat(15) }, w.admin.token), 400, "invalid_body", "15-char secret");
  assertError(await api.call("POST", path, { url: "http://127.0.0.1:9/a", events: ["*"], secret: "s".repeat(201) }, w.admin.token), 400, "invalid_body", "201-char secret");
  assertQuota(await api.call("POST", path, { url: "http://127.0.0.1:9/c", events: ["*"] }, w.admin.token), "webhooks", 2, 2, "a third webhook on free");
  assertStatus(await api.call("DELETE", `/webhooks/${given.id}`, undefined, w.admin.token), 204);
  assertStatus(await api.call("POST", path, { url: "http://127.0.0.1:9/c", events: ["*"] }, w.admin.token), 201, "a freed slot");
});

test("url and events are validated against the event table; events are de-duplicated and sorted, and any list with * is stored as [*]", async (t) => {
  const api = await startApp(t, { webhooks: FAST, defaultPlan: "team" });
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
    ["an audit action is not an event", { url, events: ["card.purged"] }],
    ["events not an array", { url, events: "*" }],
    ["active not boolean", { url, events: ["*"], active: "yes" }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", path, body, w.owner.token), 400, "invalid_body", what);
  const sortedEvents = await ok(api, 201, "POST", path, { url, events: ["member.removed", "card.moved", "card.created", "card.moved"] }, w.owner.token);
  assert.deepEqual(sortedEvents.events, ["card.created", "card.moved", "member.removed"]);
  const star = await ok(api, 201, "POST", path, { url, events: ["comment.created", "*"] }, w.owner.token);
  assert.deepEqual(star.events, ["*"]);
  const all = [
    "card.created",
    "card.updated",
    "card.moved",
    "card.deleted",
    "card.archived",
    "card.restored",
    "card.due",
    "comment.created",
    "checklist.completed",
    "attachment.added",
    "member.added",
    "member.removed",
    "sprint.started",
    "sprint.completed",
  ];
  assert.deepEqual((await ok(api, 201, "POST", path, { url, events: all }, w.owner.token)).events, [...all].sort());
  const patched = await ok(api, 200, "PATCH", `/webhooks/${sortedEvents.id}`, { events: ["comment.created", "card.deleted"] }, w.owner.token);
  assert.deepEqual(patched.events, ["card.deleted", "comment.created"]);
  assertError(await api.call("PATCH", `/webhooks/${sortedEvents.id}`, { events: ["ping"] }, w.owner.token), 400, "invalid_body", "PATCH ping");
  assertError(await api.call("PATCH", `/webhooks/${sortedEvents.id}`, { url: "mailto:x@y" }, w.owner.token), 400, "invalid_body", "PATCH url");
});

test("PATCH and rotate-secret move updatedAt; later deliveries are signed with the new secret; DELETE removes the webhook", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, webhooks: FAST });
  const w = await setupTeam(api, clock);
  const rx = await startReceiver(t);
  const h = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: "http://127.0.0.1:9/h", events: ["*"], secret: "old-secret-0123456789" }, w.owner.token);
  clock.advance(1000);
  const p = await ok(api, 200, "PATCH", `/webhooks/${h.id}`, { url: rx.url, active: false }, w.admin.token);
  assert.equal(p.url, rx.url);
  assert.equal(p.active, false);
  assert.equal(p.updatedAt, clock.iso());
  assert.equal(p.createdAt, h.createdAt);
  await ok(api, 202, "POST", `/webhooks/${h.id}/test`, undefined, w.owner.token);
  const [first] = await rx.waitForCount(1);
  assert.equal(first!.headers["x-tracker-signature"], sign("old-secret-0123456789", first!.raw));
  clock.advance(1000);
  const r = await api.call("POST", `/webhooks/${h.id}/rotate-secret`, undefined, w.admin.token);
  assertStatus(r, 200);
  assert.equal(typeof r.body.secret, "string");
  assert.ok(r.body.secret.length >= 32);
  assert.notEqual(r.body.secret, h.secret);
  assert.equal(r.body.updatedAt, clock.iso());
  assert.equal(r.body.url, rx.url);
  await ok(api, 202, "POST", `/webhooks/${h.id}/test`, undefined, w.owner.token);
  const reqs = await rx.waitForCount(2);
  assert.equal(reqs[1]!.headers["x-tracker-signature"], sign(r.body.secret, reqs[1]!.raw), "signed with the new secret");
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
  assert.deepEqual(Object.keys(body).sort(), ["actorId", "data", "event", "id", "occurredAt", "teamId", "via"]);
  assert.deepEqual(body, { id: body.id, event: "card.created", teamId: w.team.id, actorId: w.member.id, via: null, occurredAt: clock.iso(), data: { card } });
  const items = await waitDeliveries(api, w.admin.token, h.id, "a succeeded delivery", (d) => d.length === 1 && d[0].status === "succeeded");
  assert.deepEqual(items[0], { id: body.id, webhookId: h.id, event: "card.created", status: "succeeded", attempts: 1, lastStatusCode: 200, lastError: null, createdAt: clock.iso() });
});

test("every documented request event fires exactly once with its data, and cascades emit nothing", async (t) => {
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
  const shelf = await createCard(api, w.cols[0], w.member, { title: "shelf" });
  const archived = await ok(api, 200, "POST", `/cards/${shelf.id}/archive`, undefined, w.member.token);
  const restored = await ok(api, 200, "POST", `/cards/${shelf.id}/restore`, {}, w.member.token);
  // Removing `late` unassigns `card` (a cascade: no card.updated).
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}/members/${late.id}`, undefined, w.admin.token), 204);
  // Reads and failed writes emit nothing.
  await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.owner.token);
  assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "" }, w.member.token), 400, "invalid_body");
  const reqs = await rx.waitForCount(11);
  const byEvent = new Map<string, any[]>();
  for (const r of reqs) byEvent.set(r.body.event, [...(byEvent.get(r.body.event) ?? []), r.body]);
  const one = (e: string) => {
    assert.equal(byEvent.get(e)?.length, 1, `exactly one ${e}`);
    return byEvent.get(e)![0];
  };
  assert.deepEqual(one("member.added").data, { member });
  assert.equal(one("member.added").actorId, w.admin.id);
  const created = byEvent.get("card.created") ?? [];
  assert.equal(created.length, 3, "three cards were created");
  assert.deepEqual(created.find((e) => e.data?.card?.id === card.id)?.data, { card });
  assert.deepEqual(created.find((e) => e.data?.card?.id === doomed.id)?.data, { card: doomed });
  assert.deepEqual(one("card.updated").data, { card: updated, fields: ["labels", "title"] });
  assert.deepEqual(one("card.moved").data, { card: moved, fromColumnId: w.cols[0], toColumnId: w.cols[1] });
  assert.deepEqual(one("comment.created").data, { comment });
  assert.equal(one("comment.created").actorId, w.member.id);
  assert.deepEqual(one("card.deleted").data, { card: doomed });
  assert.deepEqual(one("card.archived").data, { card: archived });
  assert.deepEqual(one("card.restored").data, { card: restored });
  assert.deepEqual(one("member.removed").data, { userId: late.id });
  for (const r of reqs) assert.equal(r.body.via, null, `${r.body.event}: a request's events have via null`);
  assert.equal(byEvent.size, 9, "only the documented events");
  const all = await waitDeliveries(api, w.owner.token, h.id, "11 deliveries", (d) => d.length >= 11);
  assert.equal(all.length, 11, "the unassign cascade added no card.updated");
  assert.deepEqual(
    [...all].reverse().map((d) => d.event),
    ["member.added", "card.created", "card.updated", "card.moved", "comment.created", "card.created", "card.deleted", "card.created", "card.archived", "card.restored", "member.removed"],
    "deliveries are created in queue order",
  );
});

test("events of rule actions carry via { type: rule, ruleId, runId } and the rule creator as actor, queued after the triggering event", async (t) => {
  const api = await startApp(t, { webhooks: FAST });
  const w = await setupBoard(api);
  const rule = await createRule(api, w.team.id, w.admin, {
    trigger: { event: "card.moved", toColumnId: w.cols[2] },
    actions: [
      { type: "add_comment", body: "  Shipped {{key}} by {{user}}  " },
      { type: "set_priority", priority: "high" },
    ],
  });
  const log = await eventLog(t, api, w.team.id, w.owner);
  const card = await createCard(api, w.cols[0], w.member, { title: "ship it" });
  const moved = await ok(api, 200, "POST", `/cards/${card.id}/move`, { columnId: w.cols[2] }, w.member.token);
  assert.equal(moved.priority, "high", "the response shows the state after the rule");
  assert.deepEqual(await log.names(), ["card.created", "card.moved", "comment.created", "card.updated"]);
  const [, mv, cm, up] = await log.events(4);
  const runs = await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token);
  assert.equal(runs.items.length, 1, "one run: the rule never reacts to its own events");
  const run = runs.items[0];
  assert.deepEqual(
    [run.event, run.cardId, run.depth, run.status, run.error, run.actions],
    ["card.moved", card.id, 0, "succeeded", null, [
      { type: "add_comment", status: "succeeded", error: null },
      { type: "set_priority", status: "succeeded", error: null },
    ]],
  );
  assert.equal(mv.actorId, w.member.id);
  assert.equal(mv.via, null);
  assert.equal(mv.data.card.priority, "none", "the card.moved snapshot is taken before the rule ran");
  for (const e of [cm, up]) {
    assert.equal(e.actorId, w.admin.id, `${e.event}: the rule's creator`);
    assert.deepEqual(e.via, { type: "rule", ruleId: rule.id, runId: run.id }, `${e.event}: via`);
  }
  assert.equal(cm.data.comment.body, `Shipped ${card.key} by ${w.admin.handle}`, "placeholders replaced, body trimmed");
  assert.equal(cm.data.comment.authorId, w.admin.id);
  assert.deepEqual(up.data, { card: moved, fields: ["priority"] });
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
  assert.deepEqual((await ok(api, 200, "GET", `/webhooks/${b.id}/deliveries`, undefined, w.owner.token)).items, [], "inactive: no deliveries");
  const ping = await api.call("POST", `/webhooks/${b.id}/test`, undefined, w.admin.token);
  assertStatus(ping, 202);
  assert.equal(typeof ping.body.deliveryId, "string");
  const [p] = await rxB.waitForCount(1);
  assert.equal(p!.headers["x-tracker-event"], "ping");
  assert.equal(p!.body.event, "ping");
  assert.equal(p!.body.id, ping.body.deliveryId);
  assert.deepEqual(p!.body.data, { webhookId: b.id });
  assert.equal(p!.body.actorId, w.admin.id);
  assert.equal(p!.body.via, null);
  assert.equal(p!.headers["x-tracker-signature"], sign(b.secret, p!.raw));
  const pingA = await ok(api, 202, "POST", `/webhooks/${a.id}/test`, undefined, w.admin.token);
  const reqsA = await rxA.waitForCount(2);
  assert.equal(reqsA[1]!.body.event, "ping", "pings ignore the events filter");
  assert.equal(reqsA[1]!.body.id, pingA.deliveryId);
  const dA = await waitDeliveries(api, w.owner.token, a.id, "2 deliveries", (d) => d.length === 2 && d.every((x) => x.status === "succeeded"));
  assert.deepEqual(dA.map((d) => d.event), ["ping", "comment.created"], "newest first");
  assert.equal(rxA.received.length, 2, "card.created did not reach A");
  const activity = await ok(api, 200, "GET", `/teams/${w.team.id}/activity`, undefined, w.owner.token);
  assert.ok(!activity.items.some((e: any) => e.event === "ping"), "a ping is not an event: no activity entry");
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

test("deleting a webhook cancels its pending retries; deactivating one does not", async (t) => {
  // Both webhooks fail their first attempt and retry 800 ms later. `cancelled` is deleted and
  // `paused` deactivated right after their first attempts. `cancelled` was pinged first, so its
  // retry (if it were not cancelled) would be due no later than `paused`'s; once `paused`'s retry
  // has arrived and one more delivery has gone through a fresh webhook, it would have arrived.
  const api = await startApp(t, { webhooks: { retryDelaysMs: [800], timeoutMs: 2000 }, defaultPlan: "team" });
  const w = await setupTeam(api);
  const rxCancelled = await startReceiver(t, (_r, n) => (n === 1 ? 500 : 200));
  const rxPaused = await startReceiver(t, (_r, n) => (n === 1 ? 500 : 200));
  const cancelled = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rxCancelled.url, events: ["*"] }, w.owner.token);
  const paused = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: rxPaused.url, events: ["*"] }, w.owner.token);
  await ok(api, 202, "POST", `/webhooks/${cancelled.id}/test`, undefined, w.owner.token);
  await ok(api, 202, "POST", `/webhooks/${paused.id}/test`, undefined, w.owner.token);
  await rxCancelled.waitForCount(1);
  assertStatus(await api.call("DELETE", `/webhooks/${cancelled.id}`, undefined, w.owner.token), 204);
  await rxPaused.waitForCount(1);
  await ok(api, 200, "PATCH", `/webhooks/${paused.id}`, { active: false }, w.owner.token);
  const [d] = await waitDeliveries(api, w.owner.token, paused.id, "the inactive webhook's retry to succeed", (items) => items.length === 1 && items[0].status === "succeeded");
  assert.equal(d.attempts, 2, "a delivery created before deactivation still runs");
  const fence = await startReceiver(t);
  const late = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: fence.url, events: ["*"] }, w.owner.token);
  await ok(api, 202, "POST", `/webhooks/${late.id}/test`, undefined, w.owner.token);
  await fence.waitForCount(1);
  assert.equal(rxPaused.received.length, 2);
  assert.equal(rxCancelled.received.length, 1, "the deleted webhook's retry never ran");
});

test("deliveries are listed newest first with cursor pages; members, viewers and non-admin-scope keys get 403 on every webhook route", async (t) => {
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
  const writeKey = await createApiKey(api, w.admin, { scope: "write" });
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
  for (const [method, path, body] of calls) {
    for (const u of [w.member, w.viewer]) assertError(await api.call(method, path, body, u.token), 403, "forbidden", `${u.handle} ${method} ${path}`);
    assertError(await api.call(method, path, body, writeKey.secret), 403, "insufficient_scope", `an admin's write key: ${method} ${path} needs the admin scope`);
  }
  assertError(await api.call("GET", `/webhooks/${h.id}`, undefined, w.outsider.token), 404, "not_found", "outsider");
  assertError(await api.call("POST", `/webhooks/${h.id}/test`, undefined, w.outsider.token), 404, "not_found", "outsider");
  const adminKey = await createApiKey(api, w.admin, { scope: "admin" });
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}/webhooks`, undefined, adminKey.secret)).items.length, 1, "an admin key of an admin");
  await rx.waitForCount(3);
  assert.equal((await ok(api, 200, "GET", `/webhooks/${h.id}`, undefined, w.owner.token)).active, true, "nothing changed");
});
