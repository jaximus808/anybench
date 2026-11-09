// Area `teams`: instruction.md section 2 (Teams and roles), with the check order of section 0.3.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addMember,
  assertError,
  assertStatus,
  Clock,
  createBoard,
  createCard,
  createProject,
  ok,
  setupBoard,
  setupTeam,
  signUp,
  startApp,
} from "./helpers.ts";

test("POST /teams makes the caller owner; GET /teams lists only the caller's teams, in team creation order, with myRole", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const a = await signUp(api);
  const b = await signUp(api);
  const c = await signUp(api);
  const t1 = await api.call("POST", "/teams", { name: "  First  " }, a.token);
  assertStatus(t1, 201);
  assert.equal(t1.body.name, "First");
  assert.equal(t1.body.ownerId, a.id);
  assert.equal(t1.body.myRole, "owner");
  assert.equal(t1.body.createdAt, clock.iso());
  assert.equal(typeof t1.body.id, "string");
  clock.advance(1000);
  const t2 = await ok(api, 201, "POST", "/teams", { name: "Second" }, b.token);
  clock.advance(1000);
  await ok(api, 201, "POST", "/teams", { name: "Third" }, c.token);
  await addMember(api, t1.body.id, a, b, "member");
  const bTeams = await ok(api, 200, "GET", "/teams", undefined, b.token);
  assert.deepEqual(
    bTeams.items.map((x: any) => [x.id, x.myRole]),
    [
      [t1.body.id, "member"],
      [t2.id, "owner"],
    ],
  );
  const aTeams = await ok(api, 200, "GET", "/teams", undefined, a.token);
  assert.deepEqual(aTeams.items.map((x: any) => x.name), ["First"]);
  const one = await ok(api, 200, "GET", `/teams/${t1.body.id}`, undefined, b.token);
  assert.deepEqual({ ...one, myRole: "owner" }, t1.body);
  assert.equal(one.myRole, "member");
  assertError(await api.call("POST", "/teams", { name: "  " }, a.token), 400, "invalid_body");
  assertError(await api.call("POST", "/teams", { name: "n".repeat(101) }, a.token), 400, "invalid_body");
  assertError(await api.call("POST", "/teams", { name: 7 }, a.token), 400, "invalid_body");
});

test("non-members get 404 not_found, never 403, on every team route", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const tid = w.team.id;
  const o = w.outsider.token;
  const calls: [string, string, unknown?][] = [
    ["GET", `/teams/${tid}`],
    ["PATCH", `/teams/${tid}`, { name: "Mine" }],
    ["DELETE", `/teams/${tid}`],
    ["GET", `/teams/${tid}/members`],
    ["POST", `/teams/${tid}/members`, { email: w.outsider.email, role: "admin" }],
    ["PATCH", `/teams/${tid}/members/${w.member.id}`, { role: "viewer" }],
    ["DELETE", `/teams/${tid}/members/${w.member.id}`],
    ["DELETE", `/teams/${tid}/members/${w.outsider.id}`],
    ["POST", `/teams/${tid}/transfer`, { userId: w.outsider.id }],
    // Step 5 comes before body validation (step 7).
    ["PATCH", `/teams/${tid}`, { name: "" }],
    ["POST", `/teams/${tid}/members`, { email: "bad", role: "owner" }],
  ];
  for (const [method, path, body] of calls) assertError(await api.call(method, path, body, o), 404, "not_found", `${method} ${path}`);
  assertError(await api.call("GET", "/teams/no-such-team", undefined, w.owner.token), 404, "not_found", "unknown team id");
  assertError(await api.call("DELETE", "/teams/no-such-team", undefined, w.owner.token), 404, "not_found", "unknown team id");
  // The outsider changed nothing.
  const members = await ok(api, 200, "GET", `/teams/${tid}/members`, undefined, w.owner.token);
  assert.equal(members.items.length, 4);
  assert.equal((await ok(api, 200, "GET", `/teams/${tid}`, undefined, w.owner.token)).name, "Core");
});

