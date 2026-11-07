import assert from "node:assert/strict";
import { test } from "node:test";
import { alice, assertError, bob, decodePart, startApp } from "./helpers.ts";

test("logout revokes the token (204, then token_revoked)", async (t) => {
  const api = await startApp(t);
  const { token } = await bob(api);
  const out = await api.call("POST", "/auth/logout", { token });
  assert.equal(out.status, 204);
  assertError(await api.call("GET", "/me", { token }), 401, "token_revoked");
  const other = await bob(api);
  assert.equal((await api.call("GET", "/me", { token: other.token })).status, 200, "other tokens still work");
});

test("refresh issues a new token and revokes the old one", async (t) => {
  const api = await startApp(t);
  const { token } = await alice(api);
  const res = await api.call("POST", "/auth/refresh", { token });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, "string");
  assert.equal(res.body.expiresIn, 900);
  assert.notEqual(decodePart(res.body.token.split(".")[1]).jti, decodePart(token.split(".")[1]!).jti);
  assertError(await api.call("GET", "/me", { token }), 401, "token_revoked");
  assert.equal((await api.call("GET", "/me", { token: res.body.token })).status, 200);
});

test("tokens are stateless: another instance with the same secret accepts them", async (t) => {
  const a = await startApp(t);
  const b = await startApp(t);
  const c = await startApp(t, { JWT_SECRET: "a-completely-different-secret" });
  const { token } = await alice(a);
  const viaB = await b.call("GET", "/me", { token });
  assert.equal(viaB.status, 200);
  assert.equal(viaB.body.username, "alice");
  assertError(await c.call("GET", "/me", { token }), 401, "invalid_token");
});
