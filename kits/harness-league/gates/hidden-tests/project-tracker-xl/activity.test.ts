// Area `activity`: instruction.md section 25 (Activity and card history): one activity entry per
// event, appended in step 4 of the change pipeline (section 0.8).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  addMember,
  assertError,
  Clock,
  createApiKey,
  createBoard,
  createCard,
  createProject,
  createRule,
  ok,
  setupBoard,
} from "./helpers.ts";
import { addItem, archive, assertKeys, comment, feed, history, instantiate, mkSprint, mkTemplate, move, startApp } from "./helpers-pipeline.ts";

const teamFeed = (api: Api, token: string, teamId: string, q = "") => feed(api, token, `/teams/${teamId}/activity${q === "" ? "" : `?${q}`}`);
const events = (items: any[]): string[] => items.map((e) => e.event);

test("an activity entry has the documented shape: the event's name, actor, via and data, its card and project, at its occurredAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  clock.advance(5000);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const entry = (await teamFeed(api, w.viewer.token, w.team.id)).at(-1);
  assertKeys(entry, ["id", "teamId", "projectId", "cardId", "event", "actorId", "via", "data", "at"], "activity entry");
  assert.deepEqual(
    [entry.teamId, entry.projectId, entry.cardId, entry.event, entry.actorId, entry.via, entry.at],
    [w.team.id, w.project.id, card.id, "card.created", w.member.id, null, clock.iso()],
  );
  assert.deepEqual(entry.data, { card });
});

