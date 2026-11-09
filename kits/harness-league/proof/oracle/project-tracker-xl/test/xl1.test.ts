// Smoke tests for the second-half sections (reference self-check).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Clock, DAY, addDays, assertError, assertStatus, createCard, createRule, eventLog, getCard, ok, setupBoard, startApp, startOf, upload, signUp,
} from "./support.ts";

const T = 1e12;

test("pipeline: rule adds a label, response shows it, event snapshot does not; runs, audit, activity", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T });
  const w = await setupBoard(api, clock);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "add_label", label: " Auto " }, { type: "set_priority", priority: "high" }] });
  assert.deepEqual(rule.trigger, { event: "card.created", projectId: null, toColumnId: null, fields: null });
  assert.deepEqual(rule.actions, [{ type: "add_label", label: "auto" }, { type: "set_priority", priority: "high" }]);
  const card = await createCard(api, w.cols[0], w.member, { title: "x" });
  assert.deepEqual(card.labels, ["auto"]);
  assert.equal(card.priority, "high");
  const names = await log.names();
  assert.deepEqual(names, ["card.created", "card.updated", "card.updated"]);
  const evs = await log.events(3);
  assert.deepEqual(evs[0].data.card.labels, []);
  assert.equal(evs[1].via.type, "rule");
  assert.equal(evs[1].actorId, w.admin.id);
  assert.deepEqual(evs[1].data.fields, ["labels"]);
  const runs = await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token);
  assert.equal(runs.items.length, 1);
  assert.equal(runs.items[0].status, "succeeded");
  assert.deepEqual(runs.items[0].actions, [{ type: "add_label", status: "succeeded", error: null }, { type: "set_priority", status: "succeeded", error: null }]);
  assert.equal(evs[1].via.runId, runs.items[0].id);
  const act = await ok(api, 200, "GET", `/cards/${card.id}/activity`, undefined, w.viewer.token);
  assert.deepEqual(act.items.map((a: any) => a.event), ["card.updated", "card.updated", "card.created"]);
  // no self trigger, other rule reacts, maxDepth
  await createRule(api, w.team.id, w.admin, { trigger: { event: "card.updated", fields: ["priority"] }, actions: [{ type: "add_comment", body: "bumped {{key}} by {{user}} @" + w.member.handle }] });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "y" });
  const comments = await ok(api, 200, "GET", `/cards/${c2.id}/comments`, undefined, w.viewer.token);
  assert.equal(comments.items.length, 1);
  assert.equal(comments.items[0].body, `bumped ENG-2 by ${w.admin.handle} @${w.member.handle}`);
  assert.deepEqual(comments.items[0].mentions, [w.member.id]);
  assert.equal(comments.items[0].authorId, w.admin.id);
  const notes = await ok(api, 200, "GET", "/me/notifications", undefined, w.member.token);
  assert.ok(notes.items.some((n: any) => n.type === "mention" && n.cardId === c2.id));
  const watchers = await ok(api, 200, "GET", `/cards/${c2.id}/watchers`, undefined, w.member.token);
  assert.deepEqual(watchers.items.map((m: any) => m.userId), [w.member.id, w.admin.id]);
});

