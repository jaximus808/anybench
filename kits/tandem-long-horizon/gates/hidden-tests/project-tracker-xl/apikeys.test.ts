// Area `apikeys`: instruction.md section 12 (API keys): the key record, authenticating as the
// owner with the owner's current role, team-restricted keys, and check 3a of section 0.3
// (api_key_not_allowed, then insufficient_scope) on routes of every area.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addMember,
  assertError,
  assertQuota,
  assertStatus,
  auditLog,
  Clock,
  createApiKey,
  createBoard,
  createCard,
  createProject,
  eventLog,
  ok,
  setupBoard,
  setupTeam,
  signUp,
  startApp,
} from "./helpers.ts";

const KEY_FIELDS = ["createdAt", "expiresAt", "id", "name", "prefix", "scope", "teamId", "updatedAt"];

test("create answers the key with its secret: trk_ and at least 32 alphanumerics, prefix its first 12 chars", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const u = await signUp(api);
  const res = await api.call("POST", "/me/api-keys", { name: "  CI deploy  ", scope: "write" }, u.token);
  assertStatus(res, 201);
  const k = res.body;
  assert.deepEqual(Object.keys(k).sort(), [...KEY_FIELDS, "secret"].sort());
  assert.match(k.secret, /^trk_[A-Za-z0-9]{32,}$/);
  assert.equal(k.prefix, k.secret.slice(0, 12));
  assert.deepEqual(
    { name: k.name, scope: k.scope, teamId: k.teamId, expiresAt: k.expiresAt, createdAt: k.createdAt, updatedAt: k.updatedAt },
    { name: "CI deploy", scope: "write", teamId: null, expiresAt: null, createdAt: clock.iso(), updatedAt: clock.iso() },
  );
  const other = await createApiKey(api, u, { scope: "read" });
  assert.notEqual(other.secret, k.secret, "every key has its own secret");
  assert.notEqual(other.id, k.id);
  const me = await api.call("GET", "/me", undefined, k.secret);
  assertStatus(me, 200, "the secret authenticates as a Bearer credential");
  assert.equal(me.body.id, u.id);
});

test("list and get show the caller's own keys, oldest first, and never a secret", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const u = await signUp(api);
  const v = await signUp(api);
  const a = await createApiKey(api, u, { name: "a", scope: "read" });
  clock.advance(1000);
  const b = await createApiKey(api, u, { name: "b", scope: "admin" });
  await createApiKey(api, v, { name: "theirs", scope: "read" });
  const list = await api.call("GET", "/me/api-keys", undefined, u.token);
  assertStatus(list, 200);
  assert.deepEqual(list.body.items.map((x: any) => x.id), [a.id, b.id]);
  for (const x of list.body.items) assert.deepEqual(Object.keys(x).sort(), KEY_FIELDS, "no secret in the list");
  const { secret: _s, ...bWithout } = b;
  assert.deepEqual(list.body.items[1], bWithout);
  const one = await api.call("GET", `/me/api-keys/${a.id}`, undefined, u.token);
  assertStatus(one, 200);
  const { secret: _t, ...aWithout } = a;
  assert.deepEqual(one.body, aWithout);
  assert.ok(!list.text.includes(a.secret) && !list.text.includes(b.secret) && !one.text.includes(a.secret), "no route but create shows a secret");
  assert.deepEqual((await ok(api, 200, "GET", "/me/api-keys", undefined, v.token)).items.map((x: any) => x.name), ["theirs"]);
});