test("role checks: member and viewer get 403 on admin+ routes, admin gets 403 on owner-only routes", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const tid = w.team.id;
  const extra = await signUp(api);
  for (const u of [w.member, w.viewer]) {
    assertError(await api.call("PATCH", `/teams/${tid}`, { name: "X" }, u.token), 403, "forbidden", "PATCH team");
    assertError(await api.call("POST", `/teams/${tid}/members`, { email: extra.email, role: "viewer" }, u.token), 403, "forbidden", "add member");
    assertError(await api.call("PATCH", `/teams/${tid}/members/${w.viewer.id}`, { role: "member" }, u.token), 403, "forbidden", "change role");
    assertError(await api.call("DELETE", `/teams/${tid}`, undefined, u.token), 403, "forbidden", "DELETE team");
    assertError(await api.call("POST", `/teams/${tid}/transfer`, { userId: w.admin.id }, u.token), 403, "forbidden", "transfer");
  }
  assertError(await api.call("DELETE", `/teams/${tid}`, undefined, w.admin.token), 403, "forbidden", "admin deletes team");
  assertError(await api.call("POST", `/teams/${tid}/transfer`, { userId: w.member.id }, w.admin.token), 403, "forbidden", "admin transfers");
  // Role is checked before body validation (step 6 before 7).
  assertError(await api.call("PATCH", `/teams/${tid}`, { name: "" }, w.member.token), 403, "forbidden", "member with an invalid body");
  const renamed = await ok(api, 200, "PATCH", `/teams/${tid}`, { name: " Renamed " }, w.admin.token);
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.myRole, "admin");
  assertError(await api.call("PATCH", `/teams/${tid}`, { name: "" }, w.admin.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/teams/${tid}`, {}, w.admin.token), 400, "invalid_body");
  const asViewer = await ok(api, 200, "GET", `/teams/${tid}`, undefined, w.viewer.token);
  assert.equal(asViewer.myRole, "viewer");
  assert.equal(asViewer.name, "Renamed");
});

test("GET members lists the member shape, oldest joinedAt first", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const start = clock.t;
  const w = await setupTeam(api, clock);
  const res = await ok(api, 200, "GET", `/teams/${w.team.id}/members`, undefined, w.viewer.token);
  assert.deepEqual(
    res.items,
    [
      [w.owner, "owner", start],
      [w.admin, "admin", start + 1000],
      [w.member, "member", start + 2000],
      [w.viewer, "viewer", start + 3000],
    ].map(([u, role, at]: any) => ({ userId: u.id, email: u.email, name: u.name, handle: u.handle, role, joinedAt: new Date(at).toISOString() })),
  );
});

test("adding a member: bad email or role is 400, unknown email 404 user_not_found, an existing member 409 already_member", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const owner = await signUp(api);
  const newbie = await signUp(api, { email: "new.person@example.test" });
  const team = await ok(api, 201, "POST", "/teams", { name: "T" }, owner.token);
  const path = `/teams/${team.id}/members`;
  assertError(await api.call("POST", path, { email: newbie.email, role: "owner" }, owner.token), 400, "invalid_body", "role owner");
  assertError(await api.call("POST", path, { email: newbie.email, role: "boss" }, owner.token), 400, "invalid_body", "unknown role");
  assertError(await api.call("POST", path, { email: newbie.email }, owner.token), 400, "invalid_body", "missing role");
  assertError(await api.call("POST", path, { email: "not-an-email", role: "member" }, owner.token), 400, "invalid_body", "invalid email");
  assertError(await api.call("POST", path, { email: "ghost@example.test", role: "owner" }, owner.token), 400, "invalid_body", "unknown email with a bad role: validation first");
  assertError(await api.call("POST", path, { email: "ghost@example.test", role: "member" }, owner.token), 404, "user_not_found");
  clock.advance(500);
  const added = await api.call("POST", path, { email: "  NEW.Person@Example.test ", role: "member" }, owner.token);
  assertStatus(added, 201, "email matched trimmed and case-insensitively");
  assert.deepEqual(added.body, { userId: newbie.id, email: newbie.email, name: newbie.name, handle: newbie.handle, role: "member", joinedAt: clock.iso() });
  assertError(await api.call("POST", path, { email: newbie.email, role: "viewer" }, owner.token), 409, "already_member");
  assertError(await api.call("POST", path, { email: owner.email, role: "admin" }, owner.token), 409, "already_member", "the owner");
  const mine = await ok(api, 200, "GET", "/teams", undefined, newbie.token);
  assert.deepEqual(mine.items.map((x: any) => [x.id, x.myRole]), [[team.id, "member"]]);
});

test("PATCH a member's role: admin, member or viewer only; a userId that is not a member is 404", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = (u: string) => `/teams/${w.team.id}/members/${u}`;
  const res = await api.call("PATCH", path(w.member.id), { role: "viewer" }, w.admin.token);
  assertStatus(res, 200);
  assert.equal(res.body.userId, w.member.id);
  assert.equal(res.body.role, "viewer");
  assert.equal(res.body.handle, w.member.handle);
  assertStatus(await api.call("PATCH", path(w.viewer.id), { role: "admin" }, w.admin.token), 200, "promote to admin");
  assertStatus(await api.call("PATCH", path(w.viewer.id), { role: "member" }, w.admin.token), 200, "admin demotes another admin");
  assertError(await api.call("PATCH", path(w.member.id), { role: "owner" }, w.admin.token), 400, "invalid_body", "role owner");
  assertError(await api.call("PATCH", path(w.member.id), { role: "superuser" }, w.admin.token), 400, "invalid_body");
  assertError(await api.call("PATCH", path(w.member.id), {}, w.admin.token), 400, "invalid_body");
  assertError(await api.call("PATCH", path(w.outsider.id), { role: "viewer" }, w.admin.token), 404, "not_found", "not a member");
  assertError(await api.call("PATCH", path("nobody"), { role: "viewer" }, w.admin.token), 404, "not_found", "unknown user");
  const roles = await ok(api, 200, "GET", `/teams/${w.team.id}/members`, undefined, w.owner.token);
  assert.deepEqual(roles.items.map((m: any) => m.role), ["owner", "admin", "viewer", "member"]);
});

test("changing the owner's role or removing the owner is 409 owner_required, even by the owner", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/members/${w.owner.id}`;
  assertError(await api.call("PATCH", path, { role: "admin" }, w.admin.token), 409, "owner_required", "admin demotes owner");
  assertError(await api.call("PATCH", path, { role: "member" }, w.owner.token), 409, "owner_required", "owner demotes self");
  assertError(await api.call("DELETE", path, undefined, w.admin.token), 409, "owner_required", "admin removes owner");
  assertError(await api.call("DELETE", path, undefined, w.owner.token), 409, "owner_required", "owner leaves");
  const team = await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, w.owner.token);
  assert.equal(team.ownerId, w.owner.id);
  assert.equal(team.myRole, "owner");
});

