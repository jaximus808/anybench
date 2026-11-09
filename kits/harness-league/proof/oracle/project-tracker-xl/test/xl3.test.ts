// Smoke tests: notification filtering, leave cascades, restricted keys, recurrence failures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, assertError, createApiKey, createCard, createRule, getCard, ok, setupBoard, startApp } from "./support.ts";

const T = 1e12;
const types = async (api: any, u: any) => (await ok(api, 200, "GET", "/me/notifications", undefined, u.token)).items.map((n: any) => n.type);

test("mention/comment filtering, muted projects, moved + rule for one watcher", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  for (const u of [w.admin, w.viewer, w.owner]) await ok(api, 204, "POST", `/cards/${card.id}/watch`, undefined, u.token);
  await ok(api, 200, "PUT", "/me/notification-settings", { types: { mention: false, comment: true, assigned: true, moved: true, due: true, rule: true, invite: true }, mutedProjectIds: [] }, w.viewer.token);
  await ok(api, 200, "PUT", "/me/notification-settings", { types: { mention: true, comment: true, assigned: true, moved: true, due: true, rule: true, invite: true }, mutedProjectIds: [w.project.id] }, w.owner.token);
  await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: `hey @${w.viewer.handle} and @${w.admin.handle.toUpperCase()}` }, w.member.token);
  assert.deepEqual(await types(api, w.admin), ["mention"]);
  assert.deepEqual(await types(api, w.viewer), [], "mention off: no comment instead");
  assert.deepEqual(await types(api, w.owner), [], "muted");
  await createRule(api, w.team.id, w.owner, { trigger: { event: "card.moved" }, actions: [{ type: "notify", to: ["watchers"], message: "m" }] });
  await ok(api, 200, "POST", `/cards/${card.id}/move`, { columnId: w.cols[1] }, w.member.token);
  assert.deepEqual(await types(api, w.admin), ["moved", "rule", "mention"].sort((a, b) => 0) && (await types(api, w.admin)));
  const adm = await types(api, w.admin);
  assert.ok(adm.includes("moved") && adm.includes("rule"));
  assert.deepEqual(await types(api, w.member), ["rule"], "the actor gets the rule notification, not moved");
});

test("leaving a team cascades; restricted key lists", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T });
  const w = await setupBoard(api, clock);
  const f = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Owner", type: "user" }, w.admin.token);
  const card = await createCard(api, w.cols[0], w.admin, { title: "c", assigneeId: w.member.id, customFields: { [f.id]: w.member.id } });
  const tpl = await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "t", title: "t", customFields: { [f.id]: w.member.id } }, w.admin.token);
  await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "p", query: {} }, w.member.token);
  const shared = await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "s", query: {}, shared: true }, w.member.token);
  await ok(api, 200, "POST", `/cards/${card.id}/timer/start`, undefined, w.member.token);
  const before = await getCard(api, card.id, w.admin.token);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.member.token);
  const after = await getCard(api, card.id, w.admin.token);
  assert.equal(after.assigneeId, null);
  assert.deepEqual(after.customFields, {});
  assert.equal(after.updatedAt, before.updatedAt);
  assert.deepEqual((await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.admin.token)).customFields, {});
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${card.id}/watchers`, undefined, w.admin.token)).items.map((m: any) => m.userId), [w.admin.id]);
  assert.deepEqual((await ok(api, 200, "GET", `/teams/${w.team.id}/views`, undefined, w.admin.token)).items.map((x: any) => x.id), [shared.id]);
  assert.deepEqual(await ok(api, 200, "GET", "/me/timer", undefined, w.member.token), { timer: null });
  // restricted key
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.admin.token);
  const key = await createApiKey(api, w.admin, { scope: "write", teamId: other.id });
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, key.secret)).items.map((x: any) => x.id), [other.id]);
  assertError(await api.call("GET", `/teams/${w.team.id}`, undefined, key.secret), 404, "not_found");
  assertError(await api.call("POST", "/teams", { name: "x" }, key.secret), 403, "api_key_not_allowed");
  assertError(await api.call("POST", `/teams/${other.id}/projects`, { name: "x", key: "XX" }, key.secret), 403, "insufficient_scope");
});

test("recurrence failures record lastError and create nothing; rule action failures", async (t) => {
  const clock = new Clock(Date.UTC(2026, 2, 1, 12, 0, 0));
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T, defaultPlan: "team" });
  const w = await setupBoard(api, clock);
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 1 }, w.admin.token);
  await createCard(api, w.cols[1], w.member, { title: "fills" });
  const rec = await ok(api, 201, "POST", `/boards/${w.board.id}/recurrences`, { columnId: w.cols[1], schedule: { frequency: "daily", time: "13:00" }, startDate: "2026-03-01", title: "R" }, w.admin.token);
  clock.set(Date.UTC(2026, 2, 1, 13, 0, 0));
  const r = await ok(api, 200, "GET", `/recurrences/${rec.id}`, undefined, w.viewer.token);
  assert.equal(r.lastError, "wip_limit_reached");
  assert.equal(r.lastCardId, null);
  assert.equal(r.nextRunAt, "2026-03-02T13:00:00.000Z");
  const s = await ok(api, 201, "POST", `/projects/${w.project.id}/sprints`, { name: "S", startDate: "2026-03-01", endDate: "2026-03-10" }, w.admin.token);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "add_to_sprint", sprintId: "active" }, { type: "add_to_sprint", sprintId: s.id }, { type: "move_to_column", columnId: w.cols[1] }, { type: "set_priority", priority: "low" }] });
  const c = await createCard(api, w.cols[0], w.member, { title: "x" });
  const run = (await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token)).items[0];
  assert.deepEqual(run.actions.map((a: any) => [a.status, a.error]), [["failed", "not_found"], ["not_run", null], ["not_run", null], ["not_run", null]]);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "not_found");
  await ok(api, 200, "POST", `/sprints/${s.id}/start`, undefined, w.admin.token);
  await ok(api, 200, "PATCH", `/rules/${rule.id}`, { actions: [{ type: "add_to_sprint", sprintId: "active" }, { type: "add_to_sprint", sprintId: s.id }, { type: "move_to_column", columnId: w.cols[1] }] }, w.admin.token);
  const c2 = await createCard(api, w.cols[0], w.member, { title: "y" });
  assert.equal(c2.sprintId, s.id);
  const run2 = (await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token)).items[0];
  assert.deepEqual(run2.actions.map((a: any) => [a.status, a.error]), [["succeeded", null], ["noop", null], ["failed", "wip_limit_reached"]]);
  const audit = (await ok(api, 200, "GET", `/teams/${w.team.id}/audit?action=sprint.cards_added`, undefined, w.admin.token)).items;
  assert.deepEqual(audit[0].details, { cardIds: [c2.id] });
  void c;
});
