// Area `comments`: instruction.md section 6 (Comments and mentions), with the comment.created
// event of section 0.8 and the archived-card rule of section 31.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addMember, assertError, assertStatus, Clock, collectPages, createCard, eventLog, getCard, ok, setupBoard, signUp, startApp } from "./helpers.ts";

const shape = (c: any): any => ({ id: c.id, parentId: c.parentId, body: c.body, replies: c.replies.map(shape) });

test("comments come back as trees: top-level oldest first, direct replies oldest first, to any depth", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "talk" });
  const post = async (body: string, parentId?: string, u = w.member) => {
    clock.advance(1000);
    return ok(api, 201, "POST", `/cards/${card.id}/comments`, parentId === undefined ? { body } : { body, parentId }, u.token);
  };
  const c1 = await post("  first  ");
  assert.deepEqual(Object.keys(c1).sort(), ["authorId", "body", "cardId", "createdAt", "deleted", "id", "mentions", "parentId", "replies", "updatedAt"]);
  assert.equal(c1.body, "first", "trimmed");
  assert.equal(c1.cardId, card.id);
  assert.equal(c1.parentId, null);
  assert.equal(c1.authorId, w.member.id);
  assert.deepEqual(c1.mentions, []);
  assert.equal(c1.deleted, false);
  assert.equal(c1.createdAt, clock.iso());
  assert.equal(c1.updatedAt, clock.iso());
  assert.deepEqual(c1.replies, []);
  const r1 = await post("reply one", c1.id, w.admin);
  const c2 = await post("second");
  const r2 = await post("deep reply", r1.id, w.owner);
  const r3 = await post("reply two", c1.id);
  const r4 = await post("deeper", r2.id);
  const list = await ok(api, 200, "GET", `/cards/${card.id}/comments`, undefined, w.viewer.token);
  assert.deepEqual(list.items.map(shape), [
    {
      id: c1.id,
      parentId: null,
      body: "first",
      replies: [
        { id: r1.id, parentId: c1.id, body: "reply one", replies: [{ id: r2.id, parentId: r1.id, body: "deep reply", replies: [{ id: r4.id, parentId: r2.id, body: "deeper", replies: [] }] }] },
        { id: r3.id, parentId: c1.id, body: "reply two", replies: [] },
      ],
    },
    { id: c2.id, parentId: null, body: "second", replies: [] },
  ]);
  const sub = await ok(api, 200, "GET", `/comments/${r1.id}`, undefined, w.viewer.token);
  assert.deepEqual(shape(sub), shape(list.items[0].replies[0]));
  assert.equal(sub.authorId, w.admin.id);
  assertError(await api.call("GET", "/comments/nope", undefined, w.viewer.token), 404, "not_found");
  assertError(await api.call("GET", `/comments/${r1.id}`, undefined, w.outsider.token), 404, "not_found", "outsider");
});

