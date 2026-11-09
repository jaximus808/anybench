// Area `reports`: instruction.md section 28 (Reports), over non-archived cards, their history
// (section 25) and time entries (section 29).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  assertError,
  Clock,
  createBoard,
  createCard,
  createProject,
  ok,
  setupBoard,
  type User,
} from "./helpers.ts";
import { archive, move, startApp } from "./helpers-pipeline.ts";

const H = 3_600_000;
const report = (api: Api, projectId: string, name: string, token: string, q = ""): Promise<any> =>
  ok(api, 200, "GET", `/projects/${projectId}/reports/${name}${q === "" ? "" : `?${q}`}`, undefined, token);
const at = (clock: Clock, iso: string): void => {
  clock.set(Date.parse(iso));
};
const logTime = (api: Api, cardId: string, u: User, minutes: number, date: string): Promise<any> => ok(api, 201, "POST", `/cards/${cardId}/time-entries`, { minutes, date }, u.token);

test("the summary of a project without cards has every count at zero and empty lists", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s = await report(api, w.project.id, "summary", w.viewer.token);
  assert.deepEqual(s, {
    cards: 0,
    byCategory: { todo: 0, in_progress: 0, done: 0 },
    byPriority: { none: 0, low: 0, medium: 0, high: 0, urgent: 0 },
    byAssignee: [],
    byLabel: [],
    overdue: 0,
    blocked: 0,
    points: { total: 0, done: 0 },
  });
});

test("the summary counts non-archived cards by category, priority, assignee (null first, then ids ascending) and label, with points", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await createCard(api, w.cols[0], w.member, { title: "c1", priority: "high", assigneeId: w.member.id, labels: ["ui", "bug"], points: 3 });
  await createCard(api, w.cols[1], w.member, { title: "c2", priority: "high", assigneeId: w.admin.id, labels: ["bug"], points: 5 });
  await createCard(api, w.cols[2], w.member, { title: "c3", priority: "low", assigneeId: w.member.id, points: 8 });
  await createCard(api, w.cols[0], w.member, { title: "c4", labels: ["ui"] });
  const gone = await createCard(api, w.cols[0], w.member, { title: "c5", priority: "urgent", assigneeId: w.owner.id, labels: ["zzz"], points: 21 });
  await archive(api, gone.id, w.member);
  const s = await report(api, w.project.id, "summary", w.viewer.token);
  const people = [
    { assigneeId: w.member.id, open: 1, done: 1 },
    { assigneeId: w.admin.id, open: 1, done: 0 },
  ].sort((a, b) => (a.assigneeId < b.assigneeId ? -1 : 1));
  assert.deepEqual(s, {
    cards: 4,
    byCategory: { todo: 2, in_progress: 1, done: 1 },
    byPriority: { none: 1, low: 1, medium: 0, high: 2, urgent: 0 },
    byAssignee: [{ assigneeId: null, open: 1, done: 0 }, ...people],
    byLabel: [{ label: "bug", count: 2 }, { label: "ui", count: 2 }],
    overdue: 0,
    blocked: 0,
    points: { total: 16, done: 8 },
  });
});

test("overdue counts open cards due before today: a card due today is not overdue, a completed one never is, and today moves with the clock", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  await createCard(api, w.cols[0], w.member, { title: "yesterday", dueDate: "2026-02-28" });
  await createCard(api, w.cols[0], w.member, { title: "today", dueDate: "2026-03-01" });
  await createCard(api, w.cols[2], w.member, { title: "done late", dueDate: "2026-02-01" });
  await createCard(api, w.cols[1], w.member, { title: "no date" });
  assert.equal((await report(api, w.project.id, "summary", w.member.token)).overdue, 1);
  at(clock, "2026-03-01T23:59:59.999Z");
  assert.equal((await report(api, w.project.id, "summary", w.member.token)).overdue, 1);
  at(clock, "2026-03-02T00:00:00.000Z");
  assert.equal((await report(api, w.project.id, "summary", w.member.token)).overdue, 2);
});