test("rules: maxDepth 0, skipped runs, auto-disable, test route, notify", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T, automation: { maxDepth: 1 }, defaultPlan: "team" });
  const w = await setupBoard(api, clock);
  const r1 = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "move_to_column", columnId: w.cols[1] }] });
  const r2 = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.moved", toColumnId: w.cols[1] }, actions: [{ type: "notify", to: ["creator", "assignee", w.owner.id], message: "moved {{key}}" }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "m", assigneeId: w.member.id });
  assert.equal(card.columnId, w.cols[1]);
  // depth 1 event (card.moved by the rule) is not processed with maxDepth 1
  assert.equal((await ok(api, 200, "GET", `/rules/${r2.id}/runs`, undefined, w.admin.token)).items.length, 0);
  // member's move triggers r2 at depth 0
  await ok(api, 200, "POST", `/cards/${card.id}/move`, { columnId: w.cols[0] }, w.member.token);
  await ok(api, 200, "POST", `/cards/${card.id}/move`, { columnId: w.cols[1] }, w.member.token);
  const runs = (await ok(api, 200, "GET", `/rules/${r2.id}/runs`, undefined, w.admin.token)).items;
  assert.equal(runs.length, 1);
  const n = (await ok(api, 200, "GET", "/me/notifications", undefined, w.owner.token)).items;
  assert.equal(n[0].type, "rule");
  assert.equal(n[0].message, "moved ENG-1");
  const mn = (await ok(api, 200, "GET", "/me/notifications", undefined, w.member.token)).items;
  assert.equal(mn.filter((x: any) => x.type === "rule").length, 1);
  // test route
  const r3 = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, conditions: [{ field: "title", op: "contains", value: "M" }, { field: "points", op: "gt", value: 1 }], actions: [{ type: "archive_card" }] });
  const tr = await ok(api, 200, "POST", `/rules/${r3.id}/test`, { cardId: card.id }, w.admin.token);
  assert.deepEqual(tr, { matched: false, conditions: [true, false] });
  // delete the column: r1 and r2 get disabled
  await ok(api, 204, "DELETE", `/columns/${w.cols[1]}?moveTo=${w.cols[0]}`, undefined, w.admin.token);
  const rules = (await ok(api, 200, "GET", `/teams/${w.team.id}/rules`, undefined, w.viewer.token)).items;
  assert.deepEqual(rules.map((r: any) => r.enabled), [false, false, true]);
  assertError(await api.call("PATCH", `/rules/${r1.id}`, { enabled: true }, w.admin.token), 400, "invalid_body");
  // demoted creator: skipped forbidden
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.admin.id}`, { role: "member" }, w.owner.token);
  const c3 = await createCard(api, w.cols[0], w.member, { title: "zz" });
  const rr = (await ok(api, 200, "GET", `/rules/${r3.id}/runs`, undefined, w.owner.token)).items;
  assert.equal(rr[0].status, "skipped");
  assert.equal(rr[0].error, "forbidden");
  assert.equal(rr[0].cardId, c3.id);
  const filtered = await ok(api, 200, "GET", `/teams/${w.team.id}/rule-runs?status=skipped`, undefined, w.owner.token);
  assert.equal(filtered.items.length, 1);
  assertError(await api.call("GET", `/teams/${w.team.id}/rule-runs?status=x`, undefined, w.owner.token), 400, "invalid_query");
});

test("scheduler: recurrences, trash purge with retention 0, due job notifications", async (t) => {
  const clock = new Clock(Date.UTC(2026, 2, 2, 8, 0, 0)); // Monday
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T, trash: { retentionMs: 0 } });
  const w = await setupBoard(api, clock);
  const rec = await ok(api, 201, "POST", `/boards/${w.board.id}/recurrences`, {
    columnId: w.cols[0], schedule: { frequency: "weekly", interval: 2, time: "09:30", weekdays: [3, 1] }, startDate: "2026-03-02", title: "R {{date}} #{{number}} {{project}} {{user}}", assigneeId: w.member.id,
  }, w.admin.token);
  assert.deepEqual(rec.schedule, { frequency: "weekly", interval: 2, time: "09:30", weekdays: [1, 3], dayOfMonth: null });
  assert.equal(rec.nextRunAt, "2026-03-02T09:30:00.000Z");
  const occ = await ok(api, 200, "GET", `/recurrences/${rec.id}/occurrences?count=4`, undefined, w.viewer.token);
  assert.deepEqual(occ.items, ["2026-03-02T09:30:00.000Z", "2026-03-04T09:30:00.000Z", "2026-03-16T09:30:00.000Z", "2026-03-18T09:30:00.000Z"]);
  clock.set(Date.UTC(2026, 2, 10, 0, 0, 0));
  const after = await ok(api, 200, "GET", `/recurrences/${rec.id}`, undefined, w.viewer.token);
  assert.equal(after.lastError, null);
  assert.equal(after.nextRunAt, "2026-03-16T09:30:00.000Z");
  const made = await getCard(api, after.lastCardId, w.viewer.token);
  assert.equal(made.title, `R 2026-03-10 #1 ENG ${w.admin.handle}`);
  assert.equal(made.createdBy, w.admin.id);
  assert.equal(made.assigneeId, w.member.id);
  assert.equal(after.updatedAt, rec.updatedAt);
  // monthly on the 31st
  const m = await ok(api, 201, "POST", `/boards/${w.board.id}/recurrences`, {
    columnId: w.cols[0], schedule: { frequency: "monthly", time: "00:00", dayOfMonth: 31 }, startDate: "2026-01-31", endDate: "2026-06-30", title: "M",
  }, w.admin.token);
  const mo = await ok(api, 200, "GET", `/recurrences/${m.id}/occurrences?count=10`, undefined, w.viewer.token);
  assert.deepEqual(mo.items, ["2026-03-31T00:00:00.000Z", "2026-04-30T00:00:00.000Z", "2026-05-31T00:00:00.000Z", "2026-06-30T00:00:00.000Z"]);
  assertError(await api.call("POST", `/boards/${w.board.id}/recurrences`, { columnId: w.cols[0], schedule: { frequency: "daily", time: "00:00" }, startDate: "2026-01-31", title: "M" }, w.admin.token), 409, "quota_exceeded");
  // archive + purge on next request
  const log = await eventLog(t, api, w.team.id, w.admin);
  await ok(api, 200, "POST", `/cards/${made.id}/archive`, undefined, w.member.token);
  const trash = await ok(api, 200, "GET", `/projects/${w.project.id}/trash`, undefined, w.viewer.token);
  assert.equal(trash.items.length, 0, "purged at the start of this request");
  assertError(await api.call("GET", `/cards/${made.id}`, undefined, w.viewer.token), 404, "not_found");
  assert.deepEqual(await log.names(), ["card.archived", "card.deleted"]);
  const evs = await log.events(2);
  assert.deepEqual(evs[1].via, { type: "schedule" });
  assert.equal(evs[1].actorId, null);
  const audit = (await ok(api, 200, "GET", `/teams/${w.team.id}/audit?action=card.purged`, undefined, w.admin.token)).items;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorId, null);
});

