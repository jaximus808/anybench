// Area `boards`: instruction.md section 4 (Boards and columns).
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, assertStatus, cardIds, Clock, createBoard, createCard, createProject, ok, setupBoard, setupTeam, startApp } from "./helpers.ts";

const colNames = (board: any): string[] => board.columns.map((c: any) => c.name);
const positions = (board: any): number[] => board.columns.map((c: any) => c.position);

test("a new board gets the default columns To do, In progress, Done at positions 0..2", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  const project = await createProject(api, w.team.id, w.owner);
  clock.advance(1000);
  const res = await api.call("POST", `/projects/${project.id}/boards`, { name: "  Main  " }, w.admin.token);
  assertStatus(res, 201);
  const b = res.body;
  assert.equal(typeof b.id, "string");
  assert.equal(b.projectId, project.id);
  assert.equal(b.name, "Main");
  assert.equal(b.createdAt, clock.iso());
  assert.deepEqual(colNames(b), ["To do", "In progress", "Done"]);
  for (const [i, c] of b.columns.entries()) {
    assert.equal(typeof c.id, "string");
    assert.equal(c.boardId, b.id);
    assert.equal(c.position, i);
    assert.equal(c.wipLimit, null);
  }
  assert.equal(new Set(b.columns.map((c: any) => c.id)).size, 3, "column ids are unique");
  assert.deepEqual(await ok(api, 200, "GET", `/boards/${b.id}`, undefined, w.viewer.token), b);
  assertError(await api.call("GET", `/boards/${b.id}`, undefined, w.outsider.token), 404, "not_found", "outsider");
  assertError(await api.call("GET", "/boards/nope", undefined, w.owner.token), 404, "not_found");
});

