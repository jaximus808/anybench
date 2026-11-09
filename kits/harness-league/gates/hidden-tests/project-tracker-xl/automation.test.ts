// Area `automation`: instruction.md section 22 (Automation rules), run in step 2 of the change
// pipeline of section 0.8. Most tests use the team plan so that more than 3 rules fit (section 13).
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  type Api,
  addMember,
  assertError,
  assertQuota,
  assertStatus,
  auditLog,
  Clock,
  createBoard,
  createCard,
  createProject,
  createRule,
  eventLog,
  getCard,
  ok,
  setupBoard,
  setupTeam,
  signUp,
  tempDir,
  type User,
  type World,
} from "./helpers.ts";
import { archive, assertKeys, comment, feed, history, mkField, mkSprint, move, notifications, ruleRuns, settings, startApp, teamRuns, watcherIds } from "./helpers-pipeline.ts";

const TEAM = { defaultPlan: "team" as const };
const rule = (api: Api, w: World, body: Record<string, unknown>, by?: User): Promise<any> => createRule(api, w.team.id, by ?? w.admin, body);
const tryRule = (api: Api, w: World, body: Record<string, unknown>) => api.call("POST", `/teams/${w.team.id}/rules`, { name: "r", ...body }, w.admin.token);
const testRule = async (api: Api, w: World, ruleId: string, cardId: string): Promise<any> => ok(api, 200, "POST", `/rules/${ruleId}/test`, { cardId }, w.admin.token);
const runsOf = (api: Api, w: World, ruleId: string): Promise<any[]> => ruleRuns(api, w.admin.token, ruleId);
const outcome = (run: any): unknown[] => [run.status, run.error, run.actions.map((a: any) => [a.type, a.status, a.error])];
const ON_CREATE = { event: "card.created" };

test("a rule has the documented shape: trigger with four keys, conditions [] by default, enabled, createdBy the caller", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  clock.advance(5000);
  const r = await rule(api, w, { name: "  Triage  ", trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "high" }] });
  assertKeys(r, ["id", "teamId", "name", "enabled", "trigger", "conditions", "actions", "createdBy", "createdAt", "updatedAt"], "rule");
  assert.equal(r.teamId, w.team.id);
  assert.equal(r.name, "Triage");
  assert.equal(r.enabled, true);
  assert.deepEqual(r.trigger, { event: "card.created", projectId: null, toColumnId: null, fields: null });
  assert.deepEqual(r.conditions, []);
  assert.deepEqual(r.actions, [{ type: "set_priority", priority: "high" }]);
  assert.equal(r.createdBy, w.admin.id);
  assert.equal(r.createdAt, clock.iso());
  assert.equal(r.updatedAt, r.createdAt);
  const off = await rule(api, w, { trigger: { event: "comment.created" }, actions: [{ type: "set_priority", priority: "low" }], enabled: false }, w.owner);
  assert.equal(off.enabled, false);
  assert.deepEqual(await ok(api, 200, "GET", `/rules/${r.id}`, undefined, w.viewer.token), r);
  const list = await ok(api, 200, "GET", `/teams/${w.team.id}/rules`, undefined, w.viewer.token);
  assert.deepEqual(list.items.map((x: any) => x.id), [r.id, off.id], "oldest first");
});

test("trigger validation: one of the six events, projectId a project of the team, toColumnId only with card.moved, fields only with card.updated", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const elsewhere = await setupBoard(api);
  const act = [{ type: "set_priority", priority: "high" }];
  const bad: unknown[] = [
    undefined,
    "card.created",
    {},
    { event: "card.deleted" },
    { event: "card.archived" },
    { event: "member.added" },
    { event: "*" },
    { event: "card.created", projectId: "no-such-project" },
    { event: "card.created", projectId: elsewhere.project.id },
    { event: "card.updated", toColumnId: w.cols[0] },
    { event: "card.moved", toColumnId: elsewhere.cols[0] },
    { event: "card.moved", fields: ["title"] },
    { event: "card.updated", fields: [] },
    { event: "card.updated", fields: ["title", "nope"] },
    { event: "card.updated", fields: "title" },
    { event: "card.updated", fields: ["completedAt"] },
  ];
  for (const trigger of bad) assertError(await tryRule(api, w, { trigger, actions: act }), 400, "invalid_body", JSON.stringify(trigger));
  for (const event of ["card.created", "card.updated", "card.moved", "card.due", "comment.created", "checklist.completed"]) {
    assertStatus(await tryRule(api, w, { trigger: { event }, actions: act }), 201, event);
  }
});

test("trigger filters are stored: projectId, toColumnId, and fields de-duplicated and sorted; a filter not given is null", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const act = [{ type: "set_priority", priority: "high" }];
  const moved = await rule(api, w, { trigger: { event: "card.moved", toColumnId: w.cols[2], projectId: w.project.id }, actions: act });
  assert.deepEqual(moved.trigger, { event: "card.moved", projectId: w.project.id, toColumnId: w.cols[2], fields: null });
  const updated = await rule(api, w, { trigger: { event: "card.updated", fields: ["title", "labels", "title", "customFields"] }, actions: act });
  assert.deepEqual(updated.trigger, { event: "card.updated", projectId: null, toColumnId: null, fields: ["customFields", "labels", "title"] });
  const nulls = await rule(api, w, { trigger: { event: "card.moved", toColumnId: null, projectId: null }, actions: act });
  assert.deepEqual(nulls.trigger, { event: "card.moved", projectId: null, toColumnId: null, fields: null });
});

test("condition validation: known fields only, the ops each field allows, and values of the right kind; at most 10 conditions", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const elsewhere = await setupBoard(api);
  const act = [{ type: "set_priority", priority: "high" }];
  const bad: unknown[] = [
    "title",
    { field: "title", op: "eq", value: "x" },
    { field: "title", op: "contains", value: "" },
    { field: "title", op: "contains" },
    { field: "labels", op: "contains", value: "x".repeat(31) },
    { field: "labels", op: "eq", value: "x" },
    { field: "assigneeId", op: "eq", value: 5 },
    { field: "assigneeId", op: "contains", value: "x" },
    { field: "priority", op: "gt", value: "low" },
    { field: "priority", op: "eq", value: "critical" },
    { field: "points", op: "gt", value: null },
    { field: "points", op: "eq", value: 4 },
    { field: "columnId", op: "eq", value: "no-such-column" },
    { field: "columnId", op: "eq", value: elsewhere.cols[0] },
    { field: "category", op: "eq", value: "doing" },
    { field: "blocked", op: "ne", value: true },
    { field: "blocked", op: "eq", value: "true" },
    { field: "dueDate", op: "eq", value: "2026-01-01" },
    { field: "description", op: "contains", value: "x" },
    { field: "customFields", op: "is_set" },
  ];
  for (const c of bad) assertError(await tryRule(api, w, { trigger: ON_CREATE, conditions: [c], actions: act }), 400, "invalid_body", JSON.stringify(c));
  assertError(await tryRule(api, w, { trigger: ON_CREATE, conditions: {}, actions: act }), 400, "invalid_body", "conditions must be an array");
  const eleven = Array.from({ length: 11 }, () => ({ field: "dueDate", op: "is_set" }));
  assertError(await tryRule(api, w, { trigger: ON_CREATE, conditions: eleven, actions: act }), 400, "invalid_body", "11 conditions");
  const ten = await rule(api, w, { trigger: ON_CREATE, conditions: eleven.slice(1), actions: act });
  assert.equal(ten.conditions.length, 10);
  const okRule = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [
      { field: "assigneeId", op: "eq", value: null },
      { field: "points", op: "ne", value: null },
      { field: "labels", op: "contains", value: "  Bug " },
      { field: "dueDate", op: "is_not_set" },
      { field: "category", op: "ne", value: "done" },
    ],
    actions: act,
  });
  assert.deepEqual(okRule.conditions, [
    { field: "assigneeId", op: "eq", value: null },
    { field: "points", op: "ne", value: null },
    { field: "labels", op: "contains", value: "bug" },
    { field: "dueDate", op: "is_not_set", value: null },
    { field: "category", op: "ne", value: "done" },
  ]);
});

test("customFields.<fieldId> conditions: a field of the team, the ops its type allows, a value valid for it; is_set is stored with value null", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const elsewhere = await setupBoard(api);
  const foreign = await mkField(api, elsewhere.project.id, elsewhere.owner, { name: "F", type: "text" });
  const text = await mkField(api, w.project.id, w.owner, { name: "T", type: "text" });
  const num = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const date = await mkField(api, w.project.id, w.owner, { name: "D", type: "date" });
  const sel = await mkField(api, w.project.id, w.owner, { name: "S", type: "select", options: ["a", "b"] });
  const multi = await mkField(api, w.project.id, w.owner, { name: "M", type: "multiselect", options: ["x", "y"] });
  const box = await mkField(api, w.project.id, w.owner, { name: "C", type: "checkbox" });
  const user = await mkField(api, w.project.id, w.owner, { name: "U", type: "user" });
  const act = [{ type: "set_priority", priority: "high" }];
  const bad: unknown[] = [
    { field: "customFields.no-such-field", op: "is_set" },
    { field: `customFields.${foreign.id}`, op: "is_set" },
    { field: `customFields.${multi.id}`, op: "eq", value: ["x"] },
    { field: `customFields.${text.id}`, op: "gt", value: "a" },
    { field: `customFields.${text.id}`, op: "contains", value: "a" },
    { field: `customFields.${sel.id}`, op: "contains", value: "a" },
    { field: `customFields.${box.id}`, op: "gte", value: true },
    { field: `customFields.${sel.id}`, op: "eq", value: "zzz" },
    { field: `customFields.${num.id}`, op: "eq", value: "5" },
    { field: `customFields.${date.id}`, op: "eq", value: "2026-02-30" },
    { field: `customFields.${user.id}`, op: "eq", value: w.outsider.id },
    { field: `customFields.${text.id}`, op: "eq" },
  ];
  for (const c of bad) assertError(await tryRule(api, w, { trigger: ON_CREATE, conditions: [c], actions: act }), 400, "invalid_body", JSON.stringify(c));
  const r = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [
      { field: `customFields.${num.id}`, op: "gte", value: 3 },
      { field: `customFields.${date.id}`, op: "lt", value: "2026-04-01" },
      { field: `customFields.${text.id}`, op: "is_set" },
      { field: `customFields.${multi.id}`, op: "is_not_set" },
      { field: `customFields.${text.id}`, op: "ne", value: "plain" },
      { field: `customFields.${user.id}`, op: "eq", value: w.viewer.id },
    ],
    actions: act,
  });
  assert.deepEqual(r.conditions, [
    { field: `customFields.${num.id}`, op: "gte", value: 3 },
    { field: `customFields.${date.id}`, op: "lt", value: "2026-04-01" },
    { field: `customFields.${text.id}`, op: "is_set", value: null },
    { field: `customFields.${multi.id}`, op: "is_not_set", value: null },
    { field: `customFields.${text.id}`, op: "ne", value: "plain" },
    { field: `customFields.${user.id}`, op: "eq", value: w.viewer.id },
  ]);
});

