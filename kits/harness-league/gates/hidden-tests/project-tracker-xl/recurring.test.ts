// Area `recurring`: instruction.md section 21 (Recurring cards), with the scheduler of section 0.9
// and the pipeline of section 0.8. The default clock starts on Sunday 2026-03-01T12:00:00Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  type Api,
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
  ok,
  setupBoard,
  tempDir,
} from "./helpers.ts";
import { assertKeys, DAILY, mkField, mkRecurrence, mkTemplate, notifications, ruleRuns, startApp, watcherIds } from "./helpers-pipeline.ts";

const at = (iso: string): number => Date.parse(iso);
const getRec = (api: Api, id: string, token: string): Promise<any> => ok(api, 200, "GET", `/recurrences/${id}`, undefined, token);
const occurrences = async (api: Api, id: string, token: string, count?: number): Promise<string[]> =>
  (await ok(api, 200, "GET", `/recurrences/${id}/occurrences${count === undefined ? "" : `?count=${count}`}`, undefined, token)).items;
const boardCards = async (api: Api, boardId: string, token: string): Promise<any[]> => (await ok(api, 200, "GET", `/boards/${boardId}/cards`, undefined, token)).items;
const health = (api: Api): Promise<unknown> => ok(api, 200, "GET", "/health");

const REC_KEYS = [
  "id", "boardId", "columnId", "templateId", "title", "description", "labels", "assigneeId", "priority", "points", "schedule", "startDate",
  "endDate", "active", "nextRunAt", "lastRunAt", "lastCardId", "lastError", "createdBy", "createdAt", "updatedAt",
];

test("a recurrence has the documented shape: card defaults, a five-key schedule, nextRunAt the first occurrence, run fields null", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  clock.advance(5000);
  const rec = await mkRecurrence(api, w.board.id, w.admin, { columnId: w.cols[1], title: "  Standup  " });
  assertKeys(rec, REC_KEYS, "recurrence");
  assert.deepEqual(
    [rec.boardId, rec.columnId, rec.templateId, rec.title, rec.description, rec.labels, rec.assigneeId, rec.priority, rec.points],
    [w.board.id, w.cols[1], null, "Standup", "", [], null, "none", null],
  );
  assert.deepEqual(rec.schedule, { frequency: "daily", interval: 1, time: "09:00", weekdays: null, dayOfMonth: null });
  assert.deepEqual([rec.startDate, rec.endDate, rec.active], ["2026-03-02", null, true]);
  assert.equal(rec.nextRunAt, "2026-03-02T09:00:00.000Z");
  assert.deepEqual([rec.lastRunAt, rec.lastCardId, rec.lastError], [null, null, null]);
  assert.equal(rec.createdBy, w.admin.id);
  assert.equal(rec.createdAt, clock.iso());
  assert.equal(rec.updatedAt, rec.createdAt);
  assert.deepEqual(await getRec(api, rec.id, w.viewer.token), rec);
  const second = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], labels: ["B", "a"], priority: "high", points: 8, description: "d" });
  assert.deepEqual([second.labels, second.priority, second.points, second.description], [["a", "b"], "high", 8, "d"]);
  const list = await ok(api, 200, "GET", `/boards/${w.board.id}/recurrences`, undefined, w.viewer.token);
  assert.deepEqual(list.items.map((r: any) => r.id), [rec.id, second.id], "oldest first");
});

test("exactly one of templateId and title: both or neither is invalid_body; with a template the content fields are forbidden and stored null", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const tpl = await mkTemplate(api, w.project.id, w.owner);
  const other = await createProject(api, w.team.id, w.owner, "OPS");
  const foreignTpl = await mkTemplate(api, other.id, w.owner);
  const path = `/boards/${w.board.id}/recurrences`;
  const base = { columnId: w.cols[0], schedule: DAILY, startDate: "2026-03-02" };
  const bad: [string, Record<string, unknown>][] = [
    ["neither", base],
    ["both", { ...base, title: "T", templateId: tpl.id }],
    ["template with description", { ...base, templateId: tpl.id, description: "d" }],
    ["template with labels", { ...base, templateId: tpl.id, labels: [] }],
    ["template with priority", { ...base, templateId: tpl.id, priority: "low" }],
    ["template with points", { ...base, templateId: tpl.id, points: 1 }],
    ["another project's template", { ...base, templateId: foreignTpl.id }],
    ["unknown template", { ...base, templateId: "no-such-template" }],
    ["blank title", { ...base, title: "  " }],
    ["long title", { ...base, title: "x".repeat(201) }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", path, body, w.owner.token), 400, "invalid_body", what);
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], templateId: tpl.id });
  assert.deepEqual([rec.templateId, rec.title, rec.description, rec.labels, rec.priority, rec.points], [tpl.id, null, null, null, null, null]);
});

