// Area `invites`: instruction.md section 30 (Invitations), with the members quota of section 13 and
// the invite notification of section 23.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  addMember,
  assertError,
  assertQuota,
  assertStatus,
  auditLog,
  Clock,
  createApiKey,
  DAY,
  eventLog,
  ok,
  setupTeam,
  signUp,
  type User,
} from "./helpers.ts";
import { assertKeys, startApp } from "./helpers-pipeline.ts";

const invite = (api: Api, teamId: string, by: User, email: string, role = "member"): Promise<any> => ok(api, 201, "POST", `/teams/${teamId}/invites`, { email, role }, by.token);
const list = async (api: Api, teamId: string, by: User, status?: string): Promise<any[]> =>
  (await ok(api, 200, "GET", `/teams/${teamId}/invites${status === undefined ? "" : `?status=${status}`}`, undefined, by.token)).items;
const mine = async (api: Api, u: User | string): Promise<any[]> => (await ok(api, 200, "GET", "/me/invites", undefined, typeof u === "string" ? u : u.token)).items;
const accept = (api: Api, token: string, u: User | string) => api.call("POST", `/invites/${token}/accept`, undefined, typeof u === "string" ? u : u.token);

test("creating an invitation answers it with its token once: email lowercased, pending, expiring after invites.ttlMs, audited with email and role", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  clock.advance(5000);
  const inv = await invite(api, w.team.id, w.admin, "  New.Person@Example.TEST ", "viewer");
  assertKeys(inv, ["id", "teamId", "email", "role", "status", "expiresAt", "invitedBy", "createdAt", "acceptedAt", "token"], "invitation");
  assert.deepEqual(
    [inv.teamId, inv.email, inv.role, inv.status, inv.expiresAt, inv.invitedBy, inv.createdAt, inv.acceptedAt],
    [w.team.id, "new.person@example.test", "viewer", "pending", new Date(clock.t + 7 * DAY).toISOString(), w.admin.id, clock.iso(), null],
  );
  assert.ok(typeof inv.token === "string" && inv.token.length >= 32);
  const [listed] = await list(api, w.team.id, w.owner);
  const { token: _token, ...rest } = inv;
  assert.deepEqual(listed, rest, "the token is returned only by create");
  const entries = (await auditLog(api, w.owner.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.details]), [["invite.created", "invite", inv.id, w.admin.id, { email: "new.person@example.test", role: "viewer" }]]);
});

