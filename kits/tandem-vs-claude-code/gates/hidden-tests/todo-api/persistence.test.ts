import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createTodo, startApp, tempDataFile, uniqueEmail } from "./helpers.ts";

test("state survives a restart when dataFile is set", async (t) => {
  const dataFile = tempDataFile();
  const email = uniqueEmail();
  const first = await startApp(t, { dataFile });
  assert.equal((await first.call("POST", "/auth/register", { email, password: "correct horse" })).status, 201);
  const token1 = (await first.call("POST", "/auth/login", { email, password: "correct horse" })).body.token;
  const todo = await createTodo(first, token1, "survive restart");

  const second = await startApp(t, { dataFile });
  const login = await second.call("POST", "/auth/login", { email, password: "correct horse" });
  assert.equal(login.status, 200, "the user should still exist after a restart");
  const list = await second.call("GET", "/todos", undefined, login.body.token);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items, [todo]);
});

test("the data file stores a password hash, never the password", async (t) => {
  const dataFile = tempDataFile();
  const api = await startApp(t, { dataFile });
  const email = uniqueEmail();
  assert.equal((await api.call("POST", "/auth/register", { email, password: "s3cret-passphrase" })).status, 201);
  const text = readFileSync(dataFile, "utf8");
  assert.ok(text.includes(email), "the data file should contain the user");
  assert.ok(!text.includes("s3cret-passphrase"), "the data file contains the plaintext password");
});
