// Area `notifications`: instruction.md section 23 (Notifications and watchers), created in step 4 of
// the change pipeline (section 0.8), plus the rule notify action (section 22.3) and invitations (30).
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  type Api,
  addMember,
  assertError,
  assertStatus,
  Clock,
  createApiKey,
  createBoard,
  createCard,
  createProject,
  createRule,
  ok,
  setupBoard,
  signUp,
  tempDir,
  type User,
} from "./helpers.ts";
import { ALL_TYPES, archive, assertKeys, comment, instantiate, mkTemplate, move, notifications, notified, settings, startApp, watcherIds } from "./helpers-pipeline.ts";

const NOTE_KEYS = ["id", "type", "teamId", "cardId", "commentId", "actorId", "via", "message", "read", "readAt", "createdAt"];
const watch = (api: Api, cardId: string, u: User) => ok(api, 204, "POST", `/cards/${cardId}/watch`, undefined, u.token);
const unwatch = (api: Api, cardId: string, u: User) => ok(api, 204, "DELETE", `/cards/${cardId}/watch`, undefined, u.token);
const count = async (api: Api, token: string): Promise<number> => (await ok(api, 200, "GET", "/me/notifications/unread-count", undefined, token)).count;
const types = async (api: Api, u: User): Promise<string[]> => (await notifications(api, u)).map((n) => n.type);

test("a notification has the documented shape: an assigned notification for a card created with an assignee", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  clock.advance(5000);
  const card = await createCard(api, w.cols[0], w.member, { title: "c", assigneeId: w.admin.id });
  const [n] = await notifications(api, w.admin);
  assertKeys(n, NOTE_KEYS, "notification");
  assert.deepEqual(
    [n.type, n.teamId, n.cardId, n.commentId, n.actorId, n.via, n.message, n.read, n.readAt, n.createdAt],
    ["assigned", w.team.id, card.id, null, w.member.id, null, null, false, null, clock.iso()],
  );
  assert.deepEqual(await notifications(api, w.member), [], "the actor gets nothing");
  assert.equal(await count(api, w.admin.token), 1);
});

test("watch and unwatch answer 204 and are idempotent; watchers are members in watching order; viewers may watch; non-members get 404", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await watch(api, card.id, w.viewer);
  await watch(api, card.id, w.admin);
  await watch(api, card.id, w.viewer);
  const list = await ok(api, 200, "GET", `/cards/${card.id}/watchers`, undefined, w.viewer.token);
  assert.deepEqual(list.items.map((m: any) => m.userId), [w.member.id, w.viewer.id, w.admin.id]);
  assertKeys(list.items[1], ["userId", "email", "name", "handle", "role", "joinedAt"], "watcher member");
  assert.deepEqual([list.items[1].role, list.items[1].handle], ["viewer", w.viewer.handle]);
  await unwatch(api, card.id, w.viewer);
  await unwatch(api, card.id, w.viewer);
  assert.deepEqual(await watcherIds(api, w.member.token, card.id), [w.member.id, w.admin.id]);
  assertError(await api.call("POST", `/cards/${card.id}/watch`, undefined, w.outsider.token), 404, "not_found");
  assertError(await api.call("GET", `/cards/${card.id}/watchers`, undefined, w.outsider.token), 404, "not_found");
  assertError(await api.call("POST", `/cards/no-such-card/watch`, undefined, w.member.token), 404, "not_found");
});

test("users start watching when they create a card, when it is assigned to them, and when they comment, once each and in that order", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  assert.deepEqual(await watcherIds(api, w.owner.token, card.id), [w.owner.id, w.member.id], "creator first, then the assignee");
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { assigneeId: w.admin.id }, w.owner.token);
  await comment(api, card.id, w.member, "hello");
  assert.deepEqual(await watcherIds(api, w.owner.token, card.id), [w.owner.id, w.member.id, w.admin.id], "already watching keeps the place");
  await unwatch(api, card.id, w.member);
  await comment(api, card.id, w.member, "again");
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { assigneeId: w.owner.id }, w.admin.token);
  assert.deepEqual(await watcherIds(api, w.owner.token, card.id), [w.owner.id, w.admin.id, w.member.id], "re-watching by commenting appends");
  const own = await createCard(api, w.cols[0], w.member, { title: "self", assigneeId: w.member.id });
  assert.deepEqual(await watcherIds(api, w.owner.token, own.id), [w.member.id]);
});

