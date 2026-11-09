// Area `time`: instruction.md section 29 (Time tracking): manual entries, one running timer per user,
// and the card's minutesLogged.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Api,
  addMember,
  assertError,
  auditLog,
  Clock,
  createApiKey,
  createBoard,
  createCard,
  createProject,
  eventLog,
  getCard,
  ok,
  setupBoard,
  tempDir,
  type User,
} from "./helpers.ts";
import { archive, assertKeys, startApp } from "./helpers-pipeline.ts";

const MIN = 60_000;
const log = (api: Api, cardId: string, u: User, body: Record<string, unknown>) => api.call("POST", `/cards/${cardId}/time-entries`, body, u.token);
const startTimer = (api: Api, cardId: string, u: User | string) => api.call("POST", `/cards/${cardId}/timer/start`, undefined, typeof u === "string" ? u : u.token);
const stopTimer = (api: Api, cardId: string, u: User) => api.call("POST", `/cards/${cardId}/timer/stop`, undefined, u.token);
const timer = async (api: Api, token: string): Promise<any> => (await ok(api, 200, "GET", "/me/timer", undefined, token)).timer;

test("a manual time entry has the documented shape: the caller, source manual, date today by default and an empty note", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  clock.advance(5000);
  const res = await log(api, card.id, w.member, { minutes: 45 });
  assert.equal(res.status, 201);
  assertKeys(res.body, ["id", "cardId", "userId", "minutes", "date", "note", "source", "createdAt"], "time entry");
  assert.deepEqual(
    [res.body.cardId, res.body.userId, res.body.minutes, res.body.date, res.body.note, res.body.source, res.body.createdAt],
    [card.id, w.member.id, 45, "2026-03-01", "", "manual", clock.iso()],
  );
  const withNote = (await log(api, card.id, w.admin, { minutes: 1, date: "2025-12-31", note: "late entry" })).body;
  assert.deepEqual([withNote.date, withNote.note, withNote.userId], ["2025-12-31", "late entry", w.admin.id]);
});

test("minutes must be an integer 1 to 1440, date a real date not after today, note at most 500 chars", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const bad: Record<string, unknown>[] = [
    {},
    { minutes: 0 },
    { minutes: 1441 },
    { minutes: 1.5 },
    { minutes: "5" },
    { minutes: 5, date: "2026-03-02" },
    { minutes: 5, date: "2026-02-30" },
    { minutes: 5, date: 20260301 },
    { minutes: 5, note: "n".repeat(501) },
    { minutes: 5, note: 3 },
  ];
  for (const body of bad) assertError(await log(api, card.id, w.member, body), 400, "invalid_body", JSON.stringify(body).slice(0, 60));
  assert.equal((await log(api, card.id, w.member, { minutes: 1440, date: "2026-03-01", note: "n".repeat(500) })).status, 201);
  assert.equal((await log(api, card.id, w.member, { minutes: 1 })).status, 201);
  clock.set(Date.parse("2026-03-02T00:00:00.000Z"));
  assert.equal((await log(api, card.id, w.member, { minutes: 5, date: "2026-03-02" })).status, 201, "today moves with the clock");
});