test("invitation validation: an email by the account rules, role admin, member or viewer; a member's email is 409 already_member; admin+ only", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/invites`;
  for (const body of [{ role: "member" }, { email: "no-at-sign", role: "member" }, { email: "a@b@c", role: "member" }, { email: "x@y.test", role: "owner" }, { email: "x@y.test", role: "guest" }, { email: "x@y.test" }, { email: 5, role: "member" }]) {
    assertError(await api.call("POST", path, body, w.owner.token), 400, "invalid_body", JSON.stringify(body));
  }
  assertError(await api.call("POST", path, { email: w.viewer.email.toUpperCase(), role: "admin" }, w.owner.token), 409, "already_member");
  assertError(await api.call("POST", path, { email: w.owner.email, role: "admin" }, w.admin.token), 409, "already_member");
  for (const u of [w.member, w.viewer]) {
    assertError(await api.call("POST", path, { email: "x@y.test", role: "member" }, u.token), 403, "forbidden");
    assertError(await api.call("GET", path, undefined, u.token), 403, "forbidden");
  }
  assertError(await api.call("POST", path, { email: "x@y.test", role: "member" }, w.outsider.token), 404, "not_found");
  assert.deepEqual(await list(api, w.team.id, w.owner), []);
});

test("inviting an email that already has a pending invitation revokes the old one; the list is oldest first", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, defaultPlan: "team" });
  const w = await setupTeam(api, clock);
  const first = await invite(api, w.team.id, w.owner, "dup@example.test", "viewer");
  clock.advance(1000);
  const other = await invite(api, w.team.id, w.owner, "other@example.test");
  clock.advance(1000);
  const second = await invite(api, w.team.id, w.admin, "DUP@example.test", "admin");
  const items = await list(api, w.team.id, w.owner);
  assert.deepEqual(items.map((i) => [i.id, i.status]), [[first.id, "revoked"], [other.id, "pending"], [second.id, "pending"]]);
  assertError(await api.call("POST", `/invites/${first.token}/accept`, undefined, w.owner.token), 403, "forbidden", "the token is still looked up; the caller is not the addressee");
});

test("a pending invitation past expiresAt is shown, filtered and treated as expired, from exactly expiresAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, invites: { ttlMs: 3_600_000 } });
  const w = await setupTeam(api, clock);
  const u = await signUp(api);
  const inv = await invite(api, w.team.id, w.owner, u.email);
  assert.equal(inv.expiresAt, new Date(clock.t + 3_600_000).toISOString());
  clock.set(Date.parse(inv.expiresAt) - 1);
  assert.equal((await list(api, w.team.id, w.owner))[0].status, "pending");
  assert.equal((await mine(api, u)).length, 1);
  clock.set(Date.parse(inv.expiresAt));
  assert.equal((await list(api, w.team.id, w.owner))[0].status, "expired");
  assert.deepEqual(await list(api, w.team.id, w.owner, "pending"), []);
  assert.deepEqual((await list(api, w.team.id, w.owner, "expired")).map((i) => i.id), [inv.id]);
  assert.deepEqual(await mine(api, u), [], "GET /me/invites lists pending ones only");
  assertError(await accept(api, inv.token, u), 409, "invite_expired");
});

test("?status= filters by pending, accepted, declined, revoked, expired or all (the default); anything else is 400 invalid_query", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, defaultPlan: "team", invites: { ttlMs: 10_000 } });
  const w = await setupTeam(api, clock);
  const [a, d, r] = [await signUp(api), await signUp(api), await signUp(api)];
  const ia = await invite(api, w.team.id, w.owner, a.email);
  const id = await invite(api, w.team.id, w.owner, d.email);
  const ir = await invite(api, w.team.id, w.owner, r.email);
  const ie = await invite(api, w.team.id, w.owner, "late@example.test");
  await ok(api, 200, "POST", `/invites/${ia.token}/accept`, undefined, a.token);
  await ok(api, 204, "POST", `/me/invites/${id.id}/decline`, undefined, d.token);
  await ok(api, 204, "DELETE", `/invites/${ir.id}`, undefined, w.owner.token);
  clock.advance(10_000);
  const ip = await invite(api, w.team.id, w.owner, "fresh@example.test");
  const ids = async (s?: string) => (await list(api, w.team.id, w.owner, s)).map((i) => i.id);
  assert.deepEqual(await ids(), [ia.id, id.id, ir.id, ie.id, ip.id]);
  assert.deepEqual(await ids("all"), await ids());
  assert.deepEqual([await ids("accepted"), await ids("declined"), await ids("revoked"), await ids("expired"), await ids("pending")], [[ia.id], [id.id], [ir.id], [ie.id], [ip.id]]);
  for (const s of ["open", "", "PENDING"]) assertError(await api.call("GET", `/teams/${w.team.id}/invites?status=${s}`, undefined, w.owner.token), 400, "invalid_query", s);
});

test("accept: 404 for an unknown token, 403 for a caller with another email; the addressee joins with the role, member.added is emitted and audited", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  const u = await signUp(api);
  const inv = await invite(api, w.team.id, w.admin, u.email, "admin");
  const log = await eventLog(t, api, w.team.id, w.owner);
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  assertError(await accept(api, "no-such-token", u), 404, "not_found");
  assertError(await accept(api, inv.token, w.outsider), 403, "forbidden");
  clock.advance(60_000);
  const res = await accept(api, inv.token, u);
  assertStatus(res, 200);
  assert.deepEqual([res.body.userId, res.body.email, res.body.role, res.body.joinedAt, res.body.handle], [u.id, u.email, "admin", clock.iso(), u.handle]);
  const after = (await list(api, w.team.id, w.owner))[0];
  assert.deepEqual([after.status, after.acceptedAt], ["accepted", clock.iso()]);
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, u.token)).myRole, "admin");
  assert.deepEqual(await log.names(), ["member.added"]);
  const [ev] = await log.events(1);
  assert.deepEqual([ev.actorId, ev.via, ev.data.member], [u.id, null, res.body]);
  const entries = (await auditLog(api, w.owner.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.details]), [["member.added", "member", u.id, u.id, { role: "admin" }]]);
  assertError(await accept(api, inv.token, u), 409, "invite_used");
});

test("an expired invitation: accept and decline are 409 invite_expired, revoke still works", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, invites: { ttlMs: 1000 } });
  const w = await setupTeam(api, clock);
  const u = await signUp(api);
  const inv = await invite(api, w.team.id, w.owner, u.email);
  clock.advance(1000);
  assertError(await accept(api, inv.token, u), 409, "invite_expired");
  assertError(await api.call("POST", `/me/invites/${inv.id}/decline`, undefined, u.token), 409, "invite_expired");
  assertStatus(await api.call("DELETE", `/invites/${inv.id}`, undefined, w.owner.token), 204);
  assert.equal((await list(api, w.team.id, w.owner))[0].status, "revoked");
  assertError(await accept(api, inv.token, u), 409, "invite_used", "revoked is used, checked before expired");
});

test("accept checks the members quota on the members alone: a full team answers 409 quota_exceeded and the invitation stays pending", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const u = await signUp(api);
  const inv = await invite(api, w.team.id, w.owner, u.email);
  const fifth = await signUp(api);
  await addMember(api, w.team.id, w.owner, fifth, "viewer");
  assertQuota(await accept(api, inv.token, u), "members", 5, 5);
  assert.equal((await list(api, w.team.id, w.owner, "pending"))[0].id, inv.id);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${fifth.id}`, undefined, w.owner.token);
  assertStatus(await accept(api, inv.token, u), 200);
});