test("watchers are always current members: a user who leaves stops watching and is not notified", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  await watch(api, card.id, w.member);
  await watch(api, card.id, w.viewer);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.owner.token);
  assert.deepEqual(await watcherIds(api, w.owner.token, card.id), [w.owner.id, w.viewer.id]);
  await move(api, card.id, w.admin, w.cols[1]);
  await addMember(api, w.team.id, w.owner, w.member, "member");
  assert.deepEqual(await watcherIds(api, w.owner.token, card.id), [w.owner.id, w.viewer.id], "rejoining does not restore watching");
  assert.deepEqual(await types(api, w.member), []);
  assert.deepEqual(await types(api, w.viewer), ["moved"]);
});

test("watching and unwatching still work on an archived card and in an archived project", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  await archive(api, card.id, w.owner);
  await watch(api, card.id, w.member);
  const other = await createCard(api, w.cols[0], w.owner, { title: "d" });
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  await watch(api, other.id, w.viewer);
  await unwatch(api, card.id, w.member);
  assert.deepEqual(await watcherIds(api, w.owner.token, card.id), [w.owner.id]);
  assert.deepEqual(await watcherIds(api, w.owner.token, other.id), [w.owner.id, w.viewer.id]);
});

test("a comment notifies its mentioned members with mention and the card's other watchers with comment; the author and non-members get nothing", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  await watch(api, card.id, w.viewer);
  await watch(api, card.id, w.admin);
  clock.advance(1000);
  const c = await comment(api, card.id, w.member, `ping @${w.admin.handle} and @${w.outsider.handle} and @${w.member.handle}`);
  assert.deepEqual(c.mentions, [w.admin.id]);
  const forAdmin = await notifications(api, w.admin);
  assert.deepEqual(forAdmin.map((n) => [n.type, n.cardId, n.commentId, n.actorId, n.createdAt]), [["mention", card.id, c.id, w.member.id, clock.iso()]], "one per event: mention wins over comment");
  for (const u of [w.owner, w.viewer]) assert.deepEqual((await notifications(api, u)).map((n) => [n.type, n.commentId]), [["comment", c.id]], u.handle);
  assert.deepEqual(await notifications(api, w.member), [], "the author, now watching, is the actor");
  assert.deepEqual(await notifications(api, w.outsider), []);
  const mentionOnly = await createCard(api, w.cols[0], w.owner, { title: "d" });
  await comment(api, mentionOnly.id, w.admin, `@${w.viewer.handle} look`);
  assert.deepEqual((await notifications(api, w.viewer))[0].type, "mention", "a mention reaches a non-watcher");
  assert.deepEqual((await notifications(api, w.owner))[0].type, "comment");
});

test("assigned is created only when the assignee changes to another non-null user, never for the actor assigning themselves", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { assigneeId: w.member.id }, w.owner.token);
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { assigneeId: w.member.id, title: "same assignee" }, w.owner.token);
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { assigneeId: null }, w.owner.token);
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { assigneeId: w.member.id }, w.admin.token);
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { assigneeId: w.admin.id }, w.admin.token);
  assert.deepEqual(await notified(api, w.member), [["assigned", card.id], ["assigned", card.id]]);
  assert.deepEqual((await notifications(api, w.member)).map((n) => n.actorId), [w.admin.id, w.owner.id]);
  assert.deepEqual(await notified(api, w.admin), [], "self-assignment");
  await createCard(api, w.cols[0], w.owner, { title: "own", assigneeId: w.owner.id });
  assert.deepEqual(await notified(api, w.owner), []);
});

test("moved notifies the card's watchers for a move to another column, not the mover, and nothing for a reorder within a column", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  await createCard(api, w.cols[0], w.owner, { title: "d" });
  await watch(api, card.id, w.viewer);
  await watch(api, card.id, w.member);
  await move(api, card.id, w.member, w.cols[0], 1);
  assert.deepEqual(await types(api, w.viewer), [], "a reorder is not a move to another column");
  await move(api, card.id, w.member, w.cols[1]);
  for (const u of [w.owner, w.viewer]) {
    const [n] = await notifications(api, u);
    assert.deepEqual([n.type, n.cardId, n.actorId, n.commentId], ["moved", card.id, w.member.id, null], u.handle);
  }
  assert.deepEqual(await types(api, w.member), []);
  assert.deepEqual(await types(api, w.admin), [], "not watching");
});

