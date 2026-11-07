import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.ts";

async function start(t: TestContext, dataFile?: string) {
  const server = createApp(dataFile === undefined ? {} : { dataFile });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return async (method: string, path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
  };
}

async function login(call: Awaited<ReturnType<typeof start>>, email: string): Promise<string> {
  await call("POST", "/auth/register", { email, password: "password123" });
  const res = await call("POST", "/auth/login", { email, password: "password123" });
  assert.equal(res.status, 200);
  return res.body.token;
}

test("a user registers, logs in and manages todos", async (t) => {
  const call = await start(t);
  const token = await login(call, "ann@example.test");
  const created = await call("POST", "/todos", { title: "write tests" }, token);
  assert.equal(created.status, 201);
  const patched = await call("PATCH", `/todos/${created.body.id}`, { done: true }, token);
  assert.equal(patched.body.done, true);
  assert.equal((await call("DELETE", `/todos/${created.body.id}`, undefined, token)).status, 204);
  assert.equal((await call("GET", `/todos/${created.body.id}`, undefined, token)).status, 404);
});

test("wrong password and missing token are rejected", async (t) => {
  const call = await start(t);
  await login(call, "ben@example.test");
  const bad = await call("POST", "/auth/login", { email: "ben@example.test", password: "nope-nope" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, "invalid_credentials");
  assert.equal((await call("GET", "/todos")).body.error.code, "unauthorized");
});

test("another user's todo is not found", async (t) => {
  const call = await start(t);
  const a = await login(call, "a@example.test");
  const b = await login(call, "b@example.test");
  const todo = await call("POST", "/todos", { title: "private" }, a);
  assert.equal((await call("GET", `/todos/${todo.body.id}`, undefined, b)).status, 404);
});

test("listing pages through every todo once, filtered by done", async (t) => {
  const call = await start(t);
  const token = await login(call, "c@example.test");
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await call("POST", "/todos", { title: `t${i}` }, token)).body.id);
  await call("PATCH", `/todos/${ids[1]}`, { done: true }, token);
  await call("PATCH", `/todos/${ids[3]}`, { done: true }, token);

  const open: string[] = [];
  let cursor: string | null = null;
  do {
    const q: string = `?done=false&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
    const page = await call("GET", `/todos${q}`, undefined, token);
    open.push(...page.body.items.map((x: { id: string }) => x.id));
    cursor = page.body.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(open, [ids[0], ids[2], ids[4]]);
});

test("data persists across restarts without storing the password", async (t) => {
  const file = join(mkdtempSync(join(tmpdir(), "todo-api-")), "data.json");
  const first = await start(t, file);
  const token = await login(first, "d@example.test");
  await first("POST", "/todos", { title: "kept" }, token);
  const second = await start(t, file);
  const again = await login(second, "d@example.test");
  const list = await second("GET", "/todos", undefined, again);
  assert.deepEqual(list.body.items.map((x: { title: string }) => x.title), ["kept"]);
});