test("schedule validation: frequency, interval 1 to 365, HH:MM time, weekdays only and required for weekly, dayOfMonth only and required for monthly", async (t) => {
  const api = await startApp(t, { defaultPlan: "business" });
  const w = await setupBoard(api);
  const path = `/boards/${w.board.id}/recurrences`;
  const post = (schedule: unknown) => api.call("POST", path, { columnId: w.cols[0], schedule, startDate: "2026-03-02", title: "T" }, w.owner.token);
  const bad: unknown[] = [
    undefined,
    "daily",
    { frequency: "hourly", time: "09:00" },
    { frequency: "daily" },
    { frequency: "daily", time: "9:00" },
    { frequency: "daily", time: "24:00" },
    { frequency: "daily", time: "12:60" },
    { frequency: "daily", time: "09:00", interval: 0 },
    { frequency: "daily", time: "09:00", interval: 366 },
    { frequency: "daily", time: "09:00", interval: 1.5 },
    { frequency: "daily", time: "09:00", weekdays: [1] },
    { frequency: "daily", time: "09:00", dayOfMonth: 1 },
    { frequency: "weekly", time: "09:00" },
    { frequency: "weekly", time: "09:00", weekdays: [] },
    { frequency: "weekly", time: "09:00", weekdays: [1, 1] },
    { frequency: "weekly", time: "09:00", weekdays: [7] },
    { frequency: "weekly", time: "09:00", weekdays: [1], dayOfMonth: 3 },
    { frequency: "monthly", time: "09:00" },
    { frequency: "monthly", time: "09:00", dayOfMonth: 0 },
    { frequency: "monthly", time: "09:00", dayOfMonth: 32 },
    { frequency: "monthly", time: "09:00", dayOfMonth: 5, weekdays: [1] },
  ];
  for (const s of bad) assertError(await post(s), 400, "invalid_body", JSON.stringify(s));
  const weekly = await post({ frequency: "weekly", time: "00:00", weekdays: [6, 0, 3], interval: 365 });
  assertStatus(weekly, 201);
  assert.deepEqual(weekly.body.schedule, { frequency: "weekly", interval: 365, time: "00:00", weekdays: [0, 3, 6], dayOfMonth: null });
  const monthly = await post({ frequency: "monthly", time: "23:59", dayOfMonth: 31 });
  assertStatus(monthly, 201);
  assert.deepEqual(monthly.body.schedule, { frequency: "monthly", interval: 1, time: "23:59", weekdays: null, dayOfMonth: 31 });
});

test("dates, column and assignee validation: endDate >= startDate, a column of this board, a member+ assignee checked after invalid_body", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const otherBoard = await createBoard(api, w.project.id, w.owner, { name: "Other" });
  const path = `/boards/${w.board.id}/recurrences`;
  const base = { columnId: w.cols[0], schedule: DAILY, startDate: "2026-03-02", title: "T" };
  const bad: [string, Record<string, unknown>][] = [
    ["no startDate", { ...base, startDate: undefined }],
    ["bad startDate", { ...base, startDate: "2026-02-29" }],
    ["endDate before startDate", { ...base, endDate: "2026-03-01" }],
    ["bad endDate", { ...base, endDate: "03/05/2026" }],
    ["another board's column", { ...base, columnId: otherBoard.columns[0].id }],
    ["no column", { ...base, columnId: undefined }],
    ["active not boolean", { ...base, active: "yes" }],
    ["assignee type", { ...base, assigneeId: 5 }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", path, body, w.owner.token), 400, "invalid_body", what);
  assertError(await api.call("POST", path, { ...base, assigneeId: w.viewer.id }, w.owner.token), 400, "invalid_assignee");
  assertError(await api.call("POST", path, { ...base, assigneeId: w.outsider.id }, w.owner.token), 400, "invalid_assignee");
  assertError(await api.call("POST", path, { ...base, assigneeId: w.viewer.id, endDate: "2026-01-01" }, w.owner.token), 400, "invalid_body", "invalid_body first");
  const same = await mkRecurrence(api, w.board.id, w.owner, { ...base, endDate: "2026-03-02", assigneeId: w.member.id });
  assert.deepEqual([same.endDate, same.assigneeId], ["2026-03-02", w.member.id]);
});

test("the recurrences quota counts inactive recurrences: the third on the free plan is 409 quota_exceeded after validation", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await createBoard(api, w.project.id, w.owner, { name: "Other" });
  await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], active: false });
  await mkRecurrence(api, other.id, w.owner, { columnId: other.columns[0].id });
  assertQuota(await api.call("POST", `/boards/${w.board.id}/recurrences`, { columnId: w.cols[0], schedule: DAILY, startDate: "2026-03-02", title: "T" }, w.owner.token), "recurrences", 2, 2);
  assertError(await api.call("POST", `/boards/${w.board.id}/recurrences`, { columnId: w.cols[0], schedule: DAILY, startDate: "2026-03-02" }, w.owner.token), 400, "invalid_body", "validation before the quota");
  const plan = await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.viewer.token);
  assert.equal(plan.usage.recurrences, 2);
});

