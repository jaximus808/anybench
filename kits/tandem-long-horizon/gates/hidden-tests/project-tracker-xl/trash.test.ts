// Area `trash`: instruction.md section 31 (Archive and trash), with the purge job of the scheduler
// (section 0.9) and the archived-card rules it sets for other sections.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Api,
  assertError,
  assertStatus,
  auditLog,
  Clock,
  createCard,
  eventLog,
  getCard,
  ok,
  setupBoard,
  tempDir,
  upload,
} from "./helpers.ts";
import { archive, comment, history, mkSprint, startApp, watcherIds } from "./helpers-pipeline.ts";

const DAY = 86_400_000;
const restore = (api: Api, cardId: string, token: string, body: unknown = {}) => api.call("POST", `/cards/${cardId}/restore`, body, token);
const trash = async (api: Api, projectId: string, token: string): Promise<any[]> => (await ok(api, 200, "GET", `/projects/${projectId}/trash`, undefined, token)).items;
const boardIds = async (api: Api, boardId: string, token: string): Promise<string[]> => (await ok(api, 200, "GET", `/boards/${boardId}/cards`, undefined, token)).items.map((c: any) => c.id);

test("archiving sets archived, archivedAt now and position null, closes the gap, keeps the rest, and is emitted and audited", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const s = await mkSprint(api, w.project.id, w.owner);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b", labels: ["x"], sprintId: s.id, assigneeId: w.member.id });
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(60_000);
  const res = await archive(api, b.id, w.member);
  assert.deepEqual([res.archived, res.archivedAt, res.position, res.updatedAt], [true, clock.iso(), null, clock.iso()]);
  assert.deepEqual([res.columnId, res.labels, res.sprintId, res.assigneeId], [w.cols[0], ["x"], s.id, w.member.id]);
  const list = (await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token)).items;
  assert.deepEqual(list.map((x: any) => [x.id, x.position]), [[a.id, 0], [c.id, 1]]);
  assert.deepEqual(await log.names(), ["card.archived"]);
  const [ev] = await log.events(1);
  assert.deepEqual([ev.actorId, ev.via, ev.data], [w.member.id, null, { card: res }]);
  const entry = (await auditLog(api, w.admin.token, w.team.id)).at(-1);
  assert.deepEqual([entry.action, entry.targetType, entry.targetId, entry.actorId, entry.details], ["card.archived", "card", b.id, w.member.id, {}]);
});

test("archiving an archived card is 409 card_archived; in an archived project project_archived comes first; viewers get 403", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assertError(await api.call("POST", `/cards/${card.id}/archive`, undefined, w.viewer.token), 403, "forbidden");
  await archive(api, card.id, w.member);
  assertError(await api.call("POST", `/cards/${card.id}/archive`, undefined, w.member.token), 409, "card_archived");
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", `/cards/${card.id}/archive`, undefined, w.member.token), 409, "project_archived");
  assertError(await restore(api, card.id, w.member.token), 409, "project_archived");
  assertError(await api.call("POST", `/cards/no-such-card/archive`, undefined, w.member.token), 404, "not_found");
});

test("an archived card leaves board lists, search, sprint lists, WIP counts and column_not_empty", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s = await mkSprint(api, w.project.id, w.owner);
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 1 }, w.owner.token);
  const card = await createCard(api, w.cols[1], w.member, { title: "findme", sprintId: s.id });
  await archive(api, card.id, w.member);
  assert.deepEqual(await boardIds(api, w.board.id, w.member.token), []);
  assert.deepEqual((await ok(api, 200, "GET", `/teams/${w.team.id}/search?q=findme`, undefined, w.member.token)).items, []);
  assert.deepEqual((await ok(api, 200, "GET", `/teams/${w.team.id}/search?q=findme&includeArchived=true`, undefined, w.member.token)).items, [], "archived cards are never search results");
  assert.deepEqual((await ok(api, 200, "GET", `/sprints/${s.id}/cards`, undefined, w.member.token)).items, []);
  assertStatus(await api.call("POST", `/columns/${w.cols[1]}/cards`, { title: "fits" }, w.member.token), 201, "the archived card does not count toward the WIP limit");
  const extra = await ok(api, 201, "POST", `/boards/${w.board.id}/columns`, { name: "Extra", position: 1 }, w.owner.token);
  const lone = await createCard(api, extra.id, w.member, { title: "lone" });
  await archive(api, lone.id, w.member);
  assertStatus(await api.call("DELETE", `/columns/${extra.id}`, undefined, w.owner.token), 204, "only an archived card left: not column_not_empty");
  assert.equal((await getCard(api, lone.id, w.member.token)).columnId, w.cols[0], "it moves to the column at position 0");
});

