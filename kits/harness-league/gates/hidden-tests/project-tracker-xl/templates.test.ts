// Area `templates`: instruction.md section 20 (Card templates), with the conventions of section 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertDetails,
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
} from "./helpers.ts";
import { assertKeys, instantiate, mkField, mkRecurrence, mkTemplate, startApp, watcherIds } from "./helpers-pipeline.ts";

const TEMPLATE_KEYS = ["id", "projectId", "name", "title", "description", "labels", "priority", "points", "customFields", "checklist", "createdBy", "createdAt", "updatedAt"];

test("a template has the documented shape and the card defaults; name and title are trimmed, checklist entries trimmed in order", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  clock.advance(5000);
  const tpl = await mkTemplate(api, w.project.id, w.admin, { name: "  Bug report  ", title: "  Bug: ...  " });
  assertKeys(tpl, TEMPLATE_KEYS, "template");
  assert.equal(tpl.projectId, w.project.id);
  assert.equal(tpl.name, "Bug report");
  assert.equal(tpl.title, "Bug: ...");
  assert.deepEqual([tpl.description, tpl.labels, tpl.priority, tpl.points, tpl.customFields, tpl.checklist], ["", [], "none", null, {}, []]);
  assert.equal(tpl.createdBy, w.admin.id);
  assert.equal(tpl.createdAt, clock.iso());
  assert.equal(tpl.updatedAt, tpl.createdAt);
  const full = await mkTemplate(api, w.project.id, w.owner, {
    description: "steps",
    labels: [" Bug ", "ui", "bug"],
    priority: "high",
    points: 5,
    checklist: [" reproduce ", "fix", "fix"],
  });
  assert.deepEqual([full.labels, full.priority, full.points, full.checklist], [["bug", "ui"], "high", 5, ["reproduce", "fix", "fix"]]);
  assert.deepEqual(await ok(api, 200, "GET", `/templates/${full.id}`, undefined, w.viewer.token), full);
  const list = await ok(api, 200, "GET", `/projects/${w.project.id}/templates`, undefined, w.viewer.token);
  assert.deepEqual(list.items.map((x: any) => x.id), [tpl.id, full.id], "oldest first");
});

test("template validation follows the card rules: name 1 to 100, title 1 to 200, labels, priority, points, and a checklist of at most 50 entries of 1 to 200 chars", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const path = `/projects/${w.project.id}/templates`;
  const good = { name: "T", title: "Title" };
  const bad: [string, Record<string, unknown>][] = [
    ["no name", { title: "Title" }],
    ["blank name", { ...good, name: "  " }],
    ["long name", { ...good, name: "n".repeat(101) }],
    ["no title", { name: "T" }],
    ["long title", { ...good, title: "t".repeat(201) }],
    ["description", { ...good, description: "d".repeat(10001) }],
    ["labels", { ...good, labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }],
    ["empty label", { ...good, labels: [" "] }],
    ["priority", { ...good, priority: "critical" }],
    ["points", { ...good, points: 4 }],
    ["checklist type", { ...good, checklist: "a" }],
    ["checklist too long", { ...good, checklist: Array.from({ length: 51 }, () => "x") }],
    ["checklist blank entry", { ...good, checklist: ["ok", "  "] }],
    ["checklist long entry", { ...good, checklist: ["c".repeat(201)] }],
    ["checklist non-string", { ...good, checklist: [1] }],
    ["customFields type", { ...good, customFields: [] }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", path, body, w.owner.token), 400, "invalid_body", what);
  const ok50 = await mkTemplate(api, w.project.id, w.owner, { name: "n".repeat(100), title: "t".repeat(200), checklist: Array.from({ length: 50 }, () => "c".repeat(200)) });
  assert.equal(ok50.checklist.length, 50);
  assert.equal((await ok(api, 200, "GET", path, undefined, w.owner.token)).items.length, 1);
});

test("template customFields must be valid values of the project's fields: null is invalid_body, a bad value or unknown key invalid_field_value; required fields are not checked", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const sev = await mkField(api, w.project.id, w.owner, { name: "Severity", type: "select", options: ["low", "high"], required: true });
  const est = await mkField(api, w.project.id, w.owner, { name: "Estimate", type: "number" });
  const other = await createProject(api, w.team.id, w.owner, "OPS");
  const foreign = await mkField(api, other.id, w.owner, { name: "Foreign", type: "text" });
  const path = `/projects/${w.project.id}/templates`;
  assertError(await api.call("POST", path, { name: "T", title: "T", customFields: { [est.id]: null } }, w.owner.token), 400, "invalid_body", "null value");
  assertDetails(await api.call("POST", path, { name: "T", title: "T", customFields: { [est.id]: 3, [sev.id]: "medium" } }, w.owner.token), 400, "invalid_field_value", { fieldId: sev.id });
  assertDetails(await api.call("POST", path, { name: "T", title: "T", customFields: { [foreign.id]: "x" } }, w.owner.token), 400, "invalid_field_value", { fieldId: foreign.id });
  const tpl = await mkTemplate(api, w.project.id, w.owner, { customFields: { [est.id]: 8 } });
  assert.deepEqual(tpl.customFields, { [est.id]: 8 }, "the required Severity may be missing on a template");
});

