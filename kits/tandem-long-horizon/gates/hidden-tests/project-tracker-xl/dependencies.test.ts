// Area `dependencies`: instruction.md section 18 (Dependencies), with the conventions of section 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  assertDetails,
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

const block = (api: Api, cardId: string, blockerId: unknown, by: User | string): Promise<Res> =>
  api.call("POST", `/cards/${cardId}/blockers`, { blockerId }, typeof by === "string" ? by : by.token);

const blockOk = async (api: Api, cardId: string, blockerId: string, by: User): Promise<any> => {
  const res = await block(api, cardId, blockerId, by);
  assertStatus(res, 201, `block ${cardId} by ${blockerId}`);
  return res.body;
};

const listIds = async (api: Api, path: string, token: string): Promise<string[]> =>
  (await ok(api, 200, "GET", path, undefined, token)).items.map((c: any) => c.id);

const move = (api: Api, cardId: string, columnId: string, by: User): Promise<Res> => api.call("POST", `/cards/${cardId}/move`, { columnId }, by.token);

/** Cards named by title, created in this order in column `col`. */
async function cards(api: Api, col: string, by: User, titles: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const title of titles) out[title] = await createCard(api, col, by, { title });
  return out;
}

test("adding a blocker answers the dependency and makes the blocked card blocked, not the blocker", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const c = await cards(api, w.cols[0], w.member, ["a", "b"]);
  assert.equal(c.a.blocked, false);
  clock.advance(5000);
  const dep = await blockOk(api, c.a.id, c.b.id, w.member);
  assert.deepEqual(dep, { cardId: c.a.id, blockerId: c.b.id, createdAt: clock.iso() });
  assert.equal((await getCard(api, c.a.id, w.member.token)).blocked, true);
  assert.equal((await getCard(api, c.b.id, w.member.token)).blocked, false);
  assert.equal((await getCard(api, c.a.id, w.member.token)).updatedAt, c.a.updatedAt, "a dependency is not a card update");
});

test("blockerId must be a card of the same team, in any of its projects, and not the card itself", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  const other = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const inOps = await createCard(api, opsBoard.columns[0].id, w.member, { title: "ops" });
  const foreign = await createCard(api, other.cols[0], other.member, { title: "foreign" });
  for (const [what, v] of [
    ["itself", a.id],
    ["another team's card", foreign.id],
    ["unknown", "no-such-card"],
    ["not a string", 12],
    ["null", null],
  ] as const) {
    assertError(await block(api, a.id, v, w.member), 400, "invalid_body", what);
  }
  assertError(await api.call("POST", `/cards/${a.id}/blockers`, {}, w.member.token), 400, "invalid_body", "missing");
  await blockOk(api, a.id, inOps.id, w.member);
  assert.deepEqual(await listIds(api, `/cards/${a.id}/blockers`, w.member.token), [inOps.id]);
  assert.deepEqual(await listIds(api, `/cards/${inOps.id}/blocking`, w.member.token), [a.id]);
});

test("adding the same dependency twice is 409 dependency_exists", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["a", "b"]);
  await blockOk(api, c.a.id, c.b.id, w.member);
  assertError(await block(api, c.a.id, c.b.id, w.admin), 409, "dependency_exists");
  assert.deepEqual(await listIds(api, `/cards/${c.a.id}/blockers`, w.member.token), [c.b.id]);
});

test("a direct two-card cycle is 409 dependency_cycle with details.path from the new blocker to the card", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["x", "y"]);
  await blockOk(api, c.x.id, c.y.id, w.member);
  assertDetails(await block(api, c.y.id, c.x.id, w.member), 409, "dependency_cycle", { path: [c.x.id, c.y.id] });
  assert.deepEqual(await listIds(api, `/cards/${c.y.id}/blockers`, w.member.token), []);
});

test("the spec example: with C blocked by A and B blocked by C, adding A blocked by B answers path [B, C, A]", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["A", "B", "C"]);
  await blockOk(api, c.C.id, c.A.id, w.member);
  await blockOk(api, c.B.id, c.C.id, w.member);
  assertDetails(await block(api, c.A.id, c.B.id, w.member), 409, "dependency_cycle", { path: [c.B.id, c.C.id, c.A.id] });
});

