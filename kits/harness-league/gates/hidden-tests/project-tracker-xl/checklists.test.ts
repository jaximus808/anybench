// Area `checklists`: instruction.md section 17 (Checklists), with the conventions of section 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  assertError,
  assertQuota,
  assertStatus,
  auditLog,
  Clock,
  createCard,
  createRule,
  eventLog,
  getCard,
  ok,
  setupBoard,
} from "./helpers.ts";
import { addItem, archive, assertKeys, instantiate, mkTemplate, ruleRuns, startApp } from "./helpers-pipeline.ts";

const items = async (api: Api, cardId: string, token: string): Promise<any[]> => (await ok(api, 200, "GET", `/cards/${cardId}/checklist`, undefined, token)).items;
const texts = async (api: Api, cardId: string, token: string): Promise<string[]> => (await items(api, cardId, token)).map((i) => i.text);

test("a checklist item has the documented shape: text trimmed, not done, doneAt and doneBy null, updatedAt equal to createdAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  clock.advance(5000);
  const item = await addItem(api, card.id, w.member, "  Draft the outline  ");
  assertKeys(item, ["id", "cardId", "text", "done", "position", "doneAt", "doneBy", "createdAt", "updatedAt"], "item");
  assert.equal(item.cardId, card.id);
  assert.equal(item.text, "Draft the outline");
  assert.equal(item.done, false);
  assert.equal(item.position, 0);
  assert.equal(item.doneAt, null);
  assert.equal(item.doneBy, null);
  assert.equal(item.createdAt, clock.iso());
  assert.equal(item.updatedAt, item.createdAt);
  assert.deepEqual(await items(api, card.id, w.viewer.token), [item]);
});

test("item text is 1 to 200 chars after trimming and position an integer 0 .. n; anything else is 400 invalid_body", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const path = `/cards/${card.id}/checklist`;
  for (const text of ["", "   ", "x".repeat(201), 5, null, ["a"]]) assertError(await api.call("POST", path, { text }, w.member.token), 400, "invalid_body", JSON.stringify(text));
  assertError(await api.call("POST", path, {}, w.member.token), 400, "invalid_body", "missing text");
  assertError(await api.call("POST", path, undefined, w.member.token), 400, "invalid_body", "missing body");
  await addItem(api, card.id, w.member, "first");
  for (const position of [-1, 2, 1.5, "0", null]) assertError(await api.call("POST", path, { text: "x", position }, w.member.token), 400, "invalid_body", `position ${JSON.stringify(position)}`);
  const long = await addItem(api, card.id, w.member, ` ${"y".repeat(200)} `, { position: 1 });
  assert.equal(long.text, "y".repeat(200));
  assert.equal(long.position, 1);
  assertError(await api.call("PATCH", `/checklist/${long.id}`, {}, w.member.token), 400, "invalid_body", "a PATCH needs an updatable field");
  assertError(await api.call("PATCH", `/checklist/${long.id}`, { done: "yes" }, w.member.token), 400, "invalid_body", "done must be a boolean");
  assertError(await api.call("PATCH", `/checklist/${long.id}`, { text: " " }, w.member.token), 400, "invalid_body", "blank text");
  assert.equal((await items(api, card.id, w.member.token)).length, 2);
});

test("creating an item inserts it at position (default the end) and shifts the later items; the list is ordered by position", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await addItem(api, card.id, w.member, "b");
  await addItem(api, card.id, w.member, "d");
  const a = await addItem(api, card.id, w.member, "a", { position: 0 });
  assert.equal(a.position, 0);
  const c = await addItem(api, card.id, w.member, "c", { position: 2 });
  assert.equal(c.position, 2);
  await addItem(api, card.id, w.member, "e", { position: 4 });
  const list = await items(api, card.id, w.member.token);
  assert.deepEqual(list.map((i) => i.text), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(list.map((i) => i.position), [0, 1, 2, 3, 4]);
});