test("create checks members plus pending, unexpired invitations against the members limit, not counting one to the same email", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, invites: { ttlMs: 60_000 } });
  const w = await setupTeam(api, clock);
  await invite(api, w.team.id, w.owner, "one@example.test");
  assertQuota(await api.call("POST", `/teams/${w.team.id}/invites`, { email: "two@example.test", role: "member" }, w.owner.token), "members", 5, 5);
  assertError(await api.call("POST", `/teams/${w.team.id}/invites`, { email: "bad", role: "member" }, w.owner.token), 400, "invalid_body", "validation before the quota");
  assertStatus(await api.call("POST", `/teams/${w.team.id}/invites`, { email: "ONE@example.test", role: "viewer" }, w.owner.token), 201, "replacing one's own pending invitation");
  clock.advance(60_000);
  assertStatus(await api.call("POST", `/teams/${w.team.id}/invites`, { email: "two@example.test", role: "member" }, w.owner.token), 201, "an expired invitation does not count");
});

test("decline sets declined; another user's invitation id is 404; GET /me/invites lists the caller's pending invitations across teams, oldest first", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, defaultPlan: "team" });
  const w = await setupTeam(api, clock);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.admin.token);
  const u = await signUp(api);
  const i1 = await invite(api, w.team.id, w.owner, u.email);
  clock.advance(1000);
  const i2 = await invite(api, other.id, w.admin, u.email.toUpperCase(), "viewer");
  await invite(api, w.team.id, w.owner, "someone@example.test");
  assert.deepEqual((await mine(api, u)).map((i) => [i.id, i.teamId, i.status]), [[i1.id, w.team.id, "pending"], [i2.id, other.id, "pending"]]);
  assert.ok((await mine(api, u)).every((i) => !("token" in i)));
  assertError(await api.call("POST", `/me/invites/${i1.id}/decline`, undefined, w.outsider.token), 404, "not_found");
  assertStatus(await api.call("POST", `/me/invites/${i1.id}/decline`, undefined, u.token), 204);
  assert.equal((await list(api, w.team.id, w.owner))[0].status, "declined");
  assertError(await api.call("POST", `/me/invites/${i1.id}/decline`, undefined, u.token), 409, "invite_used");
  assertError(await accept(api, i1.token, u), 409, "invite_used");
  assert.deepEqual((await mine(api, u)).map((i) => i.id), [i2.id]);
});