test("action validation: 1 to 10 known actions with valid keys, notify recipients, sprints of the team, archive_card only last", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const elsewhere = await setupBoard(api);
  const foreignSprint = await mkSprint(api, elsewhere.project.id, elsewhere.owner);
  const num = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const bad: unknown[] = [
    undefined,
    [],
    {},
    Array.from({ length: 11 }, () => ({ type: "set_priority", priority: "low" })),
    [{ type: "explode" }],
    [{ type: "set_assignee" }],
    [{ type: "set_assignee", userId: w.viewer.id }],
    [{ type: "set_assignee", userId: w.outsider.id }],
    [{ type: "add_label", label: "" }],
    [{ type: "add_label", label: "x".repeat(31) }],
    [{ type: "remove_label", label: 5 }],
    [{ type: "set_priority", priority: "critical" }],
    [{ type: "move_to_column", columnId: elsewhere.cols[0] }],
    [{ type: "move_to_column" }],
    [{ type: "set_field", fieldId: "no-such-field", value: 1 }],
    [{ type: "set_field", fieldId: num.id, value: "1" }],
    [{ type: "add_comment", body: "  " }],
    [{ type: "add_comment", body: "b".repeat(5001) }],
    [{ type: "notify", to: [], message: "m" }],
    [{ type: "notify", to: ["assignee", "assignee"], message: "m" }],
    [{ type: "notify", to: ["everyone"], message: "m" }],
    [{ type: "notify", to: [w.outsider.id], message: "m" }],
    [{ type: "notify", to: ["creator"], message: "" }],
    [{ type: "notify", to: ["creator"], message: "m".repeat(501) }],
    [{ type: "notify", to: ["creator"] }],
    [{ type: "add_to_sprint", sprintId: foreignSprint.id }],
    [{ type: "add_to_sprint", sprintId: "current" }],
    [{ type: "archive_card" }, { type: "set_priority", priority: "low" }],
  ];
  for (const actions of bad) assertError(await tryRule(api, w, { trigger: ON_CREATE, actions }), 400, "invalid_body", JSON.stringify(actions)?.slice(0, 120));
  const r = await rule(api, w, {
    trigger: ON_CREATE,
    actions: [
      { type: "set_assignee", userId: null },
      { type: "set_assignee", userId: w.member.id },
      { type: "set_field", fieldId: num.id, value: null },
      { type: "notify", to: ["assignee", "watchers", "creator", w.viewer.id], message: "m" },
      { type: "add_to_sprint", sprintId: "active" },
      { type: "archive_card" },
    ],
  });
  assert.equal(r.actions.length, 6);
});

test("actions are stored with type and their own keys only, normalised as the target would store them", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const text = await mkField(api, w.project.id, w.owner, { name: "T", type: "text" });
  const multi = await mkField(api, w.project.id, w.owner, { name: "M", type: "multiselect", options: ["x", "y", "z"] });
  const r = await rule(api, w, {
    trigger: ON_CREATE,
    actions: [
      { type: "add_label", label: "  Bug ", extra: 1 },
      { type: "remove_label", label: "UI" },
      { type: "set_priority", priority: "urgent", label: "ignored" },
      { type: "set_field", fieldId: text.id, value: "  padded  " },
      { type: "set_field", fieldId: multi.id, value: ["z", "x", "z"] },
      { type: "add_comment", body: "  hello  " },
      { type: "notify", to: ["creator"], message: "  ping  " },
      { type: "archive_card", body: "ignored" },
    ],
  });
  assert.deepEqual(r.actions, [
    { type: "add_label", label: "bug" },
    { type: "remove_label", label: "ui" },
    { type: "set_priority", priority: "urgent" },
    { type: "set_field", fieldId: text.id, value: "padded" },
    { type: "set_field", fieldId: multi.id, value: ["x", "z"] },
    { type: "add_comment", body: "hello" },
    { type: "notify", to: ["creator"], message: "ping" },
    { type: "archive_card" },
  ]);
});

test("the rules quota counts disabled rules: the fourth rule on the free plan is 409 quota_exceeded, after validation", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const act = [{ type: "set_priority", priority: "high" }];
  await rule(api, w, { trigger: ON_CREATE, actions: act, enabled: false });
  await rule(api, w, { trigger: ON_CREATE, actions: act });
  const third = await rule(api, w, { trigger: ON_CREATE, actions: act });
  assertQuota(await tryRule(api, w, { trigger: ON_CREATE, actions: act }), "rules", 3, 3);
  assertError(await tryRule(api, w, { trigger: ON_CREATE, actions: [] }), 400, "invalid_body", "validation before the quota");
  await ok(api, 204, "DELETE", `/rules/${third.id}`, undefined, w.admin.token);
  assertStatus(await tryRule(api, w, { trigger: ON_CREATE, actions: act }), 201);
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.owner.token)).usage.rules, 3);
});

test("rule definitions, tests and runs are admin+; viewers and members read the rules; non-members get 404", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const r = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "high" }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  for (const u of [w.member, w.viewer]) {
    assertError(await api.call("POST", `/teams/${w.team.id}/rules`, { name: "r", trigger: ON_CREATE, actions: [{ type: "archive_card" }] }, u.token), 403, "forbidden");
    assertError(await api.call("PATCH", `/rules/${r.id}`, { name: "x" }, u.token), 403, "forbidden");
    assertError(await api.call("DELETE", `/rules/${r.id}`, undefined, u.token), 403, "forbidden");
    assertError(await api.call("POST", `/rules/${r.id}/test`, { cardId: card.id }, u.token), 403, "forbidden");
    assertError(await api.call("GET", `/rules/${r.id}/runs`, undefined, u.token), 403, "forbidden");
    assertError(await api.call("GET", `/teams/${w.team.id}/rule-runs`, undefined, u.token), 403, "forbidden");
    await ok(api, 200, "GET", `/rules/${r.id}`, undefined, u.token);
    await ok(api, 200, "GET", `/teams/${w.team.id}/rules`, undefined, u.token);
  }
  for (const [m, p] of [["GET", `/rules/${r.id}`], ["GET", `/rules/${r.id}/runs`], ["GET", `/teams/${w.team.id}/rules`], ["PATCH", `/rules/${r.id}`]] as const) {
    assertError(await api.call(m, p, m === "PATCH" ? { name: "x" } : undefined, w.outsider.token), 404, "not_found", `${m} ${p}`);
  }
  assertError(await api.call("GET", "/rules/no-such-rule", undefined, w.owner.token), 404, "not_found");
});

test("PATCH validates only the fields it has, replaces trigger, conditions and actions whole, keeps createdBy and moves updatedAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  const r = await rule(api, w, {
    trigger: { event: "card.updated", fields: ["title"] },
    conditions: [{ field: "dueDate", op: "is_set" }],
    actions: [{ type: "add_label", label: "a" }, { type: "set_priority", priority: "low" }],
  });
  clock.advance(60_000);
  const p = await ok(api, 200, "PATCH", `/rules/${r.id}`, { trigger: { event: "card.created" }, actions: [{ type: "set_priority", priority: "high" }] }, w.owner.token);
  assert.deepEqual(p.trigger, { event: "card.created", projectId: null, toColumnId: null, fields: null });
  assert.deepEqual(p.actions, [{ type: "set_priority", priority: "high" }]);
  assert.deepEqual(p.conditions, r.conditions, "not given, kept");
  assert.equal(p.createdBy, w.admin.id, "a PATCH by another admin keeps createdBy");
  assert.equal(p.updatedAt, clock.iso());
  assertError(await api.call("PATCH", `/rules/${r.id}`, {}, w.owner.token), 400, "invalid_body", "empty PATCH");
  assertError(await api.call("PATCH", `/rules/${r.id}`, { conditions: [{ field: "title", op: "eq", value: "x" }] }, w.owner.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/rules/${r.id}`, { name: "" }, w.owner.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/rules/${r.id}`, { enabled: "no" }, w.owner.token), 400, "invalid_body");
  const card = await createCard(api, w.cols[0], w.member, { title: "c", dueDate: "2026-05-01" });
  assert.equal(card.priority, "high");
  const log = await auditLog(api, w.admin.token, w.team.id);
  const byRule = log.filter((e) => e.via !== null);
  assert.deepEqual(byRule.map((e) => [e.action, e.actorId]), [["card.updated", w.admin.id]], "the rule still acts as its creator");
});