test("PATCH position moves the item to that index, keeps the others in order, and only accepts 0 .. n-1", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const made: any[] = [];
  for (const x of ["a", "b", "c", "d"]) made.push(await addItem(api, card.id, w.member, x));
  const moved = await ok(api, 200, "PATCH", `/checklist/${made[0].id}`, { position: 2 }, w.member.token);
  assert.equal(moved.position, 2);
  assert.deepEqual(await texts(api, card.id, w.member.token), ["b", "c", "a", "d"]);
  await ok(api, 200, "PATCH", `/checklist/${made[3].id}`, { position: 0 }, w.member.token);
  assert.deepEqual(await texts(api, card.id, w.member.token), ["d", "b", "c", "a"]);
  for (const position of [4, -1, 0.5]) assertError(await api.call("PATCH", `/checklist/${made[1].id}`, { position }, w.member.token), 400, "invalid_body", `position ${position}`);
  assert.deepEqual((await items(api, card.id, w.member.token)).map((i) => i.position), [0, 1, 2, 3]);
});

test("deleting an item closes the gap and answers 204; a deleted item is 404 not_found", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const made: any[] = [];
  for (const x of ["a", "b", "c"]) made.push(await addItem(api, card.id, w.member, x));
  assertStatus(await api.call("DELETE", `/checklist/${made[1].id}`, undefined, w.member.token), 204);
  const list = await items(api, card.id, w.member.token);
  assert.deepEqual(list.map((i) => [i.text, i.position]), [["a", 0], ["c", 1]]);
  assertError(await api.call("PATCH", `/checklist/${made[1].id}`, { text: "x" }, w.member.token), 404, "not_found");
  assertError(await api.call("DELETE", `/checklist/${made[1].id}`, undefined, w.member.token), 404, "not_found");
  await addItem(api, card.id, w.member, "d", { position: 2 });
  assert.deepEqual(await texts(api, card.id, w.member.token), ["a", "c", "d"]);
});

test("done false to true sets doneAt now and doneBy the caller; the same value keeps them; true to false clears both; updatedAt always moves", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const item = await addItem(api, card.id, w.member, "x");
  clock.advance(60_000);
  const doneAt = clock.iso();
  const d1 = await ok(api, 200, "PATCH", `/checklist/${item.id}`, { done: true }, w.admin.token);
  assert.deepEqual([d1.done, d1.doneAt, d1.doneBy, d1.updatedAt], [true, doneAt, w.admin.id, doneAt]);
  clock.advance(60_000);
  const d2 = await ok(api, 200, "PATCH", `/checklist/${item.id}`, { done: true }, w.member.token);
  assert.deepEqual([d2.done, d2.doneAt, d2.doneBy], [true, doneAt, w.admin.id], "sending the current value changes neither");
  assert.equal(d2.updatedAt, clock.iso());
  clock.advance(60_000);
  const d3 = await ok(api, 200, "PATCH", `/checklist/${item.id}`, { text: " renamed ", done: false }, w.member.token);
  assert.deepEqual([d3.text, d3.done, d3.doneAt, d3.doneBy, d3.updatedAt], ["renamed", false, null, null, clock.iso()]);
  assert.equal(d3.createdAt, item.createdAt);
});

test("the card's checklist summary follows its items, while checklist changes never move the card's updatedAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.deepEqual(card.checklist, { total: 0, done: 0 });
  clock.advance(1000);
  const a = await addItem(api, card.id, w.member, "a");
  const b = await addItem(api, card.id, w.member, "b");
  await addItem(api, card.id, w.member, "c");
  clock.advance(1000);
  await ok(api, 200, "PATCH", `/checklist/${a.id}`, { done: true }, w.member.token);
  await ok(api, 200, "PATCH", `/checklist/${b.id}`, { done: true }, w.member.token);
  let now = await getCard(api, card.id, w.member.token);
  assert.deepEqual(now.checklist, { total: 3, done: 2 });
  await ok(api, 204, "DELETE", `/checklist/${a.id}`, undefined, w.member.token);
  now = await getCard(api, card.id, w.member.token);
  assert.deepEqual(now.checklist, { total: 2, done: 1 });
  assert.equal(now.updatedAt, card.updatedAt);
  const listed = (await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.viewer.token)).items[0];
  assert.deepEqual(listed.checklist, { total: 2, done: 1 });
});

