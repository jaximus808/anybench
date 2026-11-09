// Area `sprints`: instruction.md section 19 (Sprints and velocity), with the conventions of section 0.
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
  type Res,
  setupBoard,
  startApp,
  type User,
} from "./helpers.ts";
import { LONG_TTL } from "./helpers-pipeline.ts";

const mkSprint = (api: Api, projectId: string, by: User, body: Record<string, unknown> = {}): Promise<any> =>
  ok(api, 201, "POST", `/projects/${projectId}/sprints`, { name: "Sprint", startDate: "2026-03-01", endDate: "2026-03-14", ...body }, by.token);

const start = (api: Api, id: string, by: User | string): Promise<Res> => api.call("POST", `/sprints/${id}/start`, undefined, typeof by === "string" ? by : by.token);
const complete = (api: Api, id: string, by: User, body: unknown = {}): Promise<Res> => api.call("POST", `/sprints/${id}/complete`, body, by.token);
const addCards = (api: Api, id: string, cardIds: unknown, by: User | string): Promise<Res> =>
  api.call("POST", `/sprints/${id}/cards`, { cardIds }, typeof by === "string" ? by : by.token);

const sprintCardIds = async (api: Api, id: string, token: string): Promise<string[]> =>
  (await ok(api, 200, "GET", `/sprints/${id}/cards`, undefined, token)).items.map((c: any) => c.id);

const sprintOf = async (api: Api, cardId: string, token: string): Promise<string | null> => (await getCard(api, cardId, token)).sprintId;

test("a new sprint is planned and has the documented shape; the name is trimmed and goal defaults to empty", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  clock.advance(5000);
  const s = await mkSprint(api, w.project.id, w.admin, { name: "  Sprint 1  ", startDate: "2026-03-02", endDate: "2026-03-15" });
  assert.deepEqual(Object.keys(s).sort(), [
    "committedPoints",
    "completedAt",
    "completedPoints",
    "createdAt",
    "endDate",
    "goal",
    "id",
    "name",
    "projectId",
    "startDate",
    "startedAt",
    "state",
    "updatedAt",
  ]);
  assert.equal(s.projectId, w.project.id);
  assert.equal(s.name, "Sprint 1");
  assert.equal(s.goal, "");
  assert.equal(s.startDate, "2026-03-02");
  assert.equal(s.endDate, "2026-03-15");
  assert.equal(s.state, "planned");
  assert.equal(s.startedAt, null);
  assert.equal(s.completedAt, null);
  assert.equal(s.committedPoints, null);
  assert.equal(s.completedPoints, null);
  assert.equal(s.createdAt, clock.iso());
  assert.equal(s.updatedAt, s.createdAt);
  assert.deepEqual(await ok(api, 200, "GET", `/sprints/${s.id}`, undefined, w.viewer.token), s);
});

test("sprint validation: name 1 to 100 chars trimmed, goal at most 500 chars, real dates with endDate >= startDate", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const path = `/projects/${w.project.id}/sprints`;
  const good = { name: "S", startDate: "2026-03-01", endDate: "2026-03-14" };
  const bad: [string, Record<string, unknown>][] = [
    ["empty name", { ...good, name: "" }],
    ["blank name", { ...good, name: "   " }],
    ["long name", { ...good, name: "n".repeat(101) }],
    ["missing name", { startDate: good.startDate, endDate: good.endDate }],
    ["long goal", { ...good, goal: "g".repeat(501) }],
    ["goal not a string", { ...good, goal: 5 }],
    ["impossible startDate", { ...good, startDate: "2026-02-30" }],
    ["missing startDate", { name: "S", endDate: good.endDate }],
    ["missing endDate", { name: "S", startDate: good.startDate }],
    ["endDate before startDate", { ...good, endDate: "2026-02-28" }],
    ["datetime endDate", { ...good, endDate: "2026-03-14T00:00:00Z" }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", path, body, w.owner.token), 400, "invalid_body", what);
  const one = await ok(api, 201, "POST", path, { name: "n".repeat(100), goal: "g".repeat(500), startDate: "2026-03-05", endDate: "2026-03-05" }, w.owner.token);
  assert.equal(one.endDate, one.startDate, "a one-day sprint is fine");
  const list = await ok(api, 200, "GET", path, undefined, w.owner.token);
  assert.equal(list.items.length, 1);
});

test("sprints list by startDate ascending then creation order, filter by ?state (default all), and other values are invalid_query", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s: Record<string, any> = {};
  for (const [k, startDate] of [
    ["a", "2026-03-10"],
    ["b", "2026-03-05"],
    ["c", "2026-03-10"],
    ["d", "2026-03-01"],
  ] as const) {
    clock.advance(1000);
    s[k] = await mkSprint(api, w.project.id, w.owner, { name: k, startDate, endDate: "2026-03-20" });
  }
  assertStatus(await start(api, s.d.id, w.owner), 200);
  const list = async (q: string) => (await ok(api, 200, "GET", `/projects/${w.project.id}/sprints${q}`, undefined, w.viewer.token)).items.map((x: any) => x.name);
  assert.deepEqual(await list(""), ["d", "b", "a", "c"]);
  assert.deepEqual(await list("?state=all"), ["d", "b", "a", "c"]);
  assert.deepEqual(await list("?state=active"), ["d"]);
  assert.deepEqual(await list("?state=planned"), ["b", "a", "c"]);
  assert.deepEqual(await list("?state=completed"), []);
  for (const q of ["?state=done", "?state=", "?state=ACTIVE"]) {
    assertError(await api.call("GET", `/projects/${w.project.id}/sprints${q}`, undefined, w.viewer.token), 400, "invalid_query", q);
  }
});

