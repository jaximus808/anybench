// Area `audit`: instruction.md section 11 (Audit log): one entry per change of section 0.8, for
// requests, rule actions and scheduler jobs, and nothing for anything else.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  addDays,
  addMember,
  assertError,
  assertStatus,
  Clock,
  collectPages,
  createApiKey,
  createBoard,
  createCard,
  createProject,
  createRule,
  ok,
  setupBoard,
  setupTeam,
  signUp,
  startApp,
  startOf,
  upload,
  type Api,
  type User,
} from "./helpers.ts";

async function auditLog(api: Api, u: User, teamId: string, q = ""): Promise<any[]> {
  return (await ok(api, 200, "GET", `/teams/${teamId}/audit?limit=100${q}`, undefined, u.token)).items;
}
const brief = (e: any): any[] => [e.action, e.targetType, e.targetId, e.details];

test("team, member, plan and project writes each append one entry with the documented action, target, details and via", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const owner = await signUp(api);
  const admin = await signUp(api);
  const bob = await signUp(api);
  const team = await ok(api, 201, "POST", "/teams", { name: "Audited" }, owner.token);
  const step = () => clock.advance(1000);
  step();
  await ok(api, 200, "PATCH", `/teams/${team.id}`, { name: "Audited 2" }, owner.token);
  step();
  await addMember(api, team.id, owner, admin, "admin");
  step();
  await addMember(api, team.id, admin, bob, "member");
  step();
  await ok(api, 200, "PATCH", `/teams/${team.id}/members/${bob.id}`, { role: "viewer" }, admin.token);
  step();
  const project = await createProject(api, team.id, admin, "AUD");
  step();
  await ok(api, 200, "PATCH", `/projects/${project.id}`, { name: "Renamed", description: "x", archived: false }, admin.token);
  step();
  await ok(api, 200, "POST", `/teams/${team.id}/transfer`, { userId: admin.id }, owner.token);
  step();
  assertStatus(await api.call("DELETE", `/teams/${team.id}/members/${bob.id}`, undefined, owner.token), 204);
  step();
  assertStatus(await api.call("DELETE", `/projects/${project.id}`, undefined, admin.token), 204);
  step();
  await ok(api, 200, "PATCH", `/teams/${team.id}/members/${owner.id}`, { role: "admin" }, admin.token);
  step();
  await ok(api, 200, "PUT", `/teams/${team.id}/plan`, { plan: "team" }, admin.token);
  step();
  await ok(api, 200, "PUT", `/teams/${team.id}/plan`, { plan: "team" }, admin.token);
  const items = await auditLog(api, admin, team.id);
  assert.deepEqual(items.map(brief), [
    ["team.plan_changed", "team", team.id, { from: "free", to: "team" }],
    ["member.role_changed", "member", owner.id, { from: "admin", to: "admin" }],
    ["project.deleted", "project", project.id, {}],
    ["member.removed", "member", bob.id, {}],
    ["team.transferred", "team", team.id, { from: owner.id, to: admin.id }],
    ["project.updated", "project", project.id, { fields: ["archived", "description", "name"] }],
    ["project.created", "project", project.id, {}],
    ["member.role_changed", "member", bob.id, { from: "member", to: "viewer" }],
    ["member.added", "member", bob.id, { role: "member" }],
    ["member.added", "member", admin.id, { role: "admin" }],
    ["team.updated", "team", team.id, { fields: ["name"] }],
    ["team.created", "team", team.id, {}],
  ]);
  const actors = [admin, admin, admin, owner, owner, admin, admin, admin, admin, owner, owner, owner].map((u) => u.id);
  assert.deepEqual(items.map((e) => e.actorId), actors);
  // The repeated PUT of the current plan is a no-op without an entry: the newest entry is 2 s old.
  const start = clock.t - 12000;
  assert.deepEqual(items.map((e) => e.at), Array.from({ length: 12 }, (_, i) => new Date(start + (11 - i) * 1000).toISOString()));
  for (const e of items) {
    assert.deepEqual(Object.keys(e).sort(), ["action", "actorId", "at", "details", "id", "targetId", "targetType", "teamId", "via"]);
    assert.equal(e.teamId, team.id);
    assert.equal(e.via, null, "a request's entry has via null");
    assert.equal(typeof e.id, "string");
  }
  assert.equal(new Set(items.map((e) => e.id)).size, 12, "entry ids are unique");
});

