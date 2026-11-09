// Area `cards`: instruction.md section 5 (Cards): numbering, normalisation, positions, moves, WIP.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, assertStatus, cardIds, Clock, createBoard, createCard, createProject, ok, setupBoard, startApp } from "./helpers.ts";

test("a card has the documented shape, key <project key>-<number> and createdBy", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  clock.advance(1000);
  const res = await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "  Write the parser  " }, w.member.token);
  assertStatus(res, 201);
  const c = res.body;
  assert.equal(typeof c.id, "string");
  assert.equal(c.number, 1);
  assert.equal(c.key, "ENG-1");
  assert.equal(c.boardId, w.board.id);
  assert.equal(c.columnId, w.cols[0]);
  assert.equal(c.position, 0);
  assert.equal(c.title, "Write the parser");
  assert.equal(c.description, "");
  assert.equal(c.assigneeId, null);
  assert.deepEqual(c.labels, []);
  assert.equal(c.dueDate, null);
  assert.equal(c.createdBy, w.member.id);
  assert.equal(c.createdAt, clock.iso());
  assert.equal(c.updatedAt, clock.iso());
  assert.deepEqual(await ok(api, 200, "GET", `/cards/${c.id}`, undefined, w.viewer.token), c);
  const full = await createCard(api, w.cols[1], w.admin, {
    title: "Full",
    description: "d".repeat(10000),
    assigneeId: w.member.id,
    labels: ["x"],
    dueDate: "2026-12-31",
  });
  assert.equal(full.key, "ENG-2");
  assert.equal(full.description.length, 10000);
  assert.equal(full.assigneeId, w.member.id);
  assert.equal(full.dueDate, "2026-12-31");
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