test("dependency_cycle reports the breadth-first path, visiting each card's blockers in link creation order", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["A", "B", "P", "Q", "R", "D", "E", "F1", "F2"]);
  await blockOk(api, c.B.id, c.P.id, w.member);
  await blockOk(api, c.P.id, c.R.id, w.member);
  await blockOk(api, c.R.id, c.A.id, w.member);
  await blockOk(api, c.B.id, c.Q.id, w.member);
  await blockOk(api, c.Q.id, c.A.id, w.member);
  assertDetails(await block(api, c.A.id, c.B.id, w.member), 409, "dependency_cycle", { path: [c.B.id, c.Q.id, c.A.id] }, "the shortest path wins over the first link");
  await blockOk(api, c.E.id, c.F2.id, w.member);
  await blockOk(api, c.E.id, c.F1.id, w.member);
  await blockOk(api, c.F1.id, c.D.id, w.member);
  await blockOk(api, c.F2.id, c.D.id, w.member);
  assertDetails(await block(api, c.D.id, c.E.id, w.member), 409, "dependency_cycle", { path: [c.E.id, c.F2.id, c.D.id] }, "equal lengths: E's first-created link");
});

test("blocked is true only while an open blocker exists: a completed or archived blocker is not open", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["card", "blocker"]);
  await blockOk(api, c.card.id, c.blocker.id, w.member);
  const blocked = async () => (await getCard(api, c.card.id, w.member.token)).blocked;
  assert.equal(await blocked(), true);
  assertStatus(await move(api, c.blocker.id, w.cols[2], w.member), 200);
  assert.equal(await blocked(), false, "completed blocker");
  assertStatus(await move(api, c.blocker.id, w.cols[1], w.member), 200);
  assert.equal(await blocked(), true, "reopened blocker");
  await ok(api, 200, "POST", `/cards/${c.blocker.id}/archive`, undefined, w.member.token);
  assert.equal(await blocked(), false, "archived blocker");
  await ok(api, 200, "POST", `/cards/${c.blocker.id}/restore`, {}, w.member.token);
  assert.equal(await blocked(), true, "restored into a column that is not done");
});

test("a blocked card cannot move into a done column (409 blocked) but may move between done columns and out of one", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const shipped = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "Shipped", category: "done" }, w.owner.token);
  const x = await createCard(api, w.cols[2], w.member, { title: "x" });
  const y = await createCard(api, w.cols[0], w.member, { title: "y" });
  await blockOk(api, x.id, y.id, w.member);
  assert.equal((await getCard(api, x.id, w.member.token)).blocked, true);
  const d2d = await move(api, x.id, shipped.id, w.member);
  assertStatus(d2d, 200, "done to done");
  assert.notEqual(d2d.body.completedAt, null);
  assertStatus(await move(api, x.id, w.cols[0], w.member), 200, "out of a done column");
  assertStatus(await move(api, x.id, w.cols[1], w.member), 200, "between columns that are not done");
  assertError(await move(api, x.id, w.cols[2], w.member), 409, "blocked");
  assertError(await move(api, x.id, shipped.id, w.member), 409, "blocked");
  const now = await getCard(api, x.id, w.member.token);
  assert.equal(now.columnId, w.cols[1]);
  assert.equal(now.completedAt, null);
  await ok(api, 204, "DELETE", `/cards/${x.id}/blockers/${y.id}`, undefined, w.member.token);
  assertStatus(await move(api, x.id, w.cols[2], w.member), 200, "unblocked");
});

test("on move, 409 blocked comes after card_archived and before wip_limit_reached", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await ok(api, 200, "PATCH", `/columns/${w.cols[2]}`, { wipLimit: 1 }, w.owner.token);
  await createCard(api, w.cols[2], w.member, { title: "fills done" });
  const c = await cards(api, w.cols[0], w.member, ["blocked", "free", "blocker", "shelved"]);
  await blockOk(api, c.blocked.id, c.blocker.id, w.member);
  await blockOk(api, c.shelved.id, c.blocker.id, w.member);
  await ok(api, 200, "POST", `/cards/${c.shelved.id}/archive`, undefined, w.member.token);
  assertError(await move(api, c.shelved.id, w.cols[2], w.member), 409, "card_archived");
  assertError(await move(api, c.blocked.id, w.cols[2], w.member), 409, "blocked");
  assertError(await move(api, c.free.id, w.cols[2], w.member), 409, "wip_limit_reached");
});