test("board, column, card (archive and restore included) and comment writes append their entries", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const board = await createBoard(api, w.project.id, w.admin, { name: "Audit board" });
  await ok(api, 200, "PATCH", `/boards/${board.id}`, { name: "Renamed" }, w.admin.token);
  const col = await ok(api, 201, "POST", `/boards/${board.id}/columns`, { name: "Extra" }, w.admin.token);
  await ok(api, 200, "PATCH", `/columns/${col.id}`, { wipLimit: 3, name: "Extra2" }, w.admin.token);
  const card = await createCard(api, board.columns[0].id, w.member, { title: "a" });
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "b", labels: ["x"], dueDate: null }, w.member.token);
  await ok(api, 200, "POST", `/cards/${card.id}/move`, { columnId: col.id, position: 0 }, w.member.token);
  const comment = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "c" }, w.member.token);
  await ok(api, 200, "PATCH", `/comments/${comment.id}`, { body: "d" }, w.member.token);
  assertStatus(await api.call("DELETE", `/comments/${comment.id}`, undefined, w.admin.token), 204);
  await ok(api, 200, "POST", `/cards/${card.id}/archive`, undefined, w.member.token);
  await ok(api, 200, "POST", `/cards/${card.id}/restore`, {}, w.member.token);
  assertStatus(await api.call("DELETE", `/cards/${card.id}`, undefined, w.member.token), 204);
  assertStatus(await api.call("DELETE", `/columns/${col.id}`, undefined, w.admin.token), 204);
  assertStatus(await api.call("DELETE", `/boards/${board.id}`, undefined, w.admin.token), 204);
  const items = await auditLog(api, w.owner, w.team.id, `&actorId=${w.admin.id}`);
  const memberItems = await auditLog(api, w.owner, w.team.id, `&actorId=${w.member.id}`);
  assert.deepEqual(items.map(brief), [
    ["board.deleted", "board", board.id, {}],
    ["column.deleted", "column", col.id, {}],
    ["comment.deleted", "comment", comment.id, {}],
    ["column.updated", "column", col.id, { fields: ["name", "wipLimit"] }],
    ["column.created", "column", col.id, {}],
    ["board.updated", "board", board.id, { fields: ["name"] }],
    ["board.created", "board", board.id, {}],
  ]);
  assert.deepEqual(memberItems.map(brief), [
    ["card.deleted", "card", card.id, {}],
    ["card.restored", "card", card.id, {}],
    ["card.archived", "card", card.id, {}],
    ["comment.updated", "comment", comment.id, {}],
    ["comment.created", "comment", comment.id, {}],
    ["card.moved", "card", card.id, { fromColumnId: board.columns[0].id, toColumnId: col.id, position: 0 }],
    ["card.updated", "card", card.id, { fields: ["dueDate", "labels", "title"] }],
    ["card.created", "card", card.id, {}],
  ]);
});