test("an archived card is still returned by GET, the trash, the blocker lists and exports, but is never an open blocker", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const blocked = await createCard(api, w.cols[0], w.member, { title: "blocked" });
  const blocker = await createCard(api, w.cols[0], w.member, { title: "blocker" });
  await ok(api, 201, "POST", `/cards/${blocked.id}/blockers`, { blockerId: blocker.id }, w.member.token);
  assert.equal((await getCard(api, blocked.id, w.member.token)).blocked, true);
  await archive(api, blocker.id, w.member);
  assert.equal((await getCard(api, blocked.id, w.member.token)).blocked, false);
  assert.equal((await getCard(api, blocker.id, w.member.token)).archived, true);
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${blocked.id}/blockers`, undefined, w.member.token)).items.map((c: any) => c.id), [blocker.id]);
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${blocker.id}/blocking`, undefined, w.member.token)).items.map((c: any) => c.id), [blocked.id]);
  assert.deepEqual((await trash(api, w.project.id, w.viewer.token)).map((c) => c.id), [blocker.id]);
  const doc = await ok(api, 200, "GET", `/projects/${w.project.id}/export`, undefined, w.viewer.token);
  assert.deepEqual(doc.cards.map((c: any) => [c.title, c.archived]), [["blocked", false], ["blocker", true]]);
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.owner.token)).usage.cards, 2, "it still counts toward the cards quota");
});

test("writes to an archived card answer 409 card_archived", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s = await mkSprint(api, w.project.id, w.owner);
  const f = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "F", type: "text" }, w.owner.token);
  const other = await createCard(api, w.cols[0], w.member, { title: "other" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c", sprintId: s.id });
  const c = await comment(api, card.id, w.member, "hello");
  const item = await ok(api, 201, "POST", `/cards/${card.id}/checklist`, { text: "x" }, w.member.token);
  const att = (await upload(api, card.id, w.member.token, "bytes", "a.txt")).body;
  await archive(api, card.id, w.member);
  const writes: [string, string, unknown][] = [
    ["PATCH", `/cards/${card.id}`, { title: "x" }],
    ["POST", `/cards/${card.id}/move`, { columnId: w.cols[1] }],
    ["POST", `/cards/${card.id}/comments`, { body: "x" }],
    ["PATCH", `/comments/${c.id}`, { body: "x" }],
    ["DELETE", `/comments/${c.id}`, undefined],
    ["PUT", `/cards/${card.id}/fields/${f.id}`, { value: "v" }],
    ["DELETE", `/cards/${card.id}/fields/${f.id}`, undefined],
    ["POST", `/cards/${card.id}/checklist`, { text: "y" }],
    ["PATCH", `/checklist/${item.id}`, { done: true }],
    ["POST", `/cards/${card.id}/blockers`, { blockerId: other.id }],
    ["POST", `/cards/${other.id}/blockers`, { blockerId: card.id }],
    ["PATCH", `/attachments/${att.id}`, { filename: "b.txt" }],
    ["DELETE", `/attachments/${att.id}`, undefined],
    ["POST", `/cards/${card.id}/time-entries`, { minutes: 5 }],
    ["POST", `/cards/${card.id}/timer/start`, undefined],
    ["DELETE", `/sprints/${s.id}/cards/${card.id}`, undefined],
  ];
  for (const [m, p, body] of writes) assertError(await api.call(m, p, body, w.member.token), 409, "card_archived", `${m} ${p}`);
  assertError(await upload(api, card.id, w.member.token, "more", "b.txt"), 409, "card_archived", "upload");
  const now = await getCard(api, card.id, w.member.token);
  assert.deepEqual([now.title, now.sprintId, now.checklist, now.minutesLogged], ["c", s.id, { total: 1, done: 0 }, 0]);
});