test("member events have no card or project; sprint events have the sprint's project and no card", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner);
  const started = await ok(api, 200, "POST", `/sprints/${s.id}/start`, undefined, w.owner.token);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.viewer.id}`, undefined, w.admin.token);
  const items = await teamFeed(api, w.owner.token, w.team.id);
  assert.deepEqual(events(items), ["member.added", "member.added", "member.added", "sprint.started", "member.removed"]);
  const added = items[0];
  assert.deepEqual([added.cardId, added.projectId, added.actorId, added.data.member.userId, added.data.member.role], [null, null, w.owner.id, w.admin.id, "admin"]);
  assert.deepEqual([items[3].cardId, items[3].projectId, items[3].data], [null, w.project.id, { sprint: started }]);
  assert.deepEqual([items[4].cardId, items[4].projectId, items[4].actorId, items[4].data], [null, null, w.admin.id, { userId: w.viewer.id }]);
});

test("comment, checklist, move and attachment events are filed under their card and project", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const c = await comment(api, card.id, w.member, "hello");
  const item = await addItem(api, card.id, w.member, "x");
  await ok(api, 200, "PATCH", `/checklist/${item.id}`, { done: true }, w.member.token);
  await move(api, card.id, w.admin, w.cols[1]);
  const cardItems = await feed(api, w.viewer.token, `/cards/${card.id}/activity`);
  assert.deepEqual(events(cardItems), ["card.created", "comment.created", "checklist.completed", "card.moved"]);
  assert.ok(cardItems.every((e) => e.cardId === card.id && e.projectId === w.project.id));
  assert.deepEqual(cardItems[1].data, { comment: c });
  assert.deepEqual([cardItems[3].actorId, cardItems[3].data.fromColumnId, cardItems[3].data.toColumnId], [w.admin.id, w.cols[0], w.cols[1]]);
});

test("only events make entries: project, webhook, dependency, time and checklist item writes add none; a failed request adds none", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  const before = (await teamFeed(api, w.owner.token, w.team.id)).length;
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { description: "d" }, w.owner.token);
  await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: "http://127.0.0.1:9/hook", events: ["*"], active: false }, w.owner.token);
  await ok(api, 201, "POST", `/cards/${a.id}/blockers`, { blockerId: b.id }, w.member.token);
  await ok(api, 201, "POST", `/cards/${a.id}/time-entries`, { minutes: 5 }, w.member.token);
  await addItem(api, a.id, w.member, "open item");
  assertError(await api.call("PATCH", `/cards/${a.id}`, { title: "" }, w.member.token), 400, "invalid_body");
  assertError(await api.call("POST", `/cards/${a.id}/move`, { columnId: w.cols[2] }, w.member.token), 409, "blocked");
  assert.equal((await teamFeed(api, w.owner.token, w.team.id)).length, before);
});

test("the team feed filters by ?event and ?actorId exactly; empty or unknown values match nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "d" }, w.admin.token);
  await move(api, card.id, w.member, w.cols[1]);
  assert.deepEqual(events(await teamFeed(api, w.owner.token, w.team.id, "event=card.moved")), ["card.moved"]);
  assert.deepEqual(events(await teamFeed(api, w.owner.token, w.team.id, `actorId=${w.member.id}`)), ["card.created", "card.moved"]);
  assert.deepEqual(events(await teamFeed(api, w.owner.token, w.team.id, `actorId=${w.admin.id}&event=card.updated`)), ["card.updated"]);
  assert.deepEqual(await teamFeed(api, w.owner.token, w.team.id, `actorId=${w.admin.id}&event=card.moved`), []);
  for (const q of ["event=", "actorId=", "event=card", "event=CARD.MOVED"]) assert.deepEqual(await teamFeed(api, w.owner.token, w.team.id, q), [], q);
});

test("the project and card feeds list only their own entries, newest first", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const ob = await createBoard(api, ops.id, w.owner);
  clock.advance(1000);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  clock.advance(1000);
  const o = await createCard(api, ob.columns[0].id, w.member, { title: "o" });
  clock.advance(1000);
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  clock.advance(1000);
  await move(api, a.id, w.member, w.cols[1]);
  const proj = await ok(api, 200, "GET", `/projects/${w.project.id}/activity`, undefined, w.viewer.token);
  assert.deepEqual(proj.items.map((e: any) => [e.event, e.cardId]), [["card.moved", a.id], ["card.created", b.id], ["card.created", a.id]]);
  const opsFeed = await ok(api, 200, "GET", `/projects/${ops.id}/activity`, undefined, w.viewer.token);
  assert.deepEqual(opsFeed.items.map((e: any) => e.cardId), [o.id]);
  const cardFeed = await ok(api, 200, "GET", `/cards/${a.id}/activity`, undefined, w.viewer.token);
  assert.deepEqual(cardFeed.items.map((e: any) => e.event), ["card.moved", "card.created"]);
  assert.equal(cardFeed.nextCursor, null);
});

test("/me/activity lists the caller's own entries in teams they belong to; a team-restricted key sees only its team", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.owner.token);
  await addMember(api, other.id, w.owner, w.member, "member");
  const op = await createProject(api, other.id, w.owner, "OTH");
  const ob = await createBoard(api, op.id, w.owner);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, ob.columns[0].id, w.member, { title: "b" });
  await createCard(api, w.cols[0], w.admin, { title: "not mine" });
  const mine = await feed(api, w.member.token, "/me/activity");
  assert.deepEqual(mine.map((e) => e.cardId), [a.id, b.id]);
  const key = (await createApiKey(api, w.member, { scope: "read", teamId: w.team.id })).secret;
  assert.deepEqual((await feed(api, key, "/me/activity")).map((e) => e.cardId), [a.id]);
  await ok(api, 204, "DELETE", `/teams/${other.id}/members/${w.member.id}`, undefined, w.member.token);
  assert.deepEqual((await feed(api, w.member.token, "/me/activity")).map((e) => e.cardId), [a.id], "a team the caller left is not listed");
});

test("activity feeds paginate with limit and cursor, visiting every entry once; bad limits and cursors are 400 invalid_query", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  for (let i = 0; i < 6; i++) {
    clock.advance(1000);
    await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: `t${i}` }, w.member.token);
  }
  const first = await ok(api, 200, "GET", `/cards/${card.id}/activity?limit=4`, undefined, w.member.token);
  assert.equal(first.items.length, 4);
  assert.equal(first.items[0].data.card.title, "t5");
  const all = await feed(api, w.member.token, `/cards/${card.id}/activity`);
  assert.deepEqual(all.map((e) => e.data.card.title), ["c", "t0", "t1", "t2", "t3", "t4", "t5"]);
  for (const path of [`/teams/${w.team.id}/activity`, `/projects/${w.project.id}/activity`, `/cards/${card.id}/activity`, "/me/activity"]) {
    for (const q of ["limit=0", "limit=101", "limit=", "cursor=zzz", "cursor="]) {
      assertError(await api.call("GET", `${path}?${q}`, undefined, w.owner.token), 400, "invalid_query", `${path}?${q}`);
    }
  }
});

test("card history records the creation and every move, within a column too, and by rules, oldest first with timestamps", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, defaultPlan: "team" });
  const w = await setupBoard(api, clock);
  await createRule(api, w.team.id, w.admin, { trigger: { event: "card.moved", toColumnId: w.cols[1] }, actions: [{ type: "move_to_column", columnId: w.cols[2] }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await createCard(api, w.cols[0], w.member, { title: "d" });
  clock.advance(1000);
  await move(api, card.id, w.member, w.cols[0], 1);
  clock.advance(1000);
  await move(api, card.id, w.member, w.cols[1]);
  const body = await ok(api, 200, "GET", `/cards/${card.id}/history`, undefined, w.viewer.token);
  assert.deepEqual(body.items.map((h: any) => [h.fromColumnId, h.toColumnId, h.at]), [
    [null, w.cols[0], "2026-03-01T12:00:03.000Z"],
    [w.cols[0], w.cols[0], "2026-03-01T12:00:04.000Z"],
    [w.cols[0], w.cols[1], "2026-03-01T12:00:05.000Z"],
    [w.cols[1], w.cols[2], "2026-03-01T12:00:05.000Z"],
  ]);
  assertKeys(body.items[0], ["fromColumnId", "toColumnId", "at"], "history entry");
});

test("history records a restore from the card's column to the target; archiving and cascades (column delete, category change) record nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[1], w.member, { title: "c" });
  await archive(api, card.id, w.member);
  await ok(api, 200, "POST", `/cards/${card.id}/restore`, { columnId: w.cols[0] }, w.member.token);
  assert.deepEqual(await history(api, w.member.token, card.id), [[null, w.cols[1]], [w.cols[1], w.cols[0]]]);
  await ok(api, 200, "PATCH", `/columns/${w.cols[0]}`, { category: "done" }, w.owner.token);
  const extra = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "Extra" }, w.owner.token);
  await move(api, card.id, w.member, extra.id);
  await ok(api, 204, "DELETE", `/columns/${extra.id}?moveTo=${w.cols[1]}`, undefined, w.owner.token);
  assert.equal((await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.member.token)).columnId, w.cols[1]);
  assert.deepEqual(await history(api, w.member.token, card.id), [[null, w.cols[1]], [w.cols[1], w.cols[0]], [w.cols[0], extra.id]]);
});

test("cards made from a template or imported from CSV start their history with a creation entry; an import row's move adds one", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const tpl = await mkTemplate(api, w.project.id, w.owner);
  const fromTpl = (await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[1] })).body;
  assert.deepEqual(await history(api, w.member.token, fromTpl.id), [[null, w.cols[1]]]);
  await ok(api, 200, "POST", `/projects/${w.project.id}/import`, { csv: "board,column,title\r\nBoard,To do,imported\r\n" }, w.owner.token);
  const imported = (await ok(api, 200, "GET", `/boards/${w.board.id}/cards?columnId=${w.cols[0]}`, undefined, w.member.token)).items[0];
  assert.equal(imported.title, "imported");
  assert.deepEqual(await history(api, w.member.token, imported.id), [[null, w.cols[0]]]);
  await ok(api, 200, "POST", `/projects/${w.project.id}/import`, { csv: `number,board,column,title\r\n${imported.number},Board,Done,imported\r\n` }, w.owner.token);
  assert.deepEqual(await history(api, w.member.token, imported.id), [[null, w.cols[0]], [w.cols[0], w.cols[2]]]);
  const entries = await feed(api, w.owner.token, `/cards/${imported.id}/activity`);
  assert.deepEqual(entries, [], "imports emit no events");
});

test("entries of a deleted card stay in the team and project feeds, while its own feed and history are 404", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await ok(api, 204, "DELETE", `/cards/${card.id}`, undefined, w.member.token);
  const teamItems = await teamFeed(api, w.owner.token, w.team.id, `event=card.deleted`);
  assert.deepEqual(teamItems.map((e) => [e.cardId, e.projectId, e.data.card.id]), [[card.id, w.project.id, card.id]]);
  const projectItems = await feed(api, w.owner.token, `/projects/${w.project.id}/activity`);
  assert.deepEqual(events(projectItems), ["card.created", "card.deleted"]);
  assertError(await api.call("GET", `/cards/${card.id}/activity`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/cards/${card.id}/history`, undefined, w.owner.token), 404, "not_found");
});