test("sprint routes: viewers read, members may only change a sprint's cards, admin+ manages sprints, non-members get 404", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await setupBoard(api);
  const s = await mkSprint(api, w.project.id, w.admin);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await ok(api, 200, "GET", `/sprints/${s.id}`, undefined, w.viewer.token);
  await ok(api, 200, "GET", `/sprints/${s.id}/cards`, undefined, w.viewer.token);
  for (const u of [w.member, w.viewer]) {
    assertError(await api.call("POST", `/projects/${w.project.id}/sprints`, { name: "S", startDate: "2026-03-01", endDate: "2026-03-02" }, u.token), 403, "forbidden", "create");
    assertError(await api.call("PATCH", `/sprints/${s.id}`, { name: "x" }, u.token), 403, "forbidden", "PATCH");
    assertError(await start(api, s.id, u), 403, "forbidden", "start");
    assertError(await complete(api, s.id, u), 403, "forbidden", "complete");
    assertError(await api.call("DELETE", `/sprints/${s.id}`, undefined, u.token), 403, "forbidden", "DELETE");
  }
  assertError(await addCards(api, s.id, [card.id], w.viewer), 403, "forbidden", "viewer adds cards");
  assertStatus(await addCards(api, s.id, [card.id], w.member), 200, "member adds cards");
  assertError(await api.call("GET", `/sprints/${s.id}`, undefined, other.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/projects/${w.project.id}/sprints`, undefined, w.outsider.token), 404, "not_found");
  assertError(await addCards(api, s.id, [card.id], other.owner), 404, "not_found");
  assertError(await api.call("GET", `/sprints/no-such-sprint`, undefined, w.owner.token), 404, "not_found");
});

test("start makes a planned sprint active with startedAt now and committedPoints from its non-archived cards, null counting 0", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.admin);
  const pts = [3, 5, null];
  for (const points of pts) await createCard(api, w.cols[0], w.member, { title: `p${points}`, points, sprintId: s.id });
  const archived = await createCard(api, w.cols[0], w.member, { title: "archived", points: 8, sprintId: s.id });
  await ok(api, 200, "POST", `/cards/${archived.id}/archive`, undefined, w.member.token);
  await createCard(api, w.cols[0], w.member, { title: "not in it", points: 13 });
  clock.advance(60_000);
  const res = await start(api, s.id, w.admin);
  assertStatus(res, 200);
  assert.equal(res.body.state, "active");
  assert.equal(res.body.startedAt, clock.iso());
  assert.equal(res.body.updatedAt, clock.iso());
  assert.equal(res.body.committedPoints, 8);
  assert.equal(res.body.completedPoints, null);
  assert.equal(res.body.completedAt, null);
});

test("start answers sprint_state unless the sprint is planned, and sprint_active while another sprint of the project is active", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const a = await mkSprint(api, w.project.id, w.owner, { name: "A" });
  const b = await mkSprint(api, w.project.id, w.owner, { name: "B" });
  const c = await mkSprint(api, ops.id, w.owner, { name: "C" });
  assertStatus(await start(api, a.id, w.owner), 200);
  assertError(await start(api, b.id, w.owner), 409, "sprint_active");
  assertError(await start(api, a.id, w.owner), 409, "sprint_state", "already active: sprint_state before sprint_active");
  assertStatus(await start(api, c.id, w.owner), 200, "another project has its own active sprint");
  assertStatus(await complete(api, a.id, w.owner), 200);
  assertStatus(await start(api, b.id, w.owner), 200);
  assertError(await start(api, a.id, w.owner), 409, "sprint_state", "completed");
  assert.equal((await ok(api, 200, "GET", `/sprints/${b.id}`, undefined, w.owner.token)).state, "active");
});

test("complete answers sprint_state unless the sprint is active; its body must be a JSON object", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s = await mkSprint(api, w.project.id, w.owner);
  assertError(await complete(api, s.id, w.owner), 409, "sprint_state", "planned");
  assertError(await api.call("POST", `/sprints/${s.id}/complete`, undefined, w.owner.token), 400, "invalid_body", "missing body");
  await start(api, s.id, w.owner);
  assertError(await api.call("POST", `/sprints/${s.id}/complete`, undefined, w.owner.token, { raw: "[]" }), 400, "invalid_body", "array body");
  assertError(await api.call("POST", `/sprints/${s.id}/complete`, undefined, w.owner.token), 400, "invalid_body", "missing body on an active sprint");
  assertStatus(await complete(api, s.id, w.owner), 200);
  assertError(await complete(api, s.id, w.owner), 409, "sprint_state", "completed");
});

test("complete sets completedPoints from completed non-archived cards and carries open non-archived cards to a planned sprint", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s1 = await mkSprint(api, w.project.id, w.owner, { name: "S1" });
  const s2 = await mkSprint(api, w.project.id, w.owner, { name: "S2", startDate: "2026-03-15", endDate: "2026-03-28" });
  const done = await createCard(api, w.cols[2], w.member, { title: "done", points: 3, sprintId: s1.id });
  const open = await createCard(api, w.cols[0], w.member, { title: "open", points: 5, sprintId: s1.id });
  const nopts = await createCard(api, w.cols[1], w.member, { title: "no points", sprintId: s1.id });
  const shelved = await createCard(api, w.cols[0], w.member, { title: "shelved", points: 2, sprintId: s1.id });
  await ok(api, 200, "POST", `/cards/${shelved.id}/archive`, undefined, w.member.token);
  const started = await start(api, s1.id, w.owner);
  assert.equal(started.body.committedPoints, 8);
  clock.advance(60_000);
  const res = await complete(api, s1.id, w.owner, { carryOverTo: s2.id });
  assertStatus(res, 200);
  assert.equal(res.body.state, "completed");
  assert.equal(res.body.completedAt, clock.iso());
  assert.equal(res.body.completedPoints, 3);
  assert.equal(res.body.committedPoints, 8);
  assert.equal(await sprintOf(api, done.id, w.member.token), s1.id, "completed cards keep their sprint");
  assert.equal(await sprintOf(api, open.id, w.member.token), s2.id);
  assert.equal(await sprintOf(api, nopts.id, w.member.token), s2.id);
  assert.equal(await sprintOf(api, shelved.id, w.member.token), s1.id, "archived cards are not carried over");
  assert.deepEqual(await sprintCardIds(api, s2.id, w.member.token), [open.id, nopts.id]);
  assert.deepEqual(await sprintCardIds(api, s1.id, w.member.token), [done.id]);
});

test("complete without carryOverTo leaves the open cards in no sprint, without changing their updatedAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner);
  const done = await createCard(api, w.cols[2], w.member, { title: "done", points: 2, sprintId: s.id });
  const open = await createCard(api, w.cols[0], w.member, { title: "open", points: 3, sprintId: s.id });
  await start(api, s.id, w.owner);
  clock.advance(60_000);
  const res = await complete(api, s.id, w.owner, { carryOverTo: null });
  assertStatus(res, 200);
  assert.equal(res.body.completedPoints, 2);
  const o = await getCard(api, open.id, w.member.token);
  assert.equal(o.sprintId, null);
  assert.equal(o.updatedAt, open.updatedAt, "carry-over is a cascade");
  assert.equal(await sprintOf(api, done.id, w.member.token), s.id);
  const got = await ok(api, 200, "GET", `/sprints/${s.id}`, undefined, w.member.token);
  assert.deepEqual([got.state, got.completedAt, got.completedPoints], ["completed", clock.iso(), 2]);
});

test("carryOverTo must be another planned sprint of the same project, else 400 invalid_body", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const s0 = await mkSprint(api, w.project.id, w.owner, { name: "S0" });
  await start(api, s0.id, w.owner);
  await complete(api, s0.id, w.owner);
  const s1 = await mkSprint(api, w.project.id, w.owner, { name: "S1" });
  const s2 = await mkSprint(api, w.project.id, w.owner, { name: "S2" });
  const foreign = await mkSprint(api, ops.id, w.owner, { name: "OPS" });
  await start(api, s1.id, w.owner);
  for (const [what, v] of [
    ["itself (active)", s1.id],
    ["a completed sprint", s0.id],
    ["another project's planned sprint", foreign.id],
    ["unknown", "no-such-sprint"],
    ["not a string", 5],
  ] as const) {
    assertError(await complete(api, s1.id, w.owner, { carryOverTo: v }), 400, "invalid_body", what);
  }
  assert.equal((await ok(api, 200, "GET", `/sprints/${s1.id}`, undefined, w.owner.token)).state, "active");
  assertStatus(await complete(api, s1.id, w.owner, { carryOverTo: s2.id }), 200);
});

test("a completed sprint is frozen: no card enters or leaves it by POST cards, DELETE cards or a card PATCH of sprintId", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s1 = await mkSprint(api, w.project.id, w.owner, { name: "S1" });
  const s2 = await mkSprint(api, w.project.id, w.owner, { name: "S2" });
  const kept = await createCard(api, w.cols[2], w.member, { title: "kept", points: 1, sprintId: s1.id });
  const fresh = await createCard(api, w.cols[0], w.member, { title: "fresh" });
  await start(api, s1.id, w.owner);
  await complete(api, s1.id, w.owner);
  assertError(await addCards(api, s1.id, [fresh.id], w.member), 409, "sprint_state", "into a completed sprint");
  assertError(await api.call("DELETE", `/sprints/${s1.id}/cards/${kept.id}`, undefined, w.member.token), 409, "sprint_state", "out of a completed sprint");
  assertError(await api.call("PATCH", `/cards/${kept.id}`, { sprintId: null }, w.member.token), 409, "sprint_state", "PATCH sprintId null");
  assertError(await api.call("PATCH", `/cards/${kept.id}`, { sprintId: s2.id }, w.member.token), 409, "sprint_state", "PATCH to a planned sprint");
  assertError(await addCards(api, s2.id, [kept.id, fresh.id], w.member), 409, "sprint_state", "a listed card is in a completed sprint");
  assert.deepEqual(await sprintCardIds(api, s2.id, w.member.token), [], "nothing moved");
  assert.equal(await sprintOf(api, kept.id, w.member.token), s1.id);
  const renamed = await ok(api, 200, "PATCH", `/cards/${kept.id}`, { title: "renamed" }, w.member.token);
  assert.equal(renamed.sprintId, s1.id, "other card fields still change");
});

test("PATCH of a planned sprint changes any field, checks the date pair after the change and moves updatedAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner, { startDate: "2026-03-10", endDate: "2026-03-20" });
  clock.advance(60_000);
  const p = await ok(api, 200, "PATCH", `/sprints/${s.id}`, { name: " Renamed ", goal: "Ship it", startDate: "2026-03-12" }, w.admin.token);
  assert.deepEqual([p.name, p.goal, p.startDate, p.endDate], ["Renamed", "Ship it", "2026-03-12", "2026-03-20"]);
  assert.equal(p.updatedAt, clock.iso());
  assert.equal(p.createdAt, s.createdAt);
  assertError(await api.call("PATCH", `/sprints/${s.id}`, { endDate: "2026-03-11" }, w.admin.token), 400, "invalid_body", "endDate before the current startDate");
  assertError(await api.call("PATCH", `/sprints/${s.id}`, { startDate: "2026-03-21" }, w.admin.token), 400, "invalid_body", "startDate after the current endDate");
  const both = await ok(api, 200, "PATCH", `/sprints/${s.id}`, { startDate: "2026-04-01", endDate: "2026-04-10" }, w.admin.token);
  assert.deepEqual([both.startDate, both.endDate], ["2026-04-01", "2026-04-10"]);
  assertError(await api.call("PATCH", `/sprints/${s.id}`, {}, w.admin.token), 400, "invalid_body", "no updatable field");
  assertError(await api.call("PATCH", `/sprints/${s.id}`, { name: "" }, w.admin.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/sprints/${s.id}`, { goal: "g".repeat(501) }, w.admin.token), 400, "invalid_body");
});

