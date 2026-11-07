import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, createTodo, signUp, startApp } from "./helpers.ts";

test("todo routes require a bearer token (401 unauthorized)", async (t) => {
  const api = await startApp(t);
  assertError(await api.call("GET", "/todos"), 401, "unauthorized");
  assertError(await api.call("POST", "/todos", { title: "x" }), 401, "unauthorized");
  assertError(await api.call("GET", "/todos", undefined, "not-a-real-token-000000000000"), 401, "unauthorized");
});

test("POST /todos creates a todo with the documented shape", async (t) => {
  const api = await startApp(t);
  const token = await signUp(api);
  const res = await api.call("POST", "/todos", { title: "buy milk", due: "2030-01-02" }, token);
  assert.equal(res.status, 201);
  assert.equal(typeof res.body.id, "string");
  assert.equal(res.body.title, "buy milk");
  assert.equal(res.body.done, false);
  assert.equal(res.body.due, "2030-01-02");
  assert.ok(!Number.isNaN(Date.parse(res.body.createdAt)), "createdAt should be an ISO timestamp");
  const noDue = await createTodo(api, token, "no due date");
  assert.equal(noDue.due, null);
});

test("POST /todos validates the body with 400 invalid_body", async (t) => {
  const api = await startApp(t);
  const token = await signUp(api);
  assertError(await api.call("POST", "/todos", {}, token), 400, "invalid_body");
  assertError(await api.call("POST", "/todos", { title: "" }, token), 400, "invalid_body");
  assertError(await api.call("POST", "/todos", { title: "x".repeat(201) }, token), 400, "invalid_body");
  assertError(await api.call("POST", "/todos", { title: "ok", due: "next tuesday" }, token), 400, "invalid_body");
});

test("GET /todos/:id returns the todo", async (t) => {
  const api = await startApp(t);
  const token = await signUp(api);
  const todo = await createTodo(api, token, "read a book");
  const res = await api.call("GET", `/todos/${todo.id}`, undefined, token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, todo);
  assertError(await api.call("GET", "/todos/does-not-exist", undefined, token), 404, "not_found");
});

test("PATCH /todos/:id updates title and done, and the change sticks", async (t) => {
  const api = await startApp(t);
  const token = await signUp(api);
  const todo = await createTodo(api, token, "draft");
  const res = await api.call("PATCH", `/todos/${todo.id}`, { done: true, title: "final" }, token);
  assert.equal(res.status, 200);
  assert.equal(res.body.done, true);
  assert.equal(res.body.title, "final");
  const again = await api.call("GET", `/todos/${todo.id}`, undefined, token);
  assert.equal(again.body.done, true);
  assert.equal(again.body.title, "final");
  assertError(await api.call("PATCH", `/todos/${todo.id}`, { done: "yes" }, token), 400, "invalid_body");
});

test("DELETE /todos/:id answers 204 and the todo is gone", async (t) => {
  const api = await startApp(t);
  const token = await signUp(api);
  const todo = await createTodo(api, token, "temporary");
  const del = await api.call("DELETE", `/todos/${todo.id}`, undefined, token);
  assert.equal(del.status, 204);
  assertError(await api.call("GET", `/todos/${todo.id}`, undefined, token), 404, "not_found");
  assertError(await api.call("DELETE", `/todos/${todo.id}`, undefined, token), 404, "not_found");
});