test("the due job notifies the assignee and then the watchers, each once, with actor null and via schedule", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c", dueDate: "2026-03-03", assigneeId: w.member.id });
  await watch(api, card.id, w.viewer);
  await settings(api, w.owner, {});
  clock.set(Date.parse("2026-03-03T00:00:00.000Z"));
  await ok(api, 200, "GET", "/health");
  for (const u of [w.member, w.owner, w.viewer]) {
    const due = (await notifications(api, u)).filter((n) => n.type === "due");
    assert.deepEqual(due.map((n) => [n.cardId, n.actorId, n.via, n.createdAt]), [[card.id, null, { type: "schedule" }, "2026-03-03T00:00:00.000Z"]], u.handle);
  }
  assert.deepEqual(await types(api, w.admin), []);
});

test("no due notification for a card that is completed, archived, or in an archived project when its date comes", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const done = await createCard(api, w.cols[0], w.owner, { title: "done", dueDate: "2026-03-03", assigneeId: w.member.id });
  await move(api, done.id, w.owner, w.cols[2]);
  const archived = await createCard(api, w.cols[0], w.owner, { title: "arch", dueDate: "2026-03-03", assigneeId: w.member.id });
  await archive(api, archived.id, w.owner);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  await createCard(api, opsBoard.columns[0].id, w.owner, { title: "ops", dueDate: "2026-03-03", assigneeId: w.member.id });
  await ok(api, 200, "PATCH", `/projects/${ops.id}`, { archived: true }, w.owner.token);
  const live = await createCard(api, w.cols[0], w.owner, { title: "live", dueDate: "2026-03-03", assigneeId: w.member.id });
  clock.set(Date.parse("2026-03-04T08:00:00.000Z"));
  await ok(api, 200, "GET", "/health");
  const due = (await notifications(api, w.member)).filter((n) => n.type === "due");
  assert.deepEqual(due.map((n) => n.cardId), [live.id]);
});

test("notification settings default to every type on and nothing muted; PUT needs exactly the seven boolean types and a list of muted project ids", async (t) => {
  const api = await startApp(t);
  const u = await signUp(api);
  assert.deepEqual(await ok(api, 200, "GET", "/me/notification-settings", undefined, u.token), { types: ALL_TYPES, mutedProjectIds: [] });
  const bad: unknown[] = [
    {},
    { types: ALL_TYPES },
    { mutedProjectIds: [] },
    { types: { ...ALL_TYPES, invite: undefined }, mutedProjectIds: [] },
    { types: { ...ALL_TYPES, digest: true }, mutedProjectIds: [] },
    { types: { ...ALL_TYPES, rule: "no" }, mutedProjectIds: [] },
    { types: [], mutedProjectIds: [] },
    { types: ALL_TYPES, mutedProjectIds: "p1" },
    { types: ALL_TYPES, mutedProjectIds: ["p1", "p1"] },
    { types: ALL_TYPES, mutedProjectIds: [1] },
    { types: ALL_TYPES, mutedProjectIds: Array.from({ length: 101 }, (_, i) => `p${i}`) },
    [],
  ];
  for (const body of bad) assertError(await api.call("PUT", "/me/notification-settings", body, u.token), 400, "invalid_body", JSON.stringify(body).slice(0, 80));
  const set = await ok(api, 200, "PUT", "/me/notification-settings", { types: { ...ALL_TYPES, moved: false }, mutedProjectIds: ["zz", "aa", "no-such-project"], extra: 1 }, u.token);
  assert.deepEqual(set, { types: { ...ALL_TYPES, moved: false }, mutedProjectIds: ["aa", "no-such-project", "zz"] });
  assert.deepEqual(await ok(api, 200, "GET", "/me/notification-settings", undefined, u.token), set);
  const hundred = Array.from({ length: 100 }, (_, i) => `p${i}`);
  assertStatus(await api.call("PUT", "/me/notification-settings", { types: ALL_TYPES, mutedProjectIds: hundred }, u.token), 200);
});