test("parentId must be a comment on the same card; body is 1 to 5000 chars; a comment emits comment.created and leaves the card's updatedAt", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "a" });
  const other = await createCard(api, w.cols[0], w.member, { title: "b" });
  const foreign = await ok(api, 201, "POST", `/cards/${other.id}/comments`, { body: "elsewhere" }, w.member.token);
  const path = `/cards/${card.id}/comments`;
  assertError(await api.call("POST", path, { body: "x", parentId: foreign.id }, w.member.token), 400, "invalid_body", "parent on another card");
  assertError(await api.call("POST", path, { body: "x", parentId: "nope" }, w.member.token), 400, "invalid_body", "unknown parent");
  assertError(await api.call("POST", path, { body: "x", parentId: 3 }, w.member.token), 400, "invalid_body", "parent not a string");
  assertError(await api.call("POST", path, { body: "   " }, w.member.token), 400, "invalid_body", "blank");
  assertError(await api.call("POST", path, { body: "b".repeat(5001) }, w.member.token), 400, "invalid_body", "5001 chars");
  assertError(await api.call("POST", path, {}, w.member.token), 400, "invalid_body", "missing body");
  assertError(await api.call("POST", path, { body: "x" }, w.viewer.token), 403, "forbidden", "viewer");
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(5000);
  const explicitNull = await ok(api, 201, "POST", path, { body: "b".repeat(5000), parentId: null }, w.admin.token);
  assert.equal(explicitNull.parentId, null);
  assert.equal(explicitNull.body.length, 5000);
  const list = await ok(api, 200, "GET", path, undefined, w.member.token);
  assert.deepEqual(list.items.map((c: any) => c.id), [explicitNull.id], "rejected comments were not stored");
  assert.deepEqual(await log.names(), ["comment.created"]);
  const [ev] = await log.events(1);
  assert.deepEqual(ev.data, { comment: explicitNull });
  assert.equal(ev.actorId, w.admin.id);
  assert.equal((await getCard(api, card.id, w.member.token)).updatedAt, card.updatedAt, "commenting does not change the card's updatedAt");
  const watchers = await ok(api, 200, "GET", `/cards/${card.id}/watchers`, undefined, w.member.token);
  assert.ok(watchers.items.some((m: any) => m.userId === w.admin.id), "the commenter starts watching the card");
});

test("mentions follow the regex and membership rules, in order of first appearance, without duplicates", async (t) => {
  const api = await startApp(t, { defaultPlan: "team" });
  const w = await setupBoard(api);
  const ada = await signUp(api, { handle: "ada" });
  const bob = await signUp(api, { handle: "bob_b" });
  await signUp(api, { handle: "zed" });
  const long20 = await signUp(api, { handle: "a".repeat(20) });
  await addMember(api, w.team.id, w.owner, ada, "viewer");
  await addMember(api, w.team.id, w.owner, bob, "member");
  await addMember(api, w.team.id, w.owner, long20, "member");
  const author = w.member;
  const card = await createCard(api, w.cols[0], author, { title: "m" });
  const post = (body: string) => ok(api, 201, "POST", `/cards/${card.id}/comments`, { body }, author.token);
  const cases: [string, string[]][] = [
    ["hi @bob_b and @ADA, then @bob_b again", [bob.id, ada.id]],
    ["mail ada@example.com or x@bob_b", []],
    ["@zed is not on the team", []],
    [`@${author.handle} is the author`, []],
    [`@${"a".repeat(21)} is 21 name characters`, []],
    [`@${"a".repeat(20)}! is exactly 20`, [long20.id]],
    ["(@ada) and @Ada's and _@bob_b", [ada.id]],
    ["@ab is too short; @@bob_b counts", [bob.id]],
    ["no mentions here", []],
  ];
  for (const [body, want] of cases) {
    const c = await post(body);
    assert.deepEqual(c.mentions, want, body);
  }
});