test("due job notifies assignee then watchers; settings and mutes", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "d", dueDate: addDays(clock.today(), 1), assigneeId: w.admin.id });
  await ok(api, 204, "POST", `/cards/${card.id}/watch`, undefined, w.viewer.token);
  await ok(api, 200, "PUT", "/me/notification-settings", { types: { mention: true, comment: true, assigned: true, moved: true, due: false, rule: true, invite: true }, mutedProjectIds: [] }, w.viewer.token);
  clock.set(startOf(addDays(clock.today(), 1)));
  await ok(api, 200, "GET", "/health");
  const a = (await ok(api, 200, "GET", "/me/notifications", undefined, w.admin.token)).items;
  assert.deepEqual(a.map((n: any) => n.type), ["due", "assigned"]);
  const m = (await ok(api, 200, "GET", "/me/notifications", undefined, w.member.token)).items;
  assert.deepEqual(m.map((n: any) => n.type), ["due"], "the creator watches");
  const v = (await ok(api, 200, "GET", "/me/notifications", undefined, w.viewer.token)).items;
  assert.deepEqual(v, []);
  assert.deepEqual(await ok(api, 200, "GET", "/me/notifications/unread-count", undefined, w.admin.token), { count: 2 });
  const r = await ok(api, 200, "POST", `/me/notifications/${a[0].id}/read`, undefined, w.admin.token);
  assert.equal(r.read, true);
  assert.equal((await ok(api, 200, "GET", "/me/notifications?unread=true", undefined, w.admin.token)).items.length, 1);
  assert.deepEqual(await ok(api, 200, "POST", "/me/notifications/read-all", {}, w.admin.token), { updated: 1 });
  assertError(await api.call("POST", `/me/notifications/${a[0].id}/read`, undefined, w.member.token), 404, "not_found");
});

test("templates, checklists, checklist.completed", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T });
  const w = await setupBoard(api, clock);
  const f = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Team", type: "select", options: ["a", "b"], required: true }, w.admin.token);
  const tpl = await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "Bug", title: "Bug {{number}} on {{date}}", labels: ["Bug"], customFields: { [f.id]: "a" }, checklist: [" one ", "two"] }, w.admin.token);
  assert.deepEqual(tpl.checklist, ["one", "two"]);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const card = await ok(api, 201, "POST", `/templates/${tpl.id}/cards`, { columnId: w.cols[0] }, w.member.token);
  assert.equal(card.title, `Bug 1 on ${clock.today()}`);
  assert.deepEqual(card.checklist, { total: 2, done: 0 });
  assert.deepEqual(card.customFields, { [f.id]: "a" });
  const items = (await ok(api, 200, "GET", `/cards/${card.id}/checklist`, undefined, w.viewer.token)).items;
  await ok(api, 200, "PATCH", `/checklist/${items[0].id}`, { done: true }, w.member.token);
  const it2 = await ok(api, 200, "PATCH", `/checklist/${items[1].id}`, { done: true, position: 0 }, w.member.token);
  assert.equal(it2.doneBy, w.member.id);
  assert.equal(it2.position, 0);
  assert.deepEqual(await log.names(), ["card.created", "checklist.completed"]);
  await ok(api, 201, "POST", `/cards/${card.id}/checklist`, { text: "three" }, w.member.token);
  const all = (await ok(api, 200, "GET", `/cards/${card.id}/checklist`, undefined, w.viewer.token)).items;
  await ok(api, 204, "DELETE", `/checklist/${all[2].id}`, undefined, w.member.token);
  assert.deepEqual(await log.names(), ["card.created", "checklist.completed", "checklist.completed"]);
  await ok(api, 201, "POST", `/boards/${w.board.id}/recurrences`, { columnId: w.cols[0], schedule: { frequency: "daily", time: "00:00" }, startDate: "2027-01-01", templateId: tpl.id }, w.admin.token);
  assertError(await api.call("DELETE", `/templates/${tpl.id}`, undefined, w.admin.token), 409, "template_in_use");
});
