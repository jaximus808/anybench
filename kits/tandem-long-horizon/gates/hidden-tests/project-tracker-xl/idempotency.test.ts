// Area `idempotency`: instruction.md section 14 (Idempotency keys) and check 3b of section 0.3, on
// POST routes of several areas, with the pipeline of section 0.8 (a replay has no effect at all).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  addMember,
  assertError,
  assertStatus,
  auditLog,
  cardIds,
  Clock,
  createApiKey,
  createCard,
  createRule,
  eventLog,
  login,
  ok,
  setupBoard,
  setupTeam,
  signUp,
  startApp,
  tempDir,
} from "./helpers.ts";

test("a repeated POST with the same key and body replays the status and exact body bytes with idempotency-replayed: true, and does nothing else", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const auditBefore = (await auditLog(api, w.admin.token, w.team.id)).length;
  const body = { title: "exactly once", labels: ["x"] };
  const first = await api.call("POST", `/columns/${w.cols[0]}/cards`, body, w.member.token, { idem: "create-card-1" });
  assertStatus(first, 201);
  assert.equal(first.headers.get("idempotency-replayed"), null, "the first response is not a replay");
  clock.advance(5000);
  const second = await api.call("POST", `/columns/${w.cols[0]}/cards`, body, w.member.token, { idem: "create-card-1" });
  assertStatus(second, 201, "the stored status");
  assert.equal(second.text, first.text, "the exact stored body bytes");
  assert.equal(second.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(await cardIds(api, w.member.token, w.board.id), [first.body.id], "one card");
  const audit = await auditLog(api, w.admin.token, w.team.id);
  assert.deepEqual(audit.slice(auditBefore).map((e) => e.action), ["card.created"], "one audit entry");
  assert.deepEqual(await log.names(), ["card.created"], "one delivery");
  const third = await createCard(api, w.cols[0], w.member, body);
  assert.equal(third.number, 2, "the replay used no card number");
});

