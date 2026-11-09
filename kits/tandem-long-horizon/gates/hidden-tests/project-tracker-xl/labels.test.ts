// Area `labels`: instruction.md section 16 (Team labels), with the conventions of section 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  assertError,
  assertStatus,
  auditLog,
  Clock,
  createApiKey,
  createBoard,
  createCard,
  createProject,
  createRule,
  eventLog,
  getCard,
  ok,
  setupBoard,
  setupTeam,
  startApp,
  type User,
} from "./helpers.ts";

const mkLabel = (api: Api, teamId: string, by: User, body: Record<string, unknown>): Promise<any> =>
  ok(api, 201, "POST", `/teams/${teamId}/labels`, body, by.token);

const labelsOf = async (api: Api, cardId: string, token: string): Promise<string[]> => (await getCard(api, cardId, token)).labels;

const recurrenceBody = (columnId: string, labels: string[]) => ({
  columnId,
  schedule: { frequency: "daily", time: "09:00" },
  startDate: "2026-06-01",
  title: "Recurring",
  labels,
});

test("a label has the documented shape: the name trimmed and lowercased, the color stored lowercase with #888888 by default", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  clock.advance(5000);
  const a = await mkLabel(api, w.team.id, w.admin, { name: "  Bug  " });
  assert.deepEqual(Object.keys(a).sort(), ["color", "createdAt", "id", "name", "teamId", "updatedAt"]);
  assert.equal(a.teamId, w.team.id);
  assert.equal(a.name, "bug");
  assert.equal(a.color, "#888888");
  assert.equal(a.createdAt, clock.iso());
  assert.equal(a.updatedAt, a.createdAt);
  const b = await mkLabel(api, w.team.id, w.owner, { name: "UI", color: "#A1b2C3" });
  assert.equal(b.name, "ui");
  assert.equal(b.color, "#a1b2c3");
});

