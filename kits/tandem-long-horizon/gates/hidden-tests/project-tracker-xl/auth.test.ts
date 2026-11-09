// Area `auth`: instruction.md section 1 (Accounts and auth), with the conventions of section 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, assertStatus, Clock, createApiKey, login, signUp, startApp } from "./helpers.ts";

const PW = "correct horse battery";

test("register returns the user with a trimmed, lowercased email and never a password or hash", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const res = await api.call("POST", "/auth/register", {
    email: "  Ada.Lovelace@Example.TEST ",
    password: PW,
    name: "  Ada Lovelace  ",
    handle: "ada_l",
    role: "ignored unknown field",
  });
  assertStatus(res, 201);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(typeof res.body.id, "string");
  assert.ok(res.body.id.length > 0);
  assert.deepEqual(Object.keys(res.body).sort(), ["createdAt", "email", "handle", "id", "name"]);
  assert.equal(res.body.email, "ada.lovelace@example.test");
  assert.equal(res.body.name, "Ada Lovelace");
  assert.equal(res.body.handle, "ada_l");
  assert.equal(res.body.createdAt, clock.iso());
  assert.ok(!res.text.includes(PW), "the response leaks the password");
  const token = await login(api, "ada.lovelace@example.test", PW);
  const me = await api.call("GET", "/me", undefined, token);
  assertStatus(me, 200);
  assert.deepEqual(me.body, res.body);
});