test("the same key with different body bytes is 409 idempotency_conflict, even when the JSON means the same", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/projects`;
  assertStatus(await api.call("POST", path, undefined, w.owner.token, { raw: '{"name":"Alpha","key":"ALP"}', idem: "proj" }), 201);
  assertError(await api.call("POST", path, undefined, w.owner.token, { raw: '{"name":"Beta","key":"BET"}', idem: "proj" }), 409, "idempotency_conflict", "another body");
  assertError(await api.call("POST", path, undefined, w.owner.token, { raw: '{"key":"ALP","name":"Alpha"}', idem: "proj" }), 409, "idempotency_conflict", "same JSON, other key order");
  assertError(await api.call("POST", path, undefined, w.owner.token, { raw: '{"name": "Alpha", "key": "ALP"}', idem: "proj" }), 409, "idempotency_conflict", "same JSON, other whitespace");
  const replay = await api.call("POST", path, undefined, w.owner.token, { raw: '{"name":"Alpha","key":"ALP"}', idem: "proj" });
  assertStatus(replay, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  const list = await ok(api, 200, "GET", `/teams/${w.team.id}/projects`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((p: any) => p.key), ["ALP"], "the conflicts created nothing");
});

test("an Idempotency-Key must be 1 to 100 characters of [A-Za-z0-9_.:-], else 400 invalid_header", async (t) => {
  const api = await startApp(t);
  const u = await signUp(api);
  for (const [what, key] of [
    ["101 chars", "k".repeat(101)],
    ["a space", "two words"],
    ["a slash", "a/b"],
    ["a plus", "a+b"],
    ["a comma", "a,b"],
  ] as const) {
    const res = await api.call("POST", "/teams", { name: "T" }, u.token, { headers: { "idempotency-key": key } });
    assertError(res, 400, "invalid_header", what);
  }
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, u.token)).items, [], "nothing was created");
  for (const key of ["k".repeat(100), "A-z_0.9:x", "1"]) {
    assertStatus(await api.call("POST", "/teams", { name: key.slice(0, 50) }, u.token, { idem: key }), 201, `key ${key.slice(0, 20)}`);
  }
});

test("a response that is not 2xx stores nothing: after a failure the same key and body run again", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const col = `/columns/${w.cols[0]}/cards`;
  await ok(api, 200, "PATCH", `/columns/${w.cols[0]}`, { wipLimit: 1 }, w.admin.token);
  const blocker = await createCard(api, w.cols[0], w.member, { title: "fills" });
  const body = { title: "waiting" };
  assertError(await api.call("POST", col, body, w.member.token, { idem: "retry-me" }), 409, "wip_limit_reached");
  assertError(await api.call("POST", col, body, w.member.token, { idem: "retry-me" }), 409, "wip_limit_reached", "not a replay: the request ran again");
  assertError(await api.call("POST", col, { title: "" }, w.member.token, { idem: "retry-me" }), 400, "invalid_body", "a different body is no conflict either");
  assertStatus(await api.call("DELETE", `/cards/${blocker.id}`, undefined, w.member.token), 204);
  const ran = await api.call("POST", col, body, w.member.token, { idem: "retry-me" });
  assertStatus(ran, 201);
  assert.equal(ran.headers.get("idempotency-replayed"), null);
  const again = await api.call("POST", col, body, w.member.token, { idem: "retry-me" });
  assert.equal(again.headers.get("idempotency-replayed"), "true", "now it is stored");
  assert.equal(again.body.id, ran.body.id);
});

test("the scope is (user, method, path, key): another path or user is unrelated, another credential of the same user is not", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "one" });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "two" });
  const body = { body: "same text" };
  const a = await ok(api, 201, "POST", `/cards/${c1.id}/comments`, body, w.member.token, { idem: "k1" });
  const b = await api.call("POST", `/cards/${c2.id}/comments`, body, w.member.token, { idem: "k1" });
  assertStatus(b, 201, "another path");
  assert.equal(b.headers.get("idempotency-replayed"), null);
  const c = await api.call("POST", `/cards/${c1.id}/comments`, body, w.admin.token, { idem: "k1" });
  assertStatus(c, 201, "another user");
  assert.equal(c.headers.get("idempotency-replayed"), null);
  assert.notEqual(c.body.id, a.id);
  const conflict = await api.call("POST", `/cards/${c1.id}/comments`, { body: "other" }, w.admin.token, { idem: "k1" });
  assertError(conflict, 409, "idempotency_conflict", "the admin's own record now");
  // The same user with another session token, or with an API key, shares the scope.
  const token2 = await login(api, w.member.email, w.member.password);
  const key = await createApiKey(api, w.member, { scope: "write" });
  for (const cred of [token2, key.secret]) {
    const r = await api.call("POST", `/cards/${c1.id}/comments`, body, cred, { idem: "k1" });
    assertStatus(r, 201);
    assert.equal(r.headers.get("idempotency-replayed"), "true");
    assert.equal(r.body.id, a.id);
  }
  // The path without the query string is the scope's path.
  const q = await api.call("POST", `/cards/${c1.id}/comments?ignored=1`, body, w.member.token, { idem: "k1" });
  assert.equal(q.headers.get("idempotency-replayed"), "true", "the query string is not part of the path");
  const comments = await ok(api, 200, "GET", `/cards/${c1.id}/comments`, undefined, w.member.token);
  assert.deepEqual(comments.items.map((x: any) => x.id), [a.id, c.body.id]);
});

test("a stored response expires after idempotencyTtlMs: until then it replays, from then on the request runs and stores anew", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, idempotencyTtlMs: 60_000, tokenTtlMs: 86_400_000 });
  const u = await signUp(api);
  const first = await ok(api, 201, "POST", "/teams", { name: "T" }, u.token, { idem: "ttl" });
  clock.advance(59_999);
  const replay = await api.call("POST", "/teams", { name: "T" }, u.token, { idem: "ttl" });
  assert.equal(replay.headers.get("idempotency-replayed"), "true", "1 ms before expiry");
  assert.equal(replay.body.id, first.id);
  clock.advance(1);
  const fresh = await api.call("POST", "/teams", { name: "Other name" }, u.token, { idem: "ttl" });
  assertStatus(fresh, 201, "expired: no conflict, the request runs");
  assert.equal(fresh.headers.get("idempotency-replayed"), null);
  const again = await api.call("POST", "/teams", { name: "Other name" }, u.token, { idem: "ttl" });
  assert.equal(again.headers.get("idempotency-replayed"), "true", "and a new record is stored");
  assert.equal(again.body.id, fresh.body.id);
  assert.equal((await ok(api, 200, "GET", "/teams", undefined, u.token)).items.length, 2);
});

test("stored responses are not persisted: after a restart the same key and body run again", async (t) => {
  const file = join(tempDir(t), "tracker.json");
  const api = await startApp(t, { dataFile: file });
  const u = await signUp(api);
  const first = await ok(api, 201, "POST", "/teams", { name: "T" }, u.token, { idem: "restart" });
  await api.close();
  const again = await startApp(t, { dataFile: file });
  const res = await again.call("POST", "/teams", { name: "T" }, u.token, { idem: "restart" });
  assertStatus(res, 201);
  assert.equal(res.headers.get("idempotency-replayed"), null);
  assert.notEqual(res.body.id, first.id);
  assert.equal((await ok(again, 200, "GET", "/teams", undefined, u.token)).items.length, 2);
});

test("PATCH, PUT and DELETE ignore the header, even an invalid one", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const field = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Size", type: "number" }, w.admin.token);
  const p1 = await api.call("PATCH", `/cards/${card.id}`, { title: "one" }, w.member.token, { idem: "same" });
  const p2 = await api.call("PATCH", `/cards/${card.id}`, { title: "two" }, w.member.token, { idem: "same" });
  assertStatus(p1, 200);
  assertStatus(p2, 200, "no idempotency_conflict on PATCH");
  assert.equal(p2.body.title, "two");
  assert.equal(p2.headers.get("idempotency-replayed"), null);
  assertStatus(await api.call("PATCH", `/cards/${card.id}`, { title: "three" }, w.member.token, { headers: { "idempotency-key": "not valid!" } }), 200, "no invalid_header on PATCH");
  assertStatus(await api.call("PUT", `/cards/${card.id}/fields/${field.id}`, { value: 1 }, w.member.token, { idem: "put" }), 200);
  const put2 = await api.call("PUT", `/cards/${card.id}/fields/${field.id}`, { value: 2 }, w.member.token, { idem: "put" });
  assertStatus(put2, 200);
  assert.equal(put2.body.customFields[field.id], 2);
  assertStatus(await api.call("DELETE", `/cards/${card.id}`, undefined, w.member.token, { headers: { "idempotency-key": "a b c" } }), 204);
  assertError(await api.call("DELETE", `/cards/${card.id}`, undefined, w.member.token, { idem: "del" }), 404, "not_found", "a second DELETE is not replayed");
});

test("the public POST routes ignore the header: register validates nothing of it, login issues a new token every time", async (t) => {
  const api = await startApp(t);
  const reg = await api.call("POST", "/auth/register", { email: "p@example.test", password: "public-pass", name: "P", handle: "ppp" }, undefined, { headers: { "idempotency-key": "not valid!" } });
  assertStatus(reg, 201, "no invalid_header on a public route");
  const l1 = await api.call("POST", "/auth/login", { email: "p@example.test", password: "public-pass" }, undefined, { idem: "login" });
  const l2 = await api.call("POST", "/auth/login", { email: "p@example.test", password: "public-pass" }, undefined, { idem: "login" });
  assertStatus(l1, 200);
  assertStatus(l2, 200);
  assert.equal(l2.headers.get("idempotency-replayed"), null);
  assert.notEqual(l1.body.token, l2.body.token, "login is not replayed");
});

test("a replay answers what was stored even after the state changed, including a 204 and a 202, with no new effect", async (t) => {
  const api = await startApp(t, { webhooks: { retryDelaysMs: [], timeoutMs: 2000 } });
  const w = await setupBoard(api);
  const card = await ok(api, 201, "POST", `/columns/${w.cols[0]}/cards`, { title: "short-lived" }, w.member.token, { idem: "card" });
  assert.ok(card.id, "created");
  assertStatus(await api.call("DELETE", `/cards/${card.id}`, undefined, w.member.token), 204);
  const replay = await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "short-lived" }, w.member.token, { idem: "card" });
  assertStatus(replay, 201, "the stored answer, although the card is gone");
  assert.deepEqual(replay.body, card);
  assertError(await api.call("GET", `/cards/${card.id}`, undefined, w.member.token), 404, "not_found", "and the card is not recreated");
  // A stored 202: the webhook test creates no second delivery.
  const hook = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: "http://127.0.0.1:9/x", events: ["*"], active: false }, w.admin.token);
  const ping = await ok(api, 202, "POST", `/webhooks/${hook.id}/test`, undefined, w.admin.token, { idem: "ping" });
  const ping2 = await api.call("POST", `/webhooks/${hook.id}/test`, undefined, w.admin.token, { idem: "ping" });
  assertStatus(ping2, 202);
  assert.equal(ping2.body.deliveryId, ping.deliveryId);
  assert.equal((await ok(api, 200, "GET", `/webhooks/${hook.id}/deliveries`, undefined, w.admin.token)).items.length, 1);
  // A stored 204: logging out again through another token of the same user revokes nothing.
  const t1 = await login(api, w.viewer.email, w.viewer.password);
  const t2 = await login(api, w.viewer.email, w.viewer.password);
  assertStatus(await api.call("POST", "/auth/logout", undefined, t1, { idem: "bye" }), 204);
  const bye = await api.call("POST", "/auth/logout", undefined, t2, { idem: "bye" });
  assertStatus(bye, 204);
  assert.equal(bye.headers.get("idempotency-replayed"), "true");
  assertStatus(await api.call("GET", "/me", undefined, t2), 200, "the replay did not revoke t2");
  assertError(await api.call("GET", "/me", undefined, t1), 401, "unauthorized");
});

test("3b sits after 3a and before the body and path checks: a replay skips them, invalid_header and idempotency_conflict come first", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const read = await createApiKey(api, w.member, { scope: "read" });
  assertError(await api.call("POST", "/teams", { name: "x" }, read.secret, { headers: { "idempotency-key": "bad key" } }), 403, "insufficient_scope", "3a before 3b");
  assertError(await api.call("POST", "/teams", undefined, w.member.token, { raw: "{oops", headers: { "idempotency-key": "bad key" } }), 400, "invalid_header", "before invalid_json");
  assertError(await api.call("POST", "/columns/no-such-column/cards", { title: "x" }, w.member.token, { headers: { "idempotency-key": "bad key" } }), 400, "invalid_header", "before 404");
  // A stored response is replayed even when the path resource is gone, and a conflict wins over the 404.
  const card = await createCard(api, w.cols[1], w.member, { title: "t" });
  const comment = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "c" }, w.member.token, { idem: "c" });
  assertStatus(await api.call("DELETE", `/cards/${card.id}`, undefined, w.member.token), 204);
  const replay = await api.call("POST", `/cards/${card.id}/comments`, { body: "c" }, w.member.token, { idem: "c" });
  assertStatus(replay, 201, "replayed although the card is gone");
  assert.equal(replay.body.id, comment.id);
  assertError(await api.call("POST", `/cards/${card.id}/comments`, { body: "d" }, w.member.token, { idem: "c" }), 409, "idempotency_conflict", "before the 404");
  assertError(await api.call("POST", `/cards/${card.id}/comments`, { body: "d" }, w.member.token, { idem: "c2" }), 404, "not_found", "without a stored record: the 404");
});

test("a replayed POST runs no pipeline: no second rule run, notification, activity entry or delivery, on routes of several areas", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const extra = await signUp(api);
  await addMember(api, w.team.id, w.owner, extra, "member");
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "comment.created" }, actions: [{ type: "set_priority", priority: "urgent" }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "busy" });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const sprint = await ok(api, 201, "POST", `/projects/${w.project.id}/sprints`, { name: "S", startDate: "2026-03-02", endDate: "2026-03-13" }, w.admin.token, { idem: "sprint" });
  const comment = { body: `hey @${extra.handle}` };
  for (let i = 0; i < 2; i++) {
    assertStatus(await api.call("POST", `/cards/${card.id}/comments`, comment, w.member.token, { idem: "comment" }), 201);
    assertStatus(await api.call("POST", `/sprints/${sprint.id}/cards`, { cardIds: [card.id] }, w.member.token, { idem: "sprint-cards" }), 200);
    assertStatus(await api.call("POST", `/projects/${w.project.id}/sprints`, { name: "S", startDate: "2026-03-02", endDate: "2026-03-13" }, w.admin.token, { idem: "sprint" }), 201);
    assertStatus(await api.call("POST", `/cards/${card.id}/checklist`, { text: "step" }, w.member.token, { idem: "item" }), 201);
  }
  assert.equal((await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token)).items.length, 1, "one rule run");
  assert.deepEqual(await log.names(), ["comment.created", "card.updated", "card.updated"], "comment, the rule's priority, the sprint: once each");
  const notes = await ok(api, 200, "GET", "/me/notifications", undefined, extra.token);
  assert.deepEqual(notes.items.map((n: any) => n.type), ["mention"], "one mention notification");
  const activity = await ok(api, 200, "GET", `/cards/${card.id}/activity`, undefined, w.member.token);
  assert.deepEqual(activity.items.map((e: any) => e.event), ["card.updated", "card.updated", "comment.created", "card.created"]);
  assert.equal((await ok(api, 200, "GET", `/projects/${w.project.id}/sprints`, undefined, w.member.token)).items.length, 1, "one sprint");
  assert.deepEqual(await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.member.token).then((c) => c.checklist), { total: 1, done: 0 }, "one checklist item");
});