test("label names must be 1 to 30 chars after trimming; colors must be # followed by 6 hex digits", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/labels`;
  for (const name of ["", "   ", "x".repeat(31), 3, null]) assertError(await api.call("POST", path, { name }, w.owner.token), 400, "invalid_body", JSON.stringify(name));
  assertError(await api.call("POST", path, {}, w.owner.token), 400, "invalid_body", "missing name");
  for (const color of ["888888", "#88888", "#8888888", "#ggg000", "red", 888888, null]) {
    assertError(await api.call("POST", path, { name: "ok", color }, w.owner.token), 400, "invalid_body", JSON.stringify(color));
  }
  const long = await mkLabel(api, w.team.id, w.owner, { name: ` ${"Y".repeat(30)} `, color: "#ABCDEF" });
  assert.equal(long.name, "y".repeat(30));
  assert.equal(long.color, "#abcdef");
  const list = await ok(api, 200, "GET", path, undefined, w.owner.token);
  assert.equal(list.items.length, 1);
});

test("label names are unique within the team, also on rename (409 label_taken); another team may reuse a name", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.owner.token);
  const bug = await mkLabel(api, w.team.id, w.owner, { name: "bug" });
  const ui = await mkLabel(api, w.team.id, w.owner, { name: "ui" });
  for (const name of ["bug", " BUG "]) assertError(await api.call("POST", `/teams/${w.team.id}/labels`, { name }, w.owner.token), 409, "label_taken", name);
  assertError(await api.call("PATCH", `/labels/${ui.id}`, { name: "Bug" }, w.owner.token), 409, "label_taken", "rename onto another label");
  const same = await ok(api, 200, "PATCH", `/labels/${bug.id}`, { name: "BUG" }, w.owner.token);
  assert.equal(same.name, "bug", "its own name is fine");
  const there = await mkLabel(api, other.id, w.owner, { name: "bug" });
  assert.equal(there.teamId, other.id);
  const list = await ok(api, 200, "GET", `/teams/${w.team.id}/labels`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((l: any) => l.name), ["bug", "ui"]);
});

test("labels are listed by name ascending; viewers read; members and viewers get 403 on writes; non-members get 404", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  const made: Record<string, any> = {};
  for (const name of ["zeta", "alpha", "mid"]) {
    clock.advance(1000);
    made[name] = await mkLabel(api, w.team.id, w.admin, { name });
  }
  const list = await ok(api, 200, "GET", `/teams/${w.team.id}/labels`, undefined, w.viewer.token);
  assert.deepEqual(list.items.map((l: any) => l.id), [made.alpha.id, made.mid.id, made.zeta.id]);
  for (const u of [w.member, w.viewer]) {
    assertError(await api.call("POST", `/teams/${w.team.id}/labels`, { name: "new" }, u.token), 403, "forbidden");
    assertError(await api.call("PATCH", `/labels/${made.mid.id}`, { color: "#000000" }, u.token), 403, "forbidden");
    assertError(await api.call("DELETE", `/labels/${made.mid.id}`, undefined, u.token), 403, "forbidden");
    assertError(await api.call("POST", `/labels/${made.mid.id}/merge`, { intoLabelId: made.zeta.id }, u.token), 403, "forbidden");
  }
  assertError(await api.call("GET", `/teams/${w.team.id}/labels`, undefined, w.outsider.token), 404, "not_found");
  assertError(await api.call("PATCH", `/labels/${made.mid.id}`, { color: "#000000" }, w.outsider.token), 404, "not_found");
  assertError(await api.call("DELETE", `/labels/no-such-label`, undefined, w.owner.token), 404, "not_found");
});

test("creating a label changes no card, and card labels need not be in the catalogue", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c", labels: ["Bug", "unlisted"] });
  clock.advance(60_000);
  await mkLabel(api, w.team.id, w.owner, { name: "bug", color: "#ff0000" });
  const after = await getCard(api, card.id, w.member.token);
  assert.deepEqual(after.labels, ["bug", "unlisted"]);
  assert.equal(after.updatedAt, card.updatedAt);
  const other = await createCard(api, w.cols[0], w.member, { title: "d", labels: ["not-in-catalogue"] });
  assert.deepEqual(other.labels, ["not-in-catalogue"]);
});

test("a PATCH of the color only changes the color and updatedAt; a PATCH needs an updatable field", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const bug = await mkLabel(api, w.team.id, w.owner, { name: "bug" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c", labels: ["bug"] });
  clock.advance(60_000);
  const p = await ok(api, 200, "PATCH", `/labels/${bug.id}`, { color: "#00FF00" }, w.admin.token);
  assert.equal(p.color, "#00ff00");
  assert.equal(p.name, "bug");
  assert.equal(p.updatedAt, clock.iso());
  assert.equal(p.createdAt, bug.createdAt);
  assertError(await api.call("PATCH", `/labels/${bug.id}`, {}, w.admin.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/labels/${bug.id}`, { color: "green" }, w.admin.token), 400, "invalid_body");
  const after = await getCard(api, card.id, w.member.token);
  assert.deepEqual(after.labels, ["bug"]);
  assert.equal(after.updatedAt, card.updatedAt);
});

test("a rename rewrites the labels of every card of the team, archived projects and archived cards included, de-duplicated and re-sorted", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  const bug = await mkLabel(api, w.team.id, w.owner, { name: "bug" });
  const zeta = await mkLabel(api, w.team.id, w.owner, { name: "zeta" });
  const a = await createCard(api, w.cols[0], w.member, { title: "a", labels: ["bug", "zeta"] });
  const b = await createCard(api, w.cols[1], w.member, { title: "b", labels: ["alpha", "bug", "fix"] });
  const c = await createCard(api, w.cols[0], w.member, { title: "c", labels: ["bug", "ops"] });
  await ok(api, 200, "POST", `/cards/${c.id}/archive`, undefined, w.member.token);
  const d = await createCard(api, opsBoard.columns[0].id, w.member, { title: "d", labels: ["bug"] });
  await ok(api, 200, "PATCH", `/projects/${ops.id}`, { archived: true }, w.owner.token);
  const elsewhere = await setupBoard(api, clock);
  const e = await createCard(api, elsewhere.cols[0], elsewhere.member, { title: "e", labels: ["bug"] });
  const before = new Map<string, string>();
  for (const x of [a, b, c, d]) before.set(x.id, (await getCard(api, x.id, w.member.token)).updatedAt);
  clock.advance(60_000);
  const renamed = await ok(api, 200, "PATCH", `/labels/${bug.id}`, { name: " FIX " }, w.owner.token);
  assert.equal(renamed.name, "fix");
  assert.deepEqual(await labelsOf(api, a.id, w.member.token), ["fix", "zeta"]);
  assert.deepEqual(await labelsOf(api, b.id, w.member.token), ["alpha", "fix"], "de-duplicated");
  assert.deepEqual(await labelsOf(api, c.id, w.member.token), ["fix", "ops"], "archived card");
  assert.deepEqual(await labelsOf(api, d.id, w.member.token), ["fix"], "archived project");
  assert.deepEqual(await labelsOf(api, e.id, elsewhere.member.token), ["bug"], "another team is untouched");
  await ok(api, 200, "PATCH", `/labels/${zeta.id}`, { name: "able" }, w.owner.token);
  assert.deepEqual(await labelsOf(api, a.id, w.member.token), ["able", "fix"], "re-sorted");
  for (const x of [a, b, c, d]) assert.equal((await getCard(api, x.id, w.member.token)).updatedAt, before.get(x.id), "a rewrite is a cascade");
});

