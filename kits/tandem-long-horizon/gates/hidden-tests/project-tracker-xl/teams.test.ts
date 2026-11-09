// Area `teams`: instruction.md section 2 (Teams and roles), with the check order of section 0.3
// and the change pipeline of section 0.8 (member events, cascades).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addMember,
  assertError,
  assertQuota,
  assertStatus,
  auditLog,
  Clock,
  createBoard,
  createCard,
  createProject,
  eventLog,
  getCard,
  ok,
  setupBoard,
  setupTeam,
  signUp,
  startApp,
} from "./helpers.ts";

test("POST /teams makes the caller owner on the defaultPlan; GET /teams lists only the caller's teams, in creation order, with myRole", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const a = await signUp(api);
  const b = await signUp(api);
  const c = await signUp(api);
  const t1 = await api.call("POST", "/teams", { name: "  First  " }, a.token);
  assertStatus(t1, 201);
  assert.deepEqual(Object.keys(t1.body).sort(), ["createdAt", "id", "myRole", "name", "ownerId", "plan"]);
  assert.equal(t1.body.name, "First");
  assert.equal(t1.body.ownerId, a.id);
  assert.equal(t1.body.myRole, "owner");
  assert.equal(t1.body.plan, "free", "the default defaultPlan is free");
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
  // defaultPlan applies to every new team of that app.
  const biz = await startApp(t, { now: clock.now, defaultPlan: "business" });
  const u = await signUp(biz);
  assert.equal((await ok(biz, 201, "POST", "/teams", { name: "Biz" }, u.token)).plan, "business");
});

test("non-members get 404 not_found, never 403, on every team-scoped route", async (t) => {
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
    ["GET", `/teams/${tid}/projects`],
    ["POST", `/teams/${tid}/projects`, { name: "P", key: "PP" }],
    ["GET", `/teams/${tid}/plan`],
    ["PUT", `/teams/${tid}/plan`, { plan: "team" }],
    ["GET", `/teams/${tid}/search`],
    ["GET", `/teams/${tid}/audit`],
    ["GET", `/teams/${tid}/webhooks`],
    ["GET", `/teams/${tid}/labels`],
    ["POST", `/teams/${tid}/labels`, { name: "x" }],
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
  const team = await ok(api, 200, "GET", `/teams/${tid}`, undefined, w.owner.token);
  assert.equal(team.name, "Core");
  assert.equal(team.plan, "free");
  assert.deepEqual((await ok(api, 200, "GET", `/teams/${tid}/projects`, undefined, w.owner.token)).items, []);
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
  assertError(await api.call("PUT", `/teams/${tid}/plan`, { plan: "team" }, w.admin.token), 403, "forbidden", "admin changes the plan");
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
  assert.equal(asViewer.plan, "free", "the refused plan change changed nothing");
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

test("the members quota is checked after already_member: a free team of 5 refuses a 6th with quota_exceeded details", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const fifth = await signUp(api);
  const sixth = await signUp(api);
  const path = `/teams/${w.team.id}/members`;
  await ok(api, 201, "POST", path, { email: fifth.email, role: "viewer" }, w.admin.token);
  const limits = await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.viewer.token);
  assert.equal(limits.limits.members, 5);
  assert.equal(limits.usage.members, 5);
  assertError(await api.call("POST", path, { email: fifth.email, role: "viewer" }, w.admin.token), 409, "already_member", "already_member comes before the quota");
  assertError(await api.call("POST", path, { email: "nobody@example.test", role: "viewer" }, w.admin.token), 404, "user_not_found", "user_not_found comes before the quota");
  assertError(await api.call("POST", path, { email: sixth.email, role: "owner" }, w.admin.token), 400, "invalid_body", "validation comes before the quota");
  assertQuota(await api.call("POST", path, { email: sixth.email, role: "viewer" }, w.admin.token), "members", 5, 5, "the 6th member");
  assertError(await api.call("GET", `/teams/${w.team.id}`, undefined, sixth.token), 404, "not_found", "the refused user is not a member");
  // Freeing a seat lets the next one in; a paid plan raises the limit.
  assertStatus(await api.call("DELETE", `${path}/${fifth.id}`, undefined, w.admin.token), 204);
  await ok(api, 201, "POST", path, { email: sixth.email, role: "viewer" }, w.admin.token);
  assertQuota(await api.call("POST", path, { email: fifth.email, role: "viewer" }, w.owner.token), "members", 5, 5, "full again");
  await ok(api, 200, "PUT", `/teams/${w.team.id}/plan`, { plan: "team" }, w.owner.token);
  await ok(api, 201, "POST", path, { email: fifth.email, role: "viewer" }, w.owner.token);
  assert.equal((await ok(api, 200, "GET", path, undefined, w.owner.token)).items.length, 6);
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
  assertStatus(await api.call("PATCH", path(w.viewer.id), { role: "member" }, w.admin.token), 200, "the current role again");
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
  // Validation (step 7) comes before the state conflict (step 8).
  assertError(await api.call("PATCH", path, { role: "owner" }, w.owner.token), 400, "invalid_body", "role owner on the owner");
  const team = await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, w.owner.token);
  assert.equal(team.ownerId, w.owner.id);
  assert.equal(team.myRole, "owner");
});