test("create validates name, scope, teamId and expiresAt; expiresAt is stored as an ISO string", async (t) => {
  const clock = new Clock(Date.UTC(2026, 2, 1, 12, 0, 0));
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api);
  const u = w.member;
  const bad: [string, unknown][] = [
    ["blank name", { name: "  ", scope: "read" }],
    ["101-char name", { name: "n".repeat(101), scope: "read" }],
    ["name not a string", { name: 3, scope: "read" }],
    ["missing name", { scope: "read" }],
    ["scope owner", { name: "k", scope: "owner" }],
    ["scope READ", { name: "k", scope: "READ" }],
    ["missing scope", { name: "k" }],
    ["teamId a number", { name: "k", scope: "read", teamId: 5 }],
    ["teamId unknown", { name: "k", scope: "read", teamId: "nope" }],
    ["expiresAt not a date", { name: "k", scope: "read", expiresAt: "soon" }],
    ["expiresAt in the past", { name: "k", scope: "read", expiresAt: "2026-02-01T00:00:00Z" }],
    ["expiresAt exactly now", { name: "k", scope: "read", expiresAt: clock.iso() }],
    ["expiresAt a number", { name: "k", scope: "read", expiresAt: Date.UTC(2027, 0, 1) }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", "/me/api-keys", body, u.token), 400, "invalid_body", what);
  assert.equal((await ok(api, 200, "GET", "/me/api-keys", undefined, u.token)).items.length, 0, "nothing was created");
  const n100 = await createApiKey(api, u, { name: "n".repeat(100), scope: "admin", teamId: w.team.id, expiresAt: "2026-03-02T01:00:00+01:00" });
  assert.equal(n100.name.length, 100);
  assert.equal(n100.teamId, w.team.id);
  assert.equal(n100.expiresAt, "2026-03-02T00:00:00.000Z", "normalised with toISOString");
  assert.equal((await createApiKey(api, u, { scope: "read", expiresAt: "2026-03-01T12:00:00.001Z" })).expiresAt, "2026-03-01T12:00:00.001Z", "1 ms in the future is fine");
  assert.equal((await createApiKey(api, u, { scope: "read", teamId: null, expiresAt: null })).teamId, null);
});

test("PATCH changes name and expiresAt and moves updatedAt; scope or teamId in the body is 400", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api);
  const k = await createApiKey(api, w.member, { name: "old", scope: "write", teamId: w.team.id });
  clock.advance(5000);
  const p = await api.call("PATCH", `/me/api-keys/${k.id}`, { name: " new ", expiresAt: "2027-01-01T00:00:00Z" }, w.member.token);
  assertStatus(p, 200);
  assert.deepEqual(Object.keys(p.body).sort(), KEY_FIELDS, "PATCH shows no secret");
  assert.deepEqual([p.body.name, p.body.expiresAt, p.body.updatedAt, p.body.createdAt, p.body.prefix], ["new", "2027-01-01T00:00:00.000Z", clock.iso(), k.createdAt, k.prefix]);
  clock.advance(1000);
  const cleared = await ok(api, 200, "PATCH", `/me/api-keys/${k.id}`, { expiresAt: null }, w.member.token);
  assert.equal(cleared.expiresAt, null);
  assert.equal(cleared.updatedAt, clock.iso());
  assertError(await api.call("PATCH", `/me/api-keys/${k.id}`, { scope: "admin" }, w.member.token), 400, "invalid_body", "scope never changes");
  assertError(await api.call("PATCH", `/me/api-keys/${k.id}`, { scope: "write" }, w.member.token), 400, "invalid_body", "not even to the same value");
  assertError(await api.call("PATCH", `/me/api-keys/${k.id}`, { teamId: w.team.id }, w.member.token), 400, "invalid_body", "teamId never changes");
  assertError(await api.call("PATCH", `/me/api-keys/${k.id}`, { name: "x", teamId: null }, w.member.token), 400, "invalid_body", "with another field");
  assertError(await api.call("PATCH", `/me/api-keys/${k.id}`, {}, w.member.token), 400, "invalid_body", "empty");
  assertError(await api.call("PATCH", `/me/api-keys/${k.id}`, { expiresAt: "2020-01-01T00:00:00Z" }, w.member.token), 400, "invalid_body", "past expiresAt");
  const now = await ok(api, 200, "GET", `/me/api-keys/${k.id}`, undefined, w.member.token);
  assert.deepEqual([now.name, now.scope, now.teamId, now.expiresAt], ["new", "write", w.team.id, null], "failed PATCHes changed nothing");
});