test("scheduler events are filed with actor null and via schedule: card.due and the trash purge's card.deleted", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, trash: { retentionMs: 3_600_000 } });
  const w = await setupBoard(api, clock);
  const due = await createCard(api, w.cols[0], w.member, { title: "due", dueDate: "2026-03-02" });
  const gone = await createCard(api, w.cols[0], w.member, { title: "gone" });
  await archive(api, gone.id, w.member);
  clock.set(Date.parse("2026-03-02T00:00:00.000Z"));
  await ok(api, 200, "GET", "/health");
  const items = await teamFeed(api, w.owner.token, w.team.id);
  const tail = items.slice(-2);
  assert.deepEqual(tail.map((e) => [e.event, e.cardId, e.actorId, e.via, e.at]), [
    ["card.deleted", gone.id, null, { type: "schedule" }, "2026-03-02T00:00:00.000Z"],
    ["card.due", due.id, null, { type: "schedule" }, "2026-03-02T00:00:00.000Z"],
  ], "the purge was due earlier (archivedAt + 1 h), so it runs first");
});

test("viewers read every feed and history; non-members get 404 for the team, project and card routes", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  for (const path of [`/teams/${w.team.id}/activity`, `/projects/${w.project.id}/activity`, `/cards/${card.id}/activity`, `/cards/${card.id}/history`]) {
    await ok(api, 200, "GET", path, undefined, w.viewer.token);
    assertError(await api.call("GET", path, undefined, w.outsider.token), 404, "not_found", path);
  }
  assert.deepEqual((await ok(api, 200, "GET", "/me/activity", undefined, w.outsider.token)).items, []);
  assertError(await api.call("GET", "/me/activity"), 401, "unauthorized");
});

test("deleting a team deletes its activity: its entries leave the actor's own feed", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.member.token);
  const op = await createProject(api, other.id, w.member, "OTH");
  const ob = await createBoard(api, op.id, w.member);
  const kept = await createCard(api, w.cols[0], w.member, { title: "kept" });
  await createCard(api, ob.columns[0].id, w.member, { title: "gone" });
  assert.equal((await feed(api, w.member.token, "/me/activity")).length, 2);
  await ok(api, 204, "DELETE", `/teams/${other.id}`, undefined, w.member.token);
  assert.deepEqual((await feed(api, w.member.token, "/me/activity")).map((e) => e.cardId), [kept.id]);
});