test("PATCH validates only the given fields, replaces customFields as a whole, moves updatedAt, and needs an updatable field", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const a = await mkField(api, w.project.id, w.owner, { name: "A", type: "text" });
  const b = await mkField(api, w.project.id, w.owner, { name: "B", type: "checkbox" });
  const tpl = await mkTemplate(api, w.project.id, w.owner, { customFields: { [a.id]: "x", [b.id]: true }, labels: ["one"] });
  clock.advance(60_000);
  const p = await ok(api, 200, "PATCH", `/templates/${tpl.id}`, { customFields: { [b.id]: false }, title: " New title " }, w.admin.token);
  assert.deepEqual(p.customFields, { [b.id]: false });
  assert.equal(p.title, "New title");
  assert.deepEqual(p.labels, ["one"]);
  assert.equal(p.updatedAt, clock.iso());
  assert.equal(p.createdBy, w.owner.id, "createdBy never changes");
  assertError(await api.call("PATCH", `/templates/${tpl.id}`, {}, w.admin.token), 400, "invalid_body", "empty PATCH");
  assertError(await api.call("PATCH", `/templates/${tpl.id}`, { points: 7 }, w.admin.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/templates/${tpl.id}`, { checklist: [""] }, w.admin.token), 400, "invalid_body");
  assertDetails(await api.call("PATCH", `/templates/${tpl.id}`, { customFields: { [b.id]: "yes" } }, w.admin.token), 400, "invalid_field_value", { fieldId: b.id });
  assert.deepEqual((await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.owner.token)).customFields, { [b.id]: false });
});

test("template definitions are admin+; members instantiate, viewers get 403 on both; non-members get 404", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const tpl = await mkTemplate(api, w.project.id, w.owner);
  for (const u of [w.member, w.viewer]) {
    assertError(await api.call("POST", `/projects/${w.project.id}/templates`, { name: "T", title: "T" }, u.token), 403, "forbidden");
    assertError(await api.call("PATCH", `/templates/${tpl.id}`, { name: "x" }, u.token), 403, "forbidden");
    assertError(await api.call("DELETE", `/templates/${tpl.id}`, undefined, u.token), 403, "forbidden");
  }
  assertError(await instantiate(api, tpl.id, w.viewer.token, { columnId: w.cols[0] }), 403, "forbidden");
  assertStatus(await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0] }), 201);
  await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.viewer.token);
  assertError(await api.call("GET", `/templates/${tpl.id}`, undefined, w.outsider.token), 404, "not_found");
  assertError(await instantiate(api, tpl.id, w.outsider.token, { columnId: w.cols[0] }), 404, "not_found");
  assertError(await api.call("GET", `/projects/${w.project.id}/templates`, undefined, w.outsider.token), 404, "not_found");
  assertError(await instantiate(api, "no-such-template", w.member.token, { columnId: w.cols[0] }), 404, "not_found");
});

test("instantiating makes a card with the template's content, sprintId null, one open checklist item per entry, the caller as creator and watcher", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const sev = await mkField(api, w.project.id, w.owner, { name: "Severity", type: "select", options: ["low", "high"] });
  const tpl = await mkTemplate(api, w.project.id, w.owner, {
    title: "Bug",
    description: "Steps",
    labels: ["bug", "triage"],
    priority: "urgent",
    points: 3,
    customFields: { [sev.id]: "high" },
    checklist: ["reproduce", "fix"],
  });
  await createCard(api, w.cols[1], w.member, { title: "existing" });
  clock.advance(1000);
  const res = await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[1], assigneeId: w.admin.id, dueDate: "2026-04-01", position: 0 });
  assertStatus(res, 201);
  const card = res.body;
  assert.deepEqual(
    [card.title, card.description, card.labels, card.priority, card.points, card.customFields, card.sprintId, card.assigneeId, card.dueDate, card.position, card.columnId],
    ["Bug", "Steps", ["bug", "triage"], "urgent", 3, { [sev.id]: "high" }, null, w.admin.id, "2026-04-01", 0, w.cols[1]],
  );
  assert.equal(card.createdBy, w.member.id);
  assert.equal(card.number, 2);
  assert.equal(card.key, "ENG-2");
  assert.deepEqual(card.checklist, { total: 2, done: 0 });
  const list = await ok(api, 200, "GET", `/cards/${card.id}/checklist`, undefined, w.member.token);
  assert.deepEqual(list.items.map((i: any) => [i.text, i.done, i.position]), [["reproduce", false, 0], ["fix", false, 1]]);
  assert.deepEqual(await watcherIds(api, w.member.token, card.id), [w.member.id, w.admin.id], "the caller, then the assignee");
  assert.equal((await getCard(api, card.id, w.member.token)).id, card.id);
});

test("placeholders {{date}}, {{user}}, {{number}} and {{project}} are replaced everywhere in title and description; anything else is kept", async (t) => {
  const clock = new Clock(Date.UTC(2026, 4, 17, 15, 30));
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  await createCard(api, w.cols[0], w.member, { title: "one" });
  const tpl = await mkTemplate(api, w.project.id, w.owner, {
    title: "{{project}}-{{number}} by {{user}} on {{date}}",
    description: "{{date}} {{date}} {{ date }} {{DATE}} {{key}} {{unknown}} {date} {{user}}",
  });
  const card = (await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0] })).body;
  assert.equal(card.title, `ENG-2 by ${w.member.handle} on 2026-05-17`);
  assert.equal(card.description, `2026-05-17 2026-05-17 {{ date }} {{DATE}} {{key}} {{unknown}} {date} ${w.member.handle}`);
  const tpl2 = await mkTemplate(api, w.project.id, w.owner, { title: "unused" });
  const over = (await instantiate(api, tpl2.id, w.admin.token, { columnId: w.cols[0], title: "  Override {{number}} for {{user}}  " })).body;
  assert.equal(over.title, `Override 3 for ${w.admin.handle}`, "a given title replaces the template's, placeholders replaced too");
});

test("after replacement the title is trimmed and cut to 200 chars and the description cut to 10000", async (t) => {
  const clock = new Clock(Date.UTC(2026, 4, 17, 15, 30));
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const tpl = await mkTemplate(api, w.project.id, w.owner, { title: "{{date}}".repeat(25), description: "{{date}}".repeat(1250) });
  assert.equal(tpl.title.length, 200, "the stored template keeps the placeholders");
  const card = (await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0] })).body;
  assert.equal(card.title, "2026-05-17".repeat(20));
  assert.equal(card.description, "2026-05-17".repeat(1000));
  assertError(await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0], title: "x".repeat(201) }), 400, "invalid_body", "a given title follows the card title rules");
  assertError(await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0], title: "   " }), 400, "invalid_body");
});

test("instantiate validation: columnId must be a column of the template's project; assigneeId, dueDate and position follow the card rules", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const second = await createBoard(api, w.project.id, w.owner, { name: "Second" });
  const other = await createProject(api, w.team.id, w.owner, "OPS");
  const otherBoard = await createBoard(api, other.id, w.owner);
  const tpl = await mkTemplate(api, w.project.id, w.owner);
  for (const [what, body] of [
    ["missing columnId", {}],
    ["unknown column", { columnId: "no-such-column" }],
    ["another project's column", { columnId: otherBoard.columns[0].id }],
    ["bad dueDate", { columnId: w.cols[0], dueDate: "2026-02-30" }],
    ["bad position", { columnId: w.cols[0], position: 1 }],
    ["bad assignee type", { columnId: w.cols[0], assigneeId: 7 }],
  ] as [string, Record<string, unknown>][]) {
    assertError(await instantiate(api, tpl.id, w.member.token, body), 400, "invalid_body", what);
  }
  assertError(await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0], assigneeId: w.viewer.id }), 400, "invalid_assignee");
  assertError(await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0], assigneeId: w.viewer.id, dueDate: "x" }), 400, "invalid_body", "invalid_body before invalid_assignee");
  const res = await instantiate(api, tpl.id, w.member.token, { columnId: second.columns[2].id });
  assertStatus(res, 201, "any board of the project");
  assert.equal(res.body.boardId, second.id);
  assert.equal(res.body.completedAt !== null, true, "created in a done column");
});

test("instantiate checks required fields after taking the template's values: 400 field_required names the first missing field", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await mkField(api, w.project.id, w.owner, { name: "A", type: "text", required: true });
  const b = await mkField(api, w.project.id, w.owner, { name: "B", type: "number", required: true });
  const missingBoth = await mkTemplate(api, w.project.id, w.owner);
  const missingB = await mkTemplate(api, w.project.id, w.owner, { customFields: { [a.id]: "x" } });
  const full = await mkTemplate(api, w.project.id, w.owner, { customFields: { [a.id]: "x", [b.id]: 2 } });
  assertDetails(await instantiate(api, missingBoth.id, w.member.token, { columnId: w.cols[0] }), 400, "field_required", { fieldId: a.id });
  assertDetails(await instantiate(api, missingB.id, w.member.token, { columnId: w.cols[0] }), 400, "field_required", { fieldId: b.id });
  assertError(await instantiate(api, missingB.id, w.member.token, { columnId: w.cols[0], assigneeId: w.viewer.id }), 400, "invalid_assignee", "invalid_assignee before field_required");
  const card = (await instantiate(api, full.id, w.member.token, { columnId: w.cols[0] })).body;
  assert.deepEqual(card.customFields, { [a.id]: "x", [b.id]: 2 });
  assert.deepEqual(await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token).then((r) => r.items.map((c: any) => c.id)), [card.id]);
});

test("instantiate respects the cards quota and the WIP limit, quota first, and a 409 creates nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const tpl = await mkTemplate(api, w.project.id, w.owner, { checklist: ["a"] });
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 1 }, w.owner.token);
  await createCard(api, w.cols[1], w.member, { title: "fills the WIP limit" });
  assertError(await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[1] }), 409, "wip_limit_reached");
  for (let i = 1; i < 100; i++) await createCard(api, w.cols[0], w.member, { title: `c${i}` });
  assertQuota(await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[1] }), "cards", 100, 100, "quota before wip_limit_reached");
  assertQuota(await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0] }), "cards", 100, 100);
  const plan = await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.owner.token);
  assert.equal(plan.usage.cards, 100);
});

test("instantiating is one change: one card.created event and one card.created audit entry, no checklist entries", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const tpl = await mkTemplate(api, w.project.id, w.owner, { checklist: ["a", "b"], labels: ["x"] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(1000);
  const card = (await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0] })).body;
  assert.deepEqual(await log.names(), ["card.created"]);
  const [ev] = await log.events(1);
  assert.equal(ev.actorId, w.member.id);
  assert.equal(ev.via, null);
  assert.equal(ev.data.card.id, card.id);
  assert.deepEqual(ev.data.card.labels, ["x"]);
  assert.deepEqual(ev.data.card.checklist, { total: 2, done: 0 });
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.details, e.at]), [["card.created", "card", card.id, w.member.id, {}, clock.iso()]]);
});

test("a template used by a recurrence cannot be deleted (409 template_in_use) until the recurrence is gone; template writes are audited", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  const tpl = await mkTemplate(api, w.project.id, w.owner);
  await ok(api, 200, "PATCH", `/templates/${tpl.id}`, { priority: "low", name: "Renamed" }, w.owner.token);
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], templateId: tpl.id });
  assertError(await api.call("DELETE", `/templates/${tpl.id}`, undefined, w.admin.token), 409, "template_in_use");
  await ok(api, 204, "DELETE", `/recurrences/${rec.id}`, undefined, w.owner.token);
  assertStatus(await api.call("DELETE", `/templates/${tpl.id}`, undefined, w.admin.token), 204);
  assertError(await api.call("GET", `/templates/${tpl.id}`, undefined, w.admin.token), 404, "not_found");
  const entries = (await auditLog(api, w.owner.token, w.team.id)).slice(base).filter((e) => e.targetType === "template");
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetId, e.actorId, e.details]),
    [
      ["template.created", tpl.id, w.owner.id, {}],
      ["template.updated", tpl.id, w.owner.id, { fields: ["name", "priority"] }],
      ["template.deleted", tpl.id, w.admin.id, {}],
    ],
  );
});

test("an archived project answers 409 project_archived on template writes and instantiation, before template_in_use; reads still work", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const tpl = await mkTemplate(api, w.project.id, w.owner);
  await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], templateId: tpl.id });
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", `/projects/${w.project.id}/templates`, { name: "T", title: "T" }, w.owner.token), 409, "project_archived");
  assertError(await api.call("PATCH", `/templates/${tpl.id}`, { name: "x" }, w.owner.token), 409, "project_archived");
  assertError(await api.call("DELETE", `/templates/${tpl.id}`, undefined, w.owner.token), 409, "project_archived", "before template_in_use");
  assertError(await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0] }), 409, "project_archived");
  assertError(await instantiate(api, tpl.id, w.member.token, {}), 400, "invalid_body", "validation comes before project_archived");
  await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.viewer.token);
  await ok(api, 200, "GET", `/projects/${w.project.id}/templates`, undefined, w.viewer.token);
});

test("rules run on an instantiated card: the response carries a rule's label while the card.created snapshot does not; a replayed instantiate creates one card", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "add_label", label: "from-rule" }] });
  const tpl = await mkTemplate(api, w.project.id, w.owner, { labels: ["tpl"] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const first = await api.call("POST", `/templates/${tpl.id}/cards`, { columnId: w.cols[0] }, w.member.token, { idem: "tpl-1" });
  assertStatus(first, 201);
  assert.deepEqual(first.body.labels, ["from-rule", "tpl"]);
  const [created] = await log.events(1);
  assert.deepEqual(created.data.card.labels, ["tpl"]);
  const again = await api.call("POST", `/templates/${tpl.id}/cards`, { columnId: w.cols[0] }, w.member.token, { idem: "tpl-1" });
  assert.equal(again.status, 201);
  assert.equal(again.text, first.text);
  assert.equal(again.headers.get("idempotency-replayed"), "true");
  assert.equal((await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token)).items.length, 1);
  assert.deepEqual(await log.names(), ["card.created", "card.updated"]);
});