test("webhook writes append entries; test pings, reads and failed writes add nothing", async (t) => {
  const api = await startApp(t, { webhooks: { retryDelaysMs: [], timeoutMs: 200 } });
  const w = await setupTeam(api);
  const before = (await auditLog(api, w.owner, w.team.id)).length;
  const h = await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: "http://127.0.0.1:9/h", events: ["*"], active: false }, w.admin.token);
  await ok(api, 200, "PATCH", `/webhooks/${h.id}`, { url: "http://127.0.0.1:9/i", active: false }, w.admin.token);
  await ok(api, 200, "POST", `/webhooks/${h.id}/rotate-secret`, undefined, w.admin.token);
  await ok(api, 202, "POST", `/webhooks/${h.id}/test`, undefined, w.admin.token);
  await ok(api, 200, "GET", `/webhooks/${h.id}/deliveries`, undefined, w.admin.token);
  assertError(await api.call("PATCH", `/webhooks/${h.id}`, { events: [] }, w.admin.token), 400, "invalid_body");
  assertStatus(await api.call("DELETE", `/webhooks/${h.id}`, undefined, w.owner.token), 204);
  const items = await auditLog(api, w.owner, w.team.id);
  assert.equal(items.length, before + 4);
  assert.deepEqual(items.slice(0, 4).map((e) => [...brief(e), e.actorId]), [
    ["webhook.deleted", "webhook", h.id, {}, w.owner.id],
    ["webhook.secret_rotated", "webhook", h.id, {}, w.admin.id],
    ["webhook.updated", "webhook", h.id, { fields: ["active", "url"] }, w.admin.id],
    ["webhook.created", "webhook", h.id, {}, w.admin.id],
  ]);
});

test("failed requests, reads, /me routes, watching, dry-run imports and cascades add nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "assigned", assigneeId: w.member.id });
  await createCard(api, w.cols[1], w.owner, { title: "moves on delete" });
  const count = async () => (await auditLog(api, w.owner, w.team.id)).length;
  const n0 = await count();
  assertError(await api.call("POST", `/teams/${w.team.id}/projects`, { name: "Dup", key: "ENG" }, w.owner.token), 409, "key_taken");
  assertError(await api.call("POST", `/teams/${w.team.id}/projects`, { name: "P", key: "X1" }, w.member.token), 403, "forbidden");
  assertError(await api.call("PATCH", `/cards/${card.id}`, {}, w.member.token), 400, "invalid_body");
  assertError(await api.call("DELETE", `/columns/${w.cols[0]}`, undefined, w.owner.token), 409, "column_not_empty");
  await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.owner.token);
  await ok(api, 200, "GET", `/teams/${w.team.id}/search`, undefined, w.owner.token);
  await ok(api, 200, "PATCH", "/me", { name: "Changed" }, w.owner.token);
  assertStatus(await api.call("POST", "/me/password", { currentPassword: w.viewer.password, newPassword: "viewer-new-pw" }, w.viewer.token), 204);
  await ok(api, 200, "POST", "/auth/login", { email: w.viewer.email, password: "viewer-new-pw" });
  const key = await createApiKey(api, w.owner, { scope: "read", teamId: w.team.id });
  await ok(api, 200, "PATCH", `/me/api-keys/${key.id}`, { name: "renamed" }, w.owner.token);
  assertStatus(await api.call("DELETE", `/me/api-keys/${key.id}`, undefined, w.owner.token), 204);
  assertStatus(await api.call("POST", `/cards/${card.id}/watch`, undefined, w.viewer.token), 204);
  assertStatus(await api.call("DELETE", `/cards/${card.id}/watch`, undefined, w.viewer.token), 204);
  await ok(api, 200, "POST", "/me/notifications/read-all", {}, w.member.token);
  const dry = await ok(api, 200, "POST", `/projects/${w.project.id}/import`, { csv: "board,column,title\r\nBoard,To do,dry\r\n", dryRun: true }, w.owner.token);
  assert.deepEqual(dry, { created: 1, updated: 0, dryRun: true });
  assert.equal(await count(), n0, "nothing for failed requests, reads, /me, auth, watching and a dry run");
  // Removing the member unassigns `card`: only member.removed.
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.owner.token), 204);
  // Deleting a column with ?moveTo moves its cards: only column.deleted.
  assertStatus(await api.call("DELETE", `/columns/${w.cols[1]}?moveTo=${w.cols[2]}`, undefined, w.owner.token), 204);
  // Deleting the project deletes its board and cards: only project.deleted.
  assertStatus(await api.call("DELETE", `/projects/${w.project.id}`, undefined, w.owner.token), 204);
  const items = await auditLog(api, w.owner, w.team.id);
  assert.equal(items.length, n0 + 3);
  assert.deepEqual(items.slice(0, 3).map((e) => e.action), ["project.deleted", "column.deleted", "member.removed"]);
});