test("blocked counts cards with an open blocker; an archived or completed blocker is not open; archived cards are left out", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  const x = await createCard(api, w.cols[0], w.member, { title: "x" });
  await ok(api, 201, "POST", `/cards/${a.id}/blockers`, { blockerId: x.id }, w.member.token);
  await ok(api, 201, "POST", `/cards/${b.id}/blockers`, { blockerId: x.id }, w.member.token);
  await ok(api, 201, "POST", `/cards/${c.id}/blockers`, { blockerId: a.id }, w.member.token);
  assert.equal((await report(api, w.project.id, "summary", w.member.token)).blocked, 3);
  await archive(api, b.id, w.member);
  assert.deepEqual((await report(api, w.project.id, "summary", w.member.token)).blocked, 2, "the archived blocked card is left out");
  await archive(api, x.id, w.member);
  const s = await report(api, w.project.id, "summary", w.member.token);
  assert.deepEqual([s.blocked, s.cards], [1, 2], "x archived: a is unblocked, c still waits for a");
  await move(api, a.id, w.member, w.cols[2]);
  assert.equal((await report(api, w.project.id, "summary", w.member.token)).blocked, 0);
});

test("cycle time measures from the first history entry into an in_progress column (else createdAt) to completedAt, ordered by completedAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const base = "2026-03-02T00:00:00.000Z";
  const T = (h: number) => new Date(Date.parse(base) + h * H).toISOString();
  at(clock, T(0));
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  const d = await createCard(api, w.cols[0], w.member, { title: "d" });
  at(clock, T(0.5));
  const b = await createCard(api, w.cols[1], w.member, { title: "b" });
  at(clock, T(1));
  await move(api, a.id, w.member, w.cols[1]);
  await move(api, c.id, w.member, w.cols[2]);
  at(clock, T(2));
  await move(api, d.id, w.member, w.cols[1]);
  at(clock, T(2.5));
  await move(api, d.id, w.member, w.cols[0]);
  at(clock, T(3));
  await move(api, a.id, w.member, w.cols[2]);
  at(clock, T(4));
  await move(api, b.id, w.member, w.cols[2]);
  at(clock, T(5));
  await move(api, d.id, w.member, w.cols[1]);
  at(clock, T(6));
  await move(api, d.id, w.member, w.cols[2]);
  const r = await report(api, w.project.id, "cycle-time", w.viewer.token);
  assert.deepEqual(r.items, [
    { cardId: c.id, key: c.key, startedAt: T(0), completedAt: T(1), cycleTimeMs: 1 * H },
    { cardId: a.id, key: a.key, startedAt: T(1), completedAt: T(3), cycleTimeMs: 2 * H },
    { cardId: b.id, key: b.key, startedAt: T(0.5), completedAt: T(4), cycleTimeMs: 3.5 * H },
    { cardId: d.id, key: d.key, startedAt: T(2), completedAt: T(6), cycleTimeMs: 4 * H },
  ]);
  assert.deepEqual([r.count, r.averageMs, r.medianMs, r.p85Ms], [4, 9_450_000, 9_900_000, 14_400_000]);
});

test("cycle time statistics: average rounded, median the middle value of an odd count, p85 the value at index ceil(0.85 * count) - 1; null when nothing completed", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  assert.deepEqual(await report(api, w.project.id, "cycle-time", w.member.token), { items: [], count: 0, averageMs: null, medianMs: null, p85Ms: null });
  const minutes = [10, 1, 3, 6, 2, 5, 4];
  let start = Date.parse("2026-03-02T00:00:00.000Z");
  for (const m of minutes) {
    clock.set(start);
    const card = await createCard(api, w.cols[1], w.member, { title: `m${m}` });
    clock.set(start + m * 60_000);
    await move(api, card.id, w.member, w.cols[2]);
    start += H;
  }
  const r = await report(api, w.project.id, "cycle-time", w.member.token);
  assert.deepEqual(r.items.map((i: any) => i.cycleTimeMs / 60_000), minutes, "by completedAt");
  assert.deepEqual([r.count, r.averageMs, r.medianMs, r.p85Ms], [7, Math.round((31 * 60_000) / 7), 4 * 60_000, 6 * 60_000]);
});