test("mentions are recomputed on PATCH; a handle change only affects mentions written after it", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, defaultPlan: "team" });
  const w = await setupBoard(api, clock);
  const ada = await signUp(api, { handle: "ada" });
  const bob = await signUp(api, { handle: "bob" });
  await addMember(api, w.team.id, w.owner, ada, "member");
  await addMember(api, w.team.id, w.owner, bob, "member");
  const card = await createCard(api, w.cols[0], w.member, { title: "m" });
  const c = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "ping @ada" }, w.member.token);
  assert.deepEqual(c.mentions, [ada.id]);
  await ok(api, 200, "PATCH", "/me", { handle: "ada_new" }, ada.token);
  assert.deepEqual((await ok(api, 200, "GET", `/comments/${c.id}`, undefined, w.member.token)).mentions, [ada.id], "existing mention kept");
  const later = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "@ada @ada_new" }, w.member.token);
  assert.deepEqual(later.mentions, [ada.id], "only the new handle counts");
  clock.advance(4000);
  const edited = await api.call("PATCH", `/comments/${c.id}`, { body: " @bob and @ada_new " }, w.member.token);
  assertStatus(edited, 200);
  assert.equal(edited.body.body, "@bob and @ada_new");
  assert.deepEqual(edited.body.mentions, [bob.id, ada.id]);
  assert.equal(edited.body.updatedAt, clock.iso());
  assert.equal(edited.body.createdAt, c.createdAt);
  const again = await ok(api, 200, "PATCH", `/comments/${c.id}`, { body: "@ada (old handle)" }, w.member.token);
  assert.deepEqual(again.mentions, []);
  assertError(await api.call("PATCH", `/comments/${c.id}`, { body: "" }, w.member.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/comments/${c.id}`, {}, w.member.token), 400, "invalid_body");
});

test("PATCH is for the author only (403 even for the owner); an author demoted to viewer can still edit and delete", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const c = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "mine" }, w.member.token);
  for (const u of [w.owner, w.admin, w.viewer]) {
    assertError(await api.call("PATCH", `/comments/${c.id}`, { body: "theirs" }, u.token), 403, "forbidden", u.handle);
  }
  assertError(await api.call("PATCH", `/comments/${c.id}`, { body: "" }, w.owner.token), 403, "forbidden", "role before validation");
  assertError(await api.call("PATCH", `/comments/${c.id}`, { body: "x" }, w.outsider.token), 404, "not_found", "outsider");
  await ok(api, 200, "PATCH", `/teams/${w.team.id}/members/${w.member.id}`, { role: "viewer" }, w.owner.token);
  assert.equal((await ok(api, 200, "PATCH", `/comments/${c.id}`, { body: "still mine" }, w.member.token)).body, "still mine");
  assertStatus(await api.call("DELETE", `/comments/${c.id}`, undefined, w.member.token), 204, "viewer deletes own comment");
});

test("DELETE is for the author or admin+; another member gets 403", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await signUp(api);
  await addMember(api, w.team.id, w.owner, other, "member");
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "a" }, w.member.token);
  const b = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "b" }, w.member.token);
  const c = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "c" }, w.member.token);
  assertError(await api.call("DELETE", `/comments/${a.id}`, undefined, other.token), 403, "forbidden", "another member");
  assertError(await api.call("DELETE", `/comments/${a.id}`, undefined, w.viewer.token), 403, "forbidden", "viewer");
  assertError(await api.call("DELETE", `/comments/${a.id}`, undefined, w.outsider.token), 404, "not_found", "outsider");
  const res = await api.call("DELETE", `/comments/${a.id}`, undefined, w.admin.token);
  assertStatus(res, 204, "admin");
  assert.equal(res.text, "");
  assertStatus(await api.call("DELETE", `/comments/${b.id}`, undefined, w.owner.token), 204, "owner");
  assertStatus(await api.call("DELETE", `/comments/${c.id}`, undefined, w.member.token), 204, "author");
  const list = await ok(api, 200, "GET", `/cards/${card.id}/comments`, undefined, w.viewer.token);
  assert.deepEqual(list.items.map((x: any) => [x.id, x.deleted]), [[a.id, true], [b.id, true], [c.id, true]]);
});

test("delete is soft and keeps the replies; writes to a deleted comment are 409 comment_deleted and to an archived card's comments 409 card_archived", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const top = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: `hey @${w.admin.handle}` }, w.member.token);
  assert.deepEqual(top.mentions, [w.admin.id]);
  const reply = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "answer", parentId: top.id }, w.admin.token);
  clock.advance(2000);
  assertStatus(await api.call("DELETE", `/comments/${top.id}`, undefined, w.member.token), 204);
  const got = await ok(api, 200, "GET", `/comments/${top.id}`, undefined, w.viewer.token);
  assert.equal(got.deleted, true);
  assert.equal(got.body, "");
  assert.deepEqual(got.mentions, []);
  assert.equal(got.updatedAt, clock.iso(), "delete changes updatedAt");
  assert.equal(got.authorId, w.member.id);
  assert.deepEqual(got.replies.map((r: any) => [r.id, r.body, r.deleted]), [[reply.id, "answer", false]]);
  const list = await ok(api, 200, "GET", `/cards/${card.id}/comments`, undefined, w.viewer.token);
  assert.deepEqual(list.items.map((x: any) => x.id), [top.id]);
  assert.equal(list.items[0].replies[0].id, reply.id);
  assertError(await api.call("PATCH", `/comments/${top.id}`, { body: "undo" }, w.member.token), 409, "comment_deleted", "PATCH");
  assertError(await api.call("DELETE", `/comments/${top.id}`, undefined, w.member.token), 409, "comment_deleted", "DELETE");
  assertError(await api.call("POST", `/cards/${card.id}/comments`, { body: "late", parentId: top.id }, w.admin.token), 409, "comment_deleted", "reply");
  assertError(await api.call("PATCH", `/comments/${top.id}`, { body: "x" }, w.admin.token), 403, "forbidden", "non-author before the 409");
  assertError(await api.call("PATCH", `/comments/${top.id}`, { body: "" }, w.member.token), 400, "invalid_body", "validation before the 409");
  assertStatus(await api.call("POST", `/cards/${card.id}/comments`, { body: "reply to the reply", parentId: reply.id }, w.admin.token), 201);
  // An archived card's comments are read-only (card_archived comes before comment_deleted).
  await ok(api, 200, "POST", `/cards/${card.id}/archive`, undefined, w.member.token);
  assertError(await api.call("POST", `/cards/${card.id}/comments`, { body: "on archived" }, w.member.token), 409, "card_archived", "new comment");
  assertError(await api.call("PATCH", `/comments/${reply.id}`, { body: "edit" }, w.admin.token), 409, "card_archived", "edit");
  assertError(await api.call("DELETE", `/comments/${reply.id}`, undefined, w.admin.token), 409, "card_archived", "delete");
  assertError(await api.call("DELETE", `/comments/${top.id}`, undefined, w.member.token), 409, "card_archived", "card_archived before comment_deleted");
  assert.equal((await ok(api, 200, "GET", `/cards/${card.id}/comments`, undefined, w.viewer.token)).items.length, 1, "reads still work");
});

test("GET /me/mentions lists the caller's live mentions newest first, across teams; leaving hides them and rejoining shows them again", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const ada = await signUp(api, { handle: "ada" });
  await addMember(api, w.team.id, w.owner, ada, "viewer");
  const team2 = await ok(api, 201, "POST", "/teams", { name: "Two" }, w.outsider.token);
  await addMember(api, team2.id, w.outsider, ada, "member");
  const p2 = await ok(api, 201, "POST", `/teams/${team2.id}/projects`, { name: "P", key: "TWO" }, w.outsider.token);
  const b2 = await ok(api, 201, "POST", `/projects/${p2.id}/boards`, { name: "B" }, w.outsider.token);
  const card1 = await createCard(api, w.cols[0], w.member, { title: "one" });
  const card2 = await createCard(api, b2.columns[0].id, w.outsider, { title: "two" });
  const say = async (card: any, u: any, body: string) => {
    clock.advance(1000);
    return ok(api, 201, "POST", `/cards/${card.id}/comments`, { body }, u.token);
  };
  const m1 = await say(card1, w.member, "@ada first");
  const m2 = await say(card2, w.outsider, "@ada in team two");
  const gone = await say(card1, w.admin, "@ada deleted later");
  const edited = await say(card1, w.member, "@ada edited away");
  const m3 = await say(card1, w.admin, "@ada @ada last");
  await say(card1, w.admin, "not ada");
  assertStatus(await api.call("DELETE", `/comments/${gone.id}`, undefined, w.admin.token), 204);
  await ok(api, 200, "PATCH", `/comments/${edited.id}`, { body: "nobody now" }, w.member.token);
  const res = await ok(api, 200, "GET", "/me/mentions", undefined, ada.token);
  assert.deepEqual(res.items, [
    { commentId: m3.id, cardId: card1.id, teamId: w.team.id, authorId: w.admin.id, createdAt: m3.createdAt },
    { commentId: m2.id, cardId: card2.id, teamId: team2.id, authorId: w.outsider.id, createdAt: m2.createdAt },
    { commentId: m1.id, cardId: card1.id, teamId: w.team.id, authorId: w.member.id, createdAt: m1.createdAt },
  ]);
  assert.equal(res.nextCursor, null);
  assert.deepEqual((await ok(api, 200, "GET", "/me/mentions", undefined, w.member.token)).items, []);
  // Leaving a team hides its mentions; it does not change the comments, so rejoining shows them again.
  assertStatus(await api.call("DELETE", `/teams/${team2.id}/members/${ada.id}`, undefined, ada.token), 204);
  const after = await ok(api, 200, "GET", "/me/mentions", undefined, ada.token);
  assert.deepEqual(after.items.map((m: any) => m.commentId), [m3.id, m1.id]);
  await addMember(api, team2.id, w.outsider, ada, "viewer");
  const back = await ok(api, 200, "GET", "/me/mentions", undefined, ada.token);
  assert.deepEqual(back.items.map((m: any) => m.commentId), [m3.id, m2.id, m1.id]);
});

test("GET /me/mentions pages with limit and cursor (default 20); a bad limit or cursor is 400 invalid_query", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "busy" });
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) {
    clock.advance(1000);
    ids.push((await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: `#${i} for @${w.viewer.handle}` }, w.member.token)).id);
  }
  const newestFirst = [...ids].reverse();
  const first = await ok(api, 200, "GET", "/me/mentions", undefined, w.viewer.token);
  assert.equal(first.items.length, 20, "default limit 20");
  assert.equal(typeof first.nextCursor, "string");
  const rest = await ok(api, 200, "GET", `/me/mentions?cursor=${encodeURIComponent(first.nextCursor)}`, undefined, w.viewer.token);
  assert.deepEqual([...first.items, ...rest.items].map((m: any) => m.commentId), newestFirst);
  assert.equal(rest.nextCursor, null);
  const { items, pages } = await collectPages(api, w.viewer.token, "/me/mentions", 5);
  assert.deepEqual(items.map((m: any) => m.commentId), newestFirst);
  assert.deepEqual(pages.map((p) => p.items.length), [5, 5, 5, 5, 3]);
  const all = await ok(api, 200, "GET", "/me/mentions?limit=100", undefined, w.viewer.token);
  assert.equal(all.items.length, 23);
  assert.equal(all.nextCursor, null);
  for (const q of ["limit=0", "limit=101", "limit=abc", "limit=2.5", "limit=", "cursor=bogus", "cursor="]) {
    assertError(await api.call("GET", `/me/mentions?${q}`, undefined, w.viewer.token), 400, "invalid_query", q);
  }
});