test("the card's minutesLogged is the sum of its entries and follows deletes; entries list oldest first", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.equal(card.minutesLogged, 0);
  const a = (await log(api, card.id, w.member, { minutes: 30 })).body;
  clock.advance(1000);
  const b = (await log(api, card.id, w.admin, { minutes: 15 })).body;
  clock.advance(1000);
  const c = (await log(api, card.id, w.member, { minutes: 5 })).body;
  assert.equal((await getCard(api, card.id, w.viewer.token)).minutesLogged, 50);
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${card.id}/time-entries`, undefined, w.viewer.token)).items.map((e: any) => e.id), [a.id, b.id, c.id]);
  await ok(api, 204, "DELETE", `/time-entries/${b.id}`, undefined, w.admin.token);
  assert.equal((await getCard(api, card.id, w.viewer.token)).minutesLogged, 35);
  assert.equal((await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.viewer.token)).items[0].minutesLogged, 35);
});

test("viewers read time entries but get 403 on logging and timers; non-members get 404", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await log(api, card.id, w.member, { minutes: 5 });
  await ok(api, 200, "GET", `/cards/${card.id}/time-entries`, undefined, w.viewer.token);
  assertError(await log(api, card.id, w.viewer, { minutes: 5 }), 403, "forbidden");
  assertError(await startTimer(api, card.id, w.viewer), 403, "forbidden");
  assertError(await stopTimer(api, card.id, w.viewer), 403, "forbidden");
  assertError(await api.call("GET", `/cards/${card.id}/time-entries`, undefined, w.outsider.token), 404, "not_found");
  assertError(await log(api, card.id, w.outsider, { minutes: 5 }), 404, "not_found");
  assertError(await startTimer(api, "no-such-card", w.member), 404, "not_found");
});

test("starting a timer answers { cardId, startedAt } and GET /me/timer shows it; a second start anywhere, another team included, is 409 timer_running", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const other = await setupBoard(api, clock);
  await addMember(api, other.team.id, other.owner, w.member, "member");
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  const elsewhere = await createCard(api, other.cols[0], other.member, { title: "x" });
  assert.equal(await timer(api, w.member.token), null);
  clock.advance(1000);
  const res = await startTimer(api, a.id, w.member);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { cardId: a.id, startedAt: clock.iso() });
  assert.deepEqual(await timer(api, w.member.token), { cardId: a.id, startedAt: clock.iso() });
  for (const id of [a.id, b.id, elsewhere.id]) assertError(await startTimer(api, id, w.member), 409, "timer_running", id);
  assert.equal((await startTimer(api, b.id, w.admin)).status, 200, "timers are per user");
});

test("stop creates a timer entry dated today with minutes = min(1440, max(1, Math.round(elapsed / 60000))) and ends the timer", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const cases: [number, number][] = [[90_000, 2], [29_000, 1], [0, 1], [30_000, 1], [150_000, 3], [25 * 60 * MIN, 1440]];
  for (const [elapsed, minutes] of cases) {
    await startTimer(api, card.id, w.member);
    clock.advance(elapsed);
    const res = await stopTimer(api, card.id, w.member);
    assert.equal(res.status, 201);
    assert.deepEqual([res.body.minutes, res.body.source, res.body.date, res.body.userId, res.body.note], [minutes, "timer", new Date(clock.t).toISOString().slice(0, 10), w.member.id, ""], `elapsed ${elapsed}`);
    assert.equal(await timer(api, w.member.token), null);
  }
  assert.equal((await getCard(api, card.id, w.member.token)).minutesLogged, 2 + 1 + 1 + 1 + 3 + 1440);
});

test("stop answers 409 no_timer unless the caller's running timer is on this card", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  assertError(await stopTimer(api, a.id, w.member), 409, "no_timer");
  await startTimer(api, a.id, w.admin);
  assertError(await stopTimer(api, a.id, w.member), 409, "no_timer", "another user's timer");
  await startTimer(api, b.id, w.member);
  assertError(await stopTimer(api, a.id, w.member), 409, "no_timer", "a timer on another card");
  assert.deepEqual((await timer(api, w.member.token)).cardId, b.id);
});

test("a timer cannot start on an archived card or in an archived project, but a running one stops there", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  await startTimer(api, b.id, w.admin);
  await archive(api, a.id, w.member);
  assertError(await startTimer(api, a.id, w.member), 409, "card_archived");
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await startTimer(api, b.id, w.member), 409, "project_archived");
  assertError(await log(api, b.id, w.member, { minutes: 5 }), 409, "project_archived");
  clock.advance(5 * MIN);
  const stopped = await stopTimer(api, b.id, w.admin);
  assert.equal(stopped.status, 201);
  assert.equal(stopped.body.minutes, 5);
});

test("DELETE of a time entry: its user may always delete it, even as a viewer; others need admin+; non-members get 404", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const mine = (await log(api, card.id, w.member, { minutes: 5 })).body;
  const theirs = (await log(api, card.id, w.admin, { minutes: 6 })).body;
  const third = (await log(api, card.id, w.admin, { minutes: 7 })).body;
  assertError(await api.call("DELETE", `/time-entries/${theirs.id}`, undefined, w.member.token), 403, "forbidden");
  assertError(await api.call("DELETE", `/time-entries/${theirs.id}`, undefined, w.outsider.token), 404, "not_found");
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.member.id}`, { role: "viewer" }, w.owner.token);
  await ok(api, 204, "DELETE", `/time-entries/${mine.id}`, undefined, w.member.token);
  await ok(api, 204, "DELETE", `/time-entries/${theirs.id}`, undefined, w.owner.token);
  assertError(await api.call("DELETE", `/time-entries/${theirs.id}`, undefined, w.owner.token), 404, "not_found");
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${card.id}/time-entries`, undefined, w.owner.token)).items.map((e: any) => e.id), [third.id]);
});

test("time entries emit no events; logging and timer stops are audited as time.logged with minutes, deletes as time.deleted, timers not at all", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const events = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  const manual = (await log(api, card.id, w.member, { minutes: 20 })).body;
  await startTimer(api, card.id, w.member);
  clock.advance(3 * MIN);
  const timed = (await stopTimer(api, card.id, w.member)).body;
  await ok(api, 204, "DELETE", `/time-entries/${manual.id}`, undefined, w.admin.token);
  assert.deepEqual(await events.names(), []);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.details]), [
    ["time.logged", "time_entry", manual.id, w.member.id, { minutes: 20 }],
    ["time.logged", "time_entry", timed.id, w.member.id, { minutes: 3 }],
    ["time.deleted", "time_entry", manual.id, w.admin.id, {}],
  ]);
});

test("a running timer is discarded when its card is deleted and when its user leaves the card's team", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  await startTimer(api, a.id, w.member);
  await ok(api, 204, "DELETE", `/cards/${a.id}`, undefined, w.admin.token);
  assert.equal(await timer(api, w.member.token), null);
  assert.equal((await startTimer(api, b.id, w.member)).status, 200, "nothing is running any more");
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.owner.token);
  assert.equal(await timer(api, w.member.token), null);
  const own = await ok(api, 201, "POST", "/teams", { name: "Own" }, w.member.token);
  const p = await createProject(api, own.id, w.member, "OWN");
  const board = await createBoard(api, p.id, w.member);
  const c = await createCard(api, board.columns[0].id, w.member, { title: "c" });
  assert.equal((await startTimer(api, c.id, w.member)).status, 200);
});

test("a team-restricted API key sees { timer: null } for a timer on a card of another team, and acts as its owner", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.member.token);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const key = (await createApiKey(api, w.member, { scope: "write", teamId: other.id })).secret;
  const full = (await createApiKey(api, w.member, { scope: "write" })).secret;
  await startTimer(api, card.id, full);
  assert.equal((await timer(api, w.member.token)).cardId, card.id);
  assert.equal(await timer(api, key), null);
  assert.equal((await timer(api, full)).cardId, card.id);
  assertError(await startTimer(api, card.id, key), 404, "not_found", "the key sees nothing of the first team");
});

test("deleting a time entry still works in an archived project and on an archived card", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = (await log(api, card.id, w.member, { minutes: 5 })).body;
  const b = (await log(api, card.id, w.member, { minutes: 6 })).body;
  await archive(api, card.id, w.member);
  await ok(api, 204, "DELETE", `/time-entries/${a.id}`, undefined, w.member.token);
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  await ok(api, 204, "DELETE", `/time-entries/${b.id}`, undefined, w.member.token);
  assert.equal((await getCard(api, card.id, w.member.token)).minutesLogged, 0);
});

test("time entries and a running timer survive a restart", async (t) => {
  const clock = new Clock();
  const dataFile = join(tempDir(t), "tracker.json");
  const api1 = await startApp(t, { now: clock.now, dataFile });
  const w = await setupBoard(api1, clock);
  const card = await createCard(api1, w.cols[0], w.member, { title: "c" });
  const entry = (await log(api1, card.id, w.member, { minutes: 12 })).body;
  const started = (await startTimer(api1, card.id, w.member)).body;
  await api1.close();
  clock.advance(7 * MIN);
  const api2 = await startApp(t, { now: clock.now, dataFile });
  assert.deepEqual(await timer(api2, w.member.token), started);
  assert.deepEqual((await ok(api2, 200, "GET", `/cards/${card.id}/time-entries`, undefined, w.member.token)).items, [entry]);
  const stopped = (await stopTimer(api2, card.id, w.member)).body;
  assert.equal(stopped.minutes, 7);
  assert.equal((await getCard(api2, card.id, w.member.token)).minutesLogged, 19);
});

test("a timer that runs past midnight is dated the day it stops", async (t) => {
  const clock = new Clock(Date.parse("2026-03-01T23:30:00.000Z"));
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await startTimer(api, card.id, w.member);
  clock.set(Date.parse("2026-03-02T00:45:00.000Z"));
  const res = await stopTimer(api, card.id, w.member);
  assert.deepEqual([res.body.date, res.body.minutes], ["2026-03-02", 75]);
});