test("cycle time reads categories as they are now, and a startedAt after completedAt counts 0", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const done2 = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "Done 2", category: "done" }, w.owner.token);
  at(clock, "2026-03-02T00:00:00.000Z");
  const neg = await createCard(api, w.cols[2], w.member, { title: "neg" });
  const later = await createCard(api, w.cols[0], w.member, { title: "later" });
  at(clock, "2026-03-02T01:00:00.000Z");
  await move(api, neg.id, w.member, done2.id);
  await move(api, later.id, w.member, w.cols[2]);
  at(clock, "2026-03-02T02:00:00.000Z");
  await move(api, neg.id, w.member, w.cols[2]);
  await ok(api, 200, "PATCH", `/columns/${done2.id}`, { category: "in_progress" }, w.owner.token);
  await ok(api, 200, "PATCH", `/columns/${w.cols[0]}`, { category: "in_progress" }, w.owner.token);
  const r = await report(api, w.project.id, "cycle-time", w.member.token);
  assert.deepEqual(r.items, [
    { cardId: neg.id, key: neg.key, startedAt: "2026-03-02T01:00:00.000Z", completedAt: "2026-03-02T00:00:00.000Z", cycleTimeMs: 0 },
    { cardId: later.id, key: later.key, startedAt: "2026-03-02T00:00:00.000Z", completedAt: "2026-03-02T01:00:00.000Z", cycleTimeMs: H },
  ]);
  assert.deepEqual([r.count, r.averageMs, r.medianMs, r.p85Ms], [2, 1_800_000, 1_800_000, H]);
});

test("cycle time ?from and ?to bound the date completedAt falls on, inclusively; bad dates or to before from are 400 invalid_query; archived cards are left out", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const keys: string[] = [];
  for (const day of ["2026-03-02", "2026-03-03", "2026-03-04"]) {
    at(clock, `${day}T23:59:59.000Z`);
    keys.push((await createCard(api, w.cols[2], w.member, { title: day })).key);
  }
  const arch = await createCard(api, w.cols[2], w.member, { title: "archived" });
  await archive(api, arch.id, w.member);
  const keysOf = async (q: string) => (await report(api, w.project.id, "cycle-time", w.member.token, q)).items.map((i: any) => i.key);
  assert.deepEqual(await keysOf(""), keys);
  assert.deepEqual(await keysOf("from=2026-03-03"), keys.slice(1));
  assert.deepEqual(await keysOf("to=2026-03-03"), keys.slice(0, 2));
  assert.deepEqual(await keysOf("from=2026-03-03&to=2026-03-03"), [keys[1]]);
  for (const q of ["from=2026-02-30", "to=03-03-2026", "from=2026-03-04&to=2026-03-03", "from=", "to="]) {
    assertError(await api.call("GET", `/projects/${w.project.id}/reports/cycle-time?${q}`, undefined, w.member.token), 400, "invalid_query", q);
  }
});

test("flow counts, for each date, the cards created before its end in the category of the column they were in at its end", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  at(clock, "2026-03-02T10:00:00.000Z");
  await move(api, a.id, w.member, w.cols[1]);
  at(clock, "2026-03-02T15:00:00.000Z");
  await createCard(api, w.cols[0], w.member, { title: "b" });
  at(clock, "2026-03-03T10:00:00.000Z");
  await move(api, a.id, w.member, w.cols[2]);
  const r = await report(api, w.project.id, "flow", w.viewer.token, "from=2026-02-28&to=2026-03-04");
  assert.deepEqual(r, {
    days: [
      { date: "2026-02-28", todo: 0, in_progress: 0, done: 0 },
      { date: "2026-03-01", todo: 1, in_progress: 0, done: 0 },
      { date: "2026-03-02", todo: 1, in_progress: 1, done: 0 },
      { date: "2026-03-03", todo: 1, in_progress: 0, done: 1 },
      { date: "2026-03-04", todo: 1, in_progress: 0, done: 1 },
    ],
  });
});

test("flow uses the current category of each historic column, falls back to the card's current column for a deleted one, and leaves archived cards out", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const x = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "X", category: "done" }, w.owner.token);
  const c = await createCard(api, x.id, w.member, { title: "c" });
  const a = await createCard(api, w.cols[0], w.member, { title: "archived" });
  await archive(api, a.id, w.member);
  const d = await createCard(api, w.cols[0], w.member, { title: "d" });
  at(clock, "2026-03-03T10:00:00.000Z");
  await move(api, c.id, w.member, w.cols[1]);
  await ok(api, 204, "DELETE", `/columns/${x.id}`, undefined, w.owner.token);
  await ok(api, 200, "PATCH", `/columns/${w.cols[0]}`, { category: "done" }, w.owner.token);
  const r = await report(api, w.project.id, "flow", w.member.token, "from=2026-03-01&to=2026-03-03");
  assert.deepEqual(r.days, [
    { date: "2026-03-01", todo: 0, in_progress: 1, done: 1 },
    { date: "2026-03-02", todo: 0, in_progress: 1, done: 1 },
    { date: "2026-03-03", todo: 0, in_progress: 1, done: 1 },
  ]);
  assert.equal(d.columnId, w.cols[0]);
});