test("recurrence definitions are admin+; viewers read recurrences and occurrences; non-members get 404", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0] });
  for (const u of [w.member, w.viewer]) {
    assertError(await api.call("POST", `/boards/${w.board.id}/recurrences`, { columnId: w.cols[0], schedule: DAILY, startDate: "2026-03-02", title: "T" }, u.token), 403, "forbidden");
    assertError(await api.call("PATCH", `/recurrences/${rec.id}`, { title: "x" }, u.token), 403, "forbidden");
    assertError(await api.call("DELETE", `/recurrences/${rec.id}`, undefined, u.token), 403, "forbidden");
  }
  await ok(api, 200, "GET", `/boards/${w.board.id}/recurrences`, undefined, w.viewer.token);
  assert.equal((await occurrences(api, rec.id, w.viewer.token)).length, 5);
  for (const path of [`/recurrences/${rec.id}`, `/recurrences/${rec.id}/occurrences`, `/boards/${w.board.id}/recurrences`]) {
    assertError(await api.call("GET", path, undefined, w.outsider.token), 404, "not_found", path);
  }
  assertError(await api.call("PATCH", `/recurrences/${rec.id}`, { title: "x" }, w.outsider.token), 404, "not_found");
  assertError(await api.call("GET", `/recurrences/no-such-recurrence`, undefined, w.owner.token), 404, "not_found");
});

test("daily occurrences are startDate plus k * interval days at the schedule's time; the default count is 5", async (t) => {
  const api = await startApp(t, { now: new Clock().now });
  const w = await setupBoard(api);
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], schedule: { frequency: "daily", interval: 3, time: "09:30" }, startDate: "2026-03-05" });
  assert.deepEqual(await occurrences(api, rec.id, w.owner.token), [
    "2026-03-05T09:30:00.000Z",
    "2026-03-08T09:30:00.000Z",
    "2026-03-11T09:30:00.000Z",
    "2026-03-14T09:30:00.000Z",
    "2026-03-17T09:30:00.000Z",
  ]);
  assert.deepEqual(await occurrences(api, rec.id, w.owner.token, 2), ["2026-03-05T09:30:00.000Z", "2026-03-08T09:30:00.000Z"]);
  assert.equal(rec.nextRunAt, "2026-03-05T09:30:00.000Z");
});

test("only instants later than now count: a series that started in the past continues on its own interval, and an instant equal to now is skipped", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api);
  const later = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], schedule: { frequency: "daily", time: "13:00" }, startDate: "2026-02-20" });
  assert.equal(later.nextRunAt, "2026-03-01T13:00:00.000Z");
  const equal = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], schedule: { frequency: "daily", time: "12:00" }, startDate: "2026-02-20" });
  assert.equal(equal.nextRunAt, "2026-03-02T12:00:00.000Z", "12:00 on the 1st is now, not later than now");
  await ok(api, 204, "DELETE", `/recurrences/${equal.id}`, undefined, w.owner.token);
  const every2 = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], schedule: { frequency: "daily", interval: 2, time: "13:00" }, startDate: "2026-02-20" });
  assert.equal(every2.nextRunAt, "2026-03-02T13:00:00.000Z", "Feb 20 + 2k days: Feb 28, then Mar 2");
  assert.deepEqual(await occurrences(api, every2.id, w.owner.token, 3), ["2026-03-02T13:00:00.000Z", "2026-03-04T13:00:00.000Z", "2026-03-06T13:00:00.000Z"]);
});

test("weekly occurrences count whole weeks from the Monday on or before startDate, so Sunday ends its week", async (t) => {
  const api = await startApp(t, { now: new Clock().now, defaultPlan: "team" });
  const w = await setupBoard(api);
  const sunMon = await mkRecurrence(api, w.board.id, w.owner, {
    columnId: w.cols[0],
    schedule: { frequency: "weekly", interval: 2, time: "08:00", weekdays: [1, 0] },
    startDate: "2026-03-02",
  });
  assert.deepEqual(sunMon.schedule.weekdays, [0, 1]);
  assert.deepEqual(await occurrences(api, sunMon.id, w.owner.token), [
    "2026-03-02T08:00:00.000Z",
    "2026-03-08T08:00:00.000Z",
    "2026-03-16T08:00:00.000Z",
    "2026-03-22T08:00:00.000Z",
    "2026-03-30T08:00:00.000Z",
  ]);
  const midweek = await mkRecurrence(api, w.board.id, w.owner, {
    columnId: w.cols[0],
    schedule: { frequency: "weekly", interval: 2, time: "17:45", weekdays: [5, 1, 3] },
    startDate: "2026-03-04",
  });
  assert.deepEqual(await occurrences(api, midweek.id, w.owner.token, 6), [
    "2026-03-04T17:45:00.000Z",
    "2026-03-06T17:45:00.000Z",
    "2026-03-16T17:45:00.000Z",
    "2026-03-18T17:45:00.000Z",
    "2026-03-20T17:45:00.000Z",
    "2026-03-30T17:45:00.000Z",
  ]);
  assert.equal(midweek.nextRunAt, "2026-03-04T17:45:00.000Z", "Monday Mar 2 is before startDate");
});