test("on an archived card DELETE, watching, unwatching and stopping a running timer still work", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await ok(api, 200, "POST", `/cards/${card.id}/timer/start`, undefined, w.member.token);
  await archive(api, card.id, w.member);
  await ok(api, 204, "POST", `/cards/${card.id}/watch`, undefined, w.viewer.token);
  await ok(api, 204, "DELETE", `/cards/${card.id}/watch`, undefined, w.member.token);
  assert.deepEqual(await watcherIds(api, w.viewer.token, card.id), [w.viewer.id]);
  clock.advance(10 * 60_000);
  const entry = await ok(api, 201, "POST", `/cards/${card.id}/timer/stop`, undefined, w.member.token);
  assert.deepEqual([entry.minutes, entry.source], [10, "timer"]);
  await ok(api, 204, "DELETE", `/cards/${card.id}`, undefined, w.member.token);
  assertError(await api.call("GET", `/cards/${card.id}`, undefined, w.member.token), 404, "not_found");
});

test("restore with an empty body puts the card back at the end of its column, records history, and is emitted and audited", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[1], w.member, { title: "c" });
  await archive(api, card.id, w.member);
  const x = await createCard(api, w.cols[1], w.member, { title: "x" });
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(60_000);
  const res = await restore(api, card.id, w.member.token);
  assertStatus(res, 200);
  assert.deepEqual([res.body.archived, res.body.archivedAt, res.body.columnId, res.body.position, res.body.updatedAt], [false, null, w.cols[1], 1, clock.iso()]);
  assert.deepEqual(await boardIds(api, w.board.id, w.member.token), [x.id, card.id]);
  assert.deepEqual(await history(api, w.member.token, card.id), [[null, w.cols[1]], [w.cols[1], w.cols[1]]]);
  assert.deepEqual(await log.names(), ["card.restored"]);
  const [ev] = await log.events(1);
  assert.deepEqual(ev.data, { card: res.body });
  const entry = (await auditLog(api, w.admin.token, w.team.id)).at(-1);
  assert.deepEqual([entry.action, entry.targetId, entry.details], ["card.restored", card.id, {}]);
});

test("restore takes a column of the card's board and a position 0 .. n; other values, a non-object body and a card that is not archived are refused", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await ok(api, 201, "POST", `/projects/${w.project.id}/boards`, { name: "Other" }, w.owner.token);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[2], w.member, { title: "b" });
  const card = await createCard(api, w.cols[0], w.member, { title: "card" });
  await archive(api, card.id, w.member);
  assertError(await api.call("POST", `/cards/${card.id}/restore`, undefined, w.member.token), 400, "invalid_body", "a missing body");
  for (const body of [[], "x", { columnId: other.columns[0].id }, { columnId: "nope" }, { position: 2, columnId: w.cols[2] }, { position: -1 }, { position: "0" }]) {
    assertError(await restore(api, card.id, w.member.token, body), 400, "invalid_body", JSON.stringify(body));
  }
  const res = await restore(api, card.id, w.member.token, { columnId: w.cols[2], position: 0 });
  assert.deepEqual([res.body.columnId, res.body.position], [w.cols[2], 0]);
  assert.deepEqual((await ok(api, 200, "GET", `/boards/${w.board.id}/cards?columnId=${w.cols[2]}`, undefined, w.member.token)).items.map((c: any) => c.id), [card.id, b.id]);
  assert.deepEqual(await history(api, w.member.token, card.id), [[null, w.cols[0]], [w.cols[0], w.cols[2]]]);
  assertError(await restore(api, card.id, w.member.token), 409, "card_not_archived");
  assertError(await restore(api, a.id, w.member.token, { columnId: "nope" }), 400, "invalid_body", "validation before card_not_archived");
  assertError(await restore(api, card.id, w.viewer.token), 403, "forbidden");
});