test("flow needs from and to, to not before from, and at most 92 dates", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const path = `/projects/${w.project.id}/reports/flow`;
  for (const q of ["", "from=2026-01-01", "to=2026-01-01", "from=2026-01-01&to=2026-04-03", "from=2026-03-02&to=2026-03-01", "from=2026-01-01&to=2026-13-01", "from=&to="]) {
    assertError(await api.call("GET", `${path}${q === "" ? "" : `?${q}`}`, undefined, w.member.token), 400, "invalid_query", q);
  }
  const max = await report(api, w.project.id, "flow", w.member.token, "from=2026-01-01&to=2026-04-02");
  assert.equal(max.days.length, 92);
  assert.deepEqual([max.days[0].date, max.days[91].date], ["2026-01-01", "2026-04-02"]);
  const one = await report(api, w.project.id, "flow", w.member.token, "from=2026-03-01&to=2026-03-01");
  assert.deepEqual(one.days, [{ date: "2026-03-01", todo: 0, in_progress: 0, done: 0 }]);
});

test("the time report totals the project's entries in the date range, by user (ids ascending) and by card number, archived cards included", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const ob = await createBoard(api, ops.id, w.owner);
  const elsewhere = await createCard(api, ob.columns[0].id, w.member, { title: "ops" });
  await logTime(api, b.id, w.admin, 45, "2026-02-27");
  await logTime(api, a.id, w.member, 30, "2026-03-01");
  await logTime(api, b.id, w.member, 15, "2026-02-28");
  await logTime(api, c.id, w.admin, 10, "2026-03-01");
  const gone = await logTime(api, a.id, w.member, 99, "2026-03-01");
  await ok(api, 204, "DELETE", `/time-entries/${gone.id}`, undefined, w.member.token);
  await logTime(api, elsewhere.id, w.member, 500, "2026-03-01");
  await archive(api, c.id, w.member);
  const users = (pairs: [User, number][]) => pairs.map(([u, minutes]) => ({ userId: u.id, minutes })).sort((x, y) => (x.userId < y.userId ? -1 : 1));
  assert.deepEqual(await report(api, w.project.id, "time", w.viewer.token), {
    totalMinutes: 100,
    byUser: users([[w.admin, 55], [w.member, 45]]),
    byCard: [{ cardId: a.id, key: a.key, minutes: 30 }, { cardId: b.id, key: b.key, minutes: 60 }, { cardId: c.id, key: c.key, minutes: 10 }],
  });
  assert.deepEqual(await report(api, w.project.id, "time", w.viewer.token, "from=2026-02-28&to=2026-03-01"), {
    totalMinutes: 55,
    byUser: users([[w.admin, 10], [w.member, 45]]),
    byCard: [{ cardId: a.id, key: a.key, minutes: 30 }, { cardId: b.id, key: b.key, minutes: 15 }, { cardId: c.id, key: c.key, minutes: 10 }],
  });
  assert.deepEqual(await report(api, w.project.id, "time", w.viewer.token, "to=2026-02-27"), { totalMinutes: 45, byUser: users([[w.admin, 45]]), byCard: [{ cardId: b.id, key: b.key, minutes: 45 }] });
});

test("the time report with no entries in range is zero and empty; its from and to are validated", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  assert.deepEqual(await report(api, w.project.id, "time", w.member.token), { totalMinutes: 0, byUser: [], byCard: [] });
  for (const q of ["from=yesterday", "to=2026-02-29", "from=2026-03-02&to=2026-03-01", "from="]) {
    assertError(await api.call("GET", `/projects/${w.project.id}/reports/time?${q}`, undefined, w.member.token), 400, "invalid_query", q);
  }
});

