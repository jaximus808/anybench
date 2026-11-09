// Area `cards`: instruction.md section 5 (Cards): shape, numbering, normalisation, positions,
// moves, completion, blocked, WIP, quota and the due job, with the pipeline of section 0.8 and
// the scheduler of section 0.9.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  assertDetails,
  assertError,
  assertQuota,
  assertStatus,
  auditLog,
  cardIds,
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
  startApp,
  startOf,
  upload,
} from "./helpers.ts";

const CARD_KEYS = [
  "archived",
  "archivedAt",
  "assigneeId",
  "blocked",
  "boardId",
  "checklist",
  "columnId",
  "completedAt",
  "createdAt",
  "createdBy",
  "customFields",
  "description",
  "dueDate",
  "id",
  "key",
  "labels",
  "minutesLogged",
  "number",
  "points",
  "position",
  "priority",
  "sprintId",
  "title",
  "updatedAt",
];

test("a card has the documented shape and defaults, key <project key>-<number> and createdBy", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  clock.advance(1000);
  const res = await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "  Write the parser  ", blocked: true, archived: true, minutesLogged: 9 }, w.member.token);
  assertStatus(res, 201);
  const c = res.body;
  assert.deepEqual(Object.keys(c).sort(), CARD_KEYS);
  assert.equal(typeof c.id, "string");
  const { id: _id, ...rest } = c;
  assert.deepEqual(rest, {
    number: 1,
    key: "ENG-1",
    boardId: w.board.id,
    columnId: w.cols[0],
    position: 0,
    title: "Write the parser",
    description: "",
    assigneeId: null,
    labels: [],
    dueDate: null,
    priority: "none",
    points: null,
    sprintId: null,
    customFields: {},
    checklist: { total: 0, done: 0 },
    blocked: false,
    completedAt: null,
    minutesLogged: 0,
    archived: false,
    archivedAt: null,
    createdBy: w.member.id,
    createdAt: clock.iso(),
    updatedAt: clock.iso(),
  });
  assert.deepEqual(await ok(api, 200, "GET", `/cards/${c.id}`, undefined, w.viewer.token), c);
  const full = await createCard(api, w.cols[1], w.admin, {
    title: "Full",
    description: "d".repeat(10000),
    assigneeId: w.member.id,
    labels: ["x"],
    dueDate: "2026-12-31",
    priority: "urgent",
    points: 21,
  });
  assert.equal(full.key, "ENG-2");
  assert.equal(full.description.length, 10000);
  assert.equal(full.assigneeId, w.member.id);
  assert.equal(full.dueDate, "2026-12-31");
  assert.equal(full.priority, "urgent");
  assert.equal(full.points, 21);
  assert.equal(full.createdBy, w.admin.id);
  assertError(await api.call("GET", "/cards/nope", undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/cards/${c.id}`, undefined, w.outsider.token), 404, "not_found", "outsider");
});

test("card numbers count per project across its boards and are never reused after a delete", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const second = await createBoard(api, w.project.id, w.owner, { name: "Second" });
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, second.columns[0].id, w.member, { title: "b" });
  const c = await createCard(api, w.cols[2], w.member, { title: "c" });
  assert.deepEqual([a.number, b.number, c.number], [1, 2, 3]);
  assert.deepEqual([a.key, b.key, c.key], ["ENG-1", "ENG-2", "ENG-3"]);
  assertStatus(await api.call("DELETE", `/cards/${c.id}`, undefined, w.member.token), 204);
  const d = await createCard(api, second.columns[1].id, w.member, { title: "d" });
  assert.equal(d.number, 4, "3 is not reused");
  assert.equal(d.key, "ENG-4");
  const ops = await createProject(api, w.team.id, w.owner, "OPS9");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  const e = await createCard(api, opsBoard.columns[0].id, w.member, { title: "e" });
  assert.equal(e.number, 1, "numbering is per project");
  assert.equal(e.key, "OPS9-1");
});

test("labels are trimmed, lowercased, de-duplicated and sorted; more than 10 distinct is 400", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const col = `/columns/${w.cols[0]}/cards`;
  const c = await createCard(api, w.cols[0], w.member, { title: "l", labels: [" Bug", "bug", "UI ", "api", "BUG"] });
  assert.deepEqual(c.labels, ["api", "bug", "ui"]);
  const twelve = ["a", "A", " a", "b", "B", "c", "C", "d", "D", "e", "E ", "e"];
  assert.deepEqual((await createCard(api, w.cols[0], w.member, { title: "12 to 5", labels: twelve })).labels, ["a", "b", "c", "d", "e"]);
  const ten = Array.from({ length: 10 }, (_, i) => `l${i}`);
  assert.deepEqual((await createCard(api, w.cols[0], w.member, { title: "ten", labels: [...ten].reverse() })).labels, ten);
  assert.deepEqual((await createCard(api, w.cols[0], w.member, { title: "30", labels: ["x".repeat(30)] })).labels, ["x".repeat(30)]);
  assert.deepEqual((await createCard(api, w.cols[0], w.member, { title: "order", labels: ["b", "a10", "a9", "Z"] })).labels, ["a10", "a9", "b", "z"]);
  const bad: [string, unknown][] = [
    ["11 distinct", [...ten, "l10"]],
    ["empty label", ["ok", ""]],
    ["blank label", ["   "]],
    ["31 chars", ["x".repeat(31)]],
    ["non-string label", ["ok", 3]],
    ["not an array", "bug"],
  ];
  for (const [what, labels] of bad) assertError(await api.call("POST", col, { title: "bad", labels }, w.member.token), 400, "invalid_body", what);
  const patched = await ok(api, 200, "PATCH", `/cards/${c.id}`, { labels: ["Zeta", "alpha"] }, w.member.token);
  assert.deepEqual(patched.labels, ["alpha", "zeta"]);
  assertError(await api.call("PATCH", `/cards/${c.id}`, { labels: [...ten, "l10"] }, w.member.token), 400, "invalid_body", "PATCH 11 labels");
});

test("title, description, dueDate, priority, points and sprintId validation, including impossible calendar dates", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const col = `/columns/${w.cols[0]}/cards`;
  for (const dueDate of ["2026-02-28", "2024-02-29", "2026-12-31", null]) {
    const c = await createCard(api, w.cols[0], w.member, { title: "d", dueDate });
    assert.equal(c.dueDate, dueDate);
  }
  for (const dueDate of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-04-31", "2026-2-3", "2026-01-01T00:00:00Z", "tomorrow", 20260101]) {
    assertError(await api.call("POST", col, { title: "d", dueDate }, w.member.token), 400, "invalid_body", `dueDate ${dueDate}`);
  }
  for (const priority of ["none", "low", "medium", "high", "urgent"]) assert.equal((await createCard(api, w.cols[0], w.member, { title: "p", priority })).priority, priority);
  for (const priority of ["URGENT", "critical", "", null, 3]) {
    assertError(await api.call("POST", col, { title: "p", priority }, w.member.token), 400, "invalid_body", `priority ${JSON.stringify(priority)}`);
  }
  for (const points of [0, 1, 2, 3, 5, 8, 13, 21, null]) assert.equal((await createCard(api, w.cols[0], w.member, { title: "p", points })).points, points);
  for (const points of [4, -1, 1.5, "3", 34, 100]) {
    assertError(await api.call("POST", col, { title: "p", points }, w.member.token), 400, "invalid_body", `points ${JSON.stringify(points)}`);
  }
  const bad: [string, unknown][] = [
    ["blank title", { title: "   " }],
    ["201-char title", { title: "t".repeat(201) }],
    ["missing title", {}],
    ["title not a string", { title: 5 }],
    ["10001-char description", { title: "t", description: "d".repeat(10001) }],
    ["description not a string", { title: "t", description: null }],
    ["customFields not an object", { title: "t", customFields: [] }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", col, body, w.member.token), 400, "invalid_body", what);
  assert.equal((await createCard(api, w.cols[0], w.member, { title: "t".repeat(200) })).title.length, 200);
  // sprintId: a planned or active sprint of the card's project.
  const sprint = await ok(api, 201, "POST", `/projects/${w.project.id}/sprints`, { name: "S", startDate: "2026-03-02", endDate: "2026-03-13" }, w.admin.token);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const foreign = await ok(api, 201, "POST", `/projects/${ops.id}/sprints`, { name: "F", startDate: "2026-03-02", endDate: "2026-03-13" }, w.admin.token);
  assert.equal((await createCard(api, w.cols[0], w.member, { title: "s", sprintId: sprint.id })).sprintId, sprint.id);
  for (const [what, sprintId] of [["another project's sprint", foreign.id], ["unknown sprint", "nope"], ["a number", 7]] as const) {
    assertError(await api.call("POST", col, { title: "s", sprintId }, w.member.token), 400, "invalid_body", what);
  }
  const c = await createCard(api, w.cols[0], w.member, { title: "x", dueDate: "2026-05-05", priority: "high", points: 5 });
  const cleared = await ok(api, 200, "PATCH", `/cards/${c.id}`, { dueDate: null, points: null, priority: "none" }, w.member.token);
  assert.deepEqual([cleared.dueDate, cleared.points, cleared.priority], [null, null, "none"]);
  assertError(await api.call("PATCH", `/cards/${c.id}`, { dueDate: "2026-06-31" }, w.member.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/cards/${c.id}`, { title: "" }, w.member.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/cards/${c.id}`, { points: 4 }, w.member.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/cards/${c.id}`, { sprintId: foreign.id }, w.member.token), 400, "invalid_body");
});