test("title, description and dueDate validation, including impossible calendar dates", async (t) => {
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
  const bad: [string, unknown][] = [
    ["blank title", { title: "   " }],
    ["201-char title", { title: "t".repeat(201) }],
    ["missing title", {}],
    ["title not a string", { title: 5 }],
    ["10001-char description", { title: "t", description: "d".repeat(10001) }],
    ["description not a string", { title: "t", description: null }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", col, body, w.member.token), 400, "invalid_body", what);
  assert.equal((await createCard(api, w.cols[0], w.member, { title: "t".repeat(200) })).title.length, 200);
  const c = await createCard(api, w.cols[0], w.member, { title: "x", dueDate: "2026-05-05" });
  assert.equal((await ok(api, 200, "PATCH", `/cards/${c.id}`, { dueDate: null }, w.member.token)).dueDate, null);
  assertError(await api.call("PATCH", `/cards/${c.id}`, { dueDate: "2026-06-31" }, w.member.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/cards/${c.id}`, { title: "" }, w.member.token), 400, "invalid_body");
});

test("assigneeId must be an owner, admin or member: viewer, outsider and unknown ids are 400 invalid_assignee", async (t) => {
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
  const c = await createCard(api, w.cols[0], w.member, { title: "b", assigneeId: w.member.id });
  assertError(await api.call("PATCH", `/cards/${c.id}`, { assigneeId: w.viewer.id }, w.member.token), 400, "invalid_assignee", "PATCH viewer");
  const cleared = await ok(api, 200, "PATCH", `/cards/${c.id}`, { assigneeId: null }, w.member.token);
  assert.equal(cleared.assigneeId, null);
  // Later role changes don't touch existing assignments.
  const kept = await createCard(api, w.cols[0], w.member, { title: "k", assigneeId: w.admin.id });
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.admin.id}`, { role: "viewer" }, w.owner.token);
  assert.equal((await ok(api, 200, "GET", `/cards/${kept.id}`, undefined, w.owner.token)).assigneeId, w.admin.id);
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

test("moving a card to another column puts it at the requested index and closes the gap behind it", async (t) => {
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
  const dNow = await ok(api, 200, "GET", `/cards/${d.id}`, undefined, w.owner.token);
  assert.equal(dNow.updatedAt, d.updatedAt, "neighbours keep updatedAt");
  const eNow = await ok(api, 200, "GET", `/cards/${e.id}`, undefined, w.owner.token);
  assert.equal(eNow.position, 2);
  assert.equal(eNow.updatedAt, e.updatedAt, "a shifted neighbour keeps updatedAt");
});

test("moving within a column reorders it; the other cards keep their relative order", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ids: string[] = [];
  for (const title of ["A", "B", "C", "D"]) ids.push((await createCard(api, w.cols[0], w.member, { title })).id);
  const [a, b, c, d] = ids;
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
});

test("moving to a column of another board, an unknown column or without columnId is 400 invalid_body", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await createBoard(api, w.project.id, w.owner);
  const c = await createCard(api, w.cols[0], w.member, { title: "stay" });
  const path = `/cards/${c.id}/move`;
  assertError(await api.call("POST", path, { columnId: other.columns[0].id }, w.member.token), 400, "invalid_body", "another board");
  assertError(await api.call("POST", path, { columnId: "nope" }, w.member.token), 400, "invalid_body", "unknown column");
  assertError(await api.call("POST", path, {}, w.member.token), 400, "invalid_body", "missing");
  assertError(await api.call("POST", path, { columnId: w.cols[1], position: "0" }, w.member.token), 400, "invalid_body", "string position");
  assertError(await api.call("POST", "/cards/nope/move", { columnId: w.cols[1] }, w.member.token), 404, "not_found", "unknown card");
  const now = await ok(api, 200, "GET", `/cards/${c.id}`, undefined, w.owner.token);
  assert.equal(now.columnId, w.cols[0]);
  assert.equal(now.boardId, w.board.id);
});

test("creating in or moving into a full column is 409 wip_limit_reached; reordering inside it is allowed", async (t) => {
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
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 2 }, w.admin.token);
  assert.equal((await ok(api, 200, "POST", `/cards/${z.id}/move`, { columnId: w.cols[1] }, w.member.token)).position, 1, "room again");
});

test("GET board cards orders by column position then card position; ?columnId filters; a foreign column is 400", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await createBoard(api, w.project.id, w.owner);
  const d1 = await createCard(api, w.cols[2], w.member, { title: "d1" });
  const t1 = await createCard(api, w.cols[0], w.member, { title: "t1" });
  const p1 = await createCard(api, w.cols[1], w.member, { title: "p1" });
  const t0 = await createCard(api, w.cols[0], w.member, { title: "t0", position: 0 });
  await createCard(api, other.columns[0].id, w.member, { title: "elsewhere" });
  assert.deepEqual(await cardIds(api, w.viewer.token, w.board.id), [t0.id, t1.id, p1.id, d1.id]);
  await ok(api, 200, "PATCH", `/columns/${w.cols[2]}`, { position: 0 }, w.admin.token);
  assert.deepEqual(await cardIds(api, w.viewer.token, w.board.id), [d1.id, t0.id, t1.id, p1.id], "follows column positions");
  assert.deepEqual(await cardIds(api, w.viewer.token, w.board.id, w.cols[0]), [t0.id, t1.id]);
  assertError(await api.call("GET", `/boards/${w.board.id}/cards?columnId=${other.columns[0].id}`, undefined, w.viewer.token), 400, "invalid_query", "another board's column");
  assertError(await api.call("GET", `/boards/${w.board.id}/cards?columnId=nope`, undefined, w.viewer.token), 400, "invalid_query", "unknown column");
  assertError(await api.call("GET", `/boards/${w.board.id}/cards`, undefined, w.outsider.token), 404, "not_found", "outsider");
});

test("PATCH changes only the given fields and updatedAt; a body without an updatable field is 400", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const c = await createCard(api, w.cols[0], w.member, { title: "T", description: "D", labels: ["a"], dueDate: "2026-03-03", assigneeId: w.member.id });
  clock.advance(3000);
  const res = await api.call("PATCH", `/cards/${c.id}`, { title: "  T2 " }, w.viewer.token);
  assertError(res, 403, "forbidden", "viewer");
  const p = await ok(api, 200, "PATCH", `/cards/${c.id}`, { title: "  T2 ", description: "" }, w.admin.token);
  assert.deepEqual(p, { ...c, title: "T2", description: "", updatedAt: clock.iso() });
  assertError(await api.call("PATCH", `/cards/${c.id}`, {}, w.member.token), 400, "invalid_body", "empty");
  assertError(await api.call("PATCH", `/cards/${c.id}`, { columnId: w.cols[1] }, w.member.token), 400, "invalid_body", "columnId is not updatable");
  assertError(await api.call("PATCH", `/cards/${c.id}`, { position: 0 }, w.member.token), 400, "invalid_body", "position is not updatable");
  assert.deepEqual(await ok(api, 200, "GET", `/cards/${c.id}`, undefined, w.viewer.token), p, "failed PATCHes change nothing");
});

