import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, startApp, uniqueEmail } from "./helpers.ts";

test("register creates a user and never returns the password", async (t) => {
  const api = await startApp(t);
  const email = uniqueEmail();
  const res = await api.call("POST", "/auth/register", { email, password: "correct horse" });
  assert.equal(res.status, 201);
  assert.equal(res.body.email, email);
  assert.equal(typeof res.body.id, "string");
  assert.ok(!JSON.stringify(res.body).includes("correct horse"), "response leaks the password");
  assert.equal(res.body.password, undefined);
});

test("register rejects a duplicate email with 409 email_taken", async (t) => {
  const api = await startApp(t);
  const email = uniqueEmail();
  const first = await api.call("POST", "/auth/register", { email, password: "correct horse" });
  assert.equal(first.status, 201);
  const again = await api.call("POST", "/auth/register", { email, password: "another pass" });
  assertError(again, 409, "email_taken");
});

test("register validates email and password length with 400 invalid_body", async (t) => {
  const api = await startApp(t);
  assertError(await api.call("POST", "/auth/register", { email: "not-an-email", password: "correct horse" }), 400, "invalid_body");
  assertError(await api.call("POST", "/auth/register", { email: uniqueEmail(), password: "short" }), 400, "invalid_body");
  assertError(await api.call("POST", "/auth/register", { email: uniqueEmail() }), 400, "invalid_body");
});

test("login returns a token for good credentials and 401 invalid_credentials otherwise", async (t) => {
  const api = await startApp(t);
  const email = uniqueEmail();
  assert.equal((await api.call("POST", "/auth/register", { email, password: "correct horse" })).status, 201);
  const ok = await api.call("POST", "/auth/login", { email, password: "correct horse" });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.token, "string");
  assert.ok(ok.body.token.length >= 20, "token should be at least 20 characters");
  assertError(await api.call("POST", "/auth/login", { email, password: "wrong password" }), 401, "invalid_credentials");
  assertError(await api.call("POST", "/auth/login", { email: uniqueEmail(), password: "correct horse" }), 401, "invalid_credentials");
});