test("assigneeId must be an owner, admin or member; the validation order is invalid_body, invalid_assignee, then field values", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const col = `/columns/${w.cols[0]}/cards`;
  for (const u of [w.owner, w.admin, w.member]) {
    assert.equal((await createCard(api, w.cols[0], w.member, { title: "a", assigneeId: u.id })).assigneeId, u.id);
  }
  assertError(await api.call("POST", col, { title: "a", assigneeId: w.viewer.id }, w.member.token), 400, "invalid_assignee", "viewer");
  assertError(await api.call("POST", col, { title: "a", assigneeId: w.outsider.id }, w.member.token), 400, "invalid_assignee", "outsider");
  assertError(await api.call("POST", col, { title: "a", assigneeId: "no-such-user" }, w.member.token), 400, "invalid_assignee", "unknown id");
  assertError(await api.call("POST", col, { title: "a", assigneeId: 42 }, w.member.token), 400, "invalid_body", "a number");
  assertError(await api.call("POST", col, { title: "a", assigneeId: { id: w.member.id } }, w.member.token), 400, "invalid_body", "an object");
  // Every field's own rule first, then the assignee, then the custom field values.
  const size = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Size", type: "number" }, w.admin.token);
  assertError(await api.call("POST", col, { title: "a", assigneeId: w.viewer.id, labels: [""] }, w.member.token), 400, "invalid_body", "bad labels and a viewer assignee");
  assertError(await api.call("POST", col, { title: "a", assigneeId: w.viewer.id, customFields: { [size.id]: "big" } }, w.member.token), 400, "invalid_assignee", "viewer assignee and a bad field value");
  assertDetails(await api.call("POST", col, { title: "a", customFields: { [size.id]: "big" } }, w.member.token), 400, "invalid_field_value", { fieldId: size.id });
  const c = await createCard(api, w.cols[0], w.member, { title: "b", assigneeId: w.member.id });
  assertError(await api.call("PATCH", `/cards/${c.id}`, { assigneeId: w.viewer.id }, w.member.token), 400, "invalid_assignee", "PATCH viewer");
  const cleared = await ok(api, 200, "PATCH", `/cards/${c.id}`, { assigneeId: null }, w.member.token);
  assert.equal(cleared.assigneeId, null);
  // Later role changes don't touch existing assignments.
  const kept = await createCard(api, w.cols[0], w.member, { title: "k", assigneeId: w.admin.id });
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.admin.id}`, { role: "viewer" }, w.owner.token);
  assert.equal((await getCard(api, kept.id, w.owner.token)).assigneeId, w.admin.id);
  assertError(await api.call("PATCH", `/cards/${kept.id}`, { assigneeId: w.admin.id }, w.member.token), 400, "invalid_assignee", "re-sending a now-viewer assignee");
});

test("creating at a position shifts later cards down; deleting closes the gap; neighbours keep updatedAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const a = await createCard(api, w.cols[0], w.member, { title: "A" });
  const b = await createCard(api, w.cols[0], w.member, { title: "B" });
  const c = await createCard(api, w.cols[0], w.member, { title: "C" });
  clock.advance(5000);
  const x = await createCard(api, w.cols[0], w.member, { title: "X", position: 1 });
  assert.equal(x.position, 1);
  const list = await ok(api, 200, "GET", `/boards/${w.board.id}/cards?columnId=${w.cols[0]}`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((k: any) => [k.title, k.position]), [["A", 0], ["X", 1], ["B", 2], ["C", 3]]);
  assert.equal(list.items[2].updatedAt, b.updatedAt, "a shifted neighbour keeps updatedAt");
  assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "Y", position: 5 }, w.member.token), 400, "invalid_body", "position n+1");
  assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "Y", position: -1 }, w.member.token), 400, "invalid_body", "negative");
  assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "Y", position: 1.5 }, w.member.token), 400, "invalid_body", "fraction");
  const end = await createCard(api, w.cols[0], w.member, { title: "Z", position: 4 });
  assert.equal(end.position, 4, "position n is the end");
  assertStatus(await api.call("DELETE", `/cards/${x.id}`, undefined, w.member.token), 204);
  const after = await ok(api, 200, "GET", `/boards/${w.board.id}/cards?columnId=${w.cols[0]}`, undefined, w.owner.token);
  assert.deepEqual(after.items.map((k: any) => [k.id, k.position]), [[a.id, 0], [b.id, 1], [c.id, 2], [end.id, 3]]);
  assertError(await api.call("GET", `/cards/${x.id}`, undefined, w.owner.token), 404, "not_found");
});

test("moving a card to another column of the same board puts it at the requested index; other boards and bad bodies are 400", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const [a, b, c] = [await createCard(api, w.cols[0], w.member, { title: "A" }), await createCard(api, w.cols[0], w.member, { title: "B" }), await createCard(api, w.cols[0], w.member, { title: "C" })];
  const [d, e] = [await createCard(api, w.cols[1], w.member, { title: "D" }), await createCard(api, w.cols[1], w.member, { title: "E" })];
  clock.advance(9000);
  const res = await api.call("POST", `/cards/${b.id}/move`, { columnId: w.cols[1], position: 1 }, w.member.token);
  assertStatus(res, 200);
  assert.equal(res.body.columnId, w.cols[1]);
  assert.equal(res.body.position, 1);
  assert.equal(res.body.updatedAt, clock.iso(), "a move changes the card's updatedAt");
  assert.equal(res.body.number, b.number);
  assert.deepEqual(await cardIds(api, w.owner.token, w.board.id, w.cols[0]), [a.id, c.id]);
  assert.deepEqual(await cardIds(api, w.owner.token, w.board.id, w.cols[1]), [d.id, b.id, e.id]);
  const moved = await ok(api, 200, "POST", `/cards/${a.id}/move`, { columnId: w.cols[1] }, w.member.token);
  assert.equal(moved.position, 3, "default is the end");
  assertError(await api.call("POST", `/cards/${c.id}/move`, { columnId: w.cols[1], position: 5 }, w.member.token), 400, "invalid_body", "beyond k");
  const toEnd = await ok(api, 200, "POST", `/cards/${c.id}/move`, { columnId: w.cols[1], position: 4 }, w.member.token);
  assert.equal(toEnd.position, 4, "position k is allowed");
  assert.deepEqual(await cardIds(api, w.owner.token, w.board.id, w.cols[1]), [d.id, b.id, e.id, a.id, c.id]);
  assert.deepEqual(await cardIds(api, w.owner.token, w.board.id, w.cols[0]), []);
  const eNow = await getCard(api, e.id, w.owner.token);
  assert.equal(eNow.position, 2);
  assert.equal(eNow.updatedAt, e.updatedAt, "a shifted neighbour keeps updatedAt");
  const other = await createBoard(api, w.project.id, w.owner);
  const path = `/cards/${c.id}/move`;
  assertError(await api.call("POST", path, { columnId: other.columns[0].id }, w.member.token), 400, "invalid_body", "another board");
  assertError(await api.call("POST", path, { columnId: "nope" }, w.member.token), 400, "invalid_body", "unknown column");
  assertError(await api.call("POST", path, {}, w.member.token), 400, "invalid_body", "missing");
  assertError(await api.call("POST", path, { columnId: w.cols[0], position: "0" }, w.member.token), 400, "invalid_body", "string position");
  assertError(await api.call("POST", "/cards/nope/move", { columnId: w.cols[1] }, w.member.token), 404, "not_found", "unknown card");
  const now = await getCard(api, c.id, w.owner.token);
  assert.deepEqual([now.columnId, now.boardId, now.position], [w.cols[1], w.board.id, 4]);
});

test("moving within a column reorders it, keeps the others' order, and still emits card.moved and a history entry", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ids: string[] = [];
  for (const title of ["A", "B", "C", "D"]) ids.push((await createCard(api, w.cols[0], w.member, { title })).id);
  const [a, b, c, d] = ids;
  const log = await eventLog(t, api, w.team.id, w.admin);
  assert.equal((await ok(api, 200, "POST", `/cards/${a}/move`, { columnId: w.cols[0], position: 2 }, w.member.token)).position, 2);
  assert.deepEqual(await cardIds(api, w.owner.token, w.board.id, w.cols[0]), [b, c, a, d]);
  await ok(api, 200, "POST", `/cards/${d}/move`, { columnId: w.cols[0], position: 0 }, w.member.token);
  assert.deepEqual(await cardIds(api, w.owner.token, w.board.id, w.cols[0]), [d, b, c, a]);
  const end = await ok(api, 200, "POST", `/cards/${b}/move`, { columnId: w.cols[0] }, w.member.token);
  assert.equal(end.position, 3, "default is the end of the other cards");
  assert.deepEqual(await cardIds(api, w.owner.token, w.board.id, w.cols[0]), [d, c, a, b]);
  assertError(await api.call("POST", `/cards/${c}/move`, { columnId: w.cols[0], position: 4 }, w.member.token), 400, "invalid_body", "k = 3 other cards");
  const list = await ok(api, 200, "GET", `/boards/${w.board.id}/cards?columnId=${w.cols[0]}`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((k: any) => k.position), [0, 1, 2, 3]);
  assert.deepEqual(await log.names(), ["card.moved", "card.moved", "card.moved"]);
  const first = (await log.events(1))[0];
  assert.deepEqual([first.data.fromColumnId, first.data.toColumnId, first.data.card.id, first.data.card.position], [w.cols[0], w.cols[0], a, 2]);
  const history = await ok(api, 200, "GET", `/cards/${a}/history`, undefined, w.viewer.token);
  assert.deepEqual(history.items.map((h: any) => [h.fromColumnId, h.toColumnId]), [[null, w.cols[0]], [w.cols[0], w.cols[0]]]);
});

test("completedAt is set on entering a done column, kept between done columns and on reorder, and cleared on leaving", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const shipped = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "Shipped", category: "done" }, w.admin.token);
  const born = await createCard(api, w.cols[2], w.member, { title: "born done" });
  assert.equal(born.completedAt, clock.iso(), "created in a done column");
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.equal(c.completedAt, null);
  clock.advance(1000);
  const tDone = clock.iso();
  assert.equal((await ok(api, 200, "POST", `/cards/${c.id}/move`, { columnId: w.cols[2] }, w.member.token)).completedAt, tDone, "entering done");
  clock.advance(1000);
  assert.equal((await ok(api, 200, "POST", `/cards/${c.id}/move`, { columnId: w.cols[2], position: 0 }, w.member.token)).completedAt, tDone, "reorder keeps it");
  assert.equal((await ok(api, 200, "POST", `/cards/${c.id}/move`, { columnId: shipped.id }, w.member.token)).completedAt, tDone, "done to done keeps it");
  clock.advance(1000);
  assert.equal((await ok(api, 200, "POST", `/cards/${c.id}/move`, { columnId: w.cols[1] }, w.member.token)).completedAt, null, "leaving done clears it");
  clock.advance(1000);
  assert.equal((await ok(api, 200, "POST", `/cards/${c.id}/move`, { columnId: shipped.id }, w.member.token)).completedAt, clock.iso(), "entering done again");
  assert.equal((await getCard(api, born.id, w.member.token)).completedAt, born.completedAt);
});

test("a blocked card cannot move into a done column (409 blocked, before the WIP limit) but can be created there, move between done columns and leave", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const shipped = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "Shipped", category: "done" }, w.admin.token);
  const blocker = await createCard(api, w.cols[0], w.member, { title: "blocker" });
  const a = await createCard(api, w.cols[1], w.member, { title: "a" });
  await ok(api, 201, "POST", `/cards/${a.id}/blockers`, { blockerId: blocker.id }, w.member.token);
  assert.equal((await getCard(api, a.id, w.member.token)).blocked, true);
  assertError(await api.call("POST", `/cards/${a.id}/move`, { columnId: w.cols[2] }, w.member.token), 409, "blocked", "into a done column");
  await ok(api, 200, "PATCH", `/columns/${shipped.id}`, { wipLimit: 1 }, w.admin.token);
  await createCard(api, shipped.id, w.member, { title: "fills shipped" });
  assertError(await api.call("POST", `/cards/${a.id}/move`, { columnId: shipped.id }, w.member.token), 409, "blocked", "blocked comes before wip_limit_reached");
  assert.equal((await ok(api, 200, "POST", `/cards/${a.id}/move`, { columnId: w.cols[0] }, w.member.token)).columnId, w.cols[0], "a move that is not into done is fine");
  // A card created in a done column, then blocked, can move between done columns and out.
  const d = await createCard(api, w.cols[2], w.member, { title: "d" });
  await ok(api, 201, "POST", `/cards/${d.id}/blockers`, { blockerId: blocker.id }, w.member.token);
  await ok(api, 200, "PATCH", `/columns/${shipped.id}`, { wipLimit: null }, w.admin.token);
  assert.equal((await ok(api, 200, "POST", `/cards/${d.id}/move`, { columnId: shipped.id }, w.member.token)).columnId, shipped.id, "done to done");
  assert.equal((await ok(api, 200, "POST", `/cards/${d.id}/move`, { columnId: w.cols[1] }, w.member.token)).columnId, w.cols[1], "out of done");
  assertError(await api.call("POST", `/cards/${d.id}/move`, { columnId: w.cols[2] }, w.member.token), 409, "blocked", "back into done");
  // Completing the blocker unblocks both.
  await ok(api, 200, "POST", `/cards/${blocker.id}/move`, { columnId: w.cols[2] }, w.member.token);
  assert.equal((await getCard(api, a.id, w.member.token)).blocked, false);
  const done = await ok(api, 200, "POST", `/cards/${a.id}/move`, { columnId: w.cols[2] }, w.member.token);
  assert.equal(done.columnId, w.cols[2]);
  assert.notEqual(done.completedAt, null);
});

test("creating in or moving into a full column is 409 wip_limit_reached; reordering inside it is allowed; archived cards don't count", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 2 }, w.admin.token);
  const x = await createCard(api, w.cols[1], w.member, { title: "x" });
  const y = await createCard(api, w.cols[1], w.member, { title: "y" });
  const z = await createCard(api, w.cols[0], w.member, { title: "z" });
  assertError(await api.call("POST", `/columns/${w.cols[1]}/cards`, { title: "over" }, w.member.token), 409, "wip_limit_reached", "create");
  assertError(await api.call("POST", `/cards/${z.id}/move`, { columnId: w.cols[1], position: 0 }, w.member.token), 409, "wip_limit_reached", "move in");
  // Validation (step 7) comes before the 409 (step 8).
  assertError(await api.call("POST", `/columns/${w.cols[1]}/cards`, { title: "" }, w.member.token), 400, "invalid_body", "invalid body in a full column");
  const re = await ok(api, 200, "POST", `/cards/${y.id}/move`, { columnId: w.cols[1], position: 0 }, w.member.token);
  assert.equal(re.position, 0, "reorder inside a full column");
  assert.deepEqual(await cardIds(api, w.owner.token, w.board.id, w.cols[1]), [y.id, x.id]);
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 1 }, w.admin.token);
  assertError(await api.call("POST", `/cards/${z.id}/move`, { columnId: w.cols[1] }, w.member.token), 409, "wip_limit_reached", "over the limit");
  await ok(api, 200, "POST", `/cards/${x.id}/move`, { columnId: w.cols[0] }, w.member.token);
  assertError(await api.call("POST", `/cards/${z.id}/move`, { columnId: w.cols[1] }, w.member.token), 409, "wip_limit_reached", "at the limit");
  await ok(api, 200, "POST", `/cards/${y.id}/archive`, undefined, w.member.token);
  assert.equal((await ok(api, 200, "POST", `/cards/${z.id}/move`, { columnId: w.cols[1] }, w.member.token)).position, 0, "the archived card frees its WIP slot");
});

test("the cards quota counts every card of the team, archived cards and archived projects included, and is checked before the WIP limit", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  await createCard(api, opsBoard.columns[0].id, w.member, { title: "ops 1" });
  const archivedCard = await createCard(api, w.cols[1], w.member, { title: "archived" });
  await ok(api, 200, "POST", `/cards/${archivedCard.id}/archive`, undefined, w.member.token);
  await ok(api, 200, "PATCH", `/projects/${ops.id}`, { archived: true }, w.owner.token);
  const ids: string[] = [];
  for (let i = 0; i < 98; i++) ids.push((await createCard(api, w.cols[0], w.member, { title: `card ${i}` })).id);
  const plan = await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.member.token);
  assert.equal(plan.usage.cards, 100);
  assertQuota(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "101st" }, w.member.token), "cards", 100, 100, "the 101st card");
  await ok(api, 200, "PATCH", `/columns/${w.cols[2]}`, { wipLimit: 1 }, w.admin.token);
  await ok(api, 200, "POST", `/cards/${ids[0]}/move`, { columnId: w.cols[2] }, w.member.token);
  assertQuota(await api.call("POST", `/columns/${w.cols[2]}/cards`, { title: "full column" }, w.member.token), "cards", 100, 100, "quota before WIP");
  assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "" }, w.member.token), 400, "invalid_body", "validation before the quota");
  assertStatus(await api.call("DELETE", `/cards/${ids[1]}`, undefined, w.member.token), 204);
  assertError(await api.call("POST", `/columns/${w.cols[2]}/cards`, { title: "full column" }, w.member.token), 409, "wip_limit_reached", "room in the quota, none in the column");
  // ENG holds the archived card (1) and the 98 cards (2..99); refused requests use no number and
  // the deleted card's number is not reused.
  const last = await createCard(api, w.cols[0], w.member, { title: "the 100th again" });
  assert.equal(last.number, 100);
  assertQuota(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "again" }, w.member.token), "cards", 100, 100);
});

test("the due job emits card.due once, actor null and via schedule, on the first request at or after the start of the dueDate", async (t) => {
  const clock = new Clock(Date.UTC(2026, 2, 1, 12, 0, 0));
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const card = await createCard(api, w.cols[0], w.member, { title: "due soon", dueDate: "2026-03-03", assigneeId: w.member.id });
  const auditBefore = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.set(startOf("2026-03-03") - 1);
  assertStatus(await api.call("GET", "/health"), 200);
  assert.deepEqual(await log.names(), ["card.created"], "1 ms before the start of the date, nothing");
  clock.set(startOf("2026-03-03") + 5000);
  // Any request runs due jobs first, even an unauthenticated one.
  assertError(await api.call("GET", "/me"), 401, "unauthorized");
  assert.deepEqual(await log.names(), ["card.created", "card.due"]);
  const [, due] = await log.events(2);
  assert.equal(due.actorId, null);
  assert.deepEqual(due.via, { type: "schedule" });
  assert.equal(due.occurredAt, clock.iso());
  assert.equal(due.teamId, w.team.id);
  assert.deepEqual(due.data, { card: await getCard(api, card.id, w.member.token) });
  clock.advance(10 * 86_400_000);
  await getCard(api, card.id, w.member.token);
  assert.deepEqual(await log.names(), ["card.created", "card.due"], "the job runs once");
  const audit = await auditLog(api, w.admin.token, w.team.id);
  assert.equal(audit.length, auditBefore, "the due job appends no audit entry");
});

test("the due job is rescheduled by a new dueDate, cancelled by null, a past date or a delete, and skipped for completed or archived cards", async (t) => {
  const clock = new Clock(Date.UTC(2026, 2, 1, 12, 0, 0));
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const today = clock.today();
  const d1 = addDays(today, 2);
  const d2 = addDays(today, 5);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const cleared = await createCard(api, w.cols[0], w.member, { title: "cleared", dueDate: d1 });
  const moved = await createCard(api, w.cols[0], w.member, { title: "moved later", dueDate: d1 });
  const done = await createCard(api, w.cols[0], w.member, { title: "completed", dueDate: d1 });
  const archived = await createCard(api, w.cols[0], w.member, { title: "archived", dueDate: d1 });
  const deleted = await createCard(api, w.cols[0], w.member, { title: "deleted", dueDate: d1 });
  const pastDue = await createCard(api, w.cols[0], w.member, { title: "today", dueDate: today });
  const frozen = await createCard(api, opsBoard.columns[0].id, w.member, { title: "archived project", dueDate: d1 });
  const later = await createCard(api, w.cols[0], w.member, { title: "set to the past", dueDate: d1 });
  await ok(api, 200, "PATCH", `/cards/${cleared.id}`, { dueDate: null }, w.member.token);
  await ok(api, 200, "PATCH", `/cards/${moved.id}`, { dueDate: d2 }, w.member.token);
  await ok(api, 200, "POST", `/cards/${done.id}/move`, { columnId: w.cols[2] }, w.member.token);
  await ok(api, 200, "POST", `/cards/${archived.id}/archive`, undefined, w.member.token);
  assertStatus(await api.call("DELETE", `/cards/${deleted.id}`, undefined, w.member.token), 204);
  await ok(api, 200, "PATCH", `/projects/${ops.id}`, { archived: true }, w.owner.token);
  await ok(api, 200, "PATCH", `/cards/${later.id}`, { dueDate: "2026-02-01" }, w.member.token);
  const before = (await log.names()).length;
  clock.set(startOf(d1) + 1);
  assertStatus(await api.call("GET", "/health"), 200);
  assert.deepEqual((await log.names()).slice(before), [], "no due event at d1: every d1 job was cancelled or skipped");
  clock.set(startOf(d2));
  assertStatus(await api.call("GET", "/health"), 200);
  const names = await log.names();
  assert.deepEqual(names.slice(before), ["card.due"], "only the rescheduled card is due, at the start of its new date");
  const events = await log.events(names.length);
  assert.equal(events.at(-1).data.card.id, moved.id);
  assert.ok(![pastDue.id, frozen.id].includes(events.at(-1).data.card.id));
});

test("GET board cards lists non-archived cards by column position then card position; ?columnId filters; a foreign or empty column is 400", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await createBoard(api, w.project.id, w.owner);
  const d1 = await createCard(api, w.cols[2], w.member, { title: "d1" });
  const t1 = await createCard(api, w.cols[0], w.member, { title: "t1" });
  const p1 = await createCard(api, w.cols[1], w.member, { title: "p1" });
  const t0 = await createCard(api, w.cols[0], w.member, { title: "t0", position: 0 });
  const gone = await createCard(api, w.cols[0], w.member, { title: "archived" });
  await ok(api, 200, "POST", `/cards/${gone.id}/archive`, undefined, w.member.token);
  await createCard(api, other.columns[0].id, w.member, { title: "elsewhere" });
  assert.deepEqual(await cardIds(api, w.viewer.token, w.board.id), [t0.id, t1.id, p1.id, d1.id]);
  await ok(api, 200, "PATCH", `/columns/${w.cols[2]}`, { position: 0 }, w.admin.token);
  assert.deepEqual(await cardIds(api, w.viewer.token, w.board.id), [d1.id, t0.id, t1.id, p1.id], "follows column positions");
  assert.deepEqual(await cardIds(api, w.viewer.token, w.board.id, w.cols[0]), [t0.id, t1.id]);
  assertError(await api.call("GET", `/boards/${w.board.id}/cards?columnId=${other.columns[0].id}`, undefined, w.viewer.token), 400, "invalid_query", "another board's column");
  assertError(await api.call("GET", `/boards/${w.board.id}/cards?columnId=nope`, undefined, w.viewer.token), 400, "invalid_query", "unknown column");
  assertError(await api.call("GET", `/boards/${w.board.id}/cards?columnId=`, undefined, w.viewer.token), 400, "invalid_query", "empty value");
  assertError(await api.call("GET", `/boards/${w.board.id}/cards`, undefined, w.outsider.token), 404, "not_found", "outsider");
  assert.equal((await getCard(api, gone.id, w.viewer.token)).archived, true, "an archived card is still readable by id");
});

test("PATCH changes only the given fields and updatedAt, and emits card.updated with the sorted body fields", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const c = await createCard(api, w.cols[0], w.member, { title: "T", description: "D", labels: ["a"], dueDate: "2026-03-03", assigneeId: w.member.id });
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(3000);
  assertError(await api.call("PATCH", `/cards/${c.id}`, { title: "  T2 " }, w.viewer.token), 403, "forbidden", "viewer");
  const p = await ok(api, 200, "PATCH", `/cards/${c.id}`, { title: "  T2 ", priority: "low", description: "", unknown: 1 }, w.admin.token);
  assert.deepEqual(p, { ...c, title: "T2", description: "", priority: "low", updatedAt: clock.iso() });
  clock.advance(1000);
  const same = await ok(api, 200, "PATCH", `/cards/${c.id}`, { labels: ["a"] }, w.member.token);
  assert.equal(same.updatedAt, clock.iso(), "updatedAt moves even when the value is unchanged");
  assertError(await api.call("PATCH", `/cards/${c.id}`, {}, w.member.token), 400, "invalid_body", "empty");
  assertError(await api.call("PATCH", `/cards/${c.id}`, { columnId: w.cols[1] }, w.member.token), 400, "invalid_body", "columnId is not updatable");
  assertError(await api.call("PATCH", `/cards/${c.id}`, { position: 0 }, w.member.token), 400, "invalid_body", "position is not updatable");
  assert.deepEqual(await getCard(api, c.id, w.viewer.token), same, "failed PATCHes change nothing");
  assert.deepEqual(await log.names(), ["card.updated", "card.updated"]);
  const [e1, e2] = await log.events(2);
  assert.deepEqual(e1.data, { card: p, fields: ["description", "priority", "title"] });
  assert.equal(e1.actorId, w.admin.id);
  assert.deepEqual(e2.data.fields, ["labels"], "present even if the value did not change");
});

test("the response shows the state after the rules ran while the event snapshot does not; rule changes follow with their own via, actor and audit", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "add_label", label: " Triaged " }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const auditBefore = (await auditLog(api, w.admin.token, w.team.id)).length;
  const created = await createCard(api, w.cols[0], w.member, { title: "new", labels: ["bug"] });
  assert.deepEqual(created.labels, ["bug", "triaged"], "the response already carries the rule's label");
  assert.deepEqual(await log.names(), ["card.created", "card.updated"]);
  const [ev1, ev2] = await log.events(2);
  assert.deepEqual(ev1.data.card.labels, ["bug"], "the card.created snapshot is taken before the rule ran");
  assert.equal(ev1.actorId, w.member.id);
  assert.equal(ev1.via, null);
  assert.deepEqual(ev2.data.fields, ["labels"]);
  assert.deepEqual(ev2.data.card, created);
  assert.equal(ev2.actorId, w.admin.id, "a rule acts as its creator");
  const runs = await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token);
  assert.equal(runs.items.length, 1);
  assert.deepEqual(ev2.via, { type: "rule", ruleId: rule.id, runId: runs.items[0].id });
  assert.equal(runs.items[0].status, "succeeded");
  const audit = (await auditLog(api, w.admin.token, w.team.id)).slice(auditBefore);
  assert.deepEqual(
    audit.map((e) => [e.action, e.actorId, e.via, e.details]),
    [
      ["card.created", w.member.id, null, {}],
      ["card.updated", w.admin.id, { type: "rule", ruleId: rule.id, runId: runs.items[0].id }, { fields: ["labels"] }],
    ],
  );
});

test("viewers get 403 on every card write; API keys need the write scope for card writes and act with the owner's role", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  const writes: [string, string, unknown?][] = [
    ["POST", `/columns/${w.cols[0]}/cards`, { title: "v" }],
    ["PATCH", `/cards/${c.id}`, { title: "v" }],
    ["POST", `/cards/${c.id}/move`, { columnId: w.cols[1] }],
    ["DELETE", `/cards/${c.id}`],
  ];
  const read = await createApiKey(api, w.member, { scope: "read" });
  const viewerWrite = await createApiKey(api, w.viewer, { scope: "write" });
  for (const [method, path, body] of writes) {
    assertError(await api.call(method, path, body, w.viewer.token), 403, "forbidden", `viewer ${method} ${path}`);
    assertError(await api.call(method, path, body, w.outsider.token), 404, "not_found", `outsider ${method} ${path}`);
    assertError(await api.call(method, path, body, read.secret), 403, "insufficient_scope", `read key ${method} ${path}`);
    assertError(await api.call(method, path, body, viewerWrite.secret), 403, "forbidden", `a viewer's write key ${method} ${path}`);
  }
  assertError(await api.call("POST", "/columns/nope/cards", { title: "x" }, read.secret), 403, "insufficient_scope", "scope is checked before the path");
  assertStatus(await api.call("GET", `/cards/${c.id}`, undefined, read.secret), 200, "a read key reads");
  const write = await createApiKey(api, w.member, { scope: "write" });
  const byKey = await ok(api, 201, "POST", `/columns/${w.cols[0]}/cards`, { title: "by key" }, write.secret);
  assert.equal(byKey.createdBy, w.member.id, "a key acts as its owner");
  assertStatus(await api.call("PATCH", `/cards/${c.id}`, { title: "m" }, w.member.token), 200);
  assertStatus(await api.call("POST", `/cards/${c.id}/move`, { columnId: w.cols[1] }, write.secret), 200);
  const res = await api.call("DELETE", `/cards/${c.id}`, undefined, w.member.token);
  assertStatus(res, 204);
  assert.equal(res.text, "");
  assertError(await api.call("DELETE", `/cards/${c.id}`, undefined, w.member.token), 404, "not_found", "twice");
});