test("a rename emits no events and appends only its own label.updated entry", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const bug = await mkLabel(api, w.team.id, w.owner, { name: "bug" });
  for (let i = 0; i < 3; i++) await createCard(api, w.cols[0], w.member, { title: `c${i}`, labels: ["bug"] });
  await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "T", title: "T", labels: ["bug"] }, w.owner.token);
  await createRule(api, w.team.id, w.admin, { trigger: { event: "card.due" }, actions: [{ type: "add_label", label: "bug" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(1000);
  await ok(api, 200, "PATCH", `/labels/${bug.id}`, { name: "defect" }, w.admin.token);
  assert.deepEqual(await log.names(), []);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((x) => [x.action, x.targetType, x.targetId, x.actorId, x.details]),
    [["label.updated", "label", bug.id, w.admin.id, { fields: ["name"] }]],
  );
});

test("a rename rewrites the labels of templates and recurrences", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const bug = await mkLabel(api, w.team.id, w.owner, { name: "bug" });
  const tpl = await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "T", title: "T", labels: ["zz", "bug"] }, w.owner.token);
  const rec = await ok(api, 201, "POST", `/boards/${w.board.id}/recurrences`, recurrenceBody(w.cols[0], ["bug", "ops"]), w.owner.token);
  assert.deepEqual(rec.labels, ["bug", "ops"]);
  clock.advance(60_000);
  await ok(api, 200, "PATCH", `/labels/${bug.id}`, { name: "triage" }, w.owner.token);
  const t2 = await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.member.token);
  assert.deepEqual(t2.labels, ["triage", "zz"]);
  assert.equal(t2.updatedAt, tpl.updatedAt);
  const r2 = await ok(api, 200, "GET", `/recurrences/${rec.id}`, undefined, w.member.token);
  assert.deepEqual(r2.labels, ["ops", "triage"], "re-sorted");
  assert.equal(r2.updatedAt, rec.updatedAt);
});

test("a rename rewrites label conditions and add_label / remove_label actions of rules, which stay enabled", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const bug = await mkLabel(api, w.team.id, w.owner, { name: "bug" });
  const r1 = await createRule(api, w.team.id, w.admin, {
    trigger: { event: "card.due" },
    conditions: [{ field: "labels", op: "contains", value: "bug" }, { field: "labels", op: "not_contains", value: "keep" }],
    actions: [{ type: "add_label", label: "bug" }],
  });
  const r2 = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.due" }, actions: [{ type: "remove_label", label: "BUG" }, { type: "set_priority", priority: "low" }] });
  assert.deepEqual(r2.actions[0], { type: "remove_label", label: "bug" }, "stored normalised");
  clock.advance(60_000);
  await ok(api, 200, "PATCH", `/labels/${bug.id}`, { name: "defect" }, w.owner.token);
  const n1 = await ok(api, 200, "GET", `/rules/${r1.id}`, undefined, w.admin.token);
  const n2 = await ok(api, 200, "GET", `/rules/${r2.id}`, undefined, w.admin.token);
  assert.deepEqual(n1.conditions, [
    { field: "labels", op: "contains", value: "defect" },
    { field: "labels", op: "not_contains", value: "keep" },
  ]);
  assert.deepEqual(n1.actions, [{ type: "add_label", label: "defect" }]);
  assert.deepEqual(n2.actions, [{ type: "remove_label", label: "defect" }, { type: "set_priority", priority: "low" }]);
  assert.equal(n1.enabled, true);
  assert.equal(n2.enabled, true);
  assert.equal(n1.updatedAt, r1.updatedAt);
});