test("checklist.completed is emitted by the PATCH that marks the last open item done, with the card snapshot, and not again while all stay done", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = await addItem(api, card.id, w.member, "a");
  const b = await addItem(api, card.id, w.member, "b");
  const log = await eventLog(t, api, w.team.id, w.admin);
  await ok(api, 200, "PATCH", `/checklist/${a.id}`, { done: true }, w.member.token);
  assert.deepEqual(await log.names(), [], "one item is still open");
  clock.advance(1000);
  await ok(api, 200, "PATCH", `/checklist/${b.id}`, { done: true }, w.member.token);
  assert.deepEqual(await log.names(), ["checklist.completed"]);
  const [ev] = await log.events(1);
  assert.equal(ev.actorId, w.member.id);
  assert.equal(ev.via, null);
  assert.equal(ev.occurredAt, clock.iso());
  assert.equal(ev.data.card.id, card.id);
  assert.deepEqual(ev.data.card.checklist, { total: 2, done: 2 });
  await ok(api, 200, "PATCH", `/checklist/${b.id}`, { done: true }, w.member.token);
  await ok(api, 200, "PATCH", `/checklist/${a.id}`, { text: "renamed" }, w.member.token);
  assert.deepEqual(await log.names(), ["checklist.completed"], "before these, every item was already done");
  await ok(api, 200, "PATCH", `/checklist/${a.id}`, { done: false }, w.member.token);
  await ok(api, 200, "PATCH", `/checklist/${a.id}`, { done: true }, w.member.token);
  assert.deepEqual(await log.names(), ["checklist.completed", "checklist.completed"], "reopened, then completed again");
});

test("checklist.completed on DELETE: deleting the last open item completes; deleting a done item or the only item does not", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = await addItem(api, card.id, w.member, "a");
  const b = await addItem(api, card.id, w.member, "b");
  const c = await addItem(api, card.id, w.member, "c");
  await ok(api, 200, "PATCH", `/checklist/${a.id}`, { done: true }, w.member.token);
  const log = await eventLog(t, api, w.team.id, w.admin);
  await ok(api, 204, "DELETE", `/checklist/${a.id}`, undefined, w.member.token);
  assert.deepEqual(await log.names(), [], "a done item deleted while others are open");
  await ok(api, 200, "PATCH", `/checklist/${b.id}`, { done: true }, w.member.token);
  assert.deepEqual(await log.names(), []);
  await ok(api, 204, "DELETE", `/checklist/${c.id}`, undefined, w.member.token);
  assert.deepEqual(await log.names(), ["checklist.completed"], "the deleted open item counted; now every remaining item is done");
  const [ev] = await log.events(1);
  assert.deepEqual(ev.data.card.checklist, { total: 1, done: 1 });
  const solo = await createCard(api, w.cols[0], w.member, { title: "solo" });
  const only = await addItem(api, solo.id, w.member, "only");
  await ok(api, 204, "DELETE", `/checklist/${only.id}`, undefined, w.member.token);
  assert.deepEqual(await log.names(), ["checklist.completed", "card.created"], "a card left with no items is not completed");
});

test("instantiating a template with a checklist creates open items and emits no checklist.completed; completing them later does", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const tpl = await mkTemplate(api, w.project.id, w.owner, { checklist: ["one", " two "] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const res = await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0] });
  assertStatus(res, 201);
  assert.deepEqual(res.body.checklist, { total: 2, done: 0 });
  const list = await items(api, res.body.id, w.member.token);
  assert.deepEqual(list.map((i) => [i.text, i.done, i.position]), [["one", false, 0], ["two", false, 1]]);
  assert.deepEqual(await log.names(), ["card.created"]);
  for (const i of list) await ok(api, 200, "PATCH", `/checklist/${i.id}`, { done: true }, w.member.token);
  assert.deepEqual(await log.names(), ["card.created", "checklist.completed"]);
});

test("at most 50 items per card: the 51st is 409 quota_exceeded checklistItems, and a delete frees a slot", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const other = await createCard(api, w.cols[0], w.member, { title: "d" });
  let first: any;
  for (let i = 0; i < 50; i++) {
    const item = await addItem(api, card.id, w.member, `item ${i}`);
    first ??= item;
  }
  assertQuota(await api.call("POST", `/cards/${card.id}/checklist`, { text: "one more" }, w.member.token), "checklistItems", 50, 50);
  assertError(await api.call("POST", `/cards/${card.id}/checklist`, { text: "" }, w.member.token), 400, "invalid_body", "validation comes before the quota");
  await addItem(api, other.id, w.member, "the limit is per card");
  await ok(api, 204, "DELETE", `/checklist/${first.id}`, undefined, w.member.token);
  await addItem(api, card.id, w.member, "fits again");
  assert.deepEqual((await getCard(api, card.id, w.member.token)).checklist, { total: 50, done: 0 });
});