test("DELETE revokes a key at once; another user's key id is 404 on every :keyId route", async (t) => {
  const api = await startApp(t);
  const u = await signUp(api);
  const v = await signUp(api);
  const k = await createApiKey(api, u, { scope: "read" });
  const theirs = await createApiKey(api, v, { scope: "read" });
  for (const [method, body] of [["GET"], ["PATCH", { name: "mine" }], ["DELETE"]] as const) {
    assertError(await api.call(method, `/me/api-keys/${theirs.id}`, body, u.token), 404, "not_found", `${method} another user's key`);
  }
  assertStatus(await api.call("GET", "/me", undefined, theirs.secret), 200, "their key is untouched");
  assertStatus(await api.call("GET", "/me", undefined, k.secret), 200);
  const res = await api.call("DELETE", `/me/api-keys/${k.id}`, undefined, u.token);
  assertStatus(res, 204);
  assert.equal(res.text, "");
  assertError(await api.call("GET", "/me", undefined, k.secret), 401, "unauthorized", "a deleted key");
  assertError(await api.call("GET", `/me/api-keys/${k.id}`, undefined, u.token), 404, "not_found");
  assertError(await api.call("DELETE", `/me/api-keys/${k.id}`, undefined, u.token), 404, "not_found", "twice");
  assertError(await api.call("GET", "/me/api-keys/nope", undefined, u.token), 404, "not_found");
});

test("a user holds at most 20 keys: the 21st is 409 quota_exceeded { apiKeys, 20, 20 }, after validation", async (t) => {
  const api = await startApp(t);
  const u = await signUp(api);
  const v = await signUp(api);
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) ids.push((await createApiKey(api, u, { name: `k${i}`, scope: "read" })).id);
  assertError(await api.call("POST", "/me/api-keys", { name: "bad", scope: "root" }, u.token), 400, "invalid_body", "validation comes first");
  assertQuota(await api.call("POST", "/me/api-keys", { name: "k20", scope: "read" }, u.token), "apiKeys", 20, 20, "the 21st key");
  assert.equal((await ok(api, 200, "GET", "/me/api-keys", undefined, u.token)).items.length, 20);
  assertStatus(await api.call("POST", "/me/api-keys", { name: "theirs", scope: "read" }, v.token), 201, "the limit is per user");
  assertStatus(await api.call("DELETE", `/me/api-keys/${ids[3]}`, undefined, u.token), 204);
  assertStatus(await api.call("POST", "/me/api-keys", { name: "k20", scope: "read" }, u.token), 201, "a freed slot");
  assertQuota(await api.call("POST", "/me/api-keys", { name: "k21", scope: "read" }, u.token), "apiKeys", 20, 20);
});

test("a key acts as its owner: createdBy, authorId, the audit actorId and the event actorId are the owner's id", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const key = await createApiKey(api, w.member, { scope: "write" });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const card = await ok(api, 201, "POST", `/columns/${w.cols[0]}/cards`, { title: "by key" }, key.secret);
  assert.equal(card.createdBy, w.member.id);
  const comment = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: `ping @${w.viewer.handle}` }, key.secret);
  assert.equal(comment.authorId, w.member.id);
  const audit = await auditLog(api, w.admin.token, w.team.id);
  assert.deepEqual(audit.slice(-2).map((e) => [e.action, e.actorId]), [["card.created", w.member.id], ["comment.created", w.member.id]]);
  const events = await log.events(2);
  assert.deepEqual(events.map((e) => [e.event, e.actorId]), [["card.created", w.member.id], ["comment.created", w.member.id]]);
  const watchers = await ok(api, 200, "GET", `/cards/${card.id}/watchers`, undefined, key.secret);
  assert.deepEqual(watchers.items.map((m: any) => m.userId), [w.member.id], "the owner auto-watches the card it created through the key");
  const notes = await ok(api, 200, "GET", "/me/notifications", undefined, w.viewer.token);
  assert.deepEqual(notes.items.map((n: any) => [n.type, n.actorId]), [["mention", w.member.id]]);
});