test("deleting a rule deletes its runs: its runs route is 404 and the team's rule runs no longer list them", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const keep = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "low" }] });
  const gone = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "add_label", label: "x" }] });
  await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.equal((await teamRuns(api, w.admin.token, w.team.id)).length, 2);
  await ok(api, 204, "DELETE", `/rules/${gone.id}`, undefined, w.admin.token);
  assertError(await api.call("GET", `/rules/${gone.id}/runs`, undefined, w.admin.token), 404, "not_found");
  assertError(await api.call("GET", `/rules/${gone.id}`, undefined, w.admin.token), 404, "not_found");
  const left = await teamRuns(api, w.admin.token, w.team.id);
  assert.deepEqual(left.map((x) => x.ruleId), [keep.id]);
});

test("POST /rules/:ruleId/test answers one boolean per condition and matched, ignoring trigger and enabled, changing nothing and recording no run", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  const elsewhere = await setupBoard(api, clock);
  const r = await rule(api, w, {
    trigger: { event: "card.due" },
    enabled: false,
    conditions: [
      { field: "priority", op: "eq", value: "high" },
      { field: "title", op: "contains", value: "x" },
    ],
    actions: [{ type: "archive_card" }],
  });
  const card = await createCard(api, w.cols[0], w.member, { title: "xyz", priority: "high" });
  const other = await createCard(api, w.cols[0], w.member, { title: "abc", priority: "high" });
  clock.advance(60_000);
  assert.deepEqual(await testRule(api, w, r.id, card.id), { matched: true, conditions: [true, true] });
  assert.deepEqual(await testRule(api, w, r.id, other.id), { matched: false, conditions: [true, false] });
  const after = await getCard(api, card.id, w.member.token);
  assert.deepEqual([after.archived, after.updatedAt], [false, card.updatedAt]);
  assert.deepEqual(await runsOf(api, w, r.id), []);
  const foreign = await createCard(api, elsewhere.cols[0], elsewhere.member, { title: "x" });
  for (const body of [{ cardId: foreign.id }, { cardId: "no-such-card" }, {}, { cardId: 5 }]) {
    assertError(await api.call("POST", `/rules/${r.id}/test`, body, w.admin.token), 400, "invalid_body", JSON.stringify(body));
  }
  const empty = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "low" }] });
  assert.deepEqual(await testRule(api, w, empty.id, card.id), { matched: true, conditions: [] }, "no conditions always match");
});

test("title, labels and assigneeId conditions: case-insensitive contains, label membership, exact assignee or null", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "Fix Login Bug", labels: ["bug", "ui"], assigneeId: w.member.id });
  const r = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [
      { field: "title", op: "contains", value: "login" },
      { field: "title", op: "contains", value: "LOGIN BUG" },
      { field: "title", op: "not_contains", value: "logout" },
      { field: "title", op: "contains", value: "logout" },
      { field: "labels", op: "contains", value: " BUG " },
      { field: "labels", op: "not_contains", value: "ui" },
      { field: "assigneeId", op: "eq", value: w.member.id },
      { field: "assigneeId", op: "ne", value: null },
      { field: "assigneeId", op: "eq", value: null },
      { field: "labels", op: "contains", value: "backend" },
    ],
    actions: [{ type: "set_priority", priority: "low" }],
  });
  assert.deepEqual(await testRule(api, w, r.id, card.id), { matched: false, conditions: [true, true, true, false, true, false, true, true, false, false] });
  const bare = await createCard(api, w.cols[0], w.member, { title: "plain" });
  assert.deepEqual((await testRule(api, w, r.id, bare.id)).conditions, [false, false, true, false, false, true, false, false, true, false]);
});

test("priority conditions compare in the order none < low < medium < high < urgent; points comparisons are false on null points except eq and ne", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c", priority: "medium", points: 5 });
  const nul = await createCard(api, w.cols[0], w.member, { title: "n", priority: "none" });
  const pr = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [
      { field: "priority", op: "eq", value: "medium" },
      { field: "priority", op: "ne", value: "medium" },
      { field: "priority", op: "gte", value: "low" },
      { field: "priority", op: "gte", value: "high" },
      { field: "priority", op: "lte", value: "medium" },
      { field: "priority", op: "lte", value: "low" },
      { field: "points", op: "eq", value: 5 },
      { field: "points", op: "gt", value: 5 },
      { field: "points", op: "gte", value: 5 },
      { field: "points", op: "lt", value: 8 },
    ],
    actions: [{ type: "set_priority", priority: "low" }],
  });
  assert.deepEqual((await testRule(api, w, pr.id, card.id)).conditions, [true, false, true, false, true, false, true, false, true, true]);
  const pts = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [
      { field: "points", op: "eq", value: null },
      { field: "points", op: "ne", value: null },
      { field: "points", op: "lt", value: 21 },
      { field: "points", op: "gte", value: 0 },
      { field: "points", op: "ne", value: 3 },
      { field: "points", op: "eq", value: 3 },
      { field: "priority", op: "lte", value: "none" },
      { field: "priority", op: "gte", value: "low" },
    ],
    actions: [{ type: "set_priority", priority: "low" }],
  });
  assert.deepEqual((await testRule(api, w, pts.id, nul.id)).conditions, [true, false, false, false, true, false, true, false]);
  assert.deepEqual((await testRule(api, w, pts.id, card.id)).conditions, [false, true, true, true, true, false, false, true]);
});

test("columnId, category, dueDate and blocked conditions read the card's current column, due date and open blockers", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[1], w.member, { title: "c", dueDate: "2026-04-01" });
  const r = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [
      { field: "columnId", op: "eq", value: w.cols[1] },
      { field: "columnId", op: "ne", value: w.cols[1] },
      { field: "category", op: "eq", value: "in_progress" },
      { field: "category", op: "ne", value: "done" },
      { field: "dueDate", op: "is_set" },
      { field: "dueDate", op: "is_not_set" },
      { field: "blocked", op: "eq", value: false },
      { field: "blocked", op: "eq", value: true },
    ],
    actions: [{ type: "set_priority", priority: "low" }],
  });
  assert.deepEqual((await testRule(api, w, r.id, card.id)).conditions, [true, false, true, true, true, false, true, false]);
  const blocker = await createCard(api, w.cols[0], w.member, { title: "blocker" });
  await ok(api, 201, "POST", `/cards/${card.id}/blockers`, { blockerId: blocker.id }, w.member.token);
  await move(api, card.id, w.member, w.cols[0]);
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { dueDate: null }, w.member.token);
  assert.deepEqual((await testRule(api, w, r.id, card.id)).conditions, [false, true, false, true, false, true, false, true]);
  await move(api, blocker.id, w.member, w.cols[2]);
  assert.deepEqual((await testRule(api, w, r.id, card.id)).conditions.slice(6), [true, false], "a completed blocker is not open");
});

test("customFields conditions per type: eq and ne for scalar types, gt/gte/lt/lte for numbers and dates (dates as strings), is_set and is_not_set", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const T = await mkField(api, w.project.id, w.owner, { name: "T", type: "text" });
  const N = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const D = await mkField(api, w.project.id, w.owner, { name: "D", type: "date" });
  const S = await mkField(api, w.project.id, w.owner, { name: "S", type: "select", options: ["a", "b"] });
  const C = await mkField(api, w.project.id, w.owner, { name: "C", type: "checkbox" });
  const U = await mkField(api, w.project.id, w.owner, { name: "U", type: "user" });
  const L = await mkField(api, w.project.id, w.owner, { name: "L", type: "url" });
  const M = await mkField(api, w.project.id, w.owner, { name: "M", type: "multiselect", options: ["x", "y"] });
  const card = await createCard(api, w.cols[0], w.member, {
    title: "c",
    customFields: { [T.id]: "hello", [N.id]: 5, [D.id]: "2026-04-10", [S.id]: "a", [C.id]: true, [U.id]: w.member.id, [L.id]: "https://x.test/a" },
  });
  const cf = (f: any) => `customFields.${f.id}`;
  const one = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [
      { field: cf(T), op: "eq", value: "hello" },
      { field: cf(T), op: "ne", value: "hello" },
      { field: cf(N), op: "gt", value: 4 },
      { field: cf(N), op: "lte", value: 4 },
      { field: cf(D), op: "lt", value: "2026-05-01" },
      { field: cf(D), op: "gte", value: "2026-05-01" },
      { field: cf(S), op: "eq", value: "a" },
      { field: cf(S), op: "ne", value: "a" },
      { field: cf(C), op: "eq", value: true },
      { field: cf(C), op: "eq", value: false },
    ],
    actions: [{ type: "set_priority", priority: "low" }],
  });
  assert.deepEqual((await testRule(api, w, one.id, card.id)).conditions, [true, false, true, false, true, false, true, false, true, false]);
  const two = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [
      { field: cf(U), op: "eq", value: w.member.id },
      { field: cf(U), op: "ne", value: w.member.id },
      { field: cf(L), op: "eq", value: "https://x.test/a" },
      { field: cf(L), op: "ne", value: "https://y.test/" },
      { field: cf(M), op: "is_set" },
      { field: cf(M), op: "is_not_set" },
      { field: cf(T), op: "is_set" },
      { field: cf(N), op: "lt", value: 5 },
      { field: cf(N), op: "gte", value: 5 },
      { field: cf(D), op: "eq", value: "2026-04-10" },
    ],
    actions: [{ type: "set_priority", priority: "low" }],
  });
  assert.deepEqual((await testRule(api, w, two.id, card.id)).conditions, [true, false, true, true, false, true, true, false, true, true]);
});