test("PATCH of an active sprint may change name and goal and resend its dates; other dates are sprint_state; a completed sprint is sprint_state", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s = await mkSprint(api, w.project.id, w.owner, { startDate: "2026-03-01", endDate: "2026-03-14" });
  await start(api, s.id, w.owner);
  const p = await ok(api, 200, "PATCH", `/sprints/${s.id}`, { name: "Live", goal: "Focus", startDate: "2026-03-01", endDate: "2026-03-14" }, w.owner.token);
  assert.deepEqual([p.name, p.goal, p.state], ["Live", "Focus", "active"]);
  assertError(await api.call("PATCH", `/sprints/${s.id}`, { endDate: "2026-03-15" }, w.owner.token), 409, "sprint_state", "new endDate");
  assertError(await api.call("PATCH", `/sprints/${s.id}`, { startDate: "2026-03-02", name: "x" }, w.owner.token), 409, "sprint_state", "new startDate");
  assertError(await api.call("PATCH", `/sprints/${s.id}`, { startDate: "not-a-date" }, w.owner.token), 400, "invalid_body", "validation before the 409");
  assertError(await api.call("PATCH", `/sprints/${s.id}`, { endDate: "2026-02-01" }, w.owner.token), 400, "invalid_body", "the pair is checked first");
  const still = await ok(api, 200, "GET", `/sprints/${s.id}`, undefined, w.owner.token);
  assert.deepEqual([still.name, still.endDate], ["Live", "2026-03-14"]);
  await complete(api, s.id, w.owner);
  assertError(await api.call("PATCH", `/sprints/${s.id}`, { name: "After" }, w.owner.token), 409, "sprint_state", "completed");
});