test("revoke (DELETE) sets revoked on a pending invitation and is audited; accepted, declined or revoked ones are 409 invite_used; admin+ only", async (t) => {
  const api = await startApp(t, { defaultPlan: "team" });
  const w = await setupTeam(api);
  const u = await signUp(api);
  const pending = await invite(api, w.team.id, w.owner, "p@example.test");
  const used = await invite(api, w.team.id, w.owner, u.email);
  await ok(api, 200, "POST", `/invites/${used.token}/accept`, undefined, u.token);
  assertError(await api.call("DELETE", `/invites/${pending.id}`, undefined, w.member.token), 403, "forbidden");
  await ok(api, 204, "DELETE", `/invites/${pending.id}`, undefined, w.admin.token);
  const entry = (await auditLog(api, w.owner.token, w.team.id)).at(-1);
  assert.deepEqual([entry.action, entry.targetType, entry.targetId, entry.actorId, entry.details], ["invite.revoked", "invite", pending.id, w.admin.id, {}]);
  assertError(await api.call("DELETE", `/invites/${pending.id}`, undefined, w.admin.token), 409, "invite_used");
  assertError(await api.call("DELETE", `/invites/${used.id}`, undefined, w.admin.token), 409, "invite_used");
  assertError(await api.call("DELETE", `/invites/no-such-invite`, undefined, w.admin.token), 404, "not_found");
});

test("adding the addressee through the members route accepts their pending invitation by cascade; API keys may not accept", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  const u = await signUp(api);
  const inv = await invite(api, w.team.id, w.owner, u.email);
  const key = (await createApiKey(api, u, { scope: "admin" })).secret;
  assertError(await accept(api, inv.token, key), 403, "api_key_not_allowed");
  assertError(await accept(api, "no-such-token", key), 403, "api_key_not_allowed", "3a before step 5");
  clock.advance(1000);
  await addMember(api, w.team.id, w.admin, u, "viewer");
  const after = (await list(api, w.team.id, w.owner))[0];
  assert.deepEqual([after.status, after.acceptedAt], ["accepted", clock.iso()]);
  assertError(await accept(api, inv.token, u), 409, "invite_used");
  const entries = (await auditLog(api, w.owner.token, w.team.id)).filter((e) => e.targetType === "invite");
  assert.deepEqual(entries.map((e) => e.action), ["invite.created"], "the cascade appends nothing");
});

test("a team-restricted API key's /me/invites leaves out the invitations of other teams", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.owner.token);
  await addMember(api, other.id, w.owner, w.outsider, "member");
  const third = await ok(api, 201, "POST", "/teams", { name: "Third" }, w.owner.token);
  const inThird = await invite(api, third.id, w.owner, w.outsider.email);
  await invite(api, w.team.id, w.owner, w.outsider.email);
  assert.equal((await mine(api, w.outsider)).length, 2);
  const key = (await createApiKey(api, w.outsider, { scope: "read", teamId: other.id })).secret;
  assert.deepEqual(await mine(api, key), []);
  const unrestricted = (await createApiKey(api, w.outsider, { scope: "read" })).secret;
  assert.deepEqual((await mine(api, unrestricted)).map((i) => i.id)[0], inThird.id);
});