test("a type switched off suppresses that type, and a mentioned watcher who turned mention off gets no comment notification instead", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  await watch(api, card.id, w.admin);
  await watch(api, card.id, w.viewer);
  await settings(api, w.admin, { mention: false });
  await settings(api, w.viewer, { comment: false });
  await settings(api, w.owner, { moved: false });
  await comment(api, card.id, w.member, `hi @${w.admin.handle}`);
  assert.deepEqual(await types(api, w.admin), [], "mention off, and no comment instead");
  assert.deepEqual(await types(api, w.viewer), []);
  assert.deepEqual(await types(api, w.owner), ["comment"]);
  await move(api, card.id, w.member, w.cols[1]);
  assert.deepEqual(await types(api, w.owner), ["comment"], "moved off");
  assert.deepEqual(await types(api, w.viewer), ["moved"]);
});

test("mutedProjectIds suppresses every card notification of those projects only, never invitations", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  await settings(api, w.member, {}, [w.project.id]);
  await createCard(api, w.cols[0], w.owner, { title: "muted", assigneeId: w.member.id });
  const loud = await createCard(api, opsBoard.columns[0].id, w.owner, { title: "loud", assigneeId: w.member.id });
  assert.deepEqual(await notified(api, w.member), [["assigned", loud.id]]);
  await settings(api, w.outsider, {}, [w.project.id, ops.id]);
  await ok(api, 201, "POST", `/teams/${w.team.id}/invites`, { email: w.outsider.email, role: "member" }, w.admin.token);
  assert.deepEqual(await types(api, w.outsider), ["invite"]);
});

test("notifications are visible only while the recipient is a member of their team: hidden after leaving, shown again on rejoining", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  const [n] = await notifications(api, w.member);
  await ok(api, 200, "POST", `/me/notifications/${n.id}/read`, undefined, w.member.token);
  const second = await createCard(api, w.cols[0], w.owner, { title: "d", assigneeId: w.member.id });
  assert.equal(await count(api, w.member.token), 1);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.owner.token);
  assert.deepEqual(await notifications(api, w.member), []);
  assert.equal(await count(api, w.member.token), 0);
  assertError(await api.call("POST", `/me/notifications/${n.id}/unread`, undefined, w.member.token), 404, "not_found");
  assertError(await api.call("DELETE", `/me/notifications/${n.id}`, undefined, w.member.token), 404, "not_found");
  assert.deepEqual((await ok(api, 200, "POST", "/me/notifications/read-all", {}, w.member.token)).updated, 0);
  await addMember(api, w.team.id, w.owner, w.member, "member");
  const back = await notifications(api, w.member);
  assert.deepEqual(back.map((x) => [x.cardId, x.read]), [[second.id, false], [card.id, true]]);
});

test("another user's notification id is 404 not_found on read, unread and delete, and stays untouched", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await createCard(api, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  const [n] = await notifications(api, w.member);
  for (const [method, path] of [["POST", `/me/notifications/${n.id}/read`], ["POST", `/me/notifications/${n.id}/unread`], ["DELETE", `/me/notifications/${n.id}`]] as const) {
    assertError(await api.call(method, path, undefined, w.admin.token), 404, "not_found", `${method} ${path}`);
  }
  assertError(await api.call("POST", "/me/notifications/no-such-id/read", undefined, w.member.token), 404, "not_found");
  assert.deepEqual((await notifications(api, w.member))[0], n);
});

test("read sets read and readAt now, reading again keeps readAt; unread clears both", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  await createCard(api, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  const [n] = await notifications(api, w.member);
  clock.advance(60_000);
  const readAt = clock.iso();
  const r1 = await ok(api, 200, "POST", `/me/notifications/${n.id}/read`, undefined, w.member.token);
  assert.deepEqual({ ...r1, read: undefined, readAt: undefined }, { ...n, read: undefined, readAt: undefined });
  assert.deepEqual([r1.read, r1.readAt], [true, readAt]);
  clock.advance(60_000);
  const r2 = await ok(api, 200, "POST", `/me/notifications/${n.id}/read`, undefined, w.member.token);
  assert.equal(r2.readAt, readAt);
  const u = await ok(api, 200, "POST", `/me/notifications/${n.id}/unread`, undefined, w.member.token);
  assert.deepEqual([u.read, u.readAt], [false, null]);
  assert.equal(await count(api, w.member.token), 1);
});