test("a card without a value for the field, a card of another project included, fails every op except is_not_set, ne and not_contains", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const T = await mkField(api, w.project.id, w.owner, { name: "T", type: "text" });
  const N = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const D = await mkField(api, w.project.id, w.owner, { name: "D", type: "date" });
  const S = await mkField(api, w.project.id, w.owner, { name: "S", type: "select", options: ["a"] });
  const C = await mkField(api, w.project.id, w.owner, { name: "C", type: "checkbox" });
  const M = await mkField(api, w.project.id, w.owner, { name: "M", type: "multiselect", options: ["x"] });
  const cf = (f: any) => `customFields.${f.id}`;
  const r = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [
      { field: cf(T), op: "eq", value: "hello" },
      { field: cf(T), op: "ne", value: "hello" },
      { field: cf(T), op: "is_set" },
      { field: cf(T), op: "is_not_set" },
      { field: cf(N), op: "gt", value: 0 },
      { field: cf(N), op: "lte", value: 100 },
      { field: cf(D), op: "lt", value: "2030-01-01" },
      { field: cf(S), op: "ne", value: "a" },
      { field: cf(C), op: "eq", value: false },
      { field: cf(M), op: "is_not_set" },
    ],
    actions: [{ type: "set_priority", priority: "low" }],
  });
  const expected = [false, true, false, true, false, false, false, true, false, true];
  const bare = await createCard(api, w.cols[0], w.member, { title: "no values" });
  assert.deepEqual((await testRule(api, w, r.id, bare.id)).conditions, expected);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  const foreign = await createCard(api, opsBoard.columns[0].id, w.member, { title: "other project" });
  assert.deepEqual((await testRule(api, w, r.id, foreign.id)).conditions, expected);
});

test("conditions read the card's current state: a later rule sees an earlier rule's change; the response shows the state after every rule, the snapshot before", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const first = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "high" }] });
  const second = await rule(api, w, { trigger: ON_CREATE, conditions: [{ field: "priority", op: "eq", value: "high" }], actions: [{ type: "add_label", label: "hot" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.deepEqual([card.priority, card.labels], ["high", ["hot"]]);
  const [r1] = await runsOf(api, w, first.id);
  const [r2] = await runsOf(api, w, second.id);
  assert.deepEqual([r1.status, r1.depth, r2.status, r2.depth], ["succeeded", 0, "succeeded", 0]);
  assert.deepEqual(await log.names(), ["card.created", "card.updated", "card.updated"]);
  const [created, up1, up2] = await log.events(3);
  assert.deepEqual([created.data.card.priority, created.data.card.labels], ["none", []]);
  assert.deepEqual([up1.data.fields, up1.data.card.priority, up1.data.card.labels], [["priority"], "high", []]);
  assert.deepEqual([up2.data.fields, up2.data.card.labels], [["labels"], ["hot"]]);
  assert.deepEqual([up1.via.runId, up2.via.runId], [r1.id, r2.id]);
});

test("rules of an event run in rule creation order, so the last one wins; their runs and audit entries follow that order", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const low = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "low" }] });
  const high = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "high" }] }, w.owner);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.equal(card.priority, "high");
  const runs = await teamRuns(api, w.admin.token, w.team.id);
  assert.deepEqual(runs.map((r) => r.ruleId), [low.id, high.id]);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.actorId, e.via?.ruleId ?? null]), [
    ["card.created", w.member.id, null],
    ["card.updated", w.admin.id, low.id],
    ["card.updated", w.owner.id, high.id],
  ]);
});

test("a trigger that does not match records no run: the event, projectId, toColumnId and fields filters, and disabled rules", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const byProject = await rule(api, w, { trigger: { event: "card.created", projectId: ops.id }, actions: [{ type: "add_label", label: "ops" }] });
  const toDone = await rule(api, w, { trigger: { event: "card.moved", toColumnId: w.cols[2] }, actions: [{ type: "add_label", label: "done" }] });
  const onTitle = await rule(api, w, { trigger: { event: "card.updated", fields: ["title"] }, actions: [{ type: "add_label", label: "retitled" }] });
  const disabled = await rule(api, w, { trigger: ON_CREATE, enabled: false, actions: [{ type: "add_label", label: "never" }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await move(api, card.id, w.member, w.cols[1]);
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { priority: "low" }, w.member.token);
  assert.deepEqual((await getCard(api, card.id, w.member.token)).labels, []);
  for (const r of [byProject, toDone, onTitle, disabled]) assert.deepEqual(await runsOf(api, w, r.id), [], r.name);
  await move(api, card.id, w.member, w.cols[2]);
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "new", priority: "high" }, w.member.token);
  assert.deepEqual((await getCard(api, card.id, w.member.token)).labels, ["done", "retitled"]);
  const opsCard = await createCard(api, (await createBoard(api, ops.id, w.owner)).columns[0].id, w.member, { title: "o" });
  assert.deepEqual(opsCard.labels, ["ops"]);
  assert.deepEqual([(await runsOf(api, w, toDone.id)).length, (await runsOf(api, w, onTitle.id)).length, (await runsOf(api, w, byProject.id)).length], [1, 1, 1]);
  assert.deepEqual(await runsOf(api, w, disabled.id), []);
});

test("comment.created runs on the comment's card, and card.due runs from the scheduler with actor null while the actions act as the creator", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  const onComment = await rule(api, w, { trigger: { event: "comment.created" }, actions: [{ type: "set_priority", priority: "urgent" }] });
  const onDue = await rule(api, w, { trigger: { event: "card.due" }, actions: [{ type: "add_label", label: "overdue" }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c", dueDate: "2026-03-03" });
  await comment(api, card.id, w.member, "a comment");
  assert.equal((await getCard(api, card.id, w.member.token)).priority, "urgent");
  const [cr] = await runsOf(api, w, onComment.id);
  assert.deepEqual([cr.event, cr.cardId, cr.status], ["comment.created", card.id, "succeeded"]);
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.set(Date.parse("2026-03-03T00:00:00.000Z"));
  await ok(api, 200, "GET", "/health");
  assert.deepEqual((await getCard(api, card.id, w.member.token)).labels, ["overdue"]);
  const [dr] = await runsOf(api, w, onDue.id);
  assert.deepEqual([dr.event, dr.cardId, dr.depth, dr.at], ["card.due", card.id, 0, "2026-03-03T00:00:00.000Z"]);
  const [due, upd] = await log.events(2);
  assert.deepEqual([due.event, due.actorId, due.via], ["card.due", null, { type: "schedule" }]);
  assert.deepEqual([upd.event, upd.actorId, upd.via], ["card.updated", w.admin.id, { type: "rule", ruleId: onDue.id, runId: dr.id }]);
});

test("rules chain through events up to automation.maxDepth (default 3): events of depth 3 trigger no rule", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const r1 = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "low" }] });
  const r2 = await rule(api, w, { trigger: { event: "card.updated", fields: ["priority"] }, actions: [{ type: "add_label", label: "l2" }] });
  const r3 = await rule(api, w, { trigger: { event: "card.updated", fields: ["labels"] }, actions: [{ type: "set_assignee", userId: w.member.id }] });
  const r4 = await rule(api, w, { trigger: { event: "card.updated", fields: ["assigneeId"] }, actions: [{ type: "set_priority", priority: "urgent" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  assert.deepEqual([card.priority, card.labels, card.assigneeId], ["low", ["l2"], w.member.id]);
  const depths = [];
  for (const r of [r1, r2, r3, r4]) depths.push((await runsOf(api, w, r.id)).map((x) => x.depth));
  assert.deepEqual(depths, [[0], [1], [2], []]);
  assert.deepEqual(await log.names(), ["card.created", "card.updated", "card.updated", "card.updated"]);
  const events = await log.events(4);
  assert.deepEqual(events.map((e) => e.data.fields ?? null), [null, ["priority"], ["labels"], ["assigneeId"]]);
  assert.deepEqual(events.slice(1).map((e) => e.via.ruleId), [r1.id, r2.id, r3.id]);
});

test("automation.maxDepth 1 runs rules only on the request's own events, and maxDepth 0 runs no rule at all", async (t) => {
  for (const [maxDepth, want] of [
    [1, { priority: "low", labels: [], runs: [1, 0] }],
    [0, { priority: "none", labels: [], runs: [0, 0] }],
  ] as const) {
    const api = await startApp(t, { ...TEAM, automation: { maxDepth } });
    const w = await setupBoard(api);
    const r1 = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "low" }] });
    const r2 = await rule(api, w, { trigger: { event: "card.updated" }, actions: [{ type: "add_label", label: "l2" }] });
    const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
    assert.deepEqual([card.priority, card.labels], [want.priority, want.labels], `maxDepth ${maxDepth}`);
    assert.deepEqual([(await runsOf(api, w, r1.id)).length, (await runsOf(api, w, r2.id)).length], want.runs, `maxDepth ${maxDepth}`);
    await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "edited" }, w.owner.token);
    assert.equal((await runsOf(api, w, r2.id)).length, maxDepth === 0 ? 0 : 1, "a request's own event is depth 0");
  }
});

test("a rule never reacts to its own actions, but does react to another rule's", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const s = await rule(api, w, { trigger: { event: "card.updated" }, actions: [{ type: "set_priority", priority: "high" }] });
  const tr = await rule(api, w, { trigger: { event: "card.updated", fields: ["priority"] }, actions: [{ type: "add_label", label: "t" }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "edited" }, w.member.token);
  const sRuns = await runsOf(api, w, s.id);
  const tRuns = await runsOf(api, w, tr.id);
  assert.deepEqual(sRuns.map((r) => [r.depth, r.status, r.actions[0].status]), [[0, "succeeded", "succeeded"], [2, "succeeded", "noop"]], "s skips its own depth-1 event, then reacts to t's");
  assert.deepEqual(tRuns.map((r) => [r.depth, r.status]), [[1, "succeeded"]]);
  const now = await getCard(api, card.id, w.member.token);
  assert.deepEqual([now.priority, now.labels], ["high", ["t"]]);
});