test("a rename rewrites the label values of saved views, and the view's cards follow", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const bug = await mkLabel(api, w.team.id, w.owner, { name: "bug" });
  const c1 = await createCard(api, w.cols[0], w.member, { title: "one", labels: ["bug", "ui"] });
  await createCard(api, w.cols[0], w.member, { title: "two", labels: ["bug"] });
  const view = await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "Bugs in UI", query: { label: [" BUG ", "ui"] } }, w.member.token);
  assert.deepEqual(view.query.label, ["bug", "ui"]);
  clock.advance(60_000);
  await ok(api, 200, "PATCH", `/labels/${bug.id}`, { name: "fault" }, w.owner.token);
  const v2 = await ok(api, 200, "GET", `/views/${view.id}`, undefined, w.member.token);
  assert.deepEqual(v2.query.label, ["fault", "ui"]);
  assert.equal(v2.updatedAt, view.updatedAt);
  const cards = await ok(api, 200, "GET", `/views/${view.id}/cards`, undefined, w.member.token);
  assert.deepEqual(cards.items.map((c: any) => c.id), [c1.id]);
  assert.deepEqual(cards.items[0].labels, ["fault", "ui"]);
});

test("a delete removes the name from the labels of cards, templates and recurrences and from saved views, without updatedAt changes or events", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const bug = await mkLabel(api, w.team.id, w.owner, { name: "bug" });
  const ui = await mkLabel(api, w.team.id, w.owner, { name: "ui" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c", labels: ["bug", "ui"] });
  const shelved = await createCard(api, w.cols[0], w.member, { title: "s", labels: ["bug"] });
  await ok(api, 200, "POST", `/cards/${shelved.id}/archive`, undefined, w.member.token);
  const shelvedAt = (await getCard(api, shelved.id, w.member.token)).updatedAt;
  const tpl = await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "T", title: "T", labels: ["bug"] }, w.owner.token);
  const rec = await ok(api, 201, "POST", `/boards/${w.board.id}/recurrences`, recurrenceBody(w.cols[0], ["bug", "ops"]), w.owner.token);
  const view = await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "V", query: { label: ["bug", "ui"] }, shared: true }, w.member.token);
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(60_000);
  await ok(api, 204, "DELETE", `/labels/${bug.id}`, undefined, w.admin.token);
  const list = await ok(api, 200, "GET", `/teams/${w.team.id}/labels`, undefined, w.member.token);
  assert.deepEqual(list.items.map((l: any) => l.id), [ui.id]);
  const c2 = await getCard(api, card.id, w.member.token);
  assert.deepEqual(c2.labels, ["ui"]);
  assert.equal(c2.updatedAt, card.updatedAt);
  const s2 = await getCard(api, shelved.id, w.member.token);
  assert.deepEqual(s2.labels, []);
  assert.equal(s2.updatedAt, shelvedAt);
  assert.deepEqual((await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.member.token)).labels, []);
  assert.deepEqual((await ok(api, 200, "GET", `/recurrences/${rec.id}`, undefined, w.member.token)).labels, ["ops"]);
  assert.deepEqual((await ok(api, 200, "GET", `/views/${view.id}`, undefined, w.member.token)).query.label, ["ui"]);
  assert.deepEqual(await log.names(), []);
  assertError(await api.call("PATCH", `/labels/${bug.id}`, { color: "#000000" }, w.admin.token), 404, "not_found", "deleted");
});