test("DELETE removes only a planned sprint; its cards get sprintId null by cascade, without updatedAt changes or events", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const active = await mkSprint(api, w.project.id, w.owner, { name: "active" });
  const done = await mkSprint(api, w.project.id, w.owner, { name: "done" });
  const planned = await mkSprint(api, w.project.id, w.owner, { name: "planned" });
  await start(api, done.id, w.owner);
  await complete(api, done.id, w.owner);
  await start(api, active.id, w.owner);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1", sprintId: planned.id });
  const c2 = await createCard(api, w.cols[1], w.member, { title: "c2", sprintId: planned.id });
  assertError(await api.call("DELETE", `/sprints/${active.id}`, undefined, w.owner.token), 409, "sprint_state", "active");
  assertError(await api.call("DELETE", `/sprints/${done.id}`, undefined, w.owner.token), 409, "sprint_state", "completed");
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(60_000);
  const del = await api.call("DELETE", `/sprints/${planned.id}`, undefined, w.owner.token);
  assertStatus(del, 204);
  assertError(await api.call("GET", `/sprints/${planned.id}`, undefined, w.owner.token), 404, "not_found");
  for (const c of [c1, c2]) {
    const now = await getCard(api, c.id, w.member.token);
    assert.equal(now.sprintId, null);
    assert.equal(now.updatedAt, c.updatedAt);
  }
  assert.deepEqual(await log.names(), []);
  const list = await ok(api, 200, "GET", `/projects/${w.project.id}/sprints`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((s: any) => s.name).sort(), ["active", "done"]);
});

test("POST sprint cards adds the listed cards, answers the sprint's cards by number, and leaves cards already in it alone", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1" });
  const c2 = await createCard(api, w.cols[1], w.member, { title: "c2" });
  const c3 = await createCard(api, w.cols[0], w.member, { title: "c3" });
  clock.advance(1000);
  const first = await addCards(api, s.id, [c3.id, c1.id], w.member);
  assertStatus(first, 200);
  assert.deepEqual(first.body.items.map((c: any) => c.id), [c1.id, c3.id]);
  assert.deepEqual(first.body.items.map((c: any) => c.sprintId), [s.id, s.id]);
  const t1 = clock.iso();
  assert.equal((await getCard(api, c1.id, w.member.token)).updatedAt, t1);
  clock.advance(1000);
  const second = await addCards(api, s.id, [c1.id, c2.id], w.member);
  assertStatus(second, 200);
  assert.deepEqual(second.body.items.map((c: any) => c.id), [c1.id, c2.id, c3.id]);
  assert.equal((await getCard(api, c1.id, w.member.token)).updatedAt, t1, "a card already in the sprint is left alone");
  assert.equal((await getCard(api, c2.id, w.member.token)).updatedAt, clock.iso());
});

test("POST sprint cards emits card.updated with fields [sprintId] per changed card in body order, and one sprint.cards_added entry", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1", sprintId: s.id });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "c2" });
  const c3 = await createCard(api, w.cols[0], w.member, { title: "c3" });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(1000);
  assertStatus(await addCards(api, s.id, [c3.id, c1.id, c2.id], w.member), 200);
  assert.deepEqual(await log.names(), ["card.updated", "card.updated"]);
  const events = await log.events(2);
  assert.deepEqual(events.map((e) => e.data.card.id), [c3.id, c2.id]);
  for (const e of events) {
    assert.deepEqual(e.data.fields, ["sprintId"]);
    assert.equal(e.data.card.sprintId, s.id);
    assert.equal(e.actorId, w.member.id);
    assert.equal(e.via, null);
  }
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.details]),
    [["sprint.cards_added", "sprint", s.id, w.member.id, { cardIds: [c3.id, c2.id] }]],
  );
});

test("POST sprint cards that changes no card answers the cards but appends no audit entry and emits nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s = await mkSprint(api, w.project.id, w.owner);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1", sprintId: s.id });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "c2", sprintId: s.id });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  const res = await addCards(api, s.id, [c2.id, c1.id], w.member);
  assertStatus(res, 200);
  assert.deepEqual(res.body.items.map((c: any) => c.id), [c1.id, c2.id]);
  assert.equal((await getCard(api, c1.id, w.member.token)).updatedAt, c1.updatedAt);
  assert.deepEqual(await log.names(), []);
  assert.equal((await auditLog(api, w.admin.token, w.team.id)).length, base);
});