test("checklist writes on an archived card are card_archived and in an archived project project_archived, which comes first; reads still work", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const item = await addItem(api, card.id, w.member, "x");
  await archive(api, card.id, w.member);
  assertError(await api.call("POST", `/cards/${card.id}/checklist`, { text: "y" }, w.member.token), 409, "card_archived");
  assertError(await api.call("PATCH", `/checklist/${item.id}`, { done: true }, w.member.token), 409, "card_archived");
  assertError(await api.call("DELETE", `/checklist/${item.id}`, undefined, w.member.token), 409, "card_archived");
  assertError(await api.call("POST", `/cards/${card.id}/checklist`, { text: "" }, w.member.token), 400, "invalid_body", "validation before the 409");
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", `/cards/${card.id}/checklist`, { text: "y" }, w.member.token), 409, "project_archived");
  assertError(await api.call("PATCH", `/checklist/${item.id}`, { done: true }, w.member.token), 409, "project_archived");
  assertError(await api.call("DELETE", `/checklist/${item.id}`, undefined, w.member.token), 409, "project_archived");
  assert.deepEqual(await texts(api, card.id, w.viewer.token), ["x"]);
});

test("viewers read checklists but get 403 on writes; non-members get 404 for the card's items", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const item = await addItem(api, card.id, w.member, "x");
  assert.equal((await items(api, card.id, w.viewer.token)).length, 1);
  assertError(await api.call("POST", `/cards/${card.id}/checklist`, { text: "y" }, w.viewer.token), 403, "forbidden");
  assertError(await api.call("PATCH", `/checklist/${item.id}`, { done: true }, w.viewer.token), 403, "forbidden");
  assertError(await api.call("DELETE", `/checklist/${item.id}`, undefined, w.viewer.token), 403, "forbidden");
  assertError(await api.call("GET", `/cards/${card.id}/checklist`, undefined, w.outsider.token), 404, "not_found");
  assertError(await api.call("PATCH", `/checklist/${item.id}`, { done: true }, w.outsider.token), 404, "not_found");
  assertError(await api.call("POST", `/cards/no-such-card/checklist`, { text: "y" }, w.member.token), 404, "not_found");
  assert.equal((await items(api, card.id, w.member.token))[0].done, false);
});

test("checklist writes are audited: item_created, item_updated with the sorted body fields, item_deleted; they emit no card event", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  const a = await addItem(api, card.id, w.member, "a");
  await addItem(api, card.id, w.member, "b");
  await ok(api, 200, "PATCH", `/checklist/${a.id}`, { text: "a2", position: 1 }, w.member.token);
  await ok(api, 204, "DELETE", `/checklist/${a.id}`, undefined, w.admin.token);
  assertError(await api.call("PATCH", `/checklist/${a.id}`, { text: "gone" }, w.member.token), 404, "not_found");
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetType, e.actorId, e.via, e.details]),
    [
      ["checklist.item_created", "checklist_item", w.member.id, null, {}],
      ["checklist.item_created", "checklist_item", w.member.id, null, {}],
      ["checklist.item_updated", "checklist_item", w.member.id, null, { fields: ["position", "text"] }],
      ["checklist.item_deleted", "checklist_item", w.admin.id, null, {}],
    ],
  );
  assert.equal(entries[0].targetId, a.id);
  assert.equal(entries[3].targetId, a.id);
  assert.deepEqual(await log.names(), []);
});

test("a rule triggered by checklist.completed runs on the event's card: completing the checklist moves the card to the done column", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "checklist.completed" }, actions: [{ type: "move_to_column", columnId: w.cols[2] }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = await addItem(api, card.id, w.member, "a");
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(1000);
  await ok(api, 200, "PATCH", `/checklist/${a.id}`, { done: true }, w.member.token);
  const now = await getCard(api, card.id, w.member.token);
  assert.equal(now.columnId, w.cols[2]);
  assert.equal(now.completedAt, clock.iso());
  const runs = await ruleRuns(api, w.admin.token, rule.id);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].event, runs[0].cardId, runs[0].depth, runs[0].status], ["checklist.completed", card.id, 0, "succeeded"]);
  assert.deepEqual(await log.names(), ["checklist.completed", "card.moved"]);
  const [, moved] = await log.events(2);
  assert.deepEqual(moved.via, { type: "rule", ruleId: rule.id, runId: runs[0].id });
  assert.deepEqual([moved.data.fromColumnId, moved.data.toColumnId], [w.cols[0], w.cols[2]]);
});