test("rule events join the end of the queue: deliveries and audit entries follow queue order, rule changes carry the rule's via and creator", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  const r1 = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "add_comment", body: "auto {{key}}" }] });
  const r2 = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "high" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(1000);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  const [run1] = await runsOf(api, w, r1.id);
  const [run2] = await runsOf(api, w, r2.id);
  const via1 = { type: "rule", ruleId: r1.id, runId: run1.id };
  const via2 = { type: "rule", ruleId: r2.id, runId: run2.id };
  assert.deepEqual(await log.names(), ["card.created", "comment.created", "card.updated"]);
  const events = await log.events(3);
  assert.deepEqual(events.map((e) => [e.actorId, e.via, e.occurredAt]), [
    [w.owner.id, null, clock.iso()],
    [w.admin.id, via1, clock.iso()],
    [w.admin.id, via2, clock.iso()],
  ]);
  assert.equal(events[1].data.comment.body, "auto ENG-1");
  assert.equal(events[1].data.comment.authorId, w.admin.id);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.actorId, e.via, e.details]), [
    ["card.created", w.owner.id, null, {}],
    ["comment.created", w.admin.id, via1, {}],
    ["card.updated", w.admin.id, via2, { fields: ["priority"] }],
  ]);
  assert.equal(entries[1].targetId, events[1].data.comment.id);
  assert.equal(entries[2].targetId, card.id);
});

test("rule-caused events get activity entries with the rule's via, listed in the team, card and creator feeds", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const r1 = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "add_comment", body: "auto" }] });
  await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "high" }] });
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  const teamFeed = (await feed(api, w.viewer.token, `/teams/${w.team.id}/activity`)).filter((e) => e.cardId !== null);
  const cardFeed = await feed(api, w.viewer.token, `/cards/${card.id}/activity`);
  for (const items of [teamFeed, cardFeed]) {
    assert.deepEqual(items.map((e) => [e.event, e.actorId, e.via?.ruleId ?? null, e.cardId, e.projectId]), [
      ["card.created", w.owner.id, null, card.id, w.project.id],
      ["comment.created", w.admin.id, r1.id, card.id, w.project.id],
      ["card.updated", w.admin.id, items[2].via.ruleId, card.id, w.project.id],
    ]);
  }
  const mine = await feed(api, w.admin.token, "/me/activity");
  assert.deepEqual(mine.map((e) => e.event), ["comment.created", "card.updated"], "the rule's creator is the actor");
});

test("set_assignee assigns as the rule's creator: card.updated [assigneeId], its audit entry, an assigned notification and the assignee watching", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const r = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_assignee", userId: w.member.id }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  assert.equal(card.assigneeId, w.member.id);
  const [run] = await runsOf(api, w, r.id);
  const via = { type: "rule", ruleId: r.id, runId: run.id };
  const [, updated] = await log.events(2);
  assert.deepEqual([updated.event, updated.data.fields, updated.data.card.assigneeId, updated.actorId, updated.via], ["card.updated", ["assigneeId"], w.member.id, w.admin.id, via]);
  const entry = (await auditLog(api, w.admin.token, w.team.id)).at(-1);
  assert.deepEqual([entry.action, entry.targetId, entry.actorId, entry.via, entry.details], ["card.updated", card.id, w.admin.id, via, { fields: ["assigneeId"] }]);
  const mine = await notifications(api, w.member);
  assert.deepEqual(mine.map((n) => [n.type, n.cardId, n.actorId, n.via]), [["assigned", card.id, w.admin.id, via]]);
  assert.deepEqual(await watcherIds(api, w.owner.token, card.id), [w.owner.id, w.member.id]);
});

test("set_assignee is a noop when already assigned, fails invalid_assignee once the user is no longer member+, and null unassigns", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const r = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_assignee", userId: w.member.id }] });
  const unassign = await rule(api, w, { trigger: { event: "card.updated", fields: ["title"] }, actions: [{ type: "set_assignee", userId: null }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  await createCard(api, w.cols[0], w.owner, { title: "a", assigneeId: w.member.id });
  assert.deepEqual(outcome((await runsOf(api, w, r.id))[0]), ["succeeded", null, [["set_assignee", "noop", null]]]);
  assert.deepEqual(await log.names(), ["card.created"], "a noop changes nothing and emits nothing");
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.member.id}`, { role: "viewer" }, w.owner.token);
  const b = await createCard(api, w.cols[0], w.owner, { title: "b", assigneeId: w.admin.id });
  assert.equal(b.assigneeId, w.admin.id);
  assert.deepEqual(outcome((await runsOf(api, w, r.id))[1]), ["failed", "invalid_assignee", [["set_assignee", "failed", "invalid_assignee"]]]);
  const p = await ok(api, 200, "PATCH", `/cards/${b.id}`, { title: "b2" }, w.owner.token);
  assert.equal(p.assigneeId, null);
  await ok(api, 200, "PATCH", `/cards/${b.id}`, { title: "b3" }, w.owner.token);
  assert.deepEqual((await runsOf(api, w, unassign.id)).map((x) => x.actions[0].status), ["succeeded", "noop"]);
});

test("add_label and remove_label are noops when there is nothing to change; add_label on a card with 10 labels fails invalid_body and stops the run", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const ab = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [{ field: "labels", op: "contains", value: "a" }],
    actions: [{ type: "add_label", label: "a" }, { type: "remove_label", label: "b" }, { type: "remove_label", label: "zz" }, { type: "add_label", label: "C" }],
  });
  const full = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [{ field: "labels", op: "contains", value: "l0" }],
    actions: [{ type: "set_priority", priority: "low" }, { type: "add_label", label: "new" }, { type: "set_priority", priority: "high" }],
  });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1", labels: ["a", "b"] });
  assert.deepEqual(c1.labels, ["a", "c"]);
  assert.deepEqual(outcome((await runsOf(api, w, ab.id))[0]), ["succeeded", null, [["add_label", "noop", null], ["remove_label", "succeeded", null], ["remove_label", "noop", null], ["add_label", "succeeded", null]]]);
  assert.deepEqual(await log.names(), ["card.created", "card.updated", "card.updated"], "one change per action that changed something");
  const ten = Array.from({ length: 10 }, (_, i) => `l${i}`);
  const c2 = await createCard(api, w.cols[0], w.member, { title: "c2", labels: ten });
  assert.deepEqual([c2.priority, c2.labels], ["low", ten], "the earlier change stays");
  const run = (await runsOf(api, w, full.id)).at(-1);
  assert.deepEqual(outcome(run), ["failed", "invalid_body", [["set_priority", "succeeded", null], ["add_label", "failed", "invalid_body"], ["set_priority", "not_run", null]]]);
});

test("set_priority is a noop when equal: the run succeeds with a noop action and nothing is emitted or audited", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const r = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "high" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  await createCard(api, w.cols[0], w.member, { title: "already", priority: "high" });
  assert.deepEqual(outcome((await runsOf(api, w, r.id))[0]), ["succeeded", null, [["set_priority", "noop", null]]]);
  assert.deepEqual(await log.names(), ["card.created"]);
  assert.deepEqual((await auditLog(api, w.admin.token, w.team.id)).slice(base).map((e) => e.action), ["card.created"]);
  const changed = await createCard(api, w.cols[0], w.member, { title: "low", priority: "low" });
  assert.equal(changed.priority, "high");
  assert.deepEqual(await log.names(), ["card.created", "card.created", "card.updated"]);
});

test("move_to_column moves the card to the end of the column like the move route: card.moved, history, completedAt and its audit details", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  const r = await rule(api, w, { trigger: { event: "card.created", projectId: w.project.id }, actions: [{ type: "move_to_column", columnId: w.cols[2] }] });
  const there = await createCard(api, w.cols[2], w.member, { title: "already there" });
  assert.deepEqual(outcome((await runsOf(api, w, r.id))[0]), ["succeeded", null, [["move_to_column", "noop", null]]]);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(1000);
  const card = await createCard(api, w.cols[0], w.member, { title: "moves" });
  assert.deepEqual([card.columnId, card.position, card.completedAt], [w.cols[2], 1, clock.iso()]);
  assert.deepEqual(await history(api, w.member.token, card.id), [[null, w.cols[0]], [w.cols[0], w.cols[2]]]);
  const [, moved] = await log.events(2);
  assert.deepEqual([moved.event, moved.data.fromColumnId, moved.data.toColumnId, moved.actorId], ["card.moved", w.cols[0], w.cols[2], w.admin.id]);
  const entry = (await auditLog(api, w.admin.token, w.team.id)).slice(base).at(-1);
  assert.deepEqual([entry.action, entry.details], ["card.moved", { fromColumnId: w.cols[0], toColumnId: w.cols[2], position: 1 }]);
  assert.deepEqual((await ok(api, 200, "GET", `/boards/${w.board.id}/cards?columnId=${w.cols[2]}`, undefined, w.member.token)).items.map((c: any) => c.id), [there.id, card.id]);
});

test("move_to_column outcomes: noop when already there, failed not_found for a column of another board, then blocked before wip_limit_reached", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const board2 = await createBoard(api, w.project.id, w.owner, { name: "Second" });
  const toDone = await rule(api, w, { trigger: { event: "card.updated", fields: ["title"] }, actions: [{ type: "move_to_column", columnId: w.cols[2] }] });
  const toOther = await rule(api, w, { trigger: { event: "card.updated", fields: ["description"] }, actions: [{ type: "move_to_column", columnId: board2.columns[0].id }] });
  const a = await createCard(api, w.cols[2], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  const blocker = await createCard(api, w.cols[0], w.member, { title: "blocker" });
  await ok(api, 201, "POST", `/cards/${b.id}/blockers`, { blockerId: blocker.id }, w.member.token);
  const d = await createCard(api, w.cols[1], w.member, { title: "d" });
  const last = async (id: string) => (await runsOf(api, w, id)).at(-1);
  await ok(api, 200, "PATCH", `/cards/${a.id}`, { title: "a2" }, w.member.token);
  assert.deepEqual((await last(toDone.id)).actions[0].status, "noop");
  await ok(api, 200, "PATCH", `/columns/${w.cols[2]}`, { wipLimit: 1 }, w.owner.token);
  await ok(api, 200, "PATCH", `/cards/${b.id}`, { title: "b2" }, w.member.token);
  assert.deepEqual(outcome(await last(toDone.id)), ["failed", "blocked", [["move_to_column", "failed", "blocked"]]]);
  await ok(api, 200, "PATCH", `/cards/${d.id}`, { title: "d2" }, w.member.token);
  assert.deepEqual(outcome(await last(toDone.id)), ["failed", "wip_limit_reached", [["move_to_column", "failed", "wip_limit_reached"]]]);
  await ok(api, 200, "PATCH", `/cards/${d.id}`, { description: "x" }, w.member.token);
  assert.deepEqual(outcome(await last(toOther.id)), ["failed", "not_found", [["move_to_column", "failed", "not_found"]]]);
  assert.deepEqual([(await getCard(api, b.id, w.member.token)).columnId, (await getCard(api, d.id, w.member.token)).columnId], [w.cols[0], w.cols[1]]);
});

test("set_field sets a normalised value as a card.updated [customFields] change, is a noop when equal, and null removes the value", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const f = await mkField(api, w.project.id, w.owner, { name: "F", type: "text" });
  const set = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_field", fieldId: f.id, value: "  auto  " }] });
  const clear = await rule(api, w, { trigger: { event: "card.updated", fields: ["title"] }, actions: [{ type: "set_field", fieldId: f.id, value: null }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.deepEqual(card.customFields, { [f.id]: "auto" });
  const [, updated] = await log.events(2);
  assert.deepEqual([updated.event, updated.data.fields], ["card.updated", ["customFields"]]);
  const entry = (await auditLog(api, w.admin.token, w.team.id)).at(-1);
  assert.deepEqual([entry.action, entry.details], ["card.updated", { fields: ["customFields"] }]);
  await createCard(api, w.cols[0], w.member, { title: "same", customFields: { [f.id]: "auto" } });
  assert.equal((await runsOf(api, w, set.id))[1].actions[0].status, "noop");
  const p = await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "c2" }, w.member.token);
  assert.deepEqual(p.customFields, {});
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "c3" }, w.member.token);
  assert.deepEqual((await runsOf(api, w, clear.id)).map((r) => r.actions[0].status), ["succeeded", "noop"]);
});

test("set_field fails not_found for a field of another project, field_required when clearing a required field, invalid_field_value once the value is no longer valid", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const foreign = await mkField(api, ops.id, w.owner, { name: "Foreign", type: "text" });
  const r1 = await rule(api, w, { trigger: { event: "card.created", projectId: w.project.id }, actions: [{ type: "set_field", fieldId: foreign.id, value: "x" }] });
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1" });
  assert.deepEqual(c1.customFields, {});
  assert.deepEqual(outcome((await runsOf(api, w, r1.id))[0]), ["failed", "not_found", [["set_field", "failed", "not_found"]]]);
  const req = await mkField(api, w.project.id, w.owner, { name: "Req", type: "text", required: true });
  const r2 = await rule(api, w, { trigger: { event: "card.updated", fields: ["title"] }, actions: [{ type: "set_field", fieldId: req.id, value: null }] });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "c2", customFields: { [req.id]: "v" } });
  await ok(api, 200, "PATCH", `/cards/${c2.id}`, { title: "c2b" }, w.member.token);
  assert.deepEqual(outcome((await runsOf(api, w, r2.id))[0]), ["failed", "field_required", [["set_field", "failed", "field_required"]]]);
  assert.deepEqual((await getCard(api, c2.id, w.member.token)).customFields, { [req.id]: "v" });
  const extra = await signUp(api);
  await addMember(api, w.team.id, w.owner, extra, "member");
  const uf = await mkField(api, w.project.id, w.owner, { name: "Who", type: "user" });
  const r3 = await rule(api, w, { trigger: { event: "card.updated", fields: ["description"] }, actions: [{ type: "set_field", fieldId: uf.id, value: extra.id }] });
  await ok(api, 200, "PATCH", `/cards/${c2.id}`, { description: "1" }, w.member.token);
  assert.equal((await getCard(api, c2.id, w.member.token)).customFields[uf.id], extra.id);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${extra.id}`, undefined, w.owner.token);
  await ok(api, 200, "PATCH", `/cards/${c2.id}`, { description: "2" }, w.member.token);
  assert.deepEqual((await runsOf(api, w, r3.id)).map((r) => [r.status, r.error]), [["succeeded", null], ["failed", "invalid_field_value"]]);
  assert.equal((await ok(api, 200, "GET", `/rules/${r3.id}`, undefined, w.admin.token)).enabled, true, "a user leaving disables nothing");
});