test("the move_to_column action fails with blocked on a blocked card and moves an unblocked one, as the rule's creator", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.updated", fields: ["priority"] }, actions: [{ type: "move_to_column", columnId: w.cols[2] }] });
  const c = await cards(api, w.cols[0], w.member, ["stuck", "free", "blocker"]);
  await blockOk(api, c.stuck.id, c.blocker.id, w.member);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  const r1 = await ok(api, 200, "PATCH", `/cards/${c.stuck.id}`, { priority: "high" }, w.member.token);
  assert.equal(r1.columnId, w.cols[0], "the blocked card stays");
  let runs = await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token);
  assert.deepEqual(
    [runs.items[0].cardId, runs.items[0].status, runs.items[0].error, runs.items[0].actions],
    [c.stuck.id, "failed", "blocked", [{ type: "move_to_column", status: "failed", error: "blocked" }]],
  );
  const r2 = await ok(api, 200, "PATCH", `/cards/${c.free.id}`, { priority: "high" }, w.member.token);
  assert.equal(r2.columnId, w.cols[2], "the response shows the state after the rules ran");
  assert.notEqual(r2.completedAt, null);
  runs = await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token);
  assert.equal(runs.items[0].status, "succeeded");
  const via = { type: "rule", ruleId: rule.id, runId: runs.items[0].id };
  assert.deepEqual(await log.names(), ["card.updated", "card.updated", "card.moved"]);
  const moved = (await log.events(3))[2];
  assert.equal(moved.data.card.id, c.free.id);
  assert.equal(moved.data.fromColumnId, w.cols[0]);
  assert.equal(moved.data.toColumnId, w.cols[2]);
  assert.equal(moved.actorId, w.admin.id);
  assert.deepEqual(moved.via, via);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetId, e.actorId, e.via, e.details]),
    [
      ["card.updated", c.stuck.id, w.member.id, null, { fields: ["priority"] }],
      ["card.updated", c.free.id, w.member.id, null, { fields: ["priority"] }],
      ["card.moved", c.free.id, w.admin.id, via, { fromColumnId: w.cols[0], toColumnId: w.cols[2], position: 0 }],
    ],
  );
});

test("blockers and blocking list cards in the order the dependencies were created, archived cards included", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["A", "B", "C", "X", "Y", "Z"]);
  await blockOk(api, c.X.id, c.A.id, w.member);
  await blockOk(api, c.X.id, c.C.id, w.member);
  await blockOk(api, c.Z.id, c.A.id, w.member);
  await blockOk(api, c.X.id, c.B.id, w.member);
  await blockOk(api, c.Y.id, c.A.id, w.member);
  assert.deepEqual(await listIds(api, `/cards/${c.X.id}/blockers`, w.viewer.token), [c.A.id, c.C.id, c.B.id]);
  assert.deepEqual(await listIds(api, `/cards/${c.A.id}/blocking`, w.viewer.token), [c.X.id, c.Z.id, c.Y.id]);
  assert.deepEqual(await listIds(api, `/cards/${c.A.id}/blockers`, w.viewer.token), []);
  await ok(api, 200, "POST", `/cards/${c.C.id}/archive`, undefined, w.member.token);
  await ok(api, 200, "POST", `/cards/${c.Z.id}/archive`, undefined, w.member.token);
  const blockers = await ok(api, 200, "GET", `/cards/${c.X.id}/blockers`, undefined, w.viewer.token);
  assert.deepEqual(blockers.items.map((x: any) => [x.id, x.archived]), [
    [c.A.id, false],
    [c.C.id, true],
    [c.B.id, false],
  ]);
  assert.deepEqual(await listIds(api, `/cards/${c.A.id}/blocking`, w.viewer.token), [c.X.id, c.Z.id, c.Y.id]);
});