test("register rejects invalid emails, passwords, names, handles and bodies", async (t) => {
  const api = await startApp(t);
  const good = { email: "x@example.test", password: PW, name: "X", handle: "xyz" };
  const bad: [string, unknown][] = [
    ["email without @", { ...good, email: "no-at-sign" }],
    ["email with two @", { ...good, email: "a@b@example.test" }],
    ["email with nothing before @", { ...good, email: "@example.test" }],
    ["email with nothing after @", { ...good, email: "abc@" }],
    ["email longer than 254", { ...good, email: `${"a".repeat(250)}@b.cd` }],
    ["email not a string", { ...good, email: 42 }],
    ["password of 7 chars", { ...good, password: "1234567" }],
    ["password of 201 chars", { ...good, password: "p".repeat(201) }],
    ["blank name", { ...good, name: "   " }],
    ["name of 101 chars", { ...good, name: "n".repeat(101) }],
    ["uppercase handle", { ...good, handle: "Xyz" }],
    ["handle of 2 chars", { ...good, handle: "xy" }],
    ["handle of 21 chars", { ...good, handle: "h".repeat(21) }],
    ["handle with a dash", { ...good, handle: "x-yz" }],
    ["handle with spaces (not trimmed)", { ...good, handle: " xyz " }],
    ["missing handle", { email: good.email, password: PW, name: "X" }],
    ["an array body", [good]],
    ["a string body", "hello"],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", "/auth/register", body), 400, "invalid_body", what);
  assertError(await api.call("POST", "/auth/register", undefined, undefined, { raw: '{"email": ' }), 400, "invalid_json", "bad JSON");
  assertError(await api.call("POST", "/auth/register"), 400, "invalid_body", "missing body");
  assertError(await api.call("POST", "/auth/register", undefined, undefined, { raw: "" }), 400, "invalid_body", "zero-length body");
  assertError(await api.call("POST", "/auth/register", undefined, undefined, { raw: "  \n " }), 400, "invalid_json", "whitespace-only body");
  // Nothing was created by the rejected requests: the good body still registers, and the
  // request's content-type is not checked on JSON routes.
  assertStatus(await api.call("POST", "/auth/register", undefined, undefined, { raw: JSON.stringify(good), headers: { "content-type": "text/plain" } }), 201);
  assertError(await api.call("POST", "/auth/register", good), 409, "email_taken", "the same body again");
});

test("register accepts boundary values: password 8 and 200 chars, name 100 chars, handle 3 and 20 chars", async (t) => {
  const api = await startApp(t);
  const a = await api.call("POST", "/auth/register", { email: "a@b", password: "12345678", name: "n".repeat(100), handle: "abc" });
  assertStatus(a, 201, "short password, 3-char handle");
  assert.equal(a.body.name.length, 100);
  const b = await api.call("POST", "/auth/register", { email: "b@b", password: " ".repeat(200), name: "B", handle: "a1_".repeat(6) + "zz" });
  assertStatus(b, 201, "200-char password of spaces (not trimmed), 20-char handle");
  assert.equal(b.body.handle, "a1_a1_a1_a1_a1_a1_zz");
  await login(api, "b@b", " ".repeat(200));
});

test("email_taken is case-insensitive and is checked before handle_taken", async (t) => {
  const api = await startApp(t);
  assertStatus(await api.call("POST", "/auth/register", { email: "grace@example.test", password: PW, name: "G", handle: "grace" }), 201);
  assertError(
    await api.call("POST", "/auth/register", { email: " GRACE@Example.Test", password: PW, name: "G2", handle: "grace" }),
    409,
    "email_taken",
    "same email in another case and the same handle",
  );
  assertError(await api.call("POST", "/auth/register", { email: "other@example.test", password: PW, name: "O", handle: "grace" }), 409, "handle_taken");
  assertStatus(await api.call("POST", "/auth/register", { email: "other@example.test", password: PW, name: "O", handle: "grace2" }), 201);
});

test("login returns a fresh token of at least 20 chars, not starting with trk_, with expiresAt = now + tokenTtlMs", async (t) => {
  const clock = new Clock(Date.UTC(2026, 0, 10, 8, 0, 0));
  const api = await startApp(t, { now: clock.now, tokenTtlMs: 3_600_000 });
  assertStatus(await api.call("POST", "/auth/register", { email: "lin@example.test", password: PW, name: "L", handle: "lin" }), 201);
  const first = await api.call("POST", "/auth/login", { email: "  LIN@example.test ", password: PW });
  assertStatus(first, 200, "login with the email trimmed and in another case");
  assert.equal(typeof first.body.token, "string");
  assert.ok(first.body.token.length >= 20, "token should be at least 20 chars");
  assert.ok(!first.body.token.startsWith("trk_"), "a session token never starts with trk_ (the API key prefix)");
  assert.equal(first.body.expiresAt, new Date(clock.t + 3_600_000).toISOString());
  clock.advance(5000);
  const second = await api.call("POST", "/auth/login", { email: "lin@example.test", password: PW });
  assertStatus(second, 200);
  assert.notEqual(second.body.token, first.body.token, "each login issues a new token");
  assert.equal(second.body.expiresAt, new Date(clock.t + 3_600_000).toISOString());
  for (const tok of [first.body.token, second.body.token]) assertStatus(await api.call("GET", "/me", undefined, tok), 200, "both tokens work");
});

test("login answers 401 invalid_credentials for a wrong password or unknown email, 400 for non-string fields", async (t) => {
  const api = await startApp(t);
  assertStatus(await api.call("POST", "/auth/register", { email: "kim@example.test", password: PW, name: "K", handle: "kim" }), 201);
  assertError(await api.call("POST", "/auth/login", { email: "kim@example.test", password: "wrong password" }), 401, "invalid_credentials");
  assertError(await api.call("POST", "/auth/login", { email: "nobody@example.test", password: PW }), 401, "invalid_credentials");
  assertError(await api.call("POST", "/auth/login", { email: "kim@example.test", password: 12345678 }), 400, "invalid_body");
  assertError(await api.call("POST", "/auth/login", { email: null, password: PW }), 400, "invalid_body");
  assertError(await api.call("POST", "/auth/login", { password: PW }), 400, "invalid_body");
  assertError(await api.call("POST", "/auth/login", undefined, undefined, { raw: "nope" }), 400, "invalid_json");
});

test("authenticated routes answer 401 unauthorized for a missing, malformed, unknown or revoked token", async (t) => {
  const api = await startApp(t);
  const u = await signUp(api);
  const revoked = await login(api, u.email, u.password);
  assertStatus(await api.call("POST", "/auth/logout", undefined, revoked), 204);
  const variants: [string, Record<string, string>][] = [
    ["no header", {}],
    ["Basic scheme", { authorization: `Basic ${u.token}` }],
    ["lowercase bearer", { authorization: `bearer ${u.token}` }],
    ["Bearer with no token", { authorization: "Bearer" }],
    ["token without a scheme", { authorization: u.token }],
    ["unknown token", { authorization: `Bearer ${"z".repeat(40)}` }],
    ["unknown API-key-shaped token", { authorization: `Bearer trk_${"A".repeat(40)}` }],
    ["revoked token", { authorization: `Bearer ${revoked}` }],
  ];
  for (const [what, headers] of variants) {
    assertError(await api.call("GET", "/me", undefined, undefined, { headers }), 401, "unauthorized", what);
    assertError(await api.call("POST", "/teams", { name: "T" }, undefined, { headers }), 401, "unauthorized", `${what} (POST /teams)`);
  }
  assertStatus(await api.call("GET", "/me", undefined, u.token), 200);
  assertError(await api.call("GET", "/teams"), 401, "unauthorized", "GET /teams without a token");
  const teams = await api.call("GET", "/teams", undefined, u.token);
  assert.deepEqual(teams.body, { items: [] }, "no rejected POST /teams created a team");
});

test("a token expires when now() >= issuedAt + tokenTtlMs", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: 10_000 });
  const u = await signUp(api);
  clock.advance(9_999);
  assertStatus(await api.call("GET", "/me", undefined, u.token), 200, "1 ms before expiry");
  clock.advance(1);
  assertError(await api.call("GET", "/me", undefined, u.token), 401, "unauthorized", "at expiry");
  const fresh = await login(api, u.email, u.password);
  assertStatus(await api.call("GET", "/me", undefined, fresh), 200, "a new login works");
});