test("a delete disables every rule that uses the name in a condition or an action, definition unchanged; other rules stay enabled", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const bug = await mkLabel(api, w.team.id, w.owner, { name: "bug" });
  const byCond = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.due" }, conditions: [{ field: "labels", op: "not_contains", value: "bug" }], actions: [{ type: "set_priority", priority: "high" }] });
  const byAction = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.due" }, actions: [{ type: "set_priority", priority: "high" }, { type: "remove_label", label: "bug" }] });
  const other = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.due" }, actions: [{ type: "add_label", label: "bugfix" }] });
  clock.advance(60_000);
  await ok(api, 204, "DELETE", `/labels/${bug.id}`, undefined, w.owner.token);
  const n1 = await ok(api, 200, "GET", `/rules/${byCond.id}`, undefined, w.admin.token);
  const n2 = await ok(api, 200, "GET", `/rules/${byAction.id}`, undefined, w.admin.token);
  const n3 = await ok(api, 200, "GET", `/rules/${other.id}`, undefined, w.admin.token);
  assert.equal(n1.enabled, false);
  assert.equal(n2.enabled, false);
  assert.equal(n3.enabled, true, "bugfix is another name");
  assert.deepEqual(n1.conditions, byCond.conditions);
  assert.deepEqual(n2.actions, byAction.actions);
  assert.equal(n1.updatedAt, byCond.updatedAt);
});

test("merge rewrites the merged name into the target's everywhere, rules included and not disabled, deletes the source and answers the target unchanged", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const dup = await mkLabel(api, w.team.id, w.owner, { name: "dup" });
  const orig = await mkLabel(api, w.team.id, w.owner, { name: "orig", color: "#123456" });
  const x = await createCard(api, w.cols[0], w.member, { title: "x", labels: ["dup", "orig"] });
  const y = await createCard(api, w.cols[0], w.member, { title: "y", labels: ["dup", "aaa"] });
  const tpl = await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "T", title: "T", labels: ["dup"] }, w.owner.token);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.due" }, conditions: [{ field: "labels", op: "contains", value: "dup" }], actions: [{ type: "add_label", label: "dup" }] });
  const view = await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "V", query: { label: ["dup"] } }, w.member.token);
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(60_000);
  const res = await ok(api, 200, "POST", `/labels/${dup.id}/merge`, { intoLabelId: orig.id }, w.admin.token);
  assert.deepEqual(res, orig, "the target, unchanged");
  const list = await ok(api, 200, "GET", `/teams/${w.team.id}/labels`, undefined, w.member.token);
  assert.deepEqual(list.items, [orig]);
  assert.deepEqual(await labelsOf(api, x.id, w.member.token), ["orig"]);
  assert.deepEqual(await labelsOf(api, y.id, w.member.token), ["aaa", "orig"]);
  assert.equal((await getCard(api, y.id, w.member.token)).updatedAt, y.updatedAt);
  assert.deepEqual((await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.member.token)).labels, ["orig"]);
  const r = await ok(api, 200, "GET", `/rules/${rule.id}`, undefined, w.admin.token);
  assert.equal(r.enabled, true);
  assert.deepEqual(r.conditions, [{ field: "labels", op: "contains", value: "orig" }]);
  assert.deepEqual(r.actions, [{ type: "add_label", label: "orig" }]);
  assert.deepEqual((await ok(api, 200, "GET", `/views/${view.id}`, undefined, w.member.token)).query.label, ["orig"]);
  assert.deepEqual(await log.names(), []);
  assertError(await api.call("POST", `/labels/${dup.id}/merge`, { intoLabelId: orig.id }, w.admin.token), 404, "not_found", "the source is gone");
});