test("POST sprint cards moves a card from another planned or active sprint into this one", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const active = await mkSprint(api, w.project.id, w.owner, { name: "active" });
  const planned = await mkSprint(api, w.project.id, w.owner, { name: "planned" });
  await start(api, active.id, w.owner);
  const a = await createCard(api, w.cols[0], w.member, { title: "a", sprintId: planned.id });
  const b = await createCard(api, w.cols[0], w.member, { title: "b", sprintId: active.id });
  assertStatus(await addCards(api, active.id, [a.id], w.member), 200);
  assertStatus(await addCards(api, planned.id, [b.id], w.member), 200);
  assert.equal(await sprintOf(api, a.id, w.member.token), active.id);
  assert.equal(await sprintOf(api, b.id, w.member.token), planned.id);
  assert.deepEqual(await sprintCardIds(api, active.id, w.member.token), [a.id]);
  assert.deepEqual(await sprintCardIds(api, planned.id, w.member.token), [b.id]);
});

test("cardIds must be a non-empty array of at most 100 distinct ids of non-archived cards of the sprint's project", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  const s = await mkSprint(api, w.project.id, w.owner);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1" });
  const shelved = await createCard(api, w.cols[0], w.member, { title: "shelved" });
  await ok(api, 200, "POST", `/cards/${shelved.id}/archive`, undefined, w.member.token);
  const foreign = await createCard(api, opsBoard.columns[0].id, w.member, { title: "foreign" });
  const bad: [string, unknown][] = [
    ["empty", []],
    ["duplicates", [c1.id, c1.id]],
    ["another project's card", [c1.id, foreign.id]],
    ["an archived card", [c1.id, shelved.id]],
    ["unknown", ["no-such-card"]],
    ["not strings", [5]],
    ["not an array", c1.id],
    ["101 ids", [c1.id, ...Array.from({ length: 100 }, (_, i) => `x${i}`)]],
  ];
  for (const [what, cardIds] of bad) assertError(await addCards(api, s.id, cardIds, w.member), 400, "invalid_body", what);
  assertError(await api.call("POST", `/sprints/${s.id}/cards`, {}, w.member.token), 400, "invalid_body", "missing");
  assert.deepEqual(await sprintCardIds(api, s.id, w.member.token), []);
  assert.equal(await sprintOf(api, c1.id, w.member.token), null, "nothing was applied");
});

test("DELETE of a sprint card clears sprintId, moves updatedAt, emits card.updated [sprintId] and appends sprint.card_removed; a card not in it is 404", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner);
  const other = await mkSprint(api, w.project.id, w.owner, { name: "other" });
  const c = await createCard(api, w.cols[0], w.member, { title: "c", sprintId: s.id });
  const elsewhere = await createCard(api, w.cols[0], w.member, { title: "e", sprintId: other.id });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(1000);
  const del = await api.call("DELETE", `/sprints/${s.id}/cards/${c.id}`, undefined, w.member.token);
  assertStatus(del, 204);
  const now = await getCard(api, c.id, w.member.token);
  assert.equal(now.sprintId, null);
  assert.equal(now.updatedAt, clock.iso());
  assert.deepEqual(await log.names(), ["card.updated"]);
  const [e] = await log.events(1);
  assert.deepEqual(e.data.fields, ["sprintId"]);
  assert.equal(e.data.card.sprintId, null);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((x) => [x.action, x.targetType, x.targetId, x.details]), [["sprint.card_removed", "sprint", s.id, { cardId: c.id }]]);
  assertError(await api.call("DELETE", `/sprints/${s.id}/cards/${c.id}`, undefined, w.member.token), 404, "not_found", "no longer in it");
  assertError(await api.call("DELETE", `/sprints/${s.id}/cards/${elsewhere.id}`, undefined, w.member.token), 404, "not_found", "in another sprint");
});

test("an archived card keeps its sprint, leaves the sprint's card list, and removing it is 409 card_archived", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s = await mkSprint(api, w.project.id, w.owner);
  const a = await createCard(api, w.cols[0], w.member, { title: "a", sprintId: s.id });
  const b = await createCard(api, w.cols[0], w.member, { title: "b", sprintId: s.id });
  const archived = await ok(api, 200, "POST", `/cards/${a.id}/archive`, undefined, w.member.token);
  assert.equal(archived.sprintId, s.id);
  assert.deepEqual(await sprintCardIds(api, s.id, w.member.token), [b.id]);
  assertError(await api.call("DELETE", `/sprints/${s.id}/cards/${a.id}`, undefined, w.member.token), 409, "card_archived");
  assert.equal(await sprintOf(api, a.id, w.member.token), s.id);
});

test("a card's sprintId is null or a planned or active sprint of its project; PATCH sprintId is audited and emitted as card.updated", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const s0 = await mkSprint(api, w.project.id, w.owner, { name: "S0" });
  await start(api, s0.id, w.owner);
  await complete(api, s0.id, w.owner);
  const planned = await mkSprint(api, w.project.id, w.owner, { name: "planned" });
  const active = await mkSprint(api, w.project.id, w.owner, { name: "active" });
  await start(api, active.id, w.owner);
  const foreign = await mkSprint(api, ops.id, w.owner, { name: "foreign" });
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  for (const [what, v] of [
    ["completed", s0.id],
    ["another project", foreign.id],
    ["unknown", "no-such-sprint"],
    ["not a string", 5],
  ] as const) {
    assertError(await api.call("PATCH", `/cards/${c.id}`, { sprintId: v }, w.member.token), 400, "invalid_body", `PATCH ${what}`);
    assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "n", sprintId: v }, w.member.token), 400, "invalid_body", `create ${what}`);
  }
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  assert.equal((await ok(api, 200, "PATCH", `/cards/${c.id}`, { sprintId: planned.id }, w.member.token)).sprintId, planned.id);
  assert.equal((await ok(api, 200, "PATCH", `/cards/${c.id}`, { sprintId: active.id }, w.member.token)).sprintId, active.id);
  assert.equal((await ok(api, 200, "PATCH", `/cards/${c.id}`, { sprintId: null }, w.member.token)).sprintId, null);
  assert.deepEqual(await log.names(), ["card.updated", "card.updated", "card.updated"]);
  assert.deepEqual((await log.events(3)).map((e) => e.data.fields), [["sprintId"], ["sprintId"], ["sprintId"]]);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetId, e.details]), Array.from({ length: 3 }, () => ["card.updated", c.id, { fields: ["sprintId"] }]));
  const created = await createCard(api, w.cols[0], w.member, { title: "n", sprintId: active.id });
  assert.equal(created.sprintId, active.id);
});