test("the card error order: 404 unseen column, 403 role, 400 body, invalid_assignee, invalid_field_value, field_required, then the 409s", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await ok(api, 200, "PATCH", `/columns/${w.cols[0]}`, { wipLimit: 1 }, w.admin.token);
  const full = await createCard(api, w.cols[0], w.member, { title: "full" });
  const size = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Size", type: "number", required: true }, w.admin.token);
  const col = `/columns/${w.cols[0]}/cards`;
  const good = { title: "x", customFields: { [size.id]: 3 } };
  assertError(await api.call("POST", "/columns/nope/cards", good, w.member.token), 404, "not_found", "unknown column");
  assertError(await api.call("POST", col, { title: "" }, w.outsider.token), 404, "not_found", "outsider with a bad body");
  assertError(await api.call("POST", col, { title: "" }, w.viewer.token), 403, "forbidden", "viewer with a bad body");
  assertError(await api.call("POST", col, { title: "", assigneeId: w.viewer.id }, w.member.token), 400, "invalid_body", "bad title and bad assignee");
  assertError(await api.call("POST", col, { ...good, assigneeId: w.viewer.id, customFields: { [size.id]: "x" } }, w.member.token), 400, "invalid_assignee", "bad assignee and a bad value");
  assertDetails(await api.call("POST", col, { title: "x", customFields: { [size.id]: "x" } }, w.member.token), 400, "invalid_field_value", { fieldId: size.id });
  assertDetails(await api.call("POST", col, { title: "x" }, w.member.token), 400, "field_required", { fieldId: size.id });
  assertError(await api.call("POST", col, good, w.member.token), 409, "wip_limit_reached");
  assertError(await api.call("POST", col, undefined, w.member.token, { raw: "[1,2" }), 400, "invalid_json");
  assertError(await api.call("POST", col, [good], w.member.token), 400, "invalid_body", "an array body");
  // On an archived card: validation first, then card_archived before the route's other 409s.
  await ok(api, 200, "POST", `/cards/${full.id}/archive`, undefined, w.member.token);
  const blocker = await createCard(api, w.cols[1], w.member, { title: "blocker", customFields: { [size.id]: 1 } });
  assertError(await api.call("PATCH", `/cards/${full.id}`, { title: "" }, w.member.token), 400, "invalid_body", "invalid PATCH of an archived card");
  assertError(await api.call("PATCH", `/cards/${full.id}`, { title: "y" }, w.member.token), 409, "card_archived");
  assertError(await api.call("POST", `/cards/${full.id}/move`, { columnId: w.cols[2] }, w.member.token), 409, "card_archived", "move of an archived card");
  assertError(await api.call("POST", `/cards/${full.id}/blockers`, { blockerId: blocker.id }, w.member.token), 409, "card_archived", "a blocker on an archived card");
});