test("read-all marks every visible unread notification read, optionally of one team, and answers how many changed", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.owner.token);
  await addMember(api, other.id, w.owner, w.member, "member");
  const op = await createProject(api, other.id, w.owner, "OTH");
  const ob = await createBoard(api, op.id, w.owner);
  await createCard(api, w.cols[0], w.owner, { title: "a", assigneeId: w.member.id });
  await createCard(api, w.cols[0], w.owner, { title: "b", assigneeId: w.member.id });
  await createCard(api, ob.columns[0].id, w.owner, { title: "c", assigneeId: w.member.id });
  for (const body of [undefined, [], { teamId: 5 }, { teamId: "no-such-team" }]) {
    assertError(await api.call("POST", "/me/notifications/read-all", body, w.member.token), 400, "invalid_body", JSON.stringify(body));
  }
  const elsewhere = await ok(api, 201, "POST", "/teams", { name: "Not mine" }, w.owner.token);
  assertError(await api.call("POST", "/me/notifications/read-all", { teamId: elsewhere.id }, w.member.token), 400, "invalid_body", "not a member");
  clock.advance(1000);
  assert.deepEqual(await ok(api, 200, "POST", "/me/notifications/read-all", { teamId: other.id }, w.member.token), { updated: 1 });
  assert.equal(await count(api, w.member.token), 2);
  assert.deepEqual(await ok(api, 200, "POST", "/me/notifications/read-all", {}, w.member.token), { updated: 2 });
  assert.deepEqual(await ok(api, 200, "POST", "/me/notifications/read-all", {}, w.member.token), { updated: 0 });
  const all = await notifications(api, w.member);
  assert.ok(all.every((n) => n.read && n.readAt === clock.iso()));
});

test("unread-count counts the visible unread notifications and follows read, unread and delete", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  for (let i = 0; i < 3; i++) await createCard(api, w.cols[0], w.owner, { title: `c${i}`, assigneeId: w.member.id });
  assert.equal(await count(api, w.member.token), 3);
  const [a, b] = await notifications(api, w.member);
  await ok(api, 200, "POST", `/me/notifications/${a.id}/read`, undefined, w.member.token);
  assert.equal(await count(api, w.member.token), 2);
  await ok(api, 204, "DELETE", `/me/notifications/${b.id}`, undefined, w.member.token);
  assert.equal(await count(api, w.member.token), 1);
  await ok(api, 200, "POST", `/me/notifications/${a.id}/unread`, undefined, w.member.token);
  assert.equal(await count(api, w.member.token), 2);
  assert.equal(await count(api, w.admin.token), 0);
});

test("the list filters by ?unread and ?teamId; other unread values and an empty value are 400 invalid_query", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c1 = await createCard(api, w.cols[0], w.owner, { title: "a", assigneeId: w.member.id });
  const c2 = await createCard(api, w.cols[0], w.owner, { title: "b", assigneeId: w.member.id });
  const [n2] = await notifications(api, w.member);
  await ok(api, 200, "POST", `/me/notifications/${n2.id}/read`, undefined, w.member.token);
  assert.deepEqual((await notifications(api, w.member, "unread=true")).map((n) => n.cardId), [c1.id]);
  assert.deepEqual((await notifications(api, w.member, "unread=false")).map((n) => n.cardId), [c2.id]);
  assert.deepEqual((await notifications(api, w.member, `teamId=${w.team.id}`)).map((n) => n.cardId), [c2.id, c1.id]);
  assert.deepEqual(await notifications(api, w.member, "teamId=no-such-team"), []);
  assert.deepEqual(await notifications(api, w.member, "teamId="), [], "an empty filter matches nothing");
  for (const q of ["unread=yes", "unread=", "unread=TRUE", "limit=0", "limit=101", "cursor=nope"]) {
    assertError(await api.call("GET", `/me/notifications?${q}`, undefined, w.member.token), 400, "invalid_query", q);
  }
});

test("the list is newest first and following nextCursor visits every notification once", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const cards: any[] = [];
  for (let i = 0; i < 7; i++) {
    clock.advance(1000);
    cards.push(await createCard(api, w.cols[0], w.owner, { title: `c${i}`, assigneeId: w.member.id }));
  }
  const page = await ok(api, 200, "GET", "/me/notifications?limit=3", undefined, w.member.token);
  assert.deepEqual(page.items.map((n: any) => n.cardId), [cards[6].id, cards[5].id, cards[4].id]);
  assert.equal(typeof page.nextCursor, "string");
  const all = await notifications(api, w.member);
  assert.deepEqual(all.map((n) => n.cardId), cards.map((c) => c.id).reverse());
  const def = await ok(api, 200, "GET", "/me/notifications", undefined, w.member.token);
  assert.deepEqual([def.items.length, def.nextCursor], [7, null]);
});