test("members may remove themselves; removing someone else needs admin+; admins remove other admins", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const admin2 = await signUp(api);
  await addMember(api, w.team.id, w.owner, admin2, "admin");
  const path = (u: string) => `/teams/${w.team.id}/members/${u}`;
  assertError(await api.call("DELETE", path(w.viewer.id), undefined, w.member.token), 403, "forbidden", "member removes viewer");
  assertError(await api.call("DELETE", path(w.member.id), undefined, w.viewer.token), 403, "forbidden", "viewer removes member");
  const self = await api.call("DELETE", path(w.member.id), undefined, w.member.token);
  assertStatus(self, 204, "member leaves");
  assert.equal(self.text, "");
  assertError(await api.call("GET", `/teams/${w.team.id}`, undefined, w.member.token), 404, "not_found", "left team is invisible");
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, w.member.token)).items, []);
  assertStatus(await api.call("DELETE", path(w.viewer.id), undefined, w.viewer.token), 204, "viewer leaves");
  assertStatus(await api.call("DELETE", path(admin2.id), undefined, w.admin.token), 204, "admin removes admin");
  const members = await ok(api, 200, "GET", `/teams/${w.team.id}/members`, undefined, w.owner.token);
  assert.deepEqual(members.items.map((m: any) => m.userId), [w.owner.id, w.admin.id]);
  assertError(await api.call("DELETE", path(w.member.id), undefined, w.admin.token), 404, "not_found", "no longer a member");
});

test("removing a member unassigns their cards across the team, archived projects included, without touching updatedAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const other = await createProject(api, w.team.id, w.owner, "OPS");
  const otherBoard = await createBoard(api, other.id, w.owner);
  const c1 = await createCard(api, w.cols[0], w.owner, { title: "one", assigneeId: w.member.id });
  const c2 = await createCard(api, otherBoard.columns[1].id, w.owner, { title: "two", assigneeId: w.member.id });
  const c3 = await createCard(api, w.cols[0], w.owner, { title: "three", assigneeId: w.admin.id });
  const comment = await ok(api, 201, "POST", `/cards/${c1.id}/comments`, { body: "mine" }, w.member.token);
  await ok(api, 200, "PATCH", `/projects/${other.id}`, { archived: true }, w.owner.token);
  clock.advance(60_000);
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.admin.token), 204);
  const after1 = await ok(api, 200, "GET", `/cards/${c1.id}`, undefined, w.owner.token);
  const after2 = await ok(api, 200, "GET", `/cards/${c2.id}`, undefined, w.owner.token);
  const after3 = await ok(api, 200, "GET", `/cards/${c3.id}`, undefined, w.owner.token);
  assert.equal(after1.assigneeId, null);
  assert.equal(after2.assigneeId, null, "archived project's card too");
  assert.equal(after3.assigneeId, w.admin.id, "other assignees untouched");
  assert.equal(after1.updatedAt, c1.updatedAt, "cascade keeps updatedAt");
  assert.equal(after2.updatedAt, c2.updatedAt, "cascade keeps updatedAt");
  const still = await ok(api, 200, "GET", `/comments/${comment.id}`, undefined, w.owner.token);
  assert.equal(still.body, "mine", "their comments stay");
  assert.equal(still.authorId, w.member.id);
});