test("GET sprint cards lists its non-archived cards by number ascending, however they joined", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s = await mkSprint(api, w.project.id, w.owner);
  const n: any[] = [];
  for (let i = 1; i <= 4; i++) n.push(await createCard(api, w.cols[(i - 1) % 3], w.member, { title: `n${i}` }));
  await addCards(api, s.id, [n[3].id, n[1].id], w.member);
  await ok(api, 200, "PATCH", `/cards/${n[2].id}`, { sprintId: s.id }, w.member.token);
  await addCards(api, s.id, [n[0].id], w.member);
  assert.deepEqual(await sprintCardIds(api, s.id, w.viewer.token), [n[0].id, n[1].id, n[2].id, n[3].id]);
  await ok(api, 200, "POST", `/cards/${n[1].id}/archive`, undefined, w.member.token);
  assert.deepEqual(await sprintCardIds(api, s.id, w.viewer.token), [n[0].id, n[2].id, n[3].id]);
});

test("burndown has one entry per date; dates after today are null; remaining sums points of cards not completed before the end of each date", async (t) => {
  const clock = new Clock(Date.parse("2026-03-03T09:00:00.000Z"));
  const api = await startApp(t, { now: clock.now, tokenTtlMs: LONG_TTL });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner, { startDate: "2026-03-03", endDate: "2026-03-08" });
  const card: Record<string, any> = {};
  for (const [k, points] of [
    ["a", 5],
    ["b", 3],
    ["c", 2],
    ["d", null],
    ["e", 8],
  ] as const) {
    card[k] = await createCard(api, w.cols[0], w.member, { title: k, points, sprintId: s.id });
  }
  await ok(api, 200, "POST", `/cards/${card.e.id}/archive`, undefined, w.member.token);
  clock.set(Date.parse("2026-03-04T10:00:00.000Z"));
  await ok(api, 200, "POST", `/cards/${card.a.id}/move`, { columnId: w.cols[2] }, w.member.token);
  clock.set(Date.parse("2026-03-05T12:00:00.000Z"));
  await ok(api, 200, "POST", `/cards/${card.b.id}/move`, { columnId: w.cols[2] }, w.member.token);
  const res = await ok(api, 200, "GET", `/sprints/${s.id}/burndown`, undefined, w.viewer.token);
  assert.equal(res.sprintId, s.id);
  assert.deepEqual(res.days, [
    { date: "2026-03-03", remaining: 10 },
    { date: "2026-03-04", remaining: 5 },
    { date: "2026-03-05", remaining: 2 },
    { date: "2026-03-06", remaining: null },
    { date: "2026-03-07", remaining: null },
    { date: "2026-03-08", remaining: null },
  ]);
});

test("burndown reads the current cards: a reopened card counts on every past date, and a card added later counts too", async (t) => {
  const clock = new Clock(Date.parse("2026-03-01T12:00:00.000Z"));
  const api = await startApp(t, { now: clock.now, tokenTtlMs: LONG_TTL });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner, { startDate: "2026-03-01", endDate: "2026-03-03" });
  const a = await createCard(api, w.cols[2], w.member, { title: "a", points: 5, sprintId: s.id });
  clock.set(Date.parse("2026-03-03T08:00:00.000Z"));
  const before = await ok(api, 200, "GET", `/sprints/${s.id}/burndown`, undefined, w.member.token);
  assert.deepEqual(before.days.map((d: any) => d.remaining), [0, 0, 0]);
  await ok(api, 200, "POST", `/cards/${a.id}/move`, { columnId: w.cols[0] }, w.member.token);
  await createCard(api, w.cols[1], w.member, { title: "late", points: 2, sprintId: s.id });
  const after = await ok(api, 200, "GET", `/sprints/${s.id}/burndown`, undefined, w.member.token);
  assert.deepEqual(after.days, [
    { date: "2026-03-01", remaining: 7 },
    { date: "2026-03-02", remaining: 7 },
    { date: "2026-03-03", remaining: 7 },
  ]);
});

test("velocity lists completed sprints most recently completed first, takes the first count, and rounds the average to 2 decimals", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const plan: { name: string; done: number[]; open: number[] }[] = [
    { name: "S1", done: [5, 3], open: [] },
    { name: "S2", done: [1], open: [2] },
    { name: "S3", done: [2], open: [] },
    { name: "S4", done: [1, 1], open: [3] },
  ];
  const made: { id: string; name: string; committed: number; completed: number }[] = [];
  for (const p of plan) {
    const s = await mkSprint(api, w.project.id, w.owner, { name: p.name });
    for (const points of p.done) await createCard(api, w.cols[2], w.member, { title: `${p.name} done`, points, sprintId: s.id });
    for (const points of p.open) await createCard(api, w.cols[0], w.member, { title: `${p.name} open`, points, sprintId: s.id });
    clock.advance(60_000);
    assertStatus(await start(api, s.id, w.owner), 200);
    clock.advance(60_000);
    assertStatus(await complete(api, s.id, w.owner), 200);
    const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0);
    made.push({ id: s.id, name: p.name, committed: sum(p.done) + sum(p.open), completed: sum(p.done) });
  }
  const expect = (n: number) => {
    const items = [...made].reverse().slice(0, n);
    const mean = items.reduce((x, s) => x + s.completed, 0) / items.length;
    return {
      items: items.map((s) => ({ sprintId: s.id, name: s.name, committedPoints: s.committed, completedPoints: s.completed })),
      average: Math.round(mean * 100) / 100,
    };
  };
  const def = await ok(api, 200, "GET", `/projects/${w.project.id}/velocity`, undefined, w.viewer.token);
  assert.deepEqual(def, expect(3));
  assert.equal(def.average, 1.67, "(2 + 2 + 1) / 3");
  assert.deepEqual(await ok(api, 200, "GET", `/projects/${w.project.id}/velocity?count=4`, undefined, w.viewer.token), expect(4));
  assert.deepEqual(await ok(api, 200, "GET", `/projects/${w.project.id}/velocity?count=1`, undefined, w.viewer.token), expect(1));
});