test("DELETE removes the caller's notification with 204; afterwards it is 404", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await createCard(api, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  await createCard(api, w.cols[0], w.owner, { title: "d", assigneeId: w.member.id });
  const [n, m] = await notifications(api, w.member);
  assertStatus(await api.call("DELETE", `/me/notifications/${n.id}`, undefined, w.member.token), 204);
  assertError(await api.call("DELETE", `/me/notifications/${n.id}`, undefined, w.member.token), 404, "not_found");
  assertError(await api.call("POST", `/me/notifications/${n.id}/read`, undefined, w.member.token), 404, "not_found");
  assert.deepEqual((await notifications(api, w.member)).map((x) => x.id), [m.id]);
});

test("rule notifications sit outside one-per-event: two notify actions notify the same user twice, and a watcher also gets the move's moved", async (t) => {
  const api = await startApp(t, { defaultPlan: "team" });
  const w = await setupBoard(api);
  const r = await createRule(api, w.team.id, w.admin, {
    trigger: { event: "card.moved" },
    actions: [
      { type: "notify", to: ["watchers"], message: "first" },
      { type: "notify", to: [w.viewer.id], message: "second" },
    ],
  });
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  await watch(api, card.id, w.viewer);
  await move(api, card.id, w.member, w.cols[1]);
  const forViewer = await notifications(api, w.viewer);
  assert.deepEqual(forViewer.map((n) => [n.type, n.message]), [["moved", null], ["rule", "second"], ["rule", "first"]]);
  const runId = forViewer[1].via.runId;
  assert.deepEqual(forViewer[1].via, { type: "rule", ruleId: r.id, runId });
  assert.deepEqual((await notifications(api, w.owner)).map((n) => [n.type, n.message]), [["moved", null], ["rule", "first"]]);
});

test("an assignment made by a rule notifies as the rule's creator, who is never notified of their own action", async (t) => {
  const api = await startApp(t, { defaultPlan: "team" });
  const w = await setupBoard(api);
  await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, conditions: [{ field: "title", op: "contains", value: "to-member" }], actions: [{ type: "set_assignee", userId: w.member.id }] });
  await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, conditions: [{ field: "title", op: "contains", value: "to-admin" }], actions: [{ type: "set_assignee", userId: w.admin.id }] });
  const a = await createCard(api, w.cols[0], w.owner, { title: "to-member" });
  const b = await createCard(api, w.cols[0], w.owner, { title: "to-admin" });
  const [n] = await notifications(api, w.member);
  assert.deepEqual([n.type, n.cardId, n.actorId, n.via?.type], ["assigned", a.id, w.admin.id, "rule"]);
  assert.deepEqual(await notifications(api, w.admin), [], "the actor of the rule's change is its creator");
  assert.equal((await ok(api, 200, "GET", `/cards/${b.id}`, undefined, w.admin.token)).assigneeId, w.admin.id);
});

test("watchers are read at step 4: a user a rule assigned during the request also gets that request's moved notification", async (t) => {
  const api = await startApp(t, { defaultPlan: "team" });
  const w = await setupBoard(api);
  await createRule(api, w.team.id, w.owner, { trigger: { event: "card.moved", toColumnId: w.cols[1] }, actions: [{ type: "set_assignee", userId: w.admin.id }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await move(api, card.id, w.member, w.cols[1]);
  assert.deepEqual(await watcherIds(api, w.member.token, card.id), [w.member.id, w.admin.id]);
  assert.deepEqual((await notifications(api, w.admin)).map((n) => [n.type, n.actorId]), [["assigned", w.owner.id], ["moved", w.member.id]]);
});

test("mention recipients come from the comment as created: editing a comment to add a mention notifies nobody", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  const c = await comment(api, card.id, w.member, "no mentions yet");
  const before = await notifications(api, w.admin);
  const edited = await ok(api, 200, "PATCH", `/comments/${c.id}`, { body: `now @${w.admin.handle}` }, w.member.token);
  assert.deepEqual(edited.mentions, [w.admin.id]);
  assert.deepEqual(await notifications(api, w.admin), before);
  const reply = await comment(api, card.id, w.admin, `@${w.member.handle} replying`, c.id);
  assert.deepEqual((await notifications(api, w.member)).map((n) => [n.type, n.commentId]), [["mention", reply.id]]);
});

test("deleting a team deletes its notifications; deleting a card keeps the notifications about it", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  await ok(api, 204, "DELETE", `/cards/${card.id}`, undefined, w.owner.token);
  assert.deepEqual(await notified(api, w.member), [["assigned", card.id]]);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.owner.token);
  await addMember(api, other.id, w.owner, w.member, "member");
  const op = await createProject(api, other.id, w.owner, "OTH");
  const ob = await createBoard(api, op.id, w.owner);
  await createCard(api, ob.columns[0].id, w.owner, { title: "d", assigneeId: w.member.id });
  assert.equal((await notifications(api, w.member)).length, 2);
  await ok(api, 204, "DELETE", `/teams/${other.id}`, undefined, w.owner.token);
  assert.deepEqual(await notified(api, w.member), [["assigned", card.id]]);
});