test("monthly occurrences step interval months, clamp dayOfMonth to the month's last day, and skip a first date before startDate", async (t) => {
  const api = await startApp(t, { now: new Clock().now, defaultPlan: "team" });
  const w = await setupBoard(api);
  const end = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], schedule: { frequency: "monthly", time: "10:00", dayOfMonth: 31 }, startDate: "2026-03-31" });
  assert.deepEqual(await occurrences(api, end.id, w.owner.token), [
    "2026-03-31T10:00:00.000Z",
    "2026-04-30T10:00:00.000Z",
    "2026-05-31T10:00:00.000Z",
    "2026-06-30T10:00:00.000Z",
    "2026-07-31T10:00:00.000Z",
  ]);
  const skip = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], schedule: { frequency: "monthly", time: "10:00", dayOfMonth: 10 }, startDate: "2026-03-15" });
  assert.deepEqual(await occurrences(api, skip.id, w.owner.token, 2), ["2026-04-10T10:00:00.000Z", "2026-05-10T10:00:00.000Z"]);
  const leap = await mkRecurrence(api, w.board.id, w.owner, {
    columnId: w.cols[0],
    schedule: { frequency: "monthly", interval: 2, time: "06:15", dayOfMonth: 30 },
    startDate: "2027-12-31",
  });
  assert.deepEqual(await occurrences(api, leap.id, w.owner.token), [
    "2028-02-29T06:15:00.000Z",
    "2028-04-30T06:15:00.000Z",
    "2028-06-30T06:15:00.000Z",
    "2028-08-30T06:15:00.000Z",
    "2028-10-30T06:15:00.000Z",
  ]);
  assert.equal(leap.nextRunAt, "2028-02-29T06:15:00.000Z");
});

test("endDate is inclusive and ends the series: fewer occurrences, nextRunAt null once finished; count must be an integer 1 to 50", async (t) => {
  const api = await startApp(t, { now: new Clock().now });
  const w = await setupBoard(api);
  const short = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], startDate: "2026-03-02", endDate: "2026-03-04" });
  assert.deepEqual(await occurrences(api, short.id, w.owner.token, 10), ["2026-03-02T09:00:00.000Z", "2026-03-03T09:00:00.000Z", "2026-03-04T09:00:00.000Z"]);
  const done = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], startDate: "2026-02-01", endDate: "2026-02-10" });
  assert.equal(done.nextRunAt, null);
  assert.deepEqual(await occurrences(api, done.id, w.owner.token), []);
  for (const count of ["0", "51", "1.5", "", "x", "-1"]) {
    assertError(await api.call("GET", `/recurrences/${short.id}/occurrences?count=${count}`, undefined, w.owner.token), 400, "invalid_query", `count=${count}`);
  }
  assert.equal((await occurrences(api, short.id, w.owner.token, 50)).length, 3);
});

test("an inactive recurrence has nextRunAt null, still lists occurrences, and never runs; activating it computes nextRunAt from now", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], active: false });
  assert.equal(rec.nextRunAt, null);
  assert.deepEqual((await occurrences(api, rec.id, w.owner.token, 1)), ["2026-03-02T09:00:00.000Z"]);
  clock.set(at("2026-03-04T10:00:00.000Z"));
  await health(api);
  assert.deepEqual(await boardCards(api, w.board.id, w.owner.token), []);
  const on = await ok(api, 200, "PATCH", `/recurrences/${rec.id}`, { active: true }, w.owner.token);
  assert.equal(on.nextRunAt, "2026-03-05T09:00:00.000Z");
  assert.equal(on.updatedAt, clock.iso());
  assert.equal(on.lastRunAt, null, "activating is not a run");
  const off = await ok(api, 200, "PATCH", `/recurrences/${rec.id}`, { active: false }, w.owner.token);
  assert.equal(off.nextRunAt, null);
  clock.set(at("2026-03-06T10:00:00.000Z"));
  await health(api);
  assert.deepEqual(await boardCards(api, w.board.id, w.owner.token), []);
});

