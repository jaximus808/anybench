import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, createTodo, signUp, startApp } from "./helpers.ts";

test("users cannot see or change each other's todos (404 not_found)", async (t) => {
  const api = await startApp(t);
  const alice = await signUp(api);
  const bob = await signUp(api);
  const todo = await createTodo(api, alice, "alice only");
  assertError(await api.call("GET", `/todos/${todo.id}`, undefined, bob), 404, "not_found");
  assertError(await api.call("PATCH", `/todos/${todo.id}`, { done: true }, bob), 404, "not_found");
  assertError(await api.call("DELETE", `/todos/${todo.id}`, undefined, bob), 404, "not_found");
  assert.equal((await api.call("GET", `/todos/${todo.id}`, undefined, alice)).body.done, false);
});

test("GET /todos lists only the caller's todos, oldest first", async (t) => {
  const api = await startApp(t);
  const alice = await signUp(api);
  const bob = await signUp(api);
  const a1 = await createTodo(api, alice, "a1");
  await createTodo(api, bob, "b1");
  const a2 = await createTodo(api, alice, "a2");
  const a3 = await createTodo(api, alice, "a3");
  const res = await api.call("GET", "/todos", undefined, alice);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((x: { id: string }) => x.id), [a1.id, a2.id, a3.id]);
  assert.equal(res.body.nextCursor, null);
});

test("GET /todos?done= filters by completion", async (t) => {
  const api = await startApp(t);
  const token = await signUp(api);
  const open = await createTodo(api, token, "open");
  const closed = await createTodo(api, token, "closed");
  assert.equal((await api.call("PATCH", `/todos/${closed.id}`, { done: true }, token)).status, 200);
  const done = await api.call("GET", "/todos?done=true", undefined, token);
  assert.deepEqual(done.body.items.map((x: { id: string }) => x.id), [closed.id]);
  const notDone = await api.call("GET", "/todos?done=false", undefined, token);
  assert.deepEqual(notDone.body.items.map((x: { id: string }) => x.id), [open.id]);
  assertError(await api.call("GET", "/todos?done=maybe", undefined, token), 400, "invalid_query");
});

test("GET /todos pages with limit and cursor, without gaps or repeats", async (t) => {
  const api = await startApp(t);
  const token = await signUp(api);
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) ids.push((await createTodo(api, token, `item ${i}`)).id);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const q: string = cursor === null ? "?limit=3" : `?limit=3&cursor=${encodeURIComponent(cursor)}`;
    const res = await api.call("GET", `/todos${q}`, undefined, token);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length <= 3);
    seen.push(...res.body.items.map((x: { id: string }) => x.id));
    cursor = res.body.nextCursor;
    pages += 1;
  } while (cursor !== null && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual(seen, ids);
  assertError(await api.call("GET", "/todos?limit=0", undefined, token), 400, "invalid_query");
  assertError(await api.call("GET", "/todos?limit=101", undefined, token), 400, "invalid_query");
});