test("velocity ties on completedAt put the later-created sprint first; no completed sprint gives average null; a bad count is invalid_query", async (t) => {
  const api = await startApp(t, { now: new Clock().now });
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const empty = await ok(api, 200, "GET", `/projects/${ops.id}/velocity`, undefined, w.member.token);
  assert.deepEqual(empty, { items: [], average: null });
  const x = await mkSprint(api, w.project.id, w.owner, { name: "X" });
  const y = await mkSprint(api, w.project.id, w.owner, { name: "Y" });
  await createCard(api, w.cols[2], w.member, { title: "x", points: 3, sprintId: x.id });
  await start(api, y.id, w.owner);
  await complete(api, y.id, w.owner);
  await start(api, x.id, w.owner);
  await complete(api, x.id, w.owner);
  const v = await ok(api, 200, "GET", `/projects/${w.project.id}/velocity`, undefined, w.member.token);
  assert.deepEqual(v.items.map((i: any) => i.name), ["Y", "X"], "same completedAt: the later-created first");
  assert.equal(v.average, 1.5);
  for (const q of ["0", "21", "abc", "", "1.5"]) {
    assertError(await api.call("GET", `/projects/${w.project.id}/velocity?count=${q}`, undefined, w.member.token), 400, "invalid_query", q);
  }
  assertStatus(await api.call("GET", `/projects/${w.project.id}/velocity?count=20`, undefined, w.member.token), 200);
});

test("sprint writes are audited: created, updated with sorted fields, started, completed with carryOverTo, deleted; failed writes add nothing", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  const s1 = await mkSprint(api, w.project.id, w.admin, { name: "S1" });
  const s2 = await mkSprint(api, w.project.id, w.admin, { name: "S2" });
  const s3 = await mkSprint(api, w.project.id, w.admin, { name: "S3" });
  await ok(api, 200, "PATCH", `/sprints/${s1.id}`, { name: "One", goal: "g" }, w.owner.token);
  await start(api, s1.id, w.owner);
  assertError(await start(api, s2.id, w.owner), 409, "sprint_active");
  await complete(api, s1.id, w.owner, { carryOverTo: s2.id });
  await start(api, s2.id, w.owner);
  await complete(api, s2.id, w.owner);
  await ok(api, 204, "DELETE", `/sprints/${s3.id}`, undefined, w.owner.token);
  const entries = (await auditLog(api, w.owner.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.details]),
    [
      ["sprint.created", "sprint", s1.id, w.admin.id, {}],
      ["sprint.created", "sprint", s2.id, w.admin.id, {}],
      ["sprint.created", "sprint", s3.id, w.admin.id, {}],
      ["sprint.updated", "sprint", s1.id, w.owner.id, { fields: ["goal", "name"] }],
      ["sprint.started", "sprint", s1.id, w.owner.id, {}],
      ["sprint.completed", "sprint", s1.id, w.owner.id, { carryOverTo: s2.id }],
      ["sprint.started", "sprint", s2.id, w.owner.id, {}],
      ["sprint.completed", "sprint", s2.id, w.owner.id, { carryOverTo: null }],
      ["sprint.deleted", "sprint", s3.id, w.owner.id, {}],
    ],
  );
});

test("start and complete emit sprint.started and sprint.completed with the sprint snapshot; carried-over cards emit nothing", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner);
  const next = await mkSprint(api, w.project.id, w.owner, { name: "next" });
  const open = await createCard(api, w.cols[0], w.member, { title: "open", points: 5, sprintId: s.id });
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(1000);
  await start(api, s.id, w.owner);
  clock.advance(1000);
  await complete(api, s.id, w.owner, { carryOverTo: next.id });
  assert.deepEqual(await log.names(), ["sprint.started", "sprint.completed"]);
  const [started, completed] = await log.events(2);
  assert.equal(started.data.sprint.id, s.id);
  assert.equal(started.data.sprint.state, "active");
  assert.equal(started.data.sprint.committedPoints, 5);
  assert.equal(started.actorId, w.owner.id);
  assert.equal(started.teamId, w.team.id);
  assert.equal(completed.data.sprint.state, "completed");
  assert.equal(completed.data.sprint.completedPoints, 0);
  assert.equal(completed.occurredAt, clock.iso());
  const o = await getCard(api, open.id, w.member.token);
  assert.equal(o.sprintId, next.id);
  assert.equal(o.updatedAt, open.updatedAt);
});