test("restore checks the target column's WIP limit (409 wip_limit_reached) but not blocked", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[1], w.member, { title: "c" });
  const blocker = await createCard(api, w.cols[0], w.member, { title: "blocker" });
  await ok(api, 201, "POST", `/cards/${card.id}/blockers`, { blockerId: blocker.id }, w.member.token);
  await archive(api, card.id, w.member);
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 1 }, w.owner.token);
  await createCard(api, w.cols[1], w.member, { title: "fills" });
  assertError(await restore(api, card.id, w.member.token), 409, "wip_limit_reached", "its own column counts too");
  const res = await restore(api, card.id, w.member.token, { columnId: w.cols[2] });
  assertStatus(res, 200, "into a done column while blocked");
  assert.deepEqual([res.body.columnId, res.body.blocked], [w.cols[2], true]);
});

test("restore sets completedAt: kept for a done target when set, now for a done target when null, null for any other target", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const done = await createCard(api, w.cols[2], w.member, { title: "done" });
  const open = await createCard(api, w.cols[0], w.member, { title: "open" });
  const back = await createCard(api, w.cols[2], w.member, { title: "back" });
  for (const c of [done, open, back]) await archive(api, c.id, w.member);
  clock.advance(60_000);
  const r1 = (await restore(api, done.id, w.member.token)).body;
  const r2 = (await restore(api, open.id, w.member.token, { columnId: w.cols[2] })).body;
  const r3 = (await restore(api, back.id, w.member.token, { columnId: w.cols[1] })).body;
  assert.deepEqual([r1.completedAt, r2.completedAt, r3.completedAt], [done.completedAt, clock.iso(), null]);
});

test("the trash lists archived cards newest archivedAt first, ties by number descending, with pagination; viewers read it, non-members get 404", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const cards: any[] = [];
  for (let i = 0; i < 5; i++) cards.push(await createCard(api, w.cols[0], w.member, { title: `c${i}` }));
  await createCard(api, w.cols[0], w.member, { title: "not archived" });
  await archive(api, cards[3].id, w.member);
  clock.advance(1000);
  await archive(api, cards[0].id, w.member);
  await archive(api, cards[4].id, w.member);
  await archive(api, cards[1].id, w.member);
  const all = await trash(api, w.project.id, w.viewer.token);
  assert.deepEqual(all.map((c) => c.id), [cards[4].id, cards[1].id, cards[0].id, cards[3].id]);
  const p1 = await ok(api, 200, "GET", `/projects/${w.project.id}/trash?limit=3`, undefined, w.viewer.token);
  const p2 = await ok(api, 200, "GET", `/projects/${w.project.id}/trash?limit=3&cursor=${encodeURIComponent(p1.nextCursor)}`, undefined, w.viewer.token);
  assert.deepEqual([...p1.items, ...p2.items].map((c: any) => c.id), all.map((c) => c.id));
  assert.equal(p2.nextCursor, null);
  for (const q of ["limit=0", "limit=101", "cursor=x"]) assertError(await api.call("GET", `/projects/${w.project.id}/trash?${q}`, undefined, w.viewer.token), 400, "invalid_query", q);
  assertError(await api.call("GET", `/projects/${w.project.id}/trash`, undefined, w.outsider.token), 404, "not_found");
});