test("deleting a card deletes its comments, checklist, attachments and dependencies, and emits card.deleted with the card as it was", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await createCard(api, w.cols[0], w.member, { title: "talk" });
  const keep = await createCard(api, w.cols[0], w.member, { title: "keep" });
  const top = await ok(api, 201, "POST", `/cards/${c.id}/comments`, { body: "first" }, w.member.token);
  const reply = await ok(api, 201, "POST", `/cards/${c.id}/comments`, { body: "reply", parentId: top.id }, w.admin.token);
  const other = await ok(api, 201, "POST", `/cards/${keep.id}/comments`, { body: "other" }, w.admin.token);
  const item = await ok(api, 201, "POST", `/cards/${c.id}/checklist`, { text: "step" }, w.member.token);
  const att = await upload(api, c.id, w.member.token, "12345", "five.txt", "text/plain");
  assertStatus(att, 201);
  await ok(api, 201, "POST", `/cards/${keep.id}/blockers`, { blockerId: c.id }, w.member.token);
  assert.equal((await getCard(api, keep.id, w.member.token)).blocked, true);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const before = await getCard(api, c.id, w.member.token);
  assertStatus(await api.call("DELETE", `/cards/${c.id}`, undefined, w.member.token), 204);
  for (const path of [`/comments/${top.id}`, `/comments/${reply.id}`, `/cards/${c.id}/comments`, `/attachments/${att.body.id}`]) {
    assertError(await api.call("GET", path, undefined, w.owner.token), 404, "not_found", path);
  }
  assertError(await api.call("PATCH", `/checklist/${item.id}`, { done: true }, w.member.token), 404, "not_found", "its checklist item");
  assert.equal((await ok(api, 200, "GET", `/comments/${other.id}`, undefined, w.owner.token)).body, "other");
  const k = await getCard(api, keep.id, w.owner.token);
  assert.equal(k.position, 0, "gap closed");
  assert.equal(k.blocked, false, "the dependency went with the card");
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.owner.token)).usage.storageBytes, 0);
  assert.deepEqual(await log.names(), ["card.deleted"]);
  assert.deepEqual((await log.events(1))[0].data, { card: before });
});