test("members may remove themselves; removing someone else needs admin+; member.added and member.removed go through the pipeline", async (t) => {
  const api = await startApp(t, { defaultPlan: "team" });
  const w = await setupTeam(api);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const admin2 = await signUp(api);
  const added = await addMember(api, w.team.id, w.owner, admin2, "admin");
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
  // Events: one per successful change, in order, with the documented data and actor.
  assert.deepEqual(await log.names(), ["member.added", "member.removed", "member.removed", "member.removed"]);
  const events = await log.events(4);
  assert.deepEqual(events[0].data, { member: added });
  assert.equal(events[0].actorId, w.owner.id);
  assert.equal(events[0].via, null);
  assert.deepEqual(events.slice(1).map((e: any) => [e.data, e.actorId]), [
    [{ userId: w.member.id }, w.member.id],
    [{ userId: w.viewer.id }, w.viewer.id],
    [{ userId: admin2.id }, w.admin.id],
  ]);
  for (const e of events) assert.equal(e.teamId, w.team.id);
});

test("leaving cascades: cards unassigned (archived ones too), watching, private views, timer and user field values go, nothing else changes", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const other = await createProject(api, w.team.id, w.owner, "OPS");
  const otherBoard = await createBoard(api, other.id, w.owner);
  const field = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Reviewer", type: "user" }, w.owner.token);
  const c1 = await createCard(api, w.cols[0], w.owner, { title: "one", assigneeId: w.member.id });
  const c2 = await createCard(api, otherBoard.columns[1].id, w.owner, { title: "two", assigneeId: w.member.id });
  const c3 = await createCard(api, w.cols[0], w.owner, { title: "three", assigneeId: w.member.id });
  const c4 = await createCard(api, w.cols[1], w.owner, { title: "four", assigneeId: w.admin.id, customFields: { [field.id]: w.member.id } });
  const tpl = await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "T", title: "From template", customFields: { [field.id]: w.member.id } }, w.owner.token);
  assertStatus(await api.call("POST", `/cards/${c4.id}/watch`, undefined, w.member.token), 204);
  const comment = await ok(api, 201, "POST", `/cards/${c1.id}/comments`, { body: "mine" }, w.member.token);
  const priv = await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "private", query: {} }, w.member.token);
  const shared = await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "shared", query: {}, shared: true }, w.member.token);
  await ok(api, 200, "POST", `/cards/${c4.id}/timer/start`, undefined, w.member.token);
  await ok(api, 200, "POST", `/cards/${c3.id}/archive`, undefined, w.owner.token);
  await ok(api, 200, "PATCH", `/projects/${other.id}`, { archived: true }, w.owner.token);
  const before = await Promise.all([c1, c2, c3, c4].map((c) => getCard(api, c.id, w.owner.token)));
  const watchersBefore = await ok(api, 200, "GET", `/cards/${c4.id}/watchers`, undefined, w.owner.token);
  assert.ok(watchersBefore.items.some((m: any) => m.userId === w.member.id), "the member watched c4");
  const log = await eventLog(t, api, w.team.id, w.admin);
  const auditBefore = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(60_000);
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.admin.token), 204);
  const after = await Promise.all([c1, c2, c3, c4].map((c) => getCard(api, c.id, w.owner.token)));
  assert.deepEqual(after.slice(0, 3).map((c) => c.assigneeId), [null, null, null], "active, archived-project and archived cards are unassigned");
  assert.equal(after[3].assigneeId, w.admin.id, "other assignees untouched");
  assert.deepEqual(after[3].customFields, {}, "the user field value naming the member is removed");
  for (let i = 0; i < 4; i++) assert.equal(after[i].updatedAt, before[i].updatedAt, `cascade keeps updatedAt of card ${i + 1}`);
  const tplAfter = await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.owner.token);
  assert.deepEqual(tplAfter.customFields, {}, "the template's user value is removed too");
  assert.equal(tplAfter.updatedAt, tpl.updatedAt);
  for (const c of [c1, c4]) {
    const watchers = await ok(api, 200, "GET", `/cards/${c.id}/watchers`, undefined, w.owner.token);
    assert.ok(!watchers.items.some((m: any) => m.userId === w.member.id), `the member stopped watching ${c.id}`);
  }
  const still = await ok(api, 200, "GET", `/comments/${comment.id}`, undefined, w.owner.token);
  assert.equal(still.body, "mine", "their comments stay");
  assert.equal(still.authorId, w.member.id);
  // Cascades emit nothing and audit nothing: only the removal itself.
  assert.deepEqual(await log.names(), ["member.removed"]);
  const audit = await auditLog(api, w.admin.token, w.team.id);
  assert.deepEqual(audit.slice(auditBefore).map((e) => [e.action, e.targetId]), [["member.removed", w.member.id]]);
  // Back in the team, the member has no private view, no timer, and watches nothing.
  await addMember(api, w.team.id, w.owner, w.member, "member");
  const views = await ok(api, 200, "GET", `/teams/${w.team.id}/views`, undefined, w.member.token);
  assert.deepEqual(views.items.map((v: any) => v.id), [shared.id], "the private view was deleted, the shared one stays");
  assertError(await api.call("GET", `/views/${priv.id}`, undefined, w.member.token), 404, "not_found");
  assert.deepEqual(await ok(api, 200, "GET", "/me/timer", undefined, w.member.token), { timer: null });
  const watchers = await ok(api, 200, "GET", `/cards/${c4.id}/watchers`, undefined, w.member.token);
  assert.ok(!watchers.items.some((m: any) => m.userId === w.member.id));
});