test("merge needs intoLabelId naming another label of the same team, else 400 invalid_body, and changes nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.owner.token);
  const a = await mkLabel(api, w.team.id, w.owner, { name: "a" });
  const b = await mkLabel(api, w.team.id, w.owner, { name: "b" });
  const foreign = await mkLabel(api, other.id, w.owner, { name: "b" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c", labels: ["a"] });
  for (const [what, body] of [
    ["itself", { intoLabelId: a.id }],
    ["unknown", { intoLabelId: "no-such-label" }],
    ["another team", { intoLabelId: foreign.id }],
    ["missing", {}],
    ["not a string", { intoLabelId: 7 }],
  ] as const) {
    assertError(await api.call("POST", `/labels/${a.id}/merge`, body, w.owner.token), 400, "invalid_body", what);
  }
  const list = await ok(api, 200, "GET", `/teams/${w.team.id}/labels`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((l: any) => l.id), [a.id, b.id]);
  assert.deepEqual(await labelsOf(api, card.id, w.member.token), ["a"]);
});

test("label writes are audited: label.created, label.updated with sorted fields, label.merged with into, label.deleted", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  const a = await mkLabel(api, w.team.id, w.admin, { name: "a" });
  const b = await mkLabel(api, w.team.id, w.admin, { name: "b" });
  const c = await mkLabel(api, w.team.id, w.admin, { name: "c" });
  clock.advance(1000);
  await ok(api, 200, "PATCH", `/labels/${a.id}`, { name: "aa", color: "#000000" }, w.owner.token);
  assertError(await api.call("PATCH", `/labels/${a.id}`, { name: "b" }, w.owner.token), 409, "label_taken");
  await ok(api, 200, "POST", `/labels/${b.id}/merge`, { intoLabelId: c.id }, w.owner.token);
  await ok(api, 204, "DELETE", `/labels/${c.id}`, undefined, w.owner.token);
  const entries = (await auditLog(api, w.owner.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.via, e.details]),
    [
      ["label.created", "label", a.id, w.admin.id, null, {}],
      ["label.created", "label", b.id, w.admin.id, null, {}],
      ["label.created", "label", c.id, w.admin.id, null, {}],
      ["label.updated", "label", a.id, w.owner.id, null, { fields: ["color", "name"] }],
      ["label.merged", "label", b.id, w.owner.id, null, { into: c.id }],
      ["label.deleted", "label", c.id, w.owner.id, null, {}],
    ],
  );
  assert.equal(entries[5].at, clock.iso());
});

test("API keys: label writes need an admin key, checked before 404; a team-restricted key does not see another team's labels", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.owner.token);
  const theirs = await mkLabel(api, other.id, w.owner, { name: "theirs" });
  const mine = await mkLabel(api, w.team.id, w.owner, { name: "mine" });
  const writeKey = (await createApiKey(api, w.owner, { scope: "write" })).secret;
  const readKey = (await createApiKey(api, w.owner, { scope: "read" })).secret;
  assertError(await api.call("POST", `/teams/no-such-team/labels`, { name: "x" }, writeKey), 403, "insufficient_scope", "before 404");
  assertError(await api.call("PATCH", `/labels/${mine.id}`, { color: "#000000" }, writeKey), 403, "insufficient_scope");
  assertError(await api.call("POST", `/labels/${mine.id}/merge`, { intoLabelId: mine.id }, readKey), 403, "insufficient_scope");
  const read = await ok(api, 200, "GET", `/teams/${w.team.id}/labels`, undefined, readKey);
  assert.deepEqual(read.items.map((l: any) => l.id), [mine.id]);
  const restricted = (await createApiKey(api, w.owner, { scope: "admin", teamId: w.team.id })).secret;
  assertError(await api.call("GET", `/teams/${other.id}/labels`, undefined, restricted), 404, "not_found");
  assertError(await api.call("POST", `/teams/${other.id}/labels`, { name: "x" }, restricted), 404, "not_found");
  assertError(await api.call("PATCH", `/labels/${theirs.id}`, { color: "#000000" }, restricted), 404, "not_found");
  const made = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "via-key" }, restricted);
  assert.equal(made.teamId, w.team.id);
  assertStatus(await api.call("GET", `/teams/${other.id}/labels`, undefined, w.owner.token), 200, "the session token still sees both");
});

test("an Idempotency-Key replay of POST labels answers the stored label and creates nothing; the key with another body is idempotency_conflict", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  const path = `/teams/${w.team.id}/labels`;
  const first = await api.call("POST", path, { name: "Bug", color: "#FF0000" }, w.admin.token, { idem: "label:1" });
  assertStatus(first, 201);
  clock.advance(1000);
  const again = await api.call("POST", path, { name: "Bug", color: "#FF0000" }, w.admin.token, { idem: "label:1" });
  assertStatus(again, 201);
  assert.equal(again.text, first.text);
  assert.equal(again.headers.get("idempotency-replayed"), "true");
  assertError(await api.call("POST", path, { name: "Other" }, w.admin.token, { idem: "label:1" }), 409, "idempotency_conflict");
  assertError(await api.call("POST", path, { name: "Bug", color: "#FF0000" }, w.admin.token), 409, "label_taken");
  const list = await ok(api, 200, "GET", path, undefined, w.admin.token);
  assert.deepEqual(list.items.map((l: any) => l.id), [first.body.id]);
  const created = (await auditLog(api, w.admin.token, w.team.id)).filter((e) => e.action === "label.created");
  assert.equal(created.length, 1);
});
