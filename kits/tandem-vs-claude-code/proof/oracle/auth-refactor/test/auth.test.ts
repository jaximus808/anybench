import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.ts";
import { signJwt, verifyJwt } from "../src/jwt.ts";

async function start(t: TestContext, secret = "test-secret"): Promise<string> {
  const server = createApp({ env: { JWT_SECRET: secret } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null);
  return ((await res.json()) as { token: string }).token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("createApp refuses to start without JWT_SECRET", () => {
  assert.throws(() => createApp({ env: {} }), /JWT_SECRET/);
});

test("login returns a token that /me accepts", async (t) => {
  const base = await start(t);
  const token = await login(base, "bob", "builder123");
  const res = await fetch(`${base}/me`, { headers: bearer(token) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "u_bob", username: "bob", role: "user" });
});

test("logout revokes the token", async (t) => {
  const base = await start(t);
  const token = await login(base, "alice", "wonderland");
  assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: bearer(token) })).status, 204);
  const res = await fetch(`${base}/me`, { headers: bearer(token) });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "token_revoked");
});

test("only admins list users", async (t) => {
  const base = await start(t);
  const bob = await login(base, "bob", "builder123");
  assert.equal((await fetch(`${base}/admin/users`, { headers: bearer(bob) })).status, 403);
  const alice = await login(base, "alice", "wonderland");
  assert.equal((await fetch(`${base}/admin/users`, { headers: bearer(alice) })).status, 200);
});

test("verifyJwt rejects tampering and expiry", () => {
  const token = signJwt({ sub: "u_bob", role: "user", iat: 100, exp: 200, jti: "a" }, "k");
  assert.equal(verifyJwt(token, "k", 150).sub, "u_bob");
  assert.throws(() => verifyJwt(token, "k", 200), { code: "token_expired" });
  assert.throws(() => verifyJwt(`${token}x`, "k", 150), { code: "invalid_token" });
});
