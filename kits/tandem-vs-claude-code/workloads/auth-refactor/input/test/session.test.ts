import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.ts";

async function start(t: TestContext): Promise<string> {
  const server = createApp({ env: { SESSION_SECRET: "test-secret" } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function loginCookie(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie");
  assert.ok(cookie?.startsWith("sid="));
  return cookie.split(";")[0]!;
}

test("login sets a session cookie that /me accepts", async (t) => {
  const base = await start(t);
  const cookie = await loginCookie(base, "bob", "builder123");
  const res = await fetch(`${base}/me`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "u_bob", username: "bob", role: "user" });
});

test("logout ends the session", async (t) => {
  const base = await start(t);
  const cookie = await loginCookie(base, "alice", "wonderland");
  assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie } })).status, 204);
  assert.equal((await fetch(`${base}/me`, { headers: { cookie } })).status, 401);
});

test("only admins list users", async (t) => {
  const base = await start(t);
  const bob = await loginCookie(base, "bob", "builder123");
  assert.equal((await fetch(`${base}/admin/users`, { headers: { cookie: bob } })).status, 403);
  const alice = await loginCookie(base, "alice", "wonderland");
  assert.equal((await fetch(`${base}/admin/users`, { headers: { cookie: alice } })).status, 200);
});