test("columns given on create keep array order; 0 or 21 columns or a bad name is 400 invalid_body", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const project = await createProject(api, w.team.id, w.owner);
  const path = `/projects/${project.id}/boards`;
  const b = await ok(api, 201, "POST", path, { name: "Custom", columns: [" Backlog ", "Review", "Review"] }, w.owner.token);
  assert.deepEqual(colNames(b), ["Backlog", "Review", "Review"], "trimmed, duplicates allowed");
  assert.deepEqual(positions(b), [0, 1, 2]);
  const twenty = await ok(api, 201, "POST", path, { name: "Wide", columns: Array.from({ length: 20 }, (_, i) => `C${i}`) }, w.owner.token);
  assert.equal(twenty.columns.length, 20);
  const bad: [string, unknown][] = [
    ["no columns", { name: "B", columns: [] }],
    ["21 columns", { name: "B", columns: Array.from({ length: 21 }, (_, i) => `C${i}`) }],
    ["blank column name", { name: "B", columns: ["ok", "  "] }],
    ["51-char column name", { name: "B", columns: ["c".repeat(51)] }],
    ["non-string column", { name: "B", columns: [1] }],
    ["columns not an array", { name: "B", columns: "To do" }],
    ["blank board name", { name: "  " }],
    ["51-char board name", { name: "b".repeat(51) }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", path, body, w.owner.token), 400, "invalid_body", what);
  const fifty = await ok(api, 201, "POST", path, { name: "b".repeat(50), columns: ["c".repeat(50)] }, w.owner.token);
  assert.equal(fifty.name.length, 50);
});

test("boards list oldest first; PATCH renames a board", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  const project = await createProject(api, w.team.id, w.owner);
  const ids: string[] = [];
  for (const name of ["One", "Two", "Three"]) {
    clock.advance(1000);
    ids.push((await createBoard(api, project.id, w.owner, { name })).id);
  }
  const list = await ok(api, 200, "GET", `/projects/${project.id}/boards`, undefined, w.viewer.token);
  assert.deepEqual(list.items.map((b: any) => b.id), ids);
  assert.equal(list.items[0].columns.length, 3, "listed boards carry their columns");
  const renamed = await ok(api, 200, "PATCH", `/boards/${ids[1]}`, { name: " Second " }, w.admin.token);
  assert.equal(renamed.name, "Second");
  assert.equal(renamed.columns.length, 3);
  assertError(await api.call("PATCH", `/boards/${ids[1]}`, { name: "" }, w.admin.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/boards/${ids[1]}`, {}, w.admin.token), 400, "invalid_body");
  assert.equal((await ok(api, 200, "GET", `/boards/${ids[1]}`, undefined, w.viewer.token)).name, "Second");
});

test("adding a column at a position shifts the later columns right; default is the end", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const res = await api.call("POST", `/boards/${w.board.id}/columns`, { name: " Review ", position: 1 }, w.admin.token);
  assertStatus(res, 201);
  assert.equal(res.body.name, "Review");
  assert.equal(res.body.position, 1);
  assert.equal(res.body.boardId, w.board.id);
  assert.equal(res.body.wipLimit, null);
  const end = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "Shipped" }, w.admin.token);
  assert.equal(end.position, 4);
  const first = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "Inbox", position: 0, wipLimit: 3 }, w.admin.token);
  assert.equal(first.wipLimit, 3);
  const b = await ok(api, 200, "GET", `/boards/${w.board.id}`, undefined, w.viewer.token);
  assert.deepEqual(colNames(b), ["Inbox", "To do", "Review", "In progress", "Done", "Shipped"]);
  assert.deepEqual(positions(b), [0, 1, 2, 3, 4, 5]);
  const atEnd = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "Last", position: 6 }, w.admin.token);
  assert.equal(atEnd.position, 6, "position n is allowed");
  for (const position of [8, -1, 1.5, "2"]) {
    assertError(await api.call("POST", `/boards/${w.board.id}/columns`, { name: "Bad", position }, w.admin.token), 400, "invalid_body", `position ${position}`);
  }
  assertError(await api.call("POST", `/boards/${w.board.id}/columns`, { name: "" }, w.admin.token), 400, "invalid_body", "blank name");
  assert.equal((await ok(api, 200, "GET", `/boards/${w.board.id}`, undefined, w.viewer.token)).columns.length, 7);
});

test("PATCH a column's position moves it and keeps the others' relative order", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const project = await createProject(api, w.team.id, w.owner);
  const b = await createBoard(api, project.id, w.owner, { columns: ["A", "B", "C", "D", "E"] });
  const id = Object.fromEntries(b.columns.map((c: any) => [c.name, c.id]));
  const moved = await ok(api, 200, "PATCH", `/columns/${id.A}`, { position: 3 }, w.admin.token);
  assert.equal(moved.position, 3);
  assert.equal(moved.name, "A");
  let now = await ok(api, 200, "GET", `/boards/${b.id}`, undefined, w.owner.token);
  assert.deepEqual(colNames(now), ["B", "C", "D", "A", "E"]);
  assert.deepEqual(positions(now), [0, 1, 2, 3, 4]);
  await ok(api, 200, "PATCH", `/columns/${id.E}`, { position: 0, name: "E2" }, w.admin.token);
  now = await ok(api, 200, "GET", `/boards/${b.id}`, undefined, w.owner.token);
  assert.deepEqual(colNames(now), ["E2", "B", "C", "D", "A"]);
  await ok(api, 200, "PATCH", `/columns/${id.C}`, { position: 2 }, w.admin.token);
  now = await ok(api, 200, "GET", `/boards/${b.id}`, undefined, w.owner.token);
  assert.deepEqual(colNames(now), ["E2", "B", "C", "D", "A"], "moving to its own index changes nothing");
  for (const position of [5, -1, 0.5]) {
    assertError(await api.call("PATCH", `/columns/${id.C}`, { position }, w.admin.token), 400, "invalid_body", `position ${position}`);
  }
  assertError(await api.call("PATCH", `/columns/${id.C}`, {}, w.admin.token), 400, "invalid_body", "empty");
  assertError(await api.call("PATCH", "/columns/nope", { name: "x" }, w.admin.token), 404, "not_found");
});

test("wipLimit is null or an integer from 1 to 1000; it may be lowered below the current card count", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const path = `/boards/${w.board.id}/columns`;
  for (const wipLimit of [0, 1001, 2.5, "3", -1, false]) {
    assertError(await api.call("POST", path, { name: "X", wipLimit }, w.admin.token), 400, "invalid_body", `wipLimit ${JSON.stringify(wipLimit)}`);
    assertError(await api.call("PATCH", `/columns/${w.cols[0]}`, { wipLimit }, w.admin.token), 400, "invalid_body", `PATCH wipLimit ${JSON.stringify(wipLimit)}`);
  }
  assert.equal((await ok(api, 201, "POST", path, { name: "Max", wipLimit: 1000 }, w.admin.token)).wipLimit, 1000);
  assert.equal((await ok(api, 201, "POST", path, { name: "Min", wipLimit: 1 }, w.admin.token)).wipLimit, 1);
  assert.equal((await ok(api, 201, "POST", path, { name: "None", wipLimit: null }, w.admin.token)).wipLimit, null);
  for (let i = 0; i < 3; i++) await createCard(api, w.cols[0], w.member, { title: `c${i}` });
  const lowered = await ok(api, 200, "PATCH", `/columns/${w.cols[0]}`, { wipLimit: 1 }, w.admin.token);
  assert.equal(lowered.wipLimit, 1);
  assert.equal((await cardIds(api, w.owner.token, w.board.id, w.cols[0])).length, 3, "existing cards stay");
  assert.equal((await ok(api, 200, "PATCH", `/columns/${w.cols[0]}`, { wipLimit: null }, w.admin.token)).wipLimit, null);
});

test("DELETE column: the last column is 409 last_column; a column with cards is 409 column_not_empty; an empty one goes", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const single = await createBoard(api, w.project.id, w.owner, { columns: ["Only"] });
  assertError(await api.call("DELETE", `/columns/${single.columns[0].id}`, undefined, w.admin.token), 409, "last_column");
  await createCard(api, w.cols[0], w.member, { title: "blocker" });
  assertError(await api.call("DELETE", `/columns/${w.cols[0]}`, undefined, w.admin.token), 409, "column_not_empty");
  const res = await api.call("DELETE", `/columns/${w.cols[1]}`, undefined, w.admin.token);
  assertStatus(res, 204);
  assert.equal(res.text, "");
  const b = await ok(api, 200, "GET", `/boards/${w.board.id}`, undefined, w.owner.token);
  assert.deepEqual(colNames(b), ["To do", "Done"]);
  assert.deepEqual(positions(b), [0, 1], "renumbered without gaps");
  assertError(await api.call("DELETE", `/columns/${w.cols[1]}`, undefined, w.admin.token), 404, "not_found", "deleted column");
});

test("DELETE column ?moveTo appends its cards to the end of the target, in order, ignoring the WIP limit", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const a1 = await createCard(api, w.cols[0], w.member, { title: "a1" });
  const a2 = await createCard(api, w.cols[0], w.member, { title: "a2" });
  const a0 = await createCard(api, w.cols[0], w.member, { title: "a0", position: 0 });
  const b1 = await createCard(api, w.cols[2], w.member, { title: "b1" });
  await ok(api, 200, "PATCH", `/columns/${w.cols[2]}`, { wipLimit: 1 }, w.admin.token);
  clock.advance(60_000);
  assertStatus(await api.call("DELETE", `/columns/${w.cols[0]}?moveTo=${w.cols[2]}`, undefined, w.admin.token), 204);
  const cards = await ok(api, 200, "GET", `/boards/${w.board.id}/cards?columnId=${w.cols[2]}`, undefined, w.owner.token);
  assert.deepEqual(cards.items.map((c: any) => [c.id, c.position, c.columnId]), [
    [b1.id, 0, w.cols[2]],
    [a0.id, 1, w.cols[2]],
    [a1.id, 2, w.cols[2]],
    [a2.id, 3, w.cols[2]],
  ]);
  const moved = cards.items.find((c: any) => c.id === a1.id);
  assert.equal(moved.updatedAt, a1.updatedAt, "a cascade never changes updatedAt");
  const b = await ok(api, 200, "GET", `/boards/${w.board.id}`, undefined, w.owner.token);
  assert.deepEqual(colNames(b), ["In progress", "Done"]);
  assert.deepEqual(positions(b), [0, 1]);
  // moveTo on an empty column is fine too.
  assertStatus(await api.call("DELETE", `/columns/${w.cols[1]}?moveTo=${w.cols[2]}`, undefined, w.admin.token), 204);
});

test("an invalid ?moveTo is 400 invalid_query, even for an empty column or a board's last column", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await createBoard(api, w.project.id, w.owner);
  const single = await createBoard(api, w.project.id, w.owner, { columns: ["Only"] });
  await createCard(api, w.cols[0], w.member, { title: "x" });
  const del = (col: string, q: string) => api.call("DELETE", `/columns/${col}${q}`, undefined, w.admin.token);
  assertError(await del(w.cols[0], `?moveTo=${w.cols[0]}`), 400, "invalid_query", "itself");
  assertError(await del(w.cols[0], `?moveTo=${other.columns[0].id}`), 400, "invalid_query", "another board's column");
  assertError(await del(w.cols[0], "?moveTo=nope"), 400, "invalid_query", "unknown column");
  assertError(await del(w.cols[0], "?moveTo="), 400, "invalid_query", "empty value");
  assertError(await del(w.cols[1], "?moveTo=nope"), 400, "invalid_query", "empty column");
  assertError(await del(single.columns[0].id, `?moveTo=${w.cols[1]}`), 400, "invalid_query", "last column with moveTo");
  assertError(await del(single.columns[0].id, "?other=1"), 409, "last_column", "unrelated query param");
  assert.equal((await ok(api, 200, "GET", `/boards/${w.board.id}`, undefined, w.owner.token)).columns.length, 3);
});

test("members and viewers get 403 on board and column writes; viewers can read", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  for (const u of [w.member, w.viewer]) {
    const writes: [string, string, unknown?][] = [
      ["POST", `/projects/${w.project.id}/boards`, { name: "B" }],
      ["PATCH", `/boards/${w.board.id}`, { name: "B" }],
      ["DELETE", `/boards/${w.board.id}`],
      ["POST", `/boards/${w.board.id}/columns`, { name: "C" }],
      ["PATCH", `/columns/${w.cols[0]}`, { name: "C" }],
      ["DELETE", `/columns/${w.cols[2]}`],
    ];
    for (const [method, path, body] of writes) assertError(await api.call(method, path, body, u.token), 403, "forbidden", `${u.handle} ${method} ${path}`);
  }
  assertError(await api.call("POST", `/boards/${w.board.id}/columns`, { name: "C" }, w.outsider.token), 404, "not_found", "outsider");
  const b = await ok(api, 200, "GET", `/boards/${w.board.id}`, undefined, w.viewer.token);
  assert.deepEqual(colNames(b), ["To do", "In progress", "Done"], "nothing changed");
  assert.equal((await ok(api, 200, "GET", `/projects/${w.project.id}/boards`, undefined, w.viewer.token)).items.length, 1);
});

test("DELETE board removes its columns and cards", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const keep = await createBoard(api, w.project.id, w.owner, { name: "Keep" });
  const card = await createCard(api, w.cols[0], w.member, { title: "gone" });
  const res = await api.call("DELETE", `/boards/${w.board.id}`, undefined, w.admin.token);
  assertStatus(res, 204);
  assert.equal(res.text, "");
  assertError(await api.call("GET", `/boards/${w.board.id}`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/cards/${card.id}`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("PATCH", `/columns/${w.cols[0]}`, { name: "x" }, w.owner.token), 404, "not_found", "its column");
  assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "x" }, w.owner.token), 404, "not_found", "its column");
  const list = await ok(api, 200, "GET", `/projects/${w.project.id}/boards`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((b: any) => b.id), [keep.id]);
});