test("the log is newest first and pages with limit and cursor; a bad limit or cursor is 400 invalid_query", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, defaultPlan: "team" });
  const w = await setupTeam(api, clock);
  for (let i = 0; i < 6; i++) {
    clock.advance(1000);
    await createProject(api, w.team.id, w.owner, `P${i}`);
  }
  const all = await auditLog(api, w.admin, w.team.id);
  assert.equal(all.length, 10, "team.created, 3 member.added, 6 project.created");
  assert.deepEqual(all.map((e) => e.action), [...Array(6).fill("project.created"), "member.added", "member.added", "member.added", "team.created"]);
  const times = all.map((e) => Date.parse(e.at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");
  const { items, pages } = await collectPages(api, w.admin.token, `/teams/${w.team.id}/audit`, 4);
  assert.deepEqual(items.map((e) => e.id), all.map((e) => e.id));
  assert.deepEqual(pages.map((p) => p.items.length), [4, 4, 2]);
  const def = await ok(api, 200, "GET", `/teams/${w.team.id}/audit`, undefined, w.admin.token);
  assert.equal(def.items.length, 10);
  assert.equal(def.nextCursor, null);
  for (const q of ["limit=0", "limit=101", "limit=x", "cursor=forged"]) {
    assertError(await api.call("GET", `/teams/${w.team.id}/audit?${q}`, undefined, w.admin.token), 400, "invalid_query", q);
  }
});

test("?action= and ?actorId= filter exactly and combine; values that match nothing give an empty list", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.admin, { title: "b" });
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  await ok(api, 200, "PATCH", `/cards/${a.id}`, { title: "a2" }, w.member.token);
  const f = async (q: string) => (await auditLog(api, w.owner, w.team.id, q)).map((e) => e.targetId);
  assert.deepEqual(await f("&action=card.created"), [c.id, b.id, a.id]);
  assert.deepEqual(await f(`&action=card.created&actorId=${w.member.id}`), [c.id, a.id]);
  assert.deepEqual(await f(`&actorId=${w.member.id}`), [a.id, c.id, a.id]);
  assert.deepEqual(await f("&action=card.updated"), [a.id]);
  assert.deepEqual(await f("&action=card"), [], "no prefix matching");
  assert.deepEqual(await f("&action=CARD.CREATED"), [], "exact, case-sensitive");
  assert.deepEqual(await f("&actorId=nobody"), []);
  assert.deepEqual(await f(`&action=team.created&actorId=${w.owner.id}`), [w.team.id]);
  const paged = await collectPages(api, w.owner.token, `/teams/${w.team.id}/audit?action=card.created`, 2);
  assert.deepEqual(paged.items.map((e) => e.targetId), [c.id, b.id, a.id], "filters hold across pages");
});