test("add_comment writes a top-level comment as the rule's creator with placeholders replaced; its mentions notify and the creator starts watching", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  const r = await rule(api, w, {
    trigger: ON_CREATE,
    actions: [{ type: "add_comment", body: `{{key}} #{{number}} {{project}} {{date}} by {{user}} cc @${w.viewer.handle} @${w.admin.handle}` }],
  });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const [run] = await runsOf(api, w, r.id);
  const via = { type: "rule", ruleId: r.id, runId: run.id };
  const list = await ok(api, 200, "GET", `/cards/${card.id}/comments`, undefined, w.member.token);
  assert.equal(list.items.length, 1);
  const c = list.items[0];
  assert.deepEqual([c.authorId, c.parentId, c.body, c.mentions], [w.admin.id, null, `ENG-1 #1 ENG 2026-03-01 by ${w.admin.handle} cc @${w.viewer.handle} @${w.admin.handle}`, [w.viewer.id]]);
  assert.deepEqual(await watcherIds(api, w.member.token, card.id), [w.member.id, w.admin.id]);
  const forViewer = await notifications(api, w.viewer);
  assert.deepEqual(forViewer.map((n) => [n.type, n.commentId, n.actorId, n.via]), [["mention", c.id, w.admin.id, via]]);
  const forMember = await notifications(api, w.member);
  assert.deepEqual(forMember.map((n) => [n.type, n.commentId, n.actorId]), [["comment", c.id, w.admin.id]], "the watching creator gets a comment notification");
  assert.deepEqual(await notifications(api, w.admin), [], "the actor gets none");
});