test("transfer makes the target owner and the caller admin, and answers the team as the caller now sees it", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const res = await api.call("POST", `/teams/${w.team.id}/transfer`, { userId: w.member.id }, w.owner.token);
  assertStatus(res, 200);
  assert.equal(res.body.id, w.team.id);
  assert.equal(res.body.ownerId, w.member.id);
  assert.equal(res.body.myRole, "admin");
  assert.equal(res.body.plan, "free");
  const members = await ok(api, 200, "GET", `/teams/${w.team.id}/members`, undefined, w.member.token);
  const roleOf = Object.fromEntries(members.items.map((m: any) => [m.userId, m.role]));
  assert.equal(roleOf[w.member.id], "owner");
  assert.equal(roleOf[w.owner.id], "admin");
  assert.equal(members.items.filter((m: any) => m.role === "owner").length, 1, "exactly one owner");
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, w.member.token)).myRole, "owner");
  assertError(await api.call("DELETE", `/teams/${w.team.id}`, undefined, w.owner.token), 403, "forbidden", "the old owner");
  assertError(await api.call("PUT", `/teams/${w.team.id}/plan`, { plan: "team" }, w.owner.token), 403, "forbidden", "the old owner changes the plan");
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

test("deleting a team removes it and everything in it for every member", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const keep = await ok(api, 201, "POST", "/teams", { name: "Keep" }, w.member.token);
  const card = await createCard(api, w.cols[0], w.member, { title: "doomed" });
  const label = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "bug" }, w.admin.token);
  const hook = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: "http://127.0.0.1:9/x", events: ["*"], active: false }, w.admin.token);
  const res = await api.call("DELETE", `/teams/${w.team.id}`, undefined, w.owner.token);
  assertStatus(res, 204);
  assert.equal(res.text, "");
  for (const u of [w.owner, w.admin, w.member, w.viewer]) {
    assertError(await api.call("GET", `/teams/${w.team.id}`, undefined, u.token), 404, "not_found");
  }
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, w.owner.token)).items, []);
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, w.member.token)).items.map((x: any) => x.id), [keep.id]);
  for (const path of [`/projects/${w.project.id}`, `/boards/${w.board.id}`, `/cards/${card.id}`, `/webhooks/${hook.id}`, `/teams/${w.team.id}/audit`, `/teams/${w.team.id}/plan`]) {
    assertError(await api.call("GET", path, undefined, w.owner.token), 404, "not_found", path);
  }
  assertError(await api.call("PATCH", `/labels/${label.id}`, { color: "#000000" }, w.owner.token), 404, "not_found", "the team's label");
});