test("a handle counts only while its user is a current member of the card's team, in any role", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ada = await signUp(api, { handle: "ada" });
  const card = await createCard(api, w.cols[0], w.member, { title: "m" });
  const post = (body: string) => ok(api, 201, "POST", `/cards/${card.id}/comments`, { body }, w.member.token);
  assert.deepEqual((await post("@ada before joining")).mentions, [], "not a member yet");
  await addMember(api, w.team.id, w.owner, ada, "viewer");
  const kept = await post("@ada as a viewer");
  assert.deepEqual(kept.mentions, [ada.id], "a viewer counts");
  assertStatus(await api.call("DELETE", `/teams/${w.team.id}/members/${ada.id}`, undefined, w.admin.token), 204);
  assert.deepEqual((await post("@ada after leaving")).mentions, [], "a former member does not count");
  assert.deepEqual((await ok(api, 200, "GET", `/comments/${kept.id}`, undefined, w.member.token)).mentions, [ada.id], "mentions are computed when written");
  assert.deepEqual((await ok(api, 200, "PATCH", `/comments/${kept.id}`, { body: "@ada edited" }, w.member.token)).mentions, [], "a PATCH recomputes against current members");
  assert.deepEqual((await ok(api, 200, "GET", "/me/mentions", undefined, ada.token)).items, []);
});
