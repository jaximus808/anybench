/* global process, fetch, setTimeout */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("creates, lists and 404s", async () => {
  const srv = spawn("npm", ["start"], { env: { ...process.env, PORT: "3917" } });
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const made = await (
      await fetch("http://127.0.0.1:3917/todos", {
        method: "POST",
        body: JSON.stringify({ title: "a" }),
      })
    ).json();
    assert.ok(made.id);
    const list = await (await fetch("http://127.0.0.1:3917/todos")).json();
    assert.equal(list.length, 1);
    assert.equal((await fetch("http://127.0.0.1:3917/todos/nope")).status, 404);
  } finally {
    srv.kill();
  }
});