test("logout answers 204 with no body and revokes only the calling token", async (t) => {
  const api = await startApp(t);
  const u = await signUp(api);
  const other = await login(api, u.email, u.password);
  const res = await api.call("POST", "/auth/logout", undefined, u.token);
  assertStatus(res, 204);
  assert.equal(res.text, "", "204 has no body");
  assertError(await api.call("GET", "/me", undefined, u.token), 401, "unauthorized", "the logged-out token");
  assertError(await api.call("POST", "/auth/logout", undefined, u.token), 401, "unauthorized", "logout twice");
  assertStatus(await api.call("GET", "/me", undefined, other), 200, "the user's other token");
});

test("POST /me/password validates both fields first, then wrong_password; success revokes every session token but no API key", async (t) => {
  const api = await startApp(t);
  const u = await signUp(api);
  const second = await login(api, u.email, u.password);
  const key = await createApiKey(api, u, { scope: "read" });
  assertError(await api.call("POST", "/me/password", { currentPassword: "wrong", newPassword: "short" }, u.token), 400, "invalid_body", "short new password with a wrong current one");
  assertError(await api.call("POST", "/me/password", { currentPassword: 5, newPassword: "long enough pw" }, u.token), 400, "invalid_body", "non-string currentPassword");
  assertError(await api.call("POST", "/me/password", { currentPassword: u.password }, u.token), 400, "invalid_body", "missing newPassword");
  assertError(await api.call("POST", "/me/password", { currentPassword: "wrong one", newPassword: "long enough pw" }, u.token), 400, "wrong_password");
  assertStatus(await api.call("GET", "/me", undefined, u.token), 200, "failed attempts revoke nothing");
  const res = await api.call("POST", "/me/password", { currentPassword: u.password, newPassword: "a brand new password" }, u.token);
  assertStatus(res, 204);
  assertError(await api.call("GET", "/me", undefined, u.token), 401, "unauthorized", "the calling token");
  assertError(await api.call("GET", "/me", undefined, second), 401, "unauthorized", "the other token");
  assertError(await api.call("POST", "/auth/login", { email: u.email, password: u.password }), 401, "invalid_credentials", "old password");
  await login(api, u.email, "a brand new password");
  const me = await api.call("GET", "/me", undefined, key.secret);
  assertStatus(me, 200, "the API key still works after the password change");
  assert.equal(me.body.id, u.id);
});

test("PATCH /me updates name and handle; another user's handle is 409 handle_taken, one's own is fine", async (t) => {
  const api = await startApp(t);
  const a = await signUp(api, { handle: "alpha" });
  await signUp(api, { handle: "bravo" });
  const res = await api.call("PATCH", "/me", { name: "  New Name ", handle: "alpha_2" }, a.token);
  assertStatus(res, 200);
  assert.equal(res.body.name, "New Name");
  assert.equal(res.body.handle, "alpha_2");
  assert.equal(res.body.id, a.id);
  assertError(await api.call("PATCH", "/me", { handle: "bravo" }, a.token), 409, "handle_taken");
  assertStatus(await api.call("PATCH", "/me", { handle: "alpha_2" }, a.token), 200, "own current handle");
  assertError(await api.call("PATCH", "/me", {}, a.token), 400, "invalid_body", "no updatable field");
  assertError(await api.call("PATCH", "/me", { handle: "Bad Handle" }, a.token), 400, "invalid_body");
  assertError(await api.call("PATCH", "/me", { name: "" }, a.token), 400, "invalid_body");
  assertError(await api.call("PATCH", "/me", { email: "new@example.test" }, a.token), 400, "invalid_body", "email is not updatable");
  const me = await api.call("GET", "/me", undefined, a.token);
  assert.equal(me.body.handle, "alpha_2");
  assert.equal(me.body.name, "New Name");
  // The released handle is free again.
  assertStatus(await api.call("POST", "/auth/register", { email: "c@example.test", password: PW, name: "C", handle: "alpha" }), 201);
});