test("admin+ only: members and viewers get 403, non-members 404; the log goes with its team", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const other = await signUp(api);
  const second = await ok(api, 201, "POST", "/teams", { name: "Second" }, other.token);
  await addMember(api, second.id, other, w.owner, "admin");
  assertError(await api.call("GET", `/teams/${w.team.id}/audit`, undefined, w.member.token), 403, "forbidden", "member");
  assertError(await api.call("GET", `/teams/${w.team.id}/audit`, undefined, w.viewer.token), 403, "forbidden", "viewer");
  assertError(await api.call("GET", `/teams/${w.team.id}/audit?limit=0`, undefined, w.viewer.token), 403, "forbidden", "role before query validation");
  assertError(await api.call("GET", `/teams/${w.team.id}/audit`, undefined, w.outsider.token), 404, "not_found", "outsider");
  assert.ok((await auditLog(api, w.admin, w.team.id)).length > 0);
  const secondLog = await auditLog(api, other, second.id);
  assert.deepEqual(secondLog.map((e) => e.action), ["member.added", "team.created"], "each team has its own log");
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}`, undefined, w.owner.token), 204);
  assertError(await api.call("GET", `/teams/${w.team.id}/audit`, undefined, w.owner.token), 404, "not_found", "deleted team");
  assert.equal((await auditLog(api, other, second.id)).length, 2, "other teams' logs are untouched");
});

test("rule actions append their own entries after the request's, as the rule's creator with via rule", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const sprint = await ok(api, 201, "POST", `/projects/${w.project.id}/sprints`, { name: "S", startDate: "2026-03-01", endDate: "2026-03-14" }, w.admin.token);
  await ok(api, 200, "POST", `/sprints/${sprint.id}/start`, undefined, w.admin.token);
  const rule = await createRule(api, w.team.id, w.admin, {
    trigger: { event: "card.created" },
    actions: [
      { type: "add_label", label: "Auto" },
      { type: "add_to_sprint", sprintId: "active" },
      { type: "move_to_column", columnId: w.cols[1] },
      { type: "add_comment", body: "Triaged {{key}}" },
    ],
  });
  const before = (await auditLog(api, w.owner, w.team.id)).length;
  const card = await createCard(api, w.cols[0], w.member, { title: "incoming" });
  assert.deepEqual([card.labels, card.sprintId, card.columnId], [["auto"], sprint.id, w.cols[1]], "the response shows the rule's changes");
  const runs = await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token);
  assert.equal(runs.items.length, 1);
  const via = { type: "rule", ruleId: rule.id, runId: runs.items[0].id };
  const comment = (await ok(api, 200, "GET", `/cards/${card.id}/comments`, undefined, w.member.token)).items[0];
  assert.equal(comment.body, `Triaged ${card.key}`);
  const items = (await auditLog(api, w.owner, w.team.id)).slice(0, (await auditLog(api, w.owner, w.team.id)).length - before).reverse();
  assert.deepEqual(
    items.map((e) => [...brief(e), e.actorId, e.via]),
    [
      ["card.created", "card", card.id, {}, w.member.id, null],
      ["card.updated", "card", card.id, { fields: ["labels"] }, w.admin.id, via],
      ["sprint.cards_added", "sprint", sprint.id, { cardIds: [card.id] }, w.admin.id, via],
      ["card.moved", "card", card.id, { fromColumnId: w.cols[0], toColumnId: w.cols[1], position: 0 }, w.admin.id, via],
      ["comment.created", "comment", comment.id, {}, w.admin.id, via],
    ],
  );
});

test("scheduler jobs: a recurrence run appends card.created via the recurrence, the trash purge card.purged with no actor, the due job nothing", async (t) => {
  const clock = new Clock(Date.UTC(2026, 2, 1, 12, 0, 0));
  const api = await startApp(t, { now: clock.now, trash: { retentionMs: 1000 } });
  const w = await setupBoard(api, clock);
  const tomorrow = addDays(clock.today(), 1);
  const rec = await ok(api, 201, "POST", `/boards/${w.board.id}/recurrences`, { columnId: w.cols[0], schedule: { frequency: "daily", time: "09:00" }, startDate: tomorrow, title: "Daily" }, w.admin.token);
  await createCard(api, w.cols[0], w.member, { title: "due tomorrow", dueDate: tomorrow });
  const trashed = await createCard(api, w.cols[0], w.member, { title: "trashed" });
  await ok(api, 200, "POST", `/cards/${trashed.id}/archive`, undefined, w.member.token);
  const before = (await auditLog(api, w.owner, w.team.id)).length;
  clock.advance(1000);
  assertStatus(await api.call("GET", "/health"), 200);
  assertError(await api.call("GET", `/cards/${trashed.id}`, undefined, w.member.token), 404, "not_found", "purged");
  clock.set(startOf(tomorrow) + 9 * 3_600_000);
  assertStatus(await api.call("GET", "/health"), 200);
  const made = await ok(api, 200, "GET", `/recurrences/${rec.id}`, undefined, w.admin.token);
  assert.equal(typeof made.lastCardId, "string", "the recurrence ran");
  const all = await auditLog(api, w.owner, w.team.id);
  assert.deepEqual(
    all.slice(0, all.length - before).reverse().map((e) => [...brief(e), e.actorId, e.via]),
    [
      ["card.purged", "card", trashed.id, {}, null, { type: "schedule" }],
      ["card.created", "card", made.lastCardId, {}, w.admin.id, { type: "recurrence", recurrenceId: rec.id }],
    ],
    "no entry for the due job, which ran at the start of the date",
  );
});

test("every new kind of change appends one entry with its documented action, target and details", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const pid = w.project.id;
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  const before = (await auditLog(api, w.owner, w.team.id)).length;
  const field = await ok(api, 201, "POST", `/projects/${pid}/fields`, { name: "Size", type: "number" }, w.admin.token);
  await ok(api, 200, "PATCH", `/fields/${field.id}`, { required: true, name: "Bigness" }, w.admin.token);
  assertStatus(await api.call("DELETE", `/fields/${field.id}`, undefined, w.admin.token), 204);
  const bug = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "bug" }, w.admin.token);
  const defect = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "defect" }, w.admin.token);
  await ok(api, 200, "PATCH", `/labels/${bug.id}`, { name: "bugs", color: "#AA0000" }, w.admin.token);
  await ok(api, 200, "POST", `/labels/${defect.id}/merge`, { intoLabelId: bug.id }, w.admin.token);
  assertStatus(await api.call("DELETE", `/labels/${bug.id}`, undefined, w.admin.token), 204);
  const item = await ok(api, 201, "POST", `/cards/${a.id}/checklist`, { text: "step" }, w.member.token);
  await ok(api, 200, "PATCH", `/checklist/${item.id}`, { text: "step 1", done: true }, w.member.token);
  assertStatus(await api.call("DELETE", `/checklist/${item.id}`, undefined, w.member.token), 204);
  await ok(api, 201, "POST", `/cards/${a.id}/blockers`, { blockerId: b.id }, w.member.token);
  assertStatus(await api.call("DELETE", `/cards/${a.id}/blockers/${b.id}`, undefined, w.member.token), 204);
  const s1 = await ok(api, 201, "POST", `/projects/${pid}/sprints`, { name: "S1", startDate: "2026-03-02", endDate: "2026-03-13" }, w.admin.token);
  await ok(api, 200, "PATCH", `/sprints/${s1.id}`, { name: "Sprint 1", goal: "ship" }, w.admin.token);
  await ok(api, 200, "POST", `/sprints/${s1.id}/start`, undefined, w.admin.token);
  await ok(api, 200, "POST", `/sprints/${s1.id}/complete`, {}, w.admin.token);
  const s2 = await ok(api, 201, "POST", `/projects/${pid}/sprints`, { name: "S2", startDate: "2026-03-16", endDate: "2026-03-27" }, w.admin.token);
  assertStatus(await api.call("DELETE", `/sprints/${s2.id}`, undefined, w.admin.token), 204);
  const tpl = await ok(api, 201, "POST", `/projects/${pid}/templates`, { name: "T", title: "t" }, w.admin.token);
  await ok(api, 200, "PATCH", `/templates/${tpl.id}`, { title: "t2" }, w.admin.token);
  assertStatus(await api.call("DELETE", `/templates/${tpl.id}`, undefined, w.admin.token), 204);
  const rec = await ok(api, 201, "POST", `/boards/${w.board.id}/recurrences`, { columnId: w.cols[0], schedule: { frequency: "weekly", time: "09:00", weekdays: [1] }, startDate: "2026-03-02", title: "weekly" }, w.admin.token);
  await ok(api, 200, "PATCH", `/recurrences/${rec.id}`, { active: false }, w.admin.token);
  assertStatus(await api.call("DELETE", `/recurrences/${rec.id}`, undefined, w.admin.token), 204);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.due" }, actions: [{ type: "set_priority", priority: "high" }] });
  await ok(api, 200, "PATCH", `/rules/${rule.id}`, { name: "renamed", enabled: false }, w.admin.token);
  assertStatus(await api.call("DELETE", `/rules/${rule.id}`, undefined, w.admin.token), 204);
  const att = (await upload(api, a.id, w.member.token, "abc", "abc.txt", "text/plain")).body;
  await ok(api, 200, "PATCH", `/attachments/${att.id}`, { filename: "renamed.txt" }, w.member.token);
  assertStatus(await api.call("DELETE", `/attachments/${att.id}`, undefined, w.member.token), 204);
  const view = await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "v", query: {} }, w.member.token);
  await ok(api, 200, "PATCH", `/views/${view.id}`, { name: "v2" }, w.member.token);
  assertStatus(await api.call("DELETE", `/views/${view.id}`, undefined, w.member.token), 204);
  const entry = await ok(api, 201, "POST", `/cards/${a.id}/time-entries`, { minutes: 15 }, w.member.token);
  assertStatus(await api.call("DELETE", `/time-entries/${entry.id}`, undefined, w.member.token), 204);
  const invite = await ok(api, 201, "POST", `/teams/${w.team.id}/invites`, { email: "Guest@Example.test", role: "viewer" }, w.admin.token);
  assertStatus(await api.call("DELETE", `/invites/${invite.id}`, undefined, w.admin.token), 204);
  const all = await auditLog(api, w.owner, w.team.id);
  const sha = createHash("sha256").update("abc").digest("hex");
  assert.deepEqual(all.slice(0, all.length - before).reverse().map(brief), [
    ["field.created", "field", field.id, {}],
    ["field.updated", "field", field.id, { fields: ["name", "required"] }],
    ["field.deleted", "field", field.id, {}],
    ["label.created", "label", bug.id, {}],
    ["label.created", "label", defect.id, {}],
    ["label.updated", "label", bug.id, { fields: ["color", "name"] }],
    ["label.merged", "label", defect.id, { into: bug.id }],
    ["label.deleted", "label", bug.id, {}],
    ["checklist.item_created", "checklist_item", item.id, {}],
    ["checklist.item_updated", "checklist_item", item.id, { fields: ["done", "text"] }],
    ["checklist.item_deleted", "checklist_item", item.id, {}],
    ["dependency.added", "card", a.id, { blockerId: b.id }],
    ["dependency.removed", "card", a.id, { blockerId: b.id }],
    ["sprint.created", "sprint", s1.id, {}],
    ["sprint.updated", "sprint", s1.id, { fields: ["goal", "name"] }],
    ["sprint.started", "sprint", s1.id, {}],
    ["sprint.completed", "sprint", s1.id, { carryOverTo: null }],
    ["sprint.created", "sprint", s2.id, {}],
    ["sprint.deleted", "sprint", s2.id, {}],
    ["template.created", "template", tpl.id, {}],
    ["template.updated", "template", tpl.id, { fields: ["title"] }],
    ["template.deleted", "template", tpl.id, {}],
    ["recurrence.created", "recurrence", rec.id, {}],
    ["recurrence.updated", "recurrence", rec.id, { fields: ["active"] }],
    ["recurrence.deleted", "recurrence", rec.id, {}],
    ["rule.created", "rule", rule.id, {}],
    ["rule.updated", "rule", rule.id, { fields: ["enabled", "name"] }],
    ["rule.deleted", "rule", rule.id, {}],
    ["attachment.added", "attachment", att.id, { sha256: sha, size: 3 }],
    ["attachment.updated", "attachment", att.id, { fields: ["filename"] }],
    ["attachment.deleted", "attachment", att.id, {}],
    ["view.created", "view", view.id, {}],
    ["view.updated", "view", view.id, { fields: ["name"] }],
    ["view.deleted", "view", view.id, {}],
    ["time.logged", "time_entry", entry.id, { minutes: 15 }],
    ["time.deleted", "time_entry", entry.id, {}],
    ["invite.created", "invite", invite.id, { email: "guest@example.test", role: "viewer" }],
    ["invite.revoked", "invite", invite.id, {}],
  ]);
});