test("notify resolves assignee, watchers, creator and member ids when it runs, each once in to order, rule creator and the triggering user included", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const extra = await signUp(api);
  await addMember(api, w.team.id, w.owner, extra, "member");
  const r = await rule(api, w, {
    trigger: { event: "card.moved" },
    actions: [{ type: "notify", to: ["watchers", "assignee", "creator", w.viewer.id, w.admin.id, extra.id], message: " {{key}} moved; {{user}} says hi " }],
  });
  const card = await createCard(api, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  await ok(api, 204, "POST", `/cards/${card.id}/watch`, undefined, w.viewer.token);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${extra.id}`, undefined, w.owner.token);
  await move(api, card.id, w.member, w.cols[1]);
  const [run] = await runsOf(api, w, r.id);
  assert.deepEqual(outcome(run), ["succeeded", null, [["notify", "succeeded", null]]]);
  const via = { type: "rule", ruleId: r.id, runId: run.id };
  for (const u of [w.owner, w.member, w.viewer, w.admin]) {
    const ruleNotes = (await notifications(api, u)).filter((n) => n.type === "rule");
    assert.deepEqual(
      ruleNotes.map((n) => [n.cardId, n.actorId, n.via, n.message, n.commentId, n.read]),
      [[card.id, w.admin.id, via, `ENG-1 moved; ${w.admin.handle} says hi`, null, false]],
      u.handle,
    );
  }
  assert.deepEqual(await notifications(api, extra), [], "no longer a member");
  assert.deepEqual((await notifications(api, w.owner)).map((n) => n.type), ["moved", "rule"], "rule notifications are created when the action runs, before step 4");
  assert.deepEqual((await notifications(api, w.member)).map((n) => n.type), ["rule", "assigned"], "the mover gets no moved notification, but the rule's");
});

test("notify is a noop when nobody is left after membership and notification settings; it appends no audit entry and emits no event", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const r = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "notify", to: ["assignee"], message: "m" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  await createCard(api, w.cols[0], w.owner, { title: "unassigned" });
  await settings(api, w.member, { rule: false });
  await createCard(api, w.cols[0], w.owner, { title: "rule off", assigneeId: w.member.id });
  await settings(api, w.member, {}, [w.project.id]);
  await createCard(api, w.cols[0], w.owner, { title: "muted", assigneeId: w.member.id });
  await settings(api, w.member, {});
  await createCard(api, w.cols[0], w.owner, { title: "delivered", assigneeId: w.member.id });
  assert.deepEqual((await runsOf(api, w, r.id)).map((x) => x.actions[0].status), ["noop", "noop", "noop", "succeeded"]);
  assert.equal((await notifications(api, w.member)).filter((n) => n.type === "rule").length, 1);
  assert.deepEqual(await log.names(), ["card.created", "card.created", "card.created", "card.created"]);
  assert.deepEqual((await auditLog(api, w.admin.token, w.team.id)).slice(base).map((e) => e.action), ["card.created", "card.created", "card.created", "card.created"]);
});

test("add_to_sprint with a sprint id: joins it as sprint.cards_added, noop when already in it, failed sprint_state for a completed sprint or a card frozen in one", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const s = await mkSprint(api, w.project.id, w.owner);
  const s2 = await mkSprint(api, w.project.id, w.owner, { name: "Next" });
  const r1 = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "add_to_sprint", sprintId: s.id }] });
  const r2 = await rule(api, w, { trigger: { event: "card.updated", fields: ["title"] }, actions: [{ type: "add_to_sprint", sprintId: s2.id }] });
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1", points: 3 });
  assert.equal(c1.sprintId, s.id);
  const [run] = await runsOf(api, w, r1.id);
  const entry = (await auditLog(api, w.admin.token, w.team.id)).at(-1);
  assert.deepEqual([entry.action, entry.targetType, entry.targetId, entry.details, entry.via], ["sprint.cards_added", "sprint", s.id, { cardIds: [c1.id] }, { type: "rule", ruleId: r1.id, runId: run.id }]);
  const c2 = await createCard(api, w.cols[0], w.member, { title: "c2", sprintId: s.id });
  assert.equal((await runsOf(api, w, r1.id))[1].actions[0].status, "noop");
  await ok(api, 200, "POST", `/sprints/${s.id}/start`, undefined, w.owner.token);
  await move(api, c1.id, w.member, w.cols[2]);
  await ok(api, 200, "POST", `/sprints/${s.id}/complete`, {}, w.owner.token);
  const c3 = await createCard(api, w.cols[0], w.member, { title: "c3" });
  assert.equal(c3.sprintId, null);
  assert.deepEqual(outcome((await runsOf(api, w, r1.id))[2]), ["failed", "sprint_state", [["add_to_sprint", "failed", "sprint_state"]]]);
  await ok(api, 200, "PATCH", `/cards/${c1.id}`, { title: "c1b" }, w.member.token);
  assert.equal((await getCard(api, c1.id, w.member.token)).sprintId, s.id, "a completed sprint is frozen");
  await ok(api, 200, "PATCH", `/cards/${c2.id}`, { title: "c2b" }, w.member.token);
  assert.equal((await getCard(api, c2.id, w.member.token)).sprintId, s2.id);
  assert.deepEqual((await runsOf(api, w, r2.id)).map((x) => [x.status, x.error]), [["failed", "sprint_state"], ["succeeded", null]]);
});

test("archive_card archives the card as the rule's creator: the response shows it archived, card.archived is emitted and audited", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  const r = await rule(api, w, { trigger: ON_CREATE, conditions: [{ field: "title", op: "contains", value: "spam" }], actions: [{ type: "set_priority", priority: "high" }, { type: "archive_card" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(1000);
  const card = await createCard(api, w.cols[0], w.member, { title: "Buy SPAM now" });
  assert.deepEqual([card.archived, card.archivedAt, card.position, card.priority], [true, clock.iso(), null, "high"]);
  assert.deepEqual(await log.names(), ["card.created", "card.updated", "card.archived"]);
  const [run] = await runsOf(api, w, r.id);
  const entry = (await auditLog(api, w.admin.token, w.team.id)).at(-1);
  assert.deepEqual([entry.action, entry.targetId, entry.actorId, entry.via], ["card.archived", card.id, w.admin.id, { type: "rule", ruleId: r.id, runId: run.id }]);
  assert.deepEqual((await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token)).items, []);
  const kept = await createCard(api, w.cols[0], w.member, { title: "ham" });
  assert.equal(kept.archived, false);
});

test("a run has the documented shape; a condition that fails records no_match with no actions, a run that acts records each action", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  const r = await rule(api, w, { trigger: ON_CREATE, conditions: [{ field: "title", op: "contains", value: "go" }], actions: [{ type: "set_priority", priority: "low" }, { type: "add_label", label: "go" }] });
  clock.advance(1000);
  const stop = await createCard(api, w.cols[0], w.member, { title: "stop" });
  clock.advance(1000);
  const go = await createCard(api, w.cols[0], w.member, { title: "go now" });
  const runs = await runsOf(api, w, r.id);
  assert.equal(runs.length, 2);
  assertKeys(runs[0], ["id", "ruleId", "event", "cardId", "depth", "status", "error", "actions", "at"], "run");
  assert.deepEqual([runs[0].ruleId, runs[0].event, runs[0].cardId, runs[0].depth, runs[0].status, runs[0].error, runs[0].actions], [r.id, "card.created", stop.id, 0, "no_match", null, []]);
  assert.equal(runs[0].at, new Date(Date.parse(clock.iso()) - 1000).toISOString());
  assert.deepEqual([runs[1].cardId, runs[1].at], [go.id, clock.iso()]);
  assert.deepEqual(runs[1].actions, [{ type: "set_priority", status: "succeeded", error: null }, { type: "add_label", status: "succeeded", error: null }]);
  assert.deepEqual([runs[1].status, runs[1].error], ["succeeded", null]);
  assert.deepEqual([stop.priority, go.priority, go.labels], ["none", "low", ["go"]]);
});

test("a rule whose creator is no longer an owner or admin of the team is skipped with forbidden, and does nothing", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const r = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "high" }] });
  const byOwner = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "add_label", label: "ok" }] }, w.owner);
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.admin.id}`, { role: "member" }, w.owner.token);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1" });
  assert.deepEqual([c1.priority, c1.labels], ["none", ["ok"]]);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.admin.id}`, undefined, w.owner.token);
  await createCard(api, w.cols[0], w.member, { title: "c2" });
  const runs = await ruleRuns(api, w.owner.token, r.id);
  assert.deepEqual(runs.map((x) => [x.status, x.error, x.actions]), [["skipped", "forbidden", []], ["skipped", "forbidden", []]]);
  assert.equal((await ruleRuns(api, w.owner.token, byOwner.id)).every((x) => x.status === "succeeded"), true);
});

test("a rule that runs after another rule archived the card is skipped with card_archived", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "archive_card" }] });
  const later = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "high" }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.deepEqual([card.archived, card.priority], [true, "none"]);
  assert.deepEqual(outcome((await runsOf(api, w, later.id))[0]), ["skipped", "card_archived", []]);
});

test("at the first failed action the run fails with its error; the earlier actions' changes stay, emitted and audited, the rest are not_run", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const r = await rule(api, w, {
    trigger: { event: "card.updated", fields: ["title"] },
    actions: [{ type: "set_priority", priority: "high" }, { type: "move_to_column", columnId: w.cols[2] }, { type: "add_label", label: "x" }],
  });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const blocker = await createCard(api, w.cols[0], w.member, { title: "b" });
  await ok(api, 201, "POST", `/cards/${card.id}/blockers`, { blockerId: blocker.id }, w.member.token);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const p = await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "c2" }, w.member.token);
  assert.deepEqual([p.priority, p.columnId, p.labels], ["high", w.cols[0], []]);
  assert.deepEqual(outcome((await runsOf(api, w, r.id))[0]), ["failed", "blocked", [["set_priority", "succeeded", null], ["move_to_column", "failed", "blocked"], ["add_label", "not_run", null]]]);
  assert.deepEqual(await log.names(), ["card.updated", "card.updated"]);
  const entry = (await auditLog(api, w.admin.token, w.team.id)).at(-1);
  assert.deepEqual([entry.action, entry.actorId, entry.details], ["card.updated", w.admin.id, { fields: ["priority"] }]);
});

test("run lists are newest first with cursor pagination; the team list filters by ?status and rejects other values", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  const r = await rule(api, w, { trigger: ON_CREATE, conditions: [{ field: "title", op: "contains", value: "yes" }], actions: [{ type: "set_priority", priority: "low" }] });
  const other = await rule(api, w, { trigger: { event: "card.moved" }, actions: [{ type: "set_priority", priority: "high" }] });
  const titles = ["yes 1", "no 2", "yes 3", "no 4", "yes 5"];
  const cards: any[] = [];
  for (const title of titles) {
    clock.advance(1000);
    cards.push(await createCard(api, w.cols[0], w.member, { title }));
  }
  await move(api, cards[0].id, w.member, w.cols[1]);
  const first = await ok(api, 200, "GET", `/rules/${r.id}/runs?limit=2`, undefined, w.admin.token);
  assert.deepEqual(first.items.map((x: any) => x.cardId), [cards[4].id, cards[3].id]);
  const all = await ruleRuns(api, w.admin.token, r.id);
  assert.deepEqual(all.map((x) => x.cardId), cards.map((c) => c.id), "following nextCursor visits every run once");
  assert.deepEqual(all.map((x) => x.status), ["succeeded", "no_match", "succeeded", "no_match", "succeeded"]);
  const noMatch = await teamRuns(api, w.admin.token, w.team.id, "status=no_match");
  assert.deepEqual(noMatch.map((x) => x.cardId), [cards[1].id, cards[3].id]);
  const succeeded = await teamRuns(api, w.admin.token, w.team.id, "status=succeeded");
  assert.deepEqual(succeeded.map((x) => x.ruleId), [r.id, r.id, r.id, other.id]);
  assert.deepEqual(await teamRuns(api, w.admin.token, w.team.id, "status=skipped"), []);
  for (const q of ["status=done", "status=", "limit=0", "limit=101", "cursor=bogus"]) {
    assertError(await api.call("GET", `/teams/${w.team.id}/rule-runs?${q}`, undefined, w.admin.token), 400, "invalid_query", q);
  }
  assertError(await api.call("GET", `/rules/${r.id}/runs?limit=x`, undefined, w.admin.token), 400, "invalid_query");
});

test("rules and their runs are persisted: after a restart the runs are listed and the rule keeps running", async (t) => {
  const clock = new Clock();
  const dataFile = join(tempDir(t), "tracker.json");
  const api1 = await startApp(t, { now: clock.now, dataFile, ...TEAM });
  const w = await setupBoard(api1, clock);
  const r = await rule(api1, w, { trigger: ON_CREATE, actions: [{ type: "add_label", label: "auto" }] });
  await createCard(api1, w.cols[0], w.member, { title: "before" });
  const before = await runsOf(api1, w, r.id);
  await api1.close();
  const api2 = await startApp(t, { now: clock.now, dataFile, ...TEAM });
  assert.deepEqual(await runsOf(api2, w, r.id), before);
  assert.deepEqual(await ok(api2, 200, "GET", `/rules/${r.id}`, undefined, w.admin.token), r);
  const card = await createCard(api2, w.cols[0], w.member, { title: "after" });
  assert.deepEqual(card.labels, ["auto"]);
  assert.equal((await runsOf(api2, w, r.id)).length, 2);
});

test("deleting a column a rule references (trigger, condition or action) disables the rule without changing it; re-enabling it is 400", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, ...TEAM });
  const w = await setupBoard(api, clock);
  const x = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "X" }, w.owner.token);
  const byTrigger = await rule(api, w, { trigger: { event: "card.moved", toColumnId: x.id }, actions: [{ type: "set_priority", priority: "high" }] });
  const byCondition = await rule(api, w, { trigger: ON_CREATE, conditions: [{ field: "columnId", op: "ne", value: x.id }], actions: [{ type: "set_priority", priority: "high" }] });
  const byAction = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "move_to_column", columnId: x.id }] });
  const unrelated = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "move_to_column", columnId: w.cols[1] }] });
  clock.advance(60_000);
  await ok(api, 204, "DELETE", `/columns/${x.id}`, undefined, w.owner.token);
  for (const r of [byTrigger, byCondition, byAction]) {
    const now = await ok(api, 200, "GET", `/rules/${r.id}`, undefined, w.admin.token);
    assert.equal(now.enabled, false, r.name);
    assert.deepEqual([now.trigger, now.conditions, now.actions, now.updatedAt], [r.trigger, r.conditions, r.actions, r.updatedAt], "a cascade changes nothing else");
  }
  assert.equal((await ok(api, 200, "GET", `/rules/${unrelated.id}`, undefined, w.admin.token)).enabled, true);
  assertError(await api.call("PATCH", `/rules/${byAction.id}`, { enabled: true }, w.admin.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/rules/${byTrigger.id}`, { enabled: true, name: "again" }, w.admin.token), 400, "invalid_body");
  await createCard(api, w.cols[0], w.member, { title: "c" });
  for (const r of [byTrigger, byCondition, byAction]) assert.deepEqual(await runsOf(api, w, r.id), [], "a disabled rule never runs");
});