test("workload has one item per owner, admin and member in member order, counting their open cards in non-archived projects", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const ob = await createBoard(api, ops.id, w.owner);
  const old = await createProject(api, w.team.id, w.owner, "OLD");
  const oldBoard = await createBoard(api, old.id, w.owner);
  await createCard(api, w.cols[0], w.owner, { title: "m1", assigneeId: w.member.id, points: 3, dueDate: "2026-02-28" });
  await createCard(api, w.cols[1], w.owner, { title: "m2", assigneeId: w.member.id, dueDate: "2026-03-01" });
  await createCard(api, w.cols[2], w.owner, { title: "m done", assigneeId: w.member.id, points: 8, dueDate: "2026-01-01" });
  const arch = await createCard(api, w.cols[0], w.owner, { title: "m archived", assigneeId: w.member.id, points: 13 });
  await archive(api, arch.id, w.owner);
  await createCard(api, oldBoard.columns[0].id, w.owner, { title: "m old", assigneeId: w.member.id, points: 21, dueDate: "2026-01-01" });
  await ok(api, 200, "PATCH", `/projects/${old.id}`, { archived: true }, w.owner.token);
  await createCard(api, ob.columns[0].id, w.owner, { title: "m ops", assigneeId: w.member.id, points: 5 });
  await createCard(api, ob.columns[1].id, w.owner, { title: "o1", assigneeId: w.owner.id, dueDate: "2026-02-20" });
  const r = await ok(api, 200, "GET", `/teams/${w.team.id}/reports/workload`, undefined, w.viewer.token);
  assert.deepEqual(r, {
    items: [
      { userId: w.owner.id, openCards: 1, openPoints: 0, overdue: 1 },
      { userId: w.admin.id, openCards: 0, openPoints: 0, overdue: 0 },
      { userId: w.member.id, openCards: 3, openPoints: 8, overdue: 1 },
    ],
  });
});

test("reports are viewer+ and still answer for an archived project; non-members get 404 on every report", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await createCard(api, w.cols[0], w.member, { title: "c" });
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assert.equal((await report(api, w.project.id, "summary", w.viewer.token)).cards, 1);
  await report(api, w.project.id, "cycle-time", w.viewer.token);
  await report(api, w.project.id, "flow", w.viewer.token, "from=2026-03-01&to=2026-03-02");
  await report(api, w.project.id, "time", w.viewer.token);
  for (const path of ["summary", "cycle-time", "flow?from=2026-03-01&to=2026-03-02", "time"]) {
    assertError(await api.call("GET", `/projects/${w.project.id}/reports/${path}`, undefined, w.outsider.token), 404, "not_found", path);
  }
  assertError(await api.call("GET", `/teams/${w.team.id}/reports/workload`, undefined, w.outsider.token), 404, "not_found");
  assertError(await api.call("GET", `/projects/no-such-project/reports/summary`, undefined, w.owner.token), 404, "not_found");
});

test("workload counts a member's open cards across every active project; a member who leaves drops out with their cards unassigned", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const ob = await createBoard(api, ops.id, w.owner);
  await createCard(api, w.cols[0], w.owner, { title: "a", assigneeId: w.admin.id, points: 2 });
  await createCard(api, ob.columns[0].id, w.owner, { title: "b", assigneeId: w.admin.id, points: 3 });
  await createCard(api, ob.columns[1].id, w.owner, { title: "c", assigneeId: w.member.id, points: 1 });
  let r = await ok(api, 200, "GET", `/teams/${w.team.id}/reports/workload`, undefined, w.member.token);
  assert.deepEqual(r.items.map((i: any) => [i.userId, i.openCards, i.openPoints]), [[w.owner.id, 0, 0], [w.admin.id, 2, 5], [w.member.id, 1, 1]]);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.owner.token);
  r = await ok(api, 200, "GET", `/teams/${w.team.id}/reports/workload`, undefined, w.owner.token);
  assert.deepEqual(r.items.map((i: any) => i.userId), [w.owner.id, w.admin.id]);
  const s = await report(api, ops.id, "summary", w.owner.token);
  assert.deepEqual(s.byAssignee.find((x: any) => x.assigneeId === null), { assigneeId: null, open: 1, done: 0 });
});

test("cycle time and flow leave archived cards out, and a restored card counts again", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[1], w.member, { title: "c" });
  at(clock, "2026-03-02T12:00:00.000Z");
  await move(api, card.id, w.member, w.cols[2]);
  await archive(api, card.id, w.member);
  assert.equal((await report(api, w.project.id, "cycle-time", w.member.token)).count, 0);
  assert.deepEqual((await report(api, w.project.id, "flow", w.member.token, "from=2026-03-02&to=2026-03-02")).days, [{ date: "2026-03-02", todo: 0, in_progress: 0, done: 0 }]);
  assert.equal((await report(api, w.project.id, "summary", w.member.token)).cards, 0);
  await ok(api, 200, "POST", `/cards/${card.id}/restore`, {}, w.member.token);
  const r = await report(api, w.project.id, "cycle-time", w.member.token);
  assert.deepEqual(r.items.map((i: any) => [i.cardId, i.completedAt, i.cycleTimeMs]), [[card.id, "2026-03-02T12:00:00.000Z", 24 * H - 3000]]);
});