test("viewers get 403 on every card write; members create, update, move and delete", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  const writes: [string, string, unknown?][] = [
    ["POST", `/columns/${w.cols[0]}/cards`, { title: "v" }],
    ["PATCH", `/cards/${c.id}`, { title: "v" }],
    ["POST", `/cards/${c.id}/move`, { columnId: w.cols[1] }],
    ["DELETE", `/cards/${c.id}`],
  ];
  for (const [method, path, body] of writes) {
    assertError(await api.call(method, path, body, w.viewer.token), 403, "forbidden", `viewer ${method} ${path}`);
    assertError(await api.call(method, path, body, w.outsider.token), 404, "not_found", `outsider ${method} ${path}`);
  }
  assertStatus(await api.call("PATCH", `/cards/${c.id}`, { title: "m" }, w.member.token), 200);
  assertStatus(await api.call("POST", `/cards/${c.id}/move`, { columnId: w.cols[1] }, w.member.token), 200);
  const res = await api.call("DELETE", `/cards/${c.id}`, undefined, w.member.token);
  assertStatus(res, 204);
  assert.equal(res.text, "");
  assertError(await api.call("DELETE", `/cards/${c.id}`, undefined, w.member.token), 404, "not_found", "twice");
});

test("the card create error order: 404 unseen column, 403 role, 400 body, 400 invalid_assignee, then 409", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await ok(api, 200, "PATCH", `/columns/${w.cols[0]}`, { wipLimit: 1 }, w.admin.token);
  await createCard(api, w.cols[0], w.member, { title: "full" });
  const col = `/columns/${w.cols[0]}/cards`;
  assertError(await api.call("POST", "/columns/nope/cards", { title: "x" }, w.member.token), 404, "not_found", "unknown column");
  assertError(await api.call("POST", col, { title: "" }, w.outsider.token), 404, "not_found", "outsider with a bad body");
  assertError(await api.call("POST", col, { title: "" }, w.viewer.token), 403, "forbidden", "viewer with a bad body");
  assertError(await api.call("POST", col, { title: "", assigneeId: w.viewer.id }, w.member.token), 400, "invalid_body", "bad title and bad assignee");
  assertError(await api.call("POST", col, { title: "x", assigneeId: w.viewer.id }, w.member.token), 400, "invalid_assignee", "bad assignee in a full column");
  assertError(await api.call("POST", col, { title: "x" }, w.member.token), 409, "wip_limit_reached");
  assertError(await api.call("POST", col, undefined, w.member.token, { raw: "[1,2" }), 400, "invalid_json");
  assertError(await api.call("POST", col, [{ title: "x" }], w.member.token), 400, "invalid_body", "an array body");
});

test("deleting a card deletes its comments", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await createCard(api, w.cols[0], w.member, { title: "talk" });
  const keep = await createCard(api, w.cols[0], w.member, { title: "keep" });
  const top = await ok(api, 201, "POST", `/cards/${c.id}/comments`, { body: "first" }, w.member.token);
  const reply = await ok(api, 201, "POST", `/cards/${c.id}/comments`, { body: "reply", parentId: top.id }, w.admin.token);
  const other = await ok(api, 201, "POST", `/cards/${keep.id}/comments`, { body: "other" }, w.admin.token);
  assertStatus(await api.call("DELETE", `/cards/${c.id}`, undefined, w.member.token), 204);
  assertError(await api.call("GET", `/comments/${top.id}`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/comments/${reply.id}`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/cards/${c.id}/comments`, undefined, w.owner.token), 404, "not_found");
  assert.equal((await ok(api, 200, "GET", `/comments/${other.id}`, undefined, w.owner.token)).body, "other");
  assert.equal((await ok(api, 200, "GET", `/cards/${keep.id}`, undefined, w.owner.token)).position, 0, "gap closed");
});