test("a team-restricted API key sees only the notifications of its team, in the list, the count and the routes by id", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.owner.token);
  await addMember(api, other.id, w.owner, w.member, "member");
  const op = await createProject(api, other.id, w.owner, "OTH");
  const ob = await createBoard(api, op.id, w.owner);
  const mine = await createCard(api, w.cols[0], w.owner, { title: "a", assigneeId: w.member.id });
  await createCard(api, ob.columns[0].id, w.owner, { title: "b", assigneeId: w.member.id });
  const key = (await createApiKey(api, w.member, { scope: "write", teamId: w.team.id })).secret;
  const listed = await notifications(api, key);
  assert.deepEqual(listed.map((n) => n.cardId), [mine.id]);
  assert.equal(await count(api, key), 1);
  const foreign = (await notifications(api, w.member)).find((n) => n.teamId === other.id);
  assertError(await api.call("POST", `/me/notifications/${foreign.id}/read`, undefined, key), 404, "not_found");
  assert.deepEqual(await ok(api, 200, "POST", "/me/notifications/read-all", {}, key), { updated: 1 });
  assert.equal(await count(api, w.member.token), 1, "the other team's notification is still unread");
});

test("an invitation notifies a registered addressee who is not a member, with the inviter as actor; turning invite off suppresses it", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, defaultPlan: "team" });
  const w = await setupBoard(api, clock);
  const quiet = await signUp(api);
  await settings(api, quiet, { invite: false });
  clock.advance(1000);
  const inv = await ok(api, 201, "POST", `/teams/${w.team.id}/invites`, { email: w.outsider.email, role: "viewer" }, w.admin.token);
  await ok(api, 201, "POST", `/teams/${w.team.id}/invites`, { email: quiet.email, role: "viewer" }, w.admin.token);
  await ok(api, 201, "POST", `/teams/${w.team.id}/invites`, { email: "nobody@example.test", role: "viewer" }, w.admin.token);
  const [n] = await notifications(api, w.outsider);
  assert.deepEqual(
    [n.type, n.teamId, n.cardId, n.commentId, n.actorId, n.via, n.message, n.read, n.createdAt],
    ["invite", w.team.id, null, null, w.admin.id, null, null, false, clock.iso()],
  );
  assert.equal(await count(api, w.outsider.token), 1, "visible although not a member");
  assert.deepEqual(await notifications(api, quiet), []);
  assert.equal(typeof inv.token, "string");
});

test("replying makes the reply's author watch; the parent's author, watching since their comment, gets a comment notification", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  const parent = await comment(api, card.id, w.member, "question");
  const reply = await comment(api, card.id, w.admin, "answer", parent.id);
  assert.deepEqual(await watcherIds(api, w.owner.token, card.id), [w.owner.id, w.member.id, w.admin.id]);
  assert.deepEqual((await notifications(api, w.member)).map((n) => [n.type, n.commentId]), [["comment", reply.id]]);
  assert.deepEqual((await notifications(api, w.owner)).map((n) => [n.type, n.commentId]), [["comment", reply.id], ["comment", parent.id]]);
});

test("viewers who watch a card get its moved and comment notifications like any watcher", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  await watch(api, card.id, w.viewer);
  await move(api, card.id, w.member, w.cols[2]);
  const c = await comment(api, card.id, w.admin, "done!");
  assert.deepEqual((await notifications(api, w.viewer)).map((n) => [n.type, n.commentId]), [["comment", c.id], ["moved", null]]);
});