test("transfer makes the target owner and the caller admin, and answers the team as the caller now sees it", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const res = await api.call("POST", `/teams/${w.team.id}/transfer`, { userId: w.member.id }, w.owner.token);
  assertStatus(res, 200);
  assert.equal(res.body.id, w.team.id);
  assert.equal(res.body.ownerId, w.member.id);
  assert.equal(res.body.myRole, "admin");
  const members = await ok(api, 200, "GET", `/teams/${w.team.id}/members`, undefined, w.member.token);
  const roleOf = Object.fromEntries(members.items.map((m: any) => [m.userId, m.role]));
  assert.equal(roleOf[w.member.id], "owner");
  assert.equal(roleOf[w.owner.id], "admin");
  assert.equal(members.items.filter((m: any) => m.role === "owner").length, 1, "exactly one owner");
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, w.member.token)).myRole, "owner");
  assertError(await api.call("DELETE", `/teams/${w.team.id}`, undefined, w.owner.token), 403, "forbidden", "the old owner");
  assertError(await api.call("DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.owner.token), 409, "owner_required", "removing the new owner");
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}/members/${w.owner.id}`, undefined, w.member.token), 204, "the old owner can now be removed");
});

test("transfer to a non-member, an unknown id, oneself or without userId is 400 invalid_body", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/transfer`;
  assertError(await api.call("POST", path, { userId: w.outsider.id }, w.owner.token), 400, "invalid_body", "not a member");
  assertError(await api.call("POST", path, { userId: "nobody" }, w.owner.token), 400, "invalid_body", "unknown id");
  assertError(await api.call("POST", path, { userId: w.owner.id }, w.owner.token), 400, "invalid_body", "oneself");
  assertError(await api.call("POST", path, {}, w.owner.token), 400, "invalid_body", "missing");
  assertError(await api.call("POST", path, { userId: 5 }, w.owner.token), 400, "invalid_body", "not a string");
  const team = await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, w.owner.token);
  assert.equal(team.ownerId, w.owner.id);
});

test("an admin can promote, demote and remove; the outsider is never affected", async (t) => {
  // Covers the full lifecycle of a membership driven by an admin, as the owner and the member see it.
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/members`;
  await ok(api, 201, "POST", path, { email: w.outsider.email, role: "viewer" }, w.admin.token);
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, w.outsider.token)).myRole, "viewer");
  await ok(api, 200, "PATCH", `${path}/${w.outsider.id}`, { role: "admin" }, w.admin.token);
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, w.outsider.token)).myRole, "admin");
  // The newly promoted admin can now add members.
  const late = await signUp(api);
  await ok(api, 201, "POST", path, { email: late.email, role: "member" }, w.outsider.token);
  assertStatus(await api.call("DELETE", `${path}/${w.outsider.id}`, undefined, w.admin.token), 204);
  assertError(await api.call("GET", `/teams/${w.team.id}/members`, undefined, w.outsider.token), 404, "not_found");
  const members = await ok(api, 200, "GET", path, undefined, w.owner.token);
  assert.deepEqual(members.items.map((m: any) => m.userId), [w.owner.id, w.admin.id, w.member.id, w.viewer.id, late.id]);
});

test("deleting a team removes it and everything in it for every member", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const keep = await ok(api, 201, "POST", "/teams", { name: "Keep" }, w.member.token);
  const card = await createCard(api, w.cols[0], w.member, { title: "doomed" });
  const res = await api.call("DELETE", `/teams/${w.team.id}`, undefined, w.owner.token);
  assertStatus(res, 204);
  assert.equal(res.text, "");
  for (const u of [w.owner, w.admin, w.member, w.viewer]) {
    assertError(await api.call("GET", `/teams/${w.team.id}`, undefined, u.token), 404, "not_found");
  }
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, w.owner.token)).items, []);
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, w.member.token)).items.map((x: any) => x.id), [keep.id]);
  assertError(await api.call("GET", `/projects/${w.project.id}`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/boards/${w.board.id}`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/cards/${card.id}`, undefined, w.owner.token), 404, "not_found");
});