test("DELETE of a blocker answers 204 and unblocks; a card that is not a blocker of it is 404 not_found", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["x", "a", "b"]);
  await blockOk(api, c.x.id, c.a.id, w.member);
  await blockOk(api, c.x.id, c.b.id, w.member);
  const del = await api.call("DELETE", `/cards/${c.x.id}/blockers/${c.a.id}`, undefined, w.member.token);
  assertStatus(del, 204);
  assert.equal(del.text, "");
  assert.deepEqual(await listIds(api, `/cards/${c.x.id}/blockers`, w.member.token), [c.b.id]);
  assert.equal((await getCard(api, c.x.id, w.member.token)).blocked, true, "b still blocks");
  assertError(await api.call("DELETE", `/cards/${c.x.id}/blockers/${c.a.id}`, undefined, w.member.token), 404, "not_found", "already removed");
  assertError(await api.call("DELETE", `/cards/${c.b.id}/blockers/${c.x.id}`, undefined, w.member.token), 404, "not_found", "the reverse direction");
  assertError(await api.call("DELETE", `/cards/${c.x.id}/blockers/no-such-card`, undefined, w.member.token), 404, "not_found");
  await ok(api, 204, "DELETE", `/cards/${c.x.id}/blockers/${c.b.id}`, undefined, w.member.token);
  assert.equal((await getCard(api, c.x.id, w.member.token)).blocked, false);
});

test("project_archived applies when either card is in an archived project; reads still work and unarchiving restores writes", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  const x = await createCard(api, w.cols[0], w.member, { title: "x" });
  const y = await createCard(api, w.cols[0], w.member, { title: "y" });
  const q1 = await createCard(api, opsBoard.columns[0].id, w.member, { title: "q1" });
  const q2 = await createCard(api, opsBoard.columns[0].id, w.member, { title: "q2" });
  await blockOk(api, x.id, q1.id, w.member);
  await ok(api, 200, "PATCH", `/projects/${ops.id}`, { archived: true }, w.owner.token);
  assertError(await block(api, x.id, q2.id, w.member), 409, "project_archived", "the blocker's project");
  assertError(await block(api, q2.id, y.id, w.member), 409, "project_archived", "the card's project");
  assertError(await api.call("DELETE", `/cards/${x.id}/blockers/${q1.id}`, undefined, w.member.token), 409, "project_archived", "DELETE");
  assert.deepEqual(await listIds(api, `/cards/${x.id}/blockers`, w.member.token), [q1.id]);
  assert.deepEqual(await listIds(api, `/cards/${q1.id}/blocking`, w.member.token), [x.id]);
  await ok(api, 200, "PATCH", `/projects/${ops.id}`, { archived: false }, w.owner.token);
  await ok(api, 204, "DELETE", `/cards/${x.id}/blockers/${q1.id}`, undefined, w.member.token);
  await blockOk(api, x.id, q2.id, w.member);
});

test("card_archived applies when either card is archived, after project_archived", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["x", "b", "c", "d"]);
  await blockOk(api, c.x.id, c.c.id, w.member);
  await ok(api, 200, "POST", `/cards/${c.b.id}/archive`, undefined, w.member.token);
  await ok(api, 200, "POST", `/cards/${c.c.id}/archive`, undefined, w.member.token);
  assertError(await block(api, c.x.id, c.b.id, w.member), 409, "card_archived", "archived blocker");
  assertError(await block(api, c.b.id, c.d.id, w.member), 409, "card_archived", "archived card");
  assertError(await api.call("DELETE", `/cards/${c.x.id}/blockers/${c.c.id}`, undefined, w.member.token), 409, "card_archived", "DELETE");
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await block(api, c.x.id, c.b.id, w.member), 409, "project_archived", "project_archived first");
  assertError(await block(api, c.x.id, c.x.id, w.member), 400, "invalid_body", "validation before the 409s");
});

test("deleting a card removes the dependencies that involve it, in both directions", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["x", "a", "z"]);
  await blockOk(api, c.x.id, c.a.id, w.member);
  await blockOk(api, c.a.id, c.z.id, w.member);
  await ok(api, 204, "DELETE", `/cards/${c.a.id}`, undefined, w.member.token);
  assert.deepEqual(await listIds(api, `/cards/${c.x.id}/blockers`, w.member.token), []);
  assert.deepEqual(await listIds(api, `/cards/${c.z.id}/blocking`, w.member.token), []);
  assert.equal((await getCard(api, c.x.id, w.member.token)).blocked, false);
  await blockOk(api, c.z.id, c.x.id, w.member);
});