test("an archived card is purged trash.retentionMs after archivedAt, on the next request: card.deleted with actor null and a card.purged audit entry", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, trash: { retentionMs: DAY } });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const archived = await archive(api, card.id, w.member);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.set(Date.parse(archived.archivedAt) + DAY - 1);
  await getCard(api, card.id, w.member.token);
  clock.set(Date.parse(archived.archivedAt) + DAY);
  await ok(api, 200, "GET", "/health");
  assertError(await api.call("GET", `/cards/${card.id}`, undefined, w.member.token), 404, "not_found");
  assert.deepEqual(await trash(api, w.project.id, w.member.token), []);
  assert.deepEqual(await log.names(), ["card.deleted"]);
  const [ev] = await log.events(1);
  assert.deepEqual([ev.actorId, ev.via, ev.occurredAt, ev.data.card.id, ev.data.card.archived], [null, { type: "schedule" }, clock.iso(), card.id, true]);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.via, e.details]), [["card.purged", "card", card.id, null, { type: "schedule" }, {}]]);
});

test("restoring or deleting cancels the purge; archiving again schedules it from the new archivedAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, trash: { retentionMs: DAY } });
  const w = await setupBoard(api, clock);
  const kept = await createCard(api, w.cols[0], w.member, { title: "kept" });
  const deleted = await createCard(api, w.cols[0], w.member, { title: "deleted" });
  await archive(api, kept.id, w.member);
  await archive(api, deleted.id, w.member);
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(DAY / 2);
  await restore(api, kept.id, w.member.token);
  await ok(api, 204, "DELETE", `/cards/${deleted.id}`, undefined, w.member.token);
  clock.advance(DAY / 4);
  const again = await archive(api, kept.id, w.member);
  clock.set(Date.parse(again.archivedAt) + DAY - 1);
  await ok(api, 200, "GET", "/health");
  assert.equal((await getCard(api, kept.id, w.member.token)).archived, true, "not purged at the first archivedAt + retention");
  clock.set(Date.parse(again.archivedAt) + DAY);
  await ok(api, 200, "GET", "/health");
  assertError(await api.call("GET", `/cards/${kept.id}`, undefined, w.member.token), 404, "not_found");
  assert.deepEqual(await log.names(), ["card.restored", "card.deleted", "card.archived", "card.deleted"]);
});

test("with trash.retentionMs 0 an archived card is purged on the next request, even in an archived project, with its comments and attachment bytes", async (t) => {
  const api = await startApp(t, { trash: { retentionMs: 0 } });
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const c = await comment(api, card.id, w.member, "bye");
  await upload(api, card.id, w.member.token, "some bytes", "a.txt");
  const arch = await api.call("POST", `/cards/${card.id}/archive`, undefined, w.member.token);
  assert.equal(arch.body.archived, true, "the archive response still shows the card");
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("GET", `/cards/${card.id}`, undefined, w.member.token), 404, "not_found");
  assertError(await api.call("GET", `/comments/${c.id}`, undefined, w.member.token), 404, "not_found");
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.owner.token)).usage.storageBytes, 0);
  assert.deepEqual(await trash(api, w.project.id, w.member.token), [], "reads still work in the archived project");
});

test("pending purge jobs survive a restart and run on the first request after their time", async (t) => {
  const clock = new Clock();
  const dataFile = join(tempDir(t), "tracker.json");
  const api1 = await startApp(t, { now: clock.now, dataFile, trash: { retentionMs: DAY } });
  const w = await setupBoard(api1, clock);
  const card = await createCard(api1, w.cols[0], w.member, { title: "c" });
  const archived = await archive(api1, card.id, w.member);
  await api1.close();
  clock.set(Date.parse(archived.archivedAt) + DAY);
  const api2 = await startApp(t, { now: clock.now, dataFile, trash: { retentionMs: DAY } });
  assertError(await api2.call("GET", `/cards/${card.id}`, undefined, w.member.token), 404, "not_found");
  const entry = (await auditLog(api2, w.admin.token, w.team.id)).at(-1);
  assert.deepEqual([entry.action, entry.targetId], ["card.purged", card.id]);
});