test("PATCH replaces the schedule, recomputes nextRunAt, validates the date pair after the change, and refuses templateId and content on a template recurrence", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const otherBoard = await createBoard(api, w.project.id, w.owner, { name: "Other" });
  const rec = await mkRecurrence(api, w.board.id, w.owner, {
    columnId: w.cols[0],
    schedule: { frequency: "weekly", time: "09:00", weekdays: [3] },
    startDate: "2026-03-02",
    endDate: "2026-06-01",
  });
  assert.equal(rec.nextRunAt, "2026-03-04T09:00:00.000Z");
  clock.advance(1000);
  const p = await ok(api, 200, "PATCH", `/recurrences/${rec.id}`, { schedule: { frequency: "daily", time: "07:00", interval: 2 }, startDate: "2026-03-03" }, w.admin.token);
  assert.deepEqual(p.schedule, { frequency: "daily", interval: 2, time: "07:00", weekdays: null, dayOfMonth: null });
  assert.equal(p.nextRunAt, "2026-03-03T07:00:00.000Z");
  assert.equal(p.updatedAt, clock.iso());
  assert.equal(p.createdBy, w.owner.id);
  assertError(await api.call("PATCH", `/recurrences/${rec.id}`, { startDate: "2026-07-01" }, w.admin.token), 400, "invalid_body", "the pair after the change");
  assertError(await api.call("PATCH", `/recurrences/${rec.id}`, {}, w.admin.token), 400, "invalid_body", "empty PATCH");
  assertError(await api.call("PATCH", `/recurrences/${rec.id}`, { columnId: otherBoard.columns[0].id }, w.admin.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/recurrences/${rec.id}`, { templateId: null }, w.admin.token), 400, "invalid_body", "templateId never changes");
  assertError(await api.call("PATCH", `/recurrences/${rec.id}`, { assigneeId: w.viewer.id }, w.admin.token), 400, "invalid_assignee");
  const tpl = await mkTemplate(api, w.project.id, w.owner);
  const fromTpl = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], templateId: tpl.id });
  for (const body of [{ title: "x" }, { description: "x" }, { labels: [] }, { priority: "low" }, { points: 1 }]) {
    assertError(await api.call("PATCH", `/recurrences/${fromTpl.id}`, body, w.admin.token), 400, "invalid_body", JSON.stringify(body));
  }
  const ended = await ok(api, 200, "PATCH", `/recurrences/${rec.id}`, { endDate: null }, w.admin.token);
  assert.equal(ended.endDate, null);
});

test("when nextRunAt has come, the next request runs the recurrence: one card at the end of its column as the creator, and the run fields update", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  await createCard(api, w.cols[1], w.member, { title: "existing" });
  const rec = await mkRecurrence(api, w.board.id, w.admin, {
    columnId: w.cols[1],
    title: "Standup",
    description: "notes",
    labels: ["daily"],
    priority: "low",
    points: 1,
    assigneeId: w.member.id,
  });
  clock.set(at("2026-03-02T08:59:59.999Z"));
  await health(api);
  assert.equal((await boardCards(api, w.board.id, w.owner.token)).length, 1, "not yet due");
  clock.set(at("2026-03-02T09:00:00.000Z"));
  await health(api);
  const cards = await boardCards(api, w.board.id, w.owner.token);
  assert.equal(cards.length, 2);
  const card = cards[1];
  assert.deepEqual(
    [card.title, card.description, card.labels, card.priority, card.points, card.assigneeId, card.dueDate, card.sprintId, card.columnId, card.position],
    ["Standup", "notes", ["daily"], "low", 1, w.member.id, null, null, w.cols[1], 1],
  );
  assert.equal(card.createdBy, w.admin.id);
  assert.equal(card.createdAt, "2026-03-02T09:00:00.000Z");
  const after = await getRec(api, rec.id, w.owner.token);
  assert.deepEqual([after.lastRunAt, after.lastCardId, after.lastError, after.nextRunAt], ["2026-03-02T09:00:00.000Z", card.id, null, "2026-03-03T09:00:00.000Z"]);
  assert.equal(after.updatedAt, rec.updatedAt, "runs never change updatedAt");
});

test("after missed occurrences a run still creates exactly one card, and nextRunAt is the first occurrence later than now", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0] });
  clock.set(at("2026-03-06T10:00:00.000Z"));
  await health(api);
  await health(api);
  assert.equal((await boardCards(api, w.board.id, w.owner.token)).length, 1);
  const after = await getRec(api, rec.id, w.owner.token);
  assert.equal(after.lastRunAt, "2026-03-06T10:00:00.000Z");
  assert.equal(after.nextRunAt, "2026-03-07T09:00:00.000Z");
  clock.set(at("2026-03-07T09:00:00.000Z"));
  await health(api);
  const cards = await boardCards(api, w.board.id, w.owner.token);
  assert.deepEqual(cards.map((c) => c.number), [1, 2]);
  assert.equal((await getRec(api, rec.id, w.owner.token)).lastCardId, cards[1].id);
});

test("the scheduler runs before every request, also ones answered 401 or 404, and nothing runs between requests", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0] });
  clock.set(at("2026-03-02T09:30:00.000Z"));
  assertError(await api.call("GET", "/teams"), 401, "unauthorized");
  clock.set(at("2026-03-03T09:30:00.000Z"));
  assertError(await api.call("GET", "/no/such/route"), 404, "not_found");
  clock.set(at("2026-03-04T09:30:00.000Z"));
  assertError(await api.call("GET", "/teams", undefined, "not-a-token"), 401, "unauthorized");
  const cards = await boardCards(api, w.board.id, w.owner.token);
  assert.deepEqual(cards.map((c) => c.createdAt), ["2026-03-02T09:30:00.000Z", "2026-03-03T09:30:00.000Z", "2026-03-04T09:30:00.000Z"]);
});

test("the request that arrives after the due instant already sees the new card, and pending jobs survive a restart", async (t) => {
  const clock = new Clock();
  const dataFile = join(tempDir(t), "tracker.json");
  const api1 = await startApp(t, { now: clock.now, dataFile });
  const w = await setupBoard(api1, clock);
  const rec = await mkRecurrence(api1, w.board.id, w.owner, { columnId: w.cols[0] });
  await api1.close();
  clock.set(at("2026-03-02T09:00:00.000Z"));
  const api2 = await startApp(t, { now: clock.now, dataFile });
  const first = await ok(api2, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.owner.token);
  assert.equal(first.items.length, 1, "the first request after the restart runs the due job before it is answered");
  assert.equal(first.items[0].createdAt, "2026-03-02T09:00:00.000Z");
  assert.equal((await getRec(api2, rec.id, w.owner.token)).nextRunAt, "2026-03-03T09:00:00.000Z");
});

test("placeholders in a recurrence's title and description are replaced at run time: today, the creator's handle, the number and the project key", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  await createCard(api, w.cols[0], w.member, { title: "one" });
  await mkRecurrence(api, w.board.id, w.admin, {
    columnId: w.cols[0],
    title: "{{project}}-{{number}} {{date}}",
    description: "by {{user}} on {{date}}, {{key}} stays",
  });
  clock.set(at("2026-03-03T15:00:00.000Z"));
  await health(api);
  const card = (await boardCards(api, w.board.id, w.owner.token))[1];
  assert.equal(card.title, "ENG-2 2026-03-03");
  assert.equal(card.description, `by ${w.admin.handle} on 2026-03-03, {{key}} stays`);
});

test("a template recurrence takes the template's content at run time, with its checklist and values", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const f = await mkField(api, w.project.id, w.owner, { name: "Kind", type: "text", required: true });
  const tpl = await mkTemplate(api, w.project.id, w.owner, { title: "Old", checklist: ["a"], customFields: { [f.id]: "chore" } });
  await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], templateId: tpl.id });
  await ok(api, 200, "PATCH", `/templates/${tpl.id}`, { title: "Weekly review {{date}}", labels: ["ops"], checklist: ["collect", "review"], priority: "medium" }, w.owner.token);
  clock.set(at("2026-03-02T09:00:00.000Z"));
  await health(api);
  const [card] = await boardCards(api, w.board.id, w.owner.token);
  assert.deepEqual([card.title, card.labels, card.priority, card.customFields], ["Weekly review 2026-03-02", ["ops"], "medium", { [f.id]: "chore" }]);
  assert.deepEqual(card.checklist, { total: 2, done: 0 });
  const items = await ok(api, 200, "GET", `/cards/${card.id}/checklist`, undefined, w.owner.token);
  assert.deepEqual(items.items.map((i: any) => i.text), ["collect", "review"]);
});

test("a run fails with forbidden when the creator is no longer member+, before project_archived; a failed run keeps lastCardId and still moves on", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const rec = await mkRecurrence(api, w.board.id, w.admin, { columnId: w.cols[0] });
  clock.set(at("2026-03-02T09:00:00.000Z"));
  await health(api);
  const firstCard = (await getRec(api, rec.id, w.owner.token)).lastCardId;
  assert.equal(typeof firstCard, "string");
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.admin.id}`, { role: "viewer" }, w.owner.token);
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  clock.set(at("2026-03-03T09:00:00.000Z"));
  await health(api);
  let r = await getRec(api, rec.id, w.owner.token);
  assert.deepEqual([r.lastError, r.lastRunAt, r.lastCardId, r.nextRunAt], ["forbidden", "2026-03-03T09:00:00.000Z", firstCard, "2026-03-04T09:00:00.000Z"]);
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.admin.id}`, { role: "member" }, w.owner.token);
  clock.set(at("2026-03-04T09:00:00.000Z"));
  await health(api);
  r = await getRec(api, rec.id, w.owner.token);
  assert.deepEqual([r.lastError, r.lastCardId], ["project_archived", firstCard], "a member creator may run it again; the project is archived");
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: false }, w.owner.token);
  clock.set(at("2026-03-05T09:00:00.000Z"));
  await health(api);
  r = await getRec(api, rec.id, w.owner.token);
  assert.equal(r.lastError, null);
  assert.notEqual(r.lastCardId, firstCard);
  assert.equal((await boardCards(api, w.board.id, w.owner.token)).length, 2);
});

test("a run fails with quota_exceeded before wip_limit_reached, and creates nothing", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[1] });
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 1 }, w.owner.token);
  const last = await createCard(api, w.cols[1], w.member, { title: "fills the limit" });
  for (let i = 1; i < 100; i++) await createCard(api, w.cols[0], w.member, { title: `c${i}` });
  clock.set(at("2026-03-02T09:00:00.000Z"));
  await health(api);
  assert.equal((await getRec(api, rec.id, w.owner.token)).lastError, "quota_exceeded");
  await ok(api, 204, "DELETE", `/cards/${(await boardCards(api, w.board.id, w.owner.token))[0].id}`, undefined, w.owner.token);
  clock.set(at("2026-03-03T09:00:00.000Z"));
  await health(api);
  assert.equal((await getRec(api, rec.id, w.owner.token)).lastError, "wip_limit_reached");
  const col = (await boardCards(api, w.board.id, w.owner.token)).filter((c) => c.columnId === w.cols[1]);
  assert.deepEqual(col.map((c) => c.id), [last.id]);
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.owner.token)).usage.cards, 99);
});

test("a run fails with wip_limit_reached, then invalid_assignee, then field_required, in that order", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[1], assigneeId: w.member.id });
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 1 }, w.owner.token);
  await createCard(api, w.cols[1], w.member, { title: "fills the limit" });
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.member.id}`, { role: "viewer" }, w.owner.token);
  const f = await mkField(api, w.project.id, w.owner, { name: "Must", type: "text", required: true });
  const errors: string[] = [];
  const runAt = async (iso: string): Promise<void> => {
    clock.set(at(iso));
    await health(api);
    errors.push((await getRec(api, rec.id, w.owner.token)).lastError);
  };
  await runAt("2026-03-02T09:00:00.000Z");
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 5 }, w.owner.token);
  await runAt("2026-03-03T09:00:00.000Z");
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.member.id}`, { role: "member" }, w.owner.token);
  await runAt("2026-03-04T09:00:00.000Z");
  await ok(api, 200, "PATCH", `/fields/${f.id}`, { required: false }, w.owner.token);
  await runAt("2026-03-05T09:00:00.000Z");
  assert.deepEqual(errors, ["wip_limit_reached", "invalid_assignee", "field_required", null]);
  assert.equal((await boardCards(api, w.board.id, w.owner.token)).length, 2);
});

test("a successful run is a change via the recurrence: card.created and its audit entry carry the via, rules run on it, the creator watches; a failed run leaves no trace", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "set_priority", priority: "high" }] });
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], assigneeId: w.member.id });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.set(at("2026-03-02T09:00:00.000Z"));
  await health(api);
  const [card] = await boardCards(api, w.board.id, w.owner.token);
  assert.equal(card.priority, "high");
  const via = { type: "recurrence", recurrenceId: rec.id };
  assert.deepEqual(await log.names(), ["card.created", "card.updated"]);
  const [created, updated] = await log.events(2);
  assert.deepEqual([created.actorId, created.via, created.occurredAt], [w.owner.id, via, "2026-03-02T09:00:00.000Z"]);
  assert.equal(created.data.card.priority, "none");
  const runs = await ruleRuns(api, w.admin.token, rule.id);
  assert.deepEqual([runs[0].cardId, runs[0].depth, runs[0].status], [card.id, 0, "succeeded"]);
  assert.deepEqual(updated.via, { type: "rule", ruleId: rule.id, runId: runs[0].id });
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetId, e.actorId, e.via]), [
    ["card.created", card.id, w.owner.id, via],
    ["card.updated", card.id, w.admin.id, updated.via],
  ]);
  assert.deepEqual(await watcherIds(api, w.owner.token, card.id), [w.owner.id, w.member.id], "the creator, then the assignee");
  const assigned = (await notifications(api, w.member)).filter((n) => n.type === "assigned");
  assert.deepEqual(assigned.map((n) => [n.cardId, n.actorId, n.via]), [[card.id, w.owner.id, via]]);
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  const auditBefore = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.set(at("2026-03-03T09:00:00.000Z"));
  await health(api);
  assert.equal((await getRec(api, rec.id, w.owner.token)).lastError, "project_archived");
  assert.deepEqual(await log.names(), ["card.created", "card.updated"], "a failed run emits nothing");
  assert.equal((await auditLog(api, w.admin.token, w.team.id)).length, auditBefore, "and appends no audit entry");
});

test("due jobs run in due-instant order, then by kind (the due job before a recurrence), then by creation order of their records", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, defaultPlan: "team" });
  const w = await setupBoard(api, clock);
  const nine = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], title: "nine", schedule: { frequency: "daily", time: "09:00" }, startDate: "2026-03-03" });
  const eightA = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], title: "eight-a", schedule: { frequency: "daily", time: "08:00" }, startDate: "2026-03-03" });
  const eightB = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], title: "eight-b", schedule: { frequency: "daily", time: "08:00" }, startDate: "2026-03-03" });
  const midnight = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], title: "midnight", schedule: { frequency: "daily", time: "00:00" }, startDate: "2026-03-03" });
  const due = await createCard(api, w.cols[1], w.member, { title: "due", dueDate: "2026-03-03" });
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.set(at("2026-03-03T10:00:00.000Z"));
  await health(api);
  const titles = (await boardCards(api, w.board.id, w.owner.token)).filter((c) => c.columnId === w.cols[0]).map((c) => c.title);
  assert.deepEqual(titles, ["midnight", "eight-a", "eight-b", "nine"]);
  const events = await log.events(5);
  assert.deepEqual(
    events.map((e) => [e.event, e.event === "card.due" ? e.data.card.id : e.via.recurrenceId]),
    [
      ["card.due", due.id],
      ["card.created", midnight.id],
      ["card.created", eightA.id],
      ["card.created", eightB.id],
      ["card.created", nine.id],
    ],
  );
});

test("deleting a recurrence's column moves it to the moveTo column or deletes it; deleting its board deletes it", async (t) => {
  const api = await startApp(t, { defaultPlan: "team" });
  const w = await setupBoard(api);
  const moved = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[1] });
  const gone = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[2] });
  await createCard(api, w.cols[1], w.member, { title: "in the column" });
  await ok(api, 204, "DELETE", `/columns/${w.cols[1]}?moveTo=${w.cols[0]}`, undefined, w.owner.token);
  const m = await getRec(api, moved.id, w.owner.token);
  assert.equal(m.columnId, w.cols[0]);
  assert.equal(m.updatedAt, moved.updatedAt, "a cascade");
  await ok(api, 204, "DELETE", `/columns/${w.cols[2]}`, undefined, w.owner.token);
  assertError(await api.call("GET", `/recurrences/${gone.id}`, undefined, w.owner.token), 404, "not_found");
  const board2 = await createBoard(api, w.project.id, w.owner, { name: "Second" });
  const onBoard2 = await mkRecurrence(api, board2.id, w.owner, { columnId: board2.columns[0].id });
  await ok(api, 204, "DELETE", `/boards/${board2.id}`, undefined, w.owner.token);
  assertError(await api.call("GET", `/recurrences/${onBoard2.id}`, undefined, w.owner.token), 404, "not_found");
  const list = await ok(api, 200, "GET", `/boards/${w.board.id}/recurrences`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((r: any) => r.id), [moved.id]);
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.owner.token)).usage.recurrences, 1);
});

test("recurrence writes are audited and answer 409 project_archived in an archived project, where reads still work", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0] });
  await ok(api, 200, "PATCH", `/recurrences/${rec.id}`, { title: "Renamed", active: false }, w.admin.token);
  const doomed = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0] });
  await ok(api, 204, "DELETE", `/recurrences/${doomed.id}`, undefined, w.owner.token);
  const entries = (await auditLog(api, w.owner.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.details]), [
    ["recurrence.created", "recurrence", rec.id, w.owner.id, {}],
    ["recurrence.updated", "recurrence", rec.id, w.admin.id, { fields: ["active", "title"] }],
    ["recurrence.created", "recurrence", doomed.id, w.owner.id, {}],
    ["recurrence.deleted", "recurrence", doomed.id, w.owner.id, {}],
  ]);
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", `/boards/${w.board.id}/recurrences`, { columnId: w.cols[0], schedule: DAILY, startDate: "2026-03-02", title: "T" }, w.owner.token), 409, "project_archived");
  assertError(await api.call("PATCH", `/recurrences/${rec.id}`, { active: true }, w.owner.token), 409, "project_archived");
  assertError(await api.call("DELETE", `/recurrences/${rec.id}`, undefined, w.owner.token), 409, "project_archived");
  assertError(await api.call("PATCH", `/recurrences/${rec.id}`, {}, w.owner.token), 400, "invalid_body", "validation before project_archived");
  await getRec(api, rec.id, w.viewer.token);
  assert.equal((await occurrences(api, rec.id, w.viewer.token)).length, 5);
});

test("a PATCH of the schedule moves the pending job: the old instant no longer runs, the new one does", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const rec = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0] });
  const p = await ok(api, 200, "PATCH", `/recurrences/${rec.id}`, { schedule: { frequency: "daily", time: "15:00" } }, w.owner.token);
  assert.equal(p.nextRunAt, "2026-03-02T15:00:00.000Z");
  const p2 = await ok(api, 200, "PATCH", `/recurrences/${rec.id}`, { startDate: "2026-03-03" }, w.owner.token);
  assert.equal(p2.nextRunAt, "2026-03-03T15:00:00.000Z");
  clock.set(at("2026-03-02T16:00:00.000Z"));
  await health(api);
  assert.deepEqual(await boardCards(api, w.board.id, w.owner.token), [], "neither Mar 2 09:00 nor Mar 2 15:00 is an occurrence any more");
  clock.set(at("2026-03-03T15:00:00.000Z"));
  await health(api);
  assert.equal((await boardCards(api, w.board.id, w.owner.token)).length, 1);
});

test("a recurrence moved by a column delete runs into its new column; a deleted recurrence never runs", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[1], title: "moved" });
  const doomed = await mkRecurrence(api, w.board.id, w.owner, { columnId: w.cols[0], title: "deleted" });
  await ok(api, 204, "DELETE", `/recurrences/${doomed.id}`, undefined, w.owner.token);
  await ok(api, 204, "DELETE", `/columns/${w.cols[1]}?moveTo=${w.cols[2]}`, undefined, w.owner.token);
  clock.set(at("2026-03-02T09:00:00.000Z"));
  await health(api);
  const cards = await boardCards(api, w.board.id, w.owner.token);
  assert.deepEqual(cards.map((c) => [c.title, c.columnId]), [["moved", w.cols[2]]]);
  assert.equal(cards[0].completedAt, "2026-03-02T09:00:00.000Z", "created in a done column");
});