test("a watching assignee gets a single due notification", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c", dueDate: "2026-03-02", assigneeId: w.member.id });
  assert.deepEqual(await watcherIds(api, w.member.token, card.id), [w.member.id]);
  clock.set(Date.parse("2026-03-02T00:00:00.000Z"));
  await ok(api, 200, "GET", "/health");
  assert.deepEqual(await notified(api, w.member), [["due", card.id]], "the creator is also the assignee: one due, and no assigned (the actor)");
});

test("instantiating a template with an assignee notifies the assignee with the caller as actor and makes both watch", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const tpl = await mkTemplate(api, w.project.id, w.owner);
  const res = await instantiate(api, tpl.id, w.member.token, { columnId: w.cols[0], assigneeId: w.admin.id });
  assertStatus(res, 201);
  const [n] = await notifications(api, w.admin);
  assert.deepEqual([n.type, n.cardId, n.actorId, n.via], ["assigned", res.body.id, w.member.id, null]);
  assert.deepEqual(await watcherIds(api, w.member.token, res.body.id), [w.member.id, w.admin.id]);
});

test("settings apply only to new notifications and only to their owner", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  await watch(api, card.id, w.admin);
  await settings(api, w.member, { assigned: false, moved: false }, [w.project.id]);
  assert.deepEqual(await notified(api, w.member), [["assigned", card.id]], "settings never change existing notifications");
  await move(api, card.id, w.owner, w.cols[1]);
  assert.deepEqual(await notified(api, w.member), [["assigned", card.id]]);
  assert.deepEqual(await notified(api, w.admin), [["moved", card.id]], "another user's settings do not apply");
});

test("notifications, their read state and watchers survive a restart", async (t) => {
  const clock = new Clock();
  const dataFile = join(tempDir(t), "tracker.json");
  const api1 = await startApp(t, { now: clock.now, dataFile });
  const w = await setupBoard(api1, clock);
  const card = await createCard(api1, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  await createCard(api1, w.cols[0], w.owner, { title: "d", assigneeId: w.member.id });
  const [latest] = await notifications(api1, w.member);
  await ok(api1, 200, "POST", `/me/notifications/${latest.id}/read`, undefined, w.member.token);
  await settings(api1, w.member, { moved: false });
  const before = await notifications(api1, w.member);
  await api1.close();
  const api2 = await startApp(t, { now: clock.now, dataFile });
  assert.deepEqual(await notifications(api2, w.member), before);
  assert.equal(await count(api2, w.member.token), 1);
  assert.deepEqual(await watcherIds(api2, w.owner.token, card.id), [w.owner.id, w.member.id]);
  assert.equal((await ok(api2, 200, "GET", "/me/notification-settings", undefined, w.member.token)).types.moved, false);
});

test("a recipient whose settings drop the winning type gets no other type for that event: a muted, mentioned watcher gets nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c" });
  await watch(api, card.id, w.admin);
  await watch(api, card.id, w.viewer);
  await settings(api, w.admin, {}, [w.project.id]);
  await comment(api, card.id, w.member, `@${w.admin.handle} @${w.viewer.handle} please look`);
  assert.deepEqual(await types(api, w.admin), []);
  assert.deepEqual(await types(api, w.viewer), ["mention"]);
  assert.deepEqual(await types(api, w.owner), ["comment"]);
});

test("invite notifications can be read and are counted by read-all without membership of their team", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  await ok(api, 201, "POST", `/teams/${w.team.id}/invites`, { email: w.outsider.email, role: "member" }, w.owner.token);
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.admin.token);
  await ok(api, 201, "POST", `/teams/${other.id}/invites`, { email: w.outsider.email, role: "viewer" }, w.admin.token);
  const [latest, first] = await notifications(api, w.outsider);
  assert.deepEqual([latest.teamId, first.teamId], [other.id, w.team.id]);
  clock.advance(1000);
  const read = await ok(api, 200, "POST", `/me/notifications/${first.id}/read`, undefined, w.outsider.token);
  assert.deepEqual([read.read, read.readAt], [true, clock.iso()]);
  assert.deepEqual(await ok(api, 200, "POST", "/me/notifications/read-all", {}, w.outsider.token), { updated: 1 });
  assert.equal(await count(api, w.outsider.token), 0);
  assert.deepEqual((await notifications(api, w.outsider, `teamId=${w.team.id}`)).map((n) => n.id), [first.id]);
});