test("deleting a project removes every dependency that involves one of its cards", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  const x = await createCard(api, w.cols[0], w.member, { title: "x" });
  const y = await createCard(api, w.cols[0], w.member, { title: "y" });
  const q = await createCard(api, opsBoard.columns[0].id, w.member, { title: "q" });
  await blockOk(api, x.id, q.id, w.member);
  await blockOk(api, q.id, y.id, w.member);
  await ok(api, 204, "DELETE", `/projects/${ops.id}`, undefined, w.owner.token);
  assert.deepEqual(await listIds(api, `/cards/${x.id}/blockers`, w.member.token), []);
  assert.deepEqual(await listIds(api, `/cards/${y.id}/blocking`, w.member.token), []);
  assert.equal((await getCard(api, x.id, w.member.token)).blocked, false);
});

test("dependencies emit no events and are audited as dependency.added and dependency.removed on the blocked card", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const c = await cards(api, w.cols[0], w.member, ["x", "a"]);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(1000);
  await blockOk(api, c.x.id, c.a.id, w.member);
  assertError(await block(api, c.x.id, c.a.id, w.member), 409, "dependency_exists");
  clock.advance(1000);
  await ok(api, 204, "DELETE", `/cards/${c.x.id}/blockers/${c.a.id}`, undefined, w.admin.token);
  assert.deepEqual(await log.names(), []);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.via, e.details, e.at]),
    [
      ["dependency.added", "card", c.x.id, w.member.id, null, { blockerId: c.a.id }, new Date(clock.t - 1000).toISOString()],
      ["dependency.removed", "card", c.x.id, w.admin.id, null, { blockerId: c.a.id }, clock.iso()],
    ],
  );
});

test("viewers read the lists but get 403 on blocker writes; non-members get 404", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["x", "a", "b"]);
  await blockOk(api, c.x.id, c.a.id, w.member);
  assertError(await block(api, c.x.id, c.b.id, w.viewer), 403, "forbidden");
  assertError(await block(api, c.x.id, "not-a-card", w.viewer), 403, "forbidden", "role before validation");
  assertError(await api.call("DELETE", `/cards/${c.x.id}/blockers/${c.a.id}`, undefined, w.viewer.token), 403, "forbidden");
  assert.deepEqual(await listIds(api, `/cards/${c.x.id}/blockers`, w.viewer.token), [c.a.id]);
  assert.deepEqual(await listIds(api, `/cards/${c.a.id}/blocking`, w.viewer.token), [c.x.id]);
  assertError(await api.call("GET", `/cards/${c.x.id}/blockers`, undefined, w.outsider.token), 404, "not_found");
  assertError(await api.call("GET", `/cards/${c.a.id}/blocking`, undefined, w.outsider.token), 404, "not_found");
  assertError(await block(api, c.x.id, c.b.id, w.outsider), 404, "not_found");
  assertError(await block(api, "no-such-card", c.b.id, w.member), 404, "not_found");
});

test("a column becoming a done column completes its cards and so unblocks the cards they block; turning it back blocks them again", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["x"]);
  const blocker = await createCard(api, w.cols[1], w.member, { title: "blocker" });
  await blockOk(api, c.x.id, blocker.id, w.member);
  assert.equal((await getCard(api, c.x.id, w.member.token)).blocked, true);
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { category: "done" }, w.owner.token);
  assert.notEqual((await getCard(api, blocker.id, w.member.token)).completedAt, null);
  assert.equal((await getCard(api, c.x.id, w.member.token)).blocked, false);
  assertStatus(await move(api, c.x.id, w.cols[2], w.member), 200, "no open blocker any more");
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { category: "in_progress" }, w.owner.token);
  assert.equal((await getCard(api, blocker.id, w.member.token)).completedAt, null);
  assert.equal((await getCard(api, c.x.id, w.member.token)).blocked, true, "blocked again, even inside a done column");
});