test("a key has its owner's role at the time of the request: a demotion takes effect at once and a promotion restores access", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const key = await createApiKey(api, w.admin, { scope: "admin" });
  assertStatus(await api.call("PATCH", `/teams/${w.team.id}`, { name: "By key" }, key.secret), 200, "admin via key");
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, key.secret)).myRole, "admin");
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.admin.id}`, { role: "member" }, w.owner.token);
  assertError(await api.call("PATCH", `/teams/${w.team.id}`, { name: "Again" }, key.secret), 403, "forbidden", "now a member");
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, key.secret)).myRole, "member");
  assertStatus(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "still member+" }, key.secret), 201);
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.admin.id}`, { role: "viewer" }, w.owner.token);
  assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "viewer now" }, key.secret), 403, "forbidden");
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.admin.id}`, { role: "admin" }, w.owner.token);
  assertStatus(await api.call("PATCH", `/teams/${w.team.id}`, { name: "Back" }, key.secret), 200, "promoted again");
});

test("a key expires when now() >= expiresAt; clearing expiresAt with a session token brings it back", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: 10 * 86_400_000 });
  const u = await signUp(api);
  const key = await createApiKey(api, u, { scope: "read", expiresAt: new Date(clock.t + 10_000).toISOString() });
  clock.advance(9_999);
  assertStatus(await api.call("GET", "/me", undefined, key.secret), 200, "1 ms before expiresAt");
  clock.advance(1);
  assertError(await api.call("GET", "/me", undefined, key.secret), 401, "unauthorized", "at expiresAt");
  const listed = await ok(api, 200, "GET", "/me/api-keys", undefined, u.token);
  assert.deepEqual(listed.items.map((x: any) => x.id), [key.id], "an expired key is still listed");
  await ok(api, 200, "PATCH", `/me/api-keys/${key.id}`, { expiresAt: null }, u.token);
  assertStatus(await api.call("GET", "/me", undefined, key.secret), 200, "no expiry any more");
  clock.advance(5 * 86_400_000);
  assertStatus(await api.call("GET", "/me", undefined, key.secret), 200);
});

test("api_key_not_allowed: a key may never log out, change /me, the password, API keys, or accept an invitation, whatever its scope", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const invite = await ok(api, 201, "POST", `/teams/${w.team.id}/invites`, { email: w.outsider.email, role: "viewer" }, w.admin.token);
  const key = await createApiKey(api, w.outsider, { scope: "admin" });
  const mine = await createApiKey(api, w.outsider, { scope: "read" });
  const calls: [string, string, unknown?][] = [
    ["POST", "/auth/logout"],
    ["PATCH", "/me", { name: "x" }],
    ["POST", "/me/password", { currentPassword: w.outsider.password, newPassword: "a-new-password" }],
    ["GET", "/me/api-keys"],
    ["POST", "/me/api-keys", { name: "k", scope: "read" }],
    ["GET", `/me/api-keys/${mine.id}`],
    ["PATCH", `/me/api-keys/${mine.id}`, { name: "x" }],
    ["DELETE", `/me/api-keys/${mine.id}`],
    ["POST", `/invites/${invite.token}/accept`],
  ];
  for (const [method, path, body] of calls) assertError(await api.call(method, path, body, key.secret), 403, "api_key_not_allowed", `${method} ${path}`);
  // Nothing happened: the session still works, the password and keys are unchanged, the invite is pending.
  assertStatus(await api.call("GET", "/me", undefined, w.outsider.token), 200);
  assert.equal((await ok(api, 200, "GET", "/me", undefined, key.secret)).name, w.outsider.name, "GET /me is allowed");
  assert.equal((await ok(api, 200, "GET", "/me/api-keys", undefined, w.outsider.token)).items.length, 2);
  assertError(await api.call("GET", `/teams/${w.team.id}`, undefined, w.outsider.token), 404, "not_found", "the invitation was not accepted");
  assertStatus(await api.call("POST", `/invites/${invite.token}/accept`, undefined, w.outsider.token), 200, "a session token may accept it");
});

test("a team-restricted key may not create a team; an unrestricted write key may, as its owner", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const restricted = await createApiKey(api, w.member, { scope: "admin", teamId: w.team.id });
  const write = await createApiKey(api, w.member, { scope: "write" });
  const read = await createApiKey(api, w.member, { scope: "read" });
  assertError(await api.call("POST", "/teams", { name: "No" }, restricted.secret), 403, "api_key_not_allowed", "team-restricted");
  assertError(await api.call("POST", "/teams", { name: "No" }, read.secret), 403, "insufficient_scope", "POST /teams needs write");
  const team = await ok(api, 201, "POST", "/teams", { name: "Mine" }, write.secret);
  assert.equal(team.ownerId, w.member.id);
  assert.equal(team.myRole, "owner");
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, w.member.token)).items.map((x: any) => x.name), ["Core", "Mine"]);
});

test("3a comes before the body and path checks: api_key_not_allowed before 413, invalid_json and 404, then insufficient_scope", async (t) => {
  const api = await startApp(t);
  const u = await signUp(api);
  const read = await createApiKey(api, u, { scope: "read" });
  assertError(await api.call("PATCH", "/me", undefined, read.secret, { raw: "{oops" }), 403, "api_key_not_allowed", "before invalid_json");
  assertError(await api.call("POST", "/me/api-keys", undefined, read.secret, { raw: JSON.stringify({ name: "x".repeat(70_000), scope: "read" }) }), 403, "api_key_not_allowed", "before 413");
  assertError(await api.call("DELETE", "/me/api-keys/nope", undefined, read.secret), 403, "api_key_not_allowed", "before 404");
  assertError(await api.call("POST", "/invites/no-such-token/accept", undefined, read.secret), 403, "api_key_not_allowed", "before the unknown token's 404");
  assertError(await api.call("PATCH", "/me", { name: "x" }, read.secret), 403, "api_key_not_allowed", "not insufficient_scope, although read is too low");
  assertError(await api.call("POST", "/teams", undefined, read.secret, { raw: "{oops" }), 403, "insufficient_scope", "before invalid_json");
  assertError(await api.call("DELETE", "/teams/nope", undefined, read.secret), 403, "insufficient_scope", "before 404");
  assertError(await api.call("GET", "/nope", undefined, read.secret), 404, "not_found", "route existence comes first");
});

test("insufficient_scope: a read key on every kind of write, checked before the path resources", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const read = await createApiKey(api, w.member, { scope: "read" });
  const writes: [string, string, unknown?][] = [
    ["POST", `/columns/${w.cols[0]}/cards`, { title: "x" }],
    ["PATCH", `/cards/${card.id}`, { title: "x" }],
    ["POST", `/cards/${card.id}/move`, { columnId: w.cols[1] }],
    ["DELETE", `/cards/${card.id}`],
    ["POST", `/cards/${card.id}/comments`, { body: "x" }],
    ["POST", `/cards/${card.id}/checklist`, { text: "x" }],
    ["POST", `/cards/${card.id}/archive`],
    ["PATCH", "/cards/no-such-card", { title: "x" }],
    ["POST", "/columns/no-such-column/cards", { title: "x" }],
  ];
  for (const [method, path, body] of writes) assertError(await api.call(method, path, body, read.secret), 403, "insufficient_scope", `${method} ${path}`);
  for (const path of [`/cards/${card.id}`, `/boards/${w.board.id}/cards`, `/teams/${w.team.id}/search`, `/cards/${card.id}/comments`, "/me/mentions"]) {
    assertStatus(await api.call("GET", path, undefined, read.secret), 200, `GET ${path} with a read key`);
  }
  const now = await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.member.token);
  assert.deepEqual(now, card, "nothing changed");
});

test("routes whose Role starts with admin+ or is owner need an admin key, GETs included; other writes need write", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const write = await createApiKey(api, w.owner, { scope: "write" });
  const admin = await createApiKey(api, w.owner, { scope: "admin" });
  const adminOnly: [string, string, unknown?][] = [
    ["PATCH", `/teams/${w.team.id}`, { name: "x" }],
    ["DELETE", `/teams/${w.team.id}`],
    ["POST", `/teams/${w.team.id}/transfer`, { userId: w.admin.id }],
    ["PUT", `/teams/${w.team.id}/plan`, { plan: "team" }],
    ["POST", `/teams/${w.team.id}/members`, { email: w.outsider.email, role: "viewer" }],
    ["POST", `/teams/${w.team.id}/projects`, { name: "P", key: "PPP" }],
    ["POST", `/projects/${w.project.id}/boards`, { name: "B" }],
    ["GET", `/teams/${w.team.id}/audit`],
    ["GET", `/teams/${w.team.id}/webhooks`],
    ["POST", `/projects/${w.project.id}/fields`, { name: "F", type: "text" }],
    ["POST", `/teams/${w.team.id}/labels`, { name: "l" }],
  ];
  for (const [method, path, body] of adminOnly) assertError(await api.call(method, path, body, write.secret), 403, "insufficient_scope", `write key ${method} ${path}`);
  assertStatus(await api.call("GET", `/teams/${w.team.id}/audit`, undefined, admin.secret), 200, "an admin key reads the audit log");
  assertStatus(await api.call("PATCH", `/teams/${w.team.id}`, { name: "Renamed" }, admin.secret), 200);
  assertStatus(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "member+ write" }, write.secret), 201, "member+ writes need only write");
  // "admin+, or any member removing themselves" starts with admin+: even leaving needs an admin key.
  const mWrite = await createApiKey(api, w.member, { scope: "write" });
  const mAdmin = await createApiKey(api, w.member, { scope: "admin" });
  assertError(await api.call("DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, mWrite.secret), 403, "insufficient_scope", "leaving with a write key");
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, mAdmin.secret), 204, "a member's admin key may leave");
});

test("scope and role are separate: a member's or a viewer's admin key still gets 403 forbidden from the role check", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const memberAdmin = await createApiKey(api, w.member, { scope: "admin" });
  const viewerAdmin = await createApiKey(api, w.viewer, { scope: "admin" });
  assertError(await api.call("PATCH", `/teams/${w.team.id}`, { name: "x" }, memberAdmin.secret), 403, "forbidden", "member on an admin+ route");
  assertError(await api.call("POST", `/teams/${w.team.id}/projects`, { name: "P", key: "PPP" }, memberAdmin.secret), 403, "forbidden");
  assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "x" }, viewerAdmin.secret), 403, "forbidden", "viewer on a member+ route");
  assertError(await api.call("GET", `/teams/${w.team.id}/audit`, undefined, viewerAdmin.secret), 403, "forbidden");
  assertStatus(await api.call("GET", `/boards/${w.board.id}`, undefined, viewerAdmin.secret), 200);
  const outsiderAdmin = await createApiKey(api, w.outsider, { scope: "admin" });
  assertError(await api.call("GET", `/teams/${w.team.id}`, undefined, outsiderAdmin.secret), 404, "not_found", "a key sees what its owner sees");
});

test("the /me routes a key may use follow the method rule: GETs need read, POST and PUT need write", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const read = await createApiKey(api, w.viewer, { scope: "read" });
  const write = await createApiKey(api, w.viewer, { scope: "write" });
  const settings = { types: { mention: true, comment: true, assigned: true, moved: false, due: true, rule: true, invite: true }, mutedProjectIds: [] };
  for (const path of ["/me/notifications", "/me/notifications/unread-count", "/me/notification-settings", "/me/timer", "/me/activity", "/me/invites"]) {
    assertStatus(await api.call("GET", path, undefined, read.secret), 200, `GET ${path}`);
  }
  assertError(await api.call("POST", "/me/notifications/read-all", {}, read.secret), 403, "insufficient_scope");
  assertError(await api.call("PUT", "/me/notification-settings", settings, read.secret), 403, "insufficient_scope");
  assertError(await api.call("POST", `/cards/${card.id}/watch`, undefined, read.secret), 403, "insufficient_scope", "a viewer+ POST");
  assert.deepEqual(await ok(api, 200, "POST", "/me/notifications/read-all", {}, write.secret), { updated: 0 });
  assert.equal((await ok(api, 200, "PUT", "/me/notification-settings", settings, write.secret)).types.moved, false);
  assertStatus(await api.call("POST", `/cards/${card.id}/watch`, undefined, write.secret), 204, "a viewer's write key watches");
  const watchers = await ok(api, 200, "GET", `/cards/${card.id}/watchers`, undefined, read.secret);
  assert.ok(watchers.items.some((m: any) => m.userId === w.viewer.id));
});

test("a team-restricted key sees only its team: other teams and everything in them are 404, and GET /teams lists one team", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.member.token);
  const op = await createProject(api, other.id, w.member, "OTH");
  const ob = await createBoard(api, op.id, w.member);
  const oc = await createCard(api, ob.columns[0].id, w.member, { title: "elsewhere" });
  const key = await createApiKey(api, w.member, { scope: "admin", teamId: w.team.id });
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, key.secret)).items.map((x: any) => x.id), [w.team.id]);
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, w.member.token)).items.map((x: any) => x.id), [w.team.id, other.id]);
  for (const path of [`/teams/${other.id}`, `/teams/${other.id}/projects`, `/projects/${op.id}`, `/boards/${ob.id}`, `/cards/${oc.id}`, `/teams/${other.id}/search`]) {
    assertError(await api.call("GET", path, undefined, key.secret), 404, "not_found", `GET ${path}`);
  }
  assertError(await api.call("PATCH", `/teams/${other.id}`, { name: "x" }, key.secret), 404, "not_found", "the member owns that team, but not through this key");
  assertError(await api.call("POST", `/columns/${ob.columns[0].id}/cards`, { title: "x" }, key.secret), 404, "not_found");
  assertStatus(await api.call("GET", `/boards/${w.board.id}`, undefined, key.secret), 200, "its own team works");
  assertStatus(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "inside" }, key.secret), 201);
});

test("a team-restricted key's mentions, notifications and unread count leave out the other teams", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.outsider.token);
  await addMember(api, other.id, w.outsider, w.viewer, "viewer");
  const op = await createProject(api, other.id, w.outsider, "OTH");
  const ob = await createBoard(api, op.id, w.outsider);
  const here = await createCard(api, w.cols[0], w.member, { title: "here" });
  const there = await createCard(api, ob.columns[0].id, w.outsider, { title: "there" });
  const m1 = await ok(api, 201, "POST", `/cards/${here.id}/comments`, { body: `@${w.viewer.handle} here` }, w.member.token);
  await ok(api, 201, "POST", `/cards/${there.id}/comments`, { body: `@${w.viewer.handle} there` }, w.outsider.token);
  const key = await createApiKey(api, w.viewer, { scope: "read", teamId: w.team.id });
  assert.equal((await ok(api, 200, "GET", "/me/mentions", undefined, w.viewer.token)).items.length, 2);
  assert.deepEqual((await ok(api, 200, "GET", "/me/mentions", undefined, key.secret)).items.map((m: any) => m.commentId), [m1.id]);
  const all = await ok(api, 200, "GET", "/me/notifications", undefined, w.viewer.token);
  assert.deepEqual(all.items.map((n: any) => n.teamId).sort(), [other.id, w.team.id].sort());
  const mine = await ok(api, 200, "GET", "/me/notifications", undefined, key.secret);
  assert.deepEqual(mine.items.map((n: any) => [n.type, n.teamId, n.commentId]), [["mention", w.team.id, m1.id]]);
  assert.deepEqual(await ok(api, 200, "GET", "/me/notifications/unread-count", undefined, key.secret), { count: 1 });
  assert.deepEqual(await ok(api, 200, "GET", "/me/notifications/unread-count", undefined, w.viewer.token), { count: 2 });
  const foreign = all.items.find((n: any) => n.teamId === other.id);
  assertError(await api.call("POST", `/me/notifications/${foreign.id}/read`, undefined, (await createApiKey(api, w.viewer, { scope: "write", teamId: w.team.id })).secret), 404, "not_found", "another team's notification");
});

test("a team-restricted key's activity, timer and invitations leave out the other teams", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.outsider.token);
  await addMember(api, other.id, w.outsider, w.member, "member");
  const op = await createProject(api, other.id, w.outsider, "OTH");
  const ob = await createBoard(api, op.id, w.outsider);
  const here = await createCard(api, w.cols[0], w.member, { title: "here" });
  const there = await createCard(api, ob.columns[0].id, w.member, { title: "there" });
  const third = await ok(api, 201, "POST", "/teams", { name: "Third" }, w.admin.token);
  const invite = await ok(api, 201, "POST", `/teams/${third.id}/invites`, { email: w.member.email, role: "viewer" }, w.admin.token);
  await ok(api, 200, "POST", `/cards/${there.id}/timer/start`, undefined, w.member.token);
  const key = await createApiKey(api, w.member, { scope: "read", teamId: w.team.id });
  const act = await ok(api, 200, "GET", "/me/activity", undefined, key.secret);
  assert.deepEqual(act.items.map((e: any) => [e.event, e.cardId, e.teamId]), [["card.created", here.id, w.team.id]]);
  assert.equal((await ok(api, 200, "GET", "/me/activity", undefined, w.member.token)).items.length, 2);
  assert.deepEqual(await ok(api, 200, "GET", "/me/timer", undefined, key.secret), { timer: null }, "the running timer is on another team's card");
  assert.equal((await ok(api, 200, "GET", "/me/timer", undefined, w.member.token)).timer.cardId, there.id);
  assert.deepEqual((await ok(api, 200, "GET", "/me/invites", undefined, key.secret)).items, []);
  assert.deepEqual((await ok(api, 200, "GET", "/me/invites", undefined, w.member.token)).items.map((i: any) => i.id), [invite.id]);
});

test("a team-restricted key keeps working when its owner leaves the team, and then sees nothing of it", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const key = await createApiKey(api, w.member, { scope: "admin", teamId: w.team.id });
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.admin.token), 204);
  const me = await api.call("GET", "/me", undefined, key.secret);
  assertStatus(me, 200, "the key is not revoked");
  assert.equal(me.body.id, w.member.id);
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, key.secret)).items, []);
  assertError(await api.call("GET", `/teams/${w.team.id}`, undefined, key.secret), 404, "not_found");
  assertError(await api.call("GET", `/boards/${w.board.id}`, undefined, key.secret), 404, "not_found");
  assertError(await api.call("POST", "/teams", { name: "x" }, key.secret), 403, "api_key_not_allowed", "still team-restricted");
});

test("an unrestricted key follows its owner's membership: removed means 404, re-added with another role means that role", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const key = await createApiKey(api, w.member, { scope: "write" });
  const card = await ok(api, 201, "POST", `/columns/${w.cols[0]}/cards`, { title: "mine" }, key.secret);
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.admin.token), 204);
  assertError(await api.call("GET", `/cards/${card.id}`, undefined, key.secret), 404, "not_found", "after leaving");
  await addMember(api, w.team.id, w.owner, w.member, "viewer");
  assertStatus(await api.call("GET", `/cards/${card.id}`, undefined, key.secret), 200, "back as a viewer");
  assertError(await api.call("PATCH", `/cards/${card.id}`, { title: "x" }, key.secret), 403, "forbidden", "a viewer may not write");
});

test("only the exact secret authenticates: a forged key with a real prefix, a truncated or extended secret are 401", async (t) => {
  const api = await startApp(t);
  const u = await signUp(api);
  const key = await createApiKey(api, u, { scope: "read" });
  const forged = `${key.prefix}${"Z".repeat(key.secret.length - 12)}`;
  const variants: [string, string][] = [
    ["same prefix, other characters", forged === key.secret ? `${key.prefix}${"Y".repeat(key.secret.length - 12)}` : forged],
    ["truncated", key.secret.slice(0, -1)],
    ["extended", `${key.secret}A`],
    ["without trk_", key.secret.slice(4)],
    ["uppercase TRK_", `TRK_${key.secret.slice(4)}`],
  ];
  for (const [what, secret] of variants) assertError(await api.call("GET", "/me", undefined, secret), 401, "unauthorized", what);
  assertStatus(await api.call("GET", "/me", undefined, key.secret), 200);
});

test("teamId must name a team the caller belongs to; after that team is deleted the key still authenticates and sees no team", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const theirs = await ok(api, 201, "POST", "/teams", { name: "Theirs" }, w.outsider.token);
  assertError(await api.call("POST", "/me/api-keys", { name: "k", scope: "read", teamId: theirs.id }, w.member.token), 400, "invalid_body", "a team the caller is not in");
  const doomed = await ok(api, 201, "POST", "/teams", { name: "Doomed" }, w.member.token);
  const key = await createApiKey(api, w.member, { scope: "read", teamId: doomed.id });
  assert.equal(key.teamId, doomed.id);
  assertStatus(await api.call("DELETE", `/teams/${doomed.id}`, undefined, w.member.token), 204);
  assertStatus(await api.call("GET", "/me", undefined, key.secret), 200);
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, key.secret)).items, [], "not even the member's other team");
  assertError(await api.call("GET", `/teams/${w.team.id}`, undefined, key.secret), 404, "not_found");
});