test("points in the summary count null as 0, and points.done only the completed cards' points", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await createCard(api, w.cols[0], w.member, { title: "a", points: 13 });
  await createCard(api, w.cols[2], w.member, { title: "b", points: 21 });
  await createCard(api, w.cols[2], w.member, { title: "c" });
  const c = await createCard(api, w.cols[1], w.member, { title: "d", points: 1 });
  await move(api, c.id, w.member, w.cols[2]);
  await move(api, c.id, w.member, w.cols[0]);
  assert.deepEqual((await report(api, w.project.id, "summary", w.member.token)).points, { total: 35, done: 21 });
});

test("a card completed, reopened and completed again: completedAt is the latest completion, startedAt its first in_progress entry", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  at(clock, "2026-03-02T00:00:00.000Z");
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  at(clock, "2026-03-02T01:00:00.000Z");
  await move(api, card.id, w.member, w.cols[1]);
  at(clock, "2026-03-02T02:00:00.000Z");
  await move(api, card.id, w.member, w.cols[2]);
  at(clock, "2026-03-02T03:00:00.000Z");
  await move(api, card.id, w.member, w.cols[0]);
  assert.equal((await report(api, w.project.id, "cycle-time", w.member.token)).count, 0, "an open card is not counted");
  at(clock, "2026-03-02T05:00:00.000Z");
  await move(api, card.id, w.member, w.cols[2]);
  const r = await report(api, w.project.id, "cycle-time", w.member.token);
  assert.deepEqual(r.items, [{ cardId: card.id, key: card.key, startedAt: "2026-03-02T01:00:00.000Z", completedAt: "2026-03-02T05:00:00.000Z", cycleTimeMs: 4 * H }]);
});

test("the summary byAssignee has no null entry when every card is assigned, and counts done per assignee", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await createCard(api, w.cols[2], w.member, { title: "a", assigneeId: w.member.id });
  await createCard(api, w.cols[2], w.member, { title: "b", assigneeId: w.member.id });
  await createCard(api, w.cols[0], w.member, { title: "c", assigneeId: w.member.id });
  assert.deepEqual((await report(api, w.project.id, "summary", w.member.token)).byAssignee, [{ assigneeId: w.member.id, open: 1, done: 2 }]);
});

test("the summary counts per project: another project's cards are not in it", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const ob = await createBoard(api, ops.id, w.owner);
  await createCard(api, ob.columns[0].id, w.member, { title: "ops", labels: ["ops"] });
  await createCard(api, w.cols[0], w.member, { title: "eng", labels: ["eng"] });
  const s = await report(api, w.project.id, "summary", w.member.token);
  assert.deepEqual([s.cards, s.byLabel], [1, [{ label: "eng", count: 1 }]]);
});

test("summary and workload follow the columns' current categories across every board of the project", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const b2 = await createBoard(api, w.project.id, w.owner, { name: "Second", columns: ["Only"] });
  await createCard(api, w.cols[1], w.member, { title: "a", assigneeId: w.member.id });
  await createCard(api, b2.columns[0].id, w.member, { title: "b", assigneeId: w.member.id });
  let s = await report(api, w.project.id, "summary", w.member.token);
  assert.deepEqual(s.byCategory, { todo: 1, in_progress: 1, done: 0 });
  await ok(api, 200, "PATCH", `/columns/${b2.columns[0].id}`, { category: "done" }, w.owner.token);
  s = await report(api, w.project.id, "summary", w.member.token);
  assert.deepEqual([s.byCategory, s.byAssignee], [{ todo: 0, in_progress: 1, done: 1 }, [{ assigneeId: w.member.id, open: 1, done: 1 }]]);
  const wl = await ok(api, 200, "GET", `/teams/${w.team.id}/reports/workload`, undefined, w.member.token);
  assert.equal(wl.items.find((i: any) => i.userId === w.member.id).openCards, 1);
});