test("blocked follows the dependencies on every card read: the board list and search blocked=true|false", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["x", "y", "blocker"]);
  await blockOk(api, c.x.id, c.blocker.id, w.member);
  const board = await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token);
  assert.deepEqual(board.items.map((x: any) => [x.id, x.blocked]), [
    [c.x.id, true],
    [c.y.id, false],
    [c.blocker.id, false],
  ]);
  const t1 = await ok(api, 200, "GET", `/teams/${w.team.id}/search?blocked=true`, undefined, w.member.token);
  assert.deepEqual(t1.items.map((x: any) => x.id), [c.x.id]);
  const f1 = await ok(api, 200, "GET", `/teams/${w.team.id}/search?blocked=false`, undefined, w.member.token);
  assert.deepEqual(f1.items.map((x: any) => x.id), [c.y.id, c.blocker.id]);
  assertError(await api.call("GET", `/teams/${w.team.id}/search?blocked=yes`, undefined, w.member.token), 400, "invalid_query");
  await ok(api, 204, "DELETE", `/cards/${c.blocker.id}`, undefined, w.member.token);
  const t2 = await ok(api, 200, "GET", `/teams/${w.team.id}/search?blocked=true`, undefined, w.member.token);
  assert.deepEqual(t2.items, []);
});

test("API keys: a read key gets 403 insufficient_scope on blocker writes even for an unknown card; a write key acts as its owner", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c = await cards(api, w.cols[0], w.member, ["x", "a"]);
  const readKey = (await createApiKey(api, w.member, { scope: "read" })).secret;
  const writeKey = (await createApiKey(api, w.member, { scope: "write" })).secret;
  assertError(await block(api, "no-such-card", c.a.id, readKey), 403, "insufficient_scope", "before 404");
  assertError(await block(api, c.x.id, c.a.id, readKey), 403, "insufficient_scope");
  assertError(await api.call("DELETE", `/cards/${c.x.id}/blockers/${c.a.id}`, undefined, readKey), 403, "insufficient_scope");
  assert.deepEqual(await listIds(api, `/cards/${c.x.id}/blockers`, readKey), []);
  assertError(await block(api, "no-such-card", c.a.id, writeKey), 404, "not_found");
  assertStatus(await block(api, c.x.id, c.a.id, writeKey), 201);
  const audit = await auditLog(api, w.admin.token, w.team.id);
  assert.deepEqual([audit.at(-1).action, audit.at(-1).actorId], ["dependency.added", w.member.id]);
  const viewerKey = (await createApiKey(api, w.viewer, { scope: "write" })).secret;
  assertError(await api.call("DELETE", `/cards/${c.x.id}/blockers/${c.a.id}`, undefined, viewerKey), 403, "forbidden", "the owner's role still applies");
});

test("an Idempotency-Key replay of POST blockers answers the stored dependency and adds nothing; without the key a repeat is dependency_exists", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const c = await cards(api, w.cols[0], w.member, ["x", "a", "b"]);
  const first = await api.call("POST", `/cards/${c.x.id}/blockers`, { blockerId: c.a.id }, w.member.token, { idem: "dep-1" });
  assertStatus(first, 201);
  clock.advance(1000);
  const again = await api.call("POST", `/cards/${c.x.id}/blockers`, { blockerId: c.a.id }, w.member.token, { idem: "dep-1" });
  assertStatus(again, 201);
  assert.equal(again.text, first.text);
  assert.equal(again.headers.get("idempotency-replayed"), "true");
  assertError(await api.call("POST", `/cards/${c.x.id}/blockers`, { blockerId: c.b.id }, w.member.token, { idem: "dep-1" }), 409, "idempotency_conflict");
  assertError(await block(api, c.x.id, c.a.id, w.member), 409, "dependency_exists");
  const other = await api.call("POST", `/cards/${c.b.id}/blockers`, { blockerId: c.a.id }, w.member.token, { idem: "dep-1" });
  assertStatus(other, 201, "the same key on another path is unrelated");
  assert.deepEqual(await listIds(api, `/cards/${c.x.id}/blockers`, w.member.token), [c.a.id]);
  const added = (await auditLog(api, w.admin.token, w.team.id)).filter((e) => e.action === "dependency.added");
  assert.deepEqual(added.map((e) => e.targetId), [c.x.id, c.b.id]);
});
