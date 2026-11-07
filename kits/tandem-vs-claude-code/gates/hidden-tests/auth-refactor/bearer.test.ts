import assert from "node:assert/strict";
import { test } from "node:test";
import { alice, assertError, b64url, bob, decodePart, forge, nowS, startApp } from "./helpers.ts";

test("GET /me accepts a bearer token", async (t) => {
  const api = await startApp(t);
  const { token } = await bob(api);
  const res = await api.call("GET", "/me", { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: "u_bob", username: "bob", role: "user" });
});

test("a tampered payload is rejected with invalid_token", async (t) => {
  const api = await startApp(t);
  const { token } = await bob(api);
  const [h, p, s] = token.split(".") as [string, string, string];
  const claims = decodePart(p);
  const tampered = `${h}.${b64url({ ...claims, role: "admin" })}.${s}`;
  assertError(await api.call("GET", "/admin/users", { token: tampered }), 401, "invalid_token");
  assertError(await api.call("GET", "/me", { token: `${h}.${p}.${s.slice(0, -2)}xx` }), 401, "invalid_token");
});

test("a token signed with another secret is rejected with invalid_token", async (t) => {
  const api = await startApp(t);
  const now = nowS();
  const token = forge({ sub: "u_alice", role: "admin", iat: now, exp: now + 300, jti: "wrong-secret" }, "not-the-secret");
  assertError(await api.call("GET", "/me", { token }), 401, "invalid_token");
});

test("alg none and other algorithms are rejected with invalid_token", async (t) => {
  const api = await startApp(t);
  const now = nowS();
  const claims = { sub: "u_alice", role: "admin", iat: now, exp: now + 300, jti: "alg-none" };
  const none = `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.`;
  assertError(await api.call("GET", "/me", { token: none }), 401, "invalid_token");
  const hs512Header = forge(claims, undefined, { alg: "HS512", typ: "JWT" });
  assertError(await api.call("GET", "/me", { token: hs512Header }), 401, "invalid_token");
});

test("an expired token is rejected with token_expired", async (t) => {
  const api = await startApp(t);
  const now = nowS();
  const token = forge({ sub: "u_bob", role: "user", iat: now - 1000, exp: now - 10, jti: "old" });
  assertError(await api.call("GET", "/me", { token }), 401, "token_expired");
});

test("admin routes check the role claim: 200 for admin, 403 forbidden for users", async (t) => {
  const api = await startApp(t);
  const admin = await alice(api);
  const ok = await api.call("GET", "/admin/users", { token: admin.token });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.users.map((u: { username: string }) => u.username).sort(), ["alice", "bob"]);
  const user = await bob(api);
  assertError(await api.call("GET", "/admin/users", { token: user.token }), 403, "forbidden");
});