test("an archived project answers 409 project_archived on every sprint write, before sprint_state; reads still work", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const active = await mkSprint(api, w.project.id, w.owner, { name: "active" });
  const planned = await mkSprint(api, w.project.id, w.owner, { name: "planned" });
  await start(api, active.id, w.owner);
  const c = await createCard(api, w.cols[0], w.member, { title: "c", sprintId: planned.id });
  const free = await createCard(api, w.cols[0], w.member, { title: "free" });
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", `/projects/${w.project.id}/sprints`, { name: "S", startDate: "2026-03-01", endDate: "2026-03-02" }, w.owner.token), 409, "project_archived", "create");
  assertError(await api.call("PATCH", `/sprints/${planned.id}`, { name: "x" }, w.owner.token), 409, "project_archived", "PATCH");
  assertError(await api.call("DELETE", `/sprints/${planned.id}`, undefined, w.owner.token), 409, "project_archived", "DELETE");
  assertError(await start(api, active.id, w.owner), 409, "project_archived", "start an active sprint: project_archived first");
  assertError(await complete(api, active.id, w.owner), 409, "project_archived", "complete");
  assertError(await addCards(api, planned.id, [free.id], w.member), 409, "project_archived", "add cards");
  assertError(await api.call("DELETE", `/sprints/${planned.id}/cards/${c.id}`, undefined, w.member.token), 409, "project_archived", "remove a card");
  await ok(api, 200, "GET", `/projects/${w.project.id}/sprints`, undefined, w.viewer.token);
  await ok(api, 200, "GET", `/sprints/${planned.id}/cards`, undefined, w.viewer.token);
  await ok(api, 200, "GET", `/sprints/${planned.id}/burndown`, undefined, w.viewer.token);
  await ok(api, 200, "GET", `/projects/${w.project.id}/velocity`, undefined, w.viewer.token);
  assert.equal((await ok(api, 200, "GET", `/sprints/${active.id}`, undefined, w.viewer.token)).state, "active");
});

test("the add_to_sprint action puts the card in the active sprint as the rule's creator, and fails not_found when there is none", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner);
  await start(api, s.id, w.owner);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "add_to_sprint", sprintId: "active" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  const card = await createCard(api, w.cols[0], w.member, { title: "auto" });
  assert.equal(card.sprintId, s.id, "the response shows the state after the rules ran");
  const runs1 = await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token);
  const via = { type: "rule", ruleId: rule.id, runId: runs1.items[0].id };
  assert.deepEqual(await log.names(), ["card.created", "card.updated"]);
  const [created, updated] = await log.events(2);
  assert.equal(created.data.card.sprintId, null);
  assert.deepEqual(updated.data.fields, ["sprintId"]);
  assert.equal(updated.data.card.sprintId, s.id);
  assert.equal(updated.actorId, w.admin.id);
  assert.deepEqual(updated.via, via);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.via, e.details]),
    [
      ["card.created", "card", card.id, w.member.id, null, {}],
      ["sprint.cards_added", "sprint", s.id, w.admin.id, via, { cardIds: [card.id] }],
    ],
  );
  await complete(api, s.id, w.owner);
  const second = await createCard(api, w.cols[0], w.member, { title: "no sprint" });
  assert.equal(second.sprintId, null);
  const runs2 = await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token);
  assert.deepEqual(
    [runs2.items[0].cardId, runs2.items[0].status, runs2.items[0].error, runs2.items[0].actions],
    [second.id, "failed", "not_found", [{ type: "add_to_sprint", status: "failed", error: "not_found" }]],
  );
});

test("API keys and idempotency on sprint routes: admin+ routes need an admin key before 404, card lists a write key, and a replay creates one sprint", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner, { name: "first" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const readKey = (await createApiKey(api, w.owner, { scope: "read" })).secret;
  const writeKey = (await createApiKey(api, w.owner, { scope: "write" })).secret;
  const adminKey = (await createApiKey(api, w.owner, { scope: "admin" })).secret;
  const body = { name: "keyed", startDate: "2026-03-01", endDate: "2026-03-07" };
  assertError(await api.call("POST", `/projects/no-such-project/sprints`, body, writeKey), 403, "insufficient_scope", "before 404");
  assertError(await start(api, s.id, writeKey), 403, "insufficient_scope", "start is admin+");
  assertError(await addCards(api, s.id, [card.id], readKey), 403, "insufficient_scope", "read key adds cards");
  assertStatus(await addCards(api, s.id, [card.id], writeKey), 200, "write key adds cards");
  await ok(api, 200, "GET", `/sprints/${s.id}/burndown`, undefined, readKey);
  const first = await api.call("POST", `/projects/${w.project.id}/sprints`, body, adminKey, { idem: "sprint-1" });
  assertStatus(first, 201);
  clock.advance(1000);
  const again = await api.call("POST", `/projects/${w.project.id}/sprints`, body, w.owner.token, { idem: "sprint-1" });
  assertStatus(again, 201);
  assert.equal(again.text, first.text, "the same user with another credential gets the replay");
  assert.equal(again.headers.get("idempotency-replayed"), "true");
  assertError(await api.call("POST", `/projects/${w.project.id}/sprints`, { ...body, name: "other" }, adminKey, { idem: "sprint-1" }), 409, "idempotency_conflict");
  const list = await ok(api, 200, "GET", `/projects/${w.project.id}/sprints`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((x: any) => x.name).sort(), ["first", "keyed"]);
  const created = (await auditLog(api, w.owner.token, w.team.id)).filter((e) => e.action === "sprint.created");
  assert.equal(created.length, 2);
  assert.equal(created[1].actorId, w.owner.id, "a key acts as its owner");
});

test("deleting a sprint disables the rules whose add_to_sprint action references it; a rule using active stays enabled", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s = await mkSprint(api, w.project.id, w.owner);
  const byId = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "add_to_sprint", sprintId: s.id }] });
  const byActive = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "add_to_sprint", sprintId: "active" }] });
  assert.deepEqual(byId.actions, [{ type: "add_to_sprint", sprintId: s.id }]);
  await ok(api, 204, "DELETE", `/sprints/${s.id}`, undefined, w.owner.token);
  const n1 = await ok(api, 200, "GET", `/rules/${byId.id}`, undefined, w.admin.token);
  const n2 = await ok(api, 200, "GET", `/rules/${byActive.id}`, undefined, w.admin.token);
  assert.equal(n1.enabled, false);
  assert.deepEqual(n1.actions, byId.actions, "the definition is unchanged");
  assert.equal(n1.updatedAt, byId.updatedAt);
  assert.equal(n2.enabled, true);
  assertError(await api.call("PATCH", `/rules/${byId.id}`, { enabled: true }, w.admin.token), 400, "invalid_body", "re-enabling checks the references");
});