test("deleting a referenced field, project or board (with its columns) disables the rules that reference it", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const f = await mkField(api, w.project.id, w.owner, { name: "F", type: "text" });
  const byCond = await rule(api, w, { trigger: ON_CREATE, conditions: [{ field: `customFields.${f.id}`, op: "is_set" }], actions: [{ type: "set_priority", priority: "high" }] });
  const bySet = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_field", fieldId: f.id, value: "v" }] });
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  const byProject = await rule(api, w, { trigger: { event: "card.created", projectId: ops.id }, actions: [{ type: "set_priority", priority: "high" }] });
  const byOpsColumn = await rule(api, w, { trigger: ON_CREATE, conditions: [{ field: "columnId", op: "eq", value: opsBoard.columns[1].id }], actions: [{ type: "set_priority", priority: "high" }] });
  const board2 = await createBoard(api, w.project.id, w.owner, { name: "Second" });
  const byBoard = await rule(api, w, { trigger: { event: "card.moved", toColumnId: board2.columns[2].id }, actions: [{ type: "set_priority", priority: "high" }] });
  const keep = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "low" }] });
  const enabled = async (r: any) => (await ok(api, 200, "GET", `/rules/${r.id}`, undefined, w.admin.token)).enabled;
  await ok(api, 204, "DELETE", `/fields/${f.id}`, undefined, w.owner.token);
  assert.deepEqual([await enabled(byCond), await enabled(bySet), await enabled(byProject)], [false, false, true]);
  await ok(api, 204, "DELETE", `/projects/${ops.id}`, undefined, w.owner.token);
  assert.deepEqual([await enabled(byProject), await enabled(byOpsColumn), await enabled(byBoard)], [false, false, true]);
  await ok(api, 204, "DELETE", `/boards/${board2.id}`, undefined, w.owner.token);
  assert.deepEqual([await enabled(byBoard), await enabled(keep)], [false, true]);
});

test("deleting a team label disables the rules that use its name; merging rewrites their label values and leaves them enabled", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const bug = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "bug" }, w.owner.token);
  const old = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "old" }, w.owner.token);
  const neu = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "new" }, w.owner.token);
  const usesBug = await rule(api, w, { trigger: ON_CREATE, conditions: [{ field: "labels", op: "contains", value: "bug" }], actions: [{ type: "set_priority", priority: "high" }] });
  const addsBug = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "add_label", label: "bug" }] });
  const usesOld = await rule(api, w, {
    trigger: ON_CREATE,
    conditions: [{ field: "labels", op: "not_contains", value: "old" }],
    actions: [{ type: "add_label", label: "old" }, { type: "remove_label", label: "bug" }],
  });
  await ok(api, 204, "DELETE", `/labels/${bug.id}`, undefined, w.owner.token);
  for (const r of [usesBug, addsBug]) {
    const now = await ok(api, 200, "GET", `/rules/${r.id}`, undefined, w.admin.token);
    assert.deepEqual([now.enabled, now.conditions, now.actions], [false, r.conditions, r.actions], r.name);
  }
  const before = await ok(api, 200, "GET", `/rules/${usesOld.id}`, undefined, w.admin.token);
  assert.equal(before.enabled, false, "it also uses the deleted name bug");
  await ok(api, 200, "PATCH", `/rules/${usesOld.id}`, { actions: [{ type: "add_label", label: "old" }], enabled: true }, w.admin.token);
  await ok(api, 200, "POST", `/labels/${old.id}/merge`, { intoLabelId: neu.id }, w.owner.token);
  const merged = await ok(api, 200, "GET", `/rules/${usesOld.id}`, undefined, w.admin.token);
  assert.deepEqual([merged.enabled, merged.conditions, merged.actions], [true, [{ field: "labels", op: "not_contains", value: "new" }], [{ type: "add_label", label: "new" }]]);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.deepEqual(card.labels, ["new"]);
});

test("a disabled rule can be re-enabled with a PATCH that also replaces the missing reference", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const x = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "X" }, w.owner.token);
  const r = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "move_to_column", columnId: x.id }] });
  await ok(api, 204, "DELETE", `/columns/${x.id}`, undefined, w.owner.token);
  assertError(await api.call("PATCH", `/rules/${r.id}`, { actions: [{ type: "move_to_column", columnId: x.id }], enabled: true }, w.admin.token), 400, "invalid_body", "the deleted column");
  const fixed = await ok(api, 200, "PATCH", `/rules/${r.id}`, { actions: [{ type: "move_to_column", columnId: w.cols[1] }], enabled: true }, w.admin.token);
  assert.equal(fixed.enabled, true);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.equal(card.columnId, w.cols[1]);
  const off = await ok(api, 200, "PATCH", `/rules/${r.id}`, { enabled: false }, w.admin.token);
  assert.equal(off.enabled, false);
  assert.equal((await ok(api, 200, "PATCH", `/rules/${r.id}`, { enabled: true }, w.admin.token)).enabled, true, "references intact");
});

test("rule actions skip the rate limit and idempotency: the caller's budget moves by one per request, and a replay runs no rule", async (t) => {
  const api = await startApp(t, { ...TEAM, rateLimit: { limit: 1000, windowMs: 60_000 } });
  const w = await setupBoard(api);
  const r = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "set_priority", priority: "high" }, { type: "add_label", label: "x" }, { type: "add_comment", body: "auto" }] });
  const first = await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "c" }, w.member.token, { idem: "card-1" });
  assertStatus(first, 201);
  assert.equal(first.headers.get("x-ratelimit-remaining"), "999");
  const again = await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "c" }, w.member.token, { idem: "card-1" });
  assert.equal(again.headers.get("x-ratelimit-remaining"), "998");
  assert.equal(again.headers.get("idempotency-replayed"), "true");
  assert.equal(again.text, first.text);
  assert.equal((await runsOf(api, w, r.id)).length, 1);
  assert.equal((await ok(api, 200, "GET", `/cards/${first.body.id}/comments`, undefined, w.member.token)).items.length, 1);
});

test("a rule acts only on its own team's events, and other teams' members cannot see its runs", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const other = await setupTeam(api);
  const otherProject = await createProject(api, other.team.id, other.owner, "OTH");
  const otherBoard = await createBoard(api, otherProject.id, other.owner);
  const r = await rule(api, w, { trigger: ON_CREATE, actions: [{ type: "add_label", label: "mine" }] });
  const theirs = await createCard(api, otherBoard.columns[0].id, other.member, { title: "theirs" });
  assert.deepEqual(theirs.labels, []);
  assert.deepEqual(await runsOf(api, w, r.id), []);
  for (const path of [`/rules/${r.id}/runs`, `/teams/${w.team.id}/rule-runs`, `/rules/${r.id}`]) {
    assertError(await api.call("GET", path, undefined, other.owner.token), 404, "not_found", path);
  }
  assertError(await api.call("POST", `/rules/${r.id}/test`, { cardId: theirs.id }, other.owner.token), 404, "not_found");
});

test("an add_comment rule on comment.created answers each person's comment once and never its own", async (t) => {
  const api = await startApp(t, TEAM);
  const w = await setupBoard(api);
  const r = await rule(api, w, { trigger: { event: "comment.created" }, actions: [{ type: "add_comment", body: "thanks" }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await comment(api, card.id, w.member, "first");
  await comment(api, card.id, w.owner, "second");
  const list = await ok(api, 200, "GET", `/cards/${card.id}/comments`, undefined, w.member.token);
  assert.deepEqual(list.items.map((c: any) => [c.body, c.authorId]), [
    ["first", w.member.id],
    ["thanks", w.admin.id],
    ["second", w.owner.id],
    ["thanks", w.admin.id],
  ]);
  assert.deepEqual((await runsOf(api, w, r.id)).map((x) => x.depth), [0, 0]);
});
