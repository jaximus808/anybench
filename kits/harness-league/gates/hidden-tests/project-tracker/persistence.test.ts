// Area `persistence`: instruction.md section 10.1 (the version 2 data file).
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertError,
  assertStatus,
  Clock,
  createCard,
  loadCreateApp,
  login,
  ok,
  setupBoard,
  sign,
  startApp,
  startReceiver,
  tempDir,
  waitFor,
} from "./helpers.ts";

const readData = (file: string): any => JSON.parse(readFileSync(file, "utf8"));

test("the data file holds version 2 and the new state as soon as a mutating response arrives", async (t) => {
  const file = join(tempDir(t), "tracker.json");
  const api = await startApp(t, { dataFile: file });
  const reg = await api.call("POST", "/auth/register", { email: "durable@example.test", password: "durable-pass-1", name: "Dee", handle: "dee" });
  assertStatus(reg, 201);
  // No waiting: the write happened before the response.
  assert.ok(existsSync(file), "the file exists right after the first write");
  let data = readData(file);
  assert.equal(data.version, 2);
  assert.ok(readFileSync(file, "utf8").includes("durable@example.test"), "the user is in the file");
  const token = await login(api, "durable@example.test", "durable-pass-1");
  const team = await ok(api, 201, "POST", "/teams", { name: "Persisted Team Name" }, token);
  assert.ok(readFileSync(file, "utf8").includes("Persisted Team Name"), "the team is in the file");
  await ok(api, 200, "PATCH", `/teams/${team.id}`, { name: "Renamed Team Zebra" }, token);
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("Renamed Team Zebra"), "the rename is in the file");
  data = JSON.parse(text);
  assert.equal(data.version, 2);
});

test("a new app on the same file sees exactly the same state", async (t) => {
  const clock = new Clock();
  const file = join(tempDir(t), "tracker.json");
  const api = await startApp(t, { dataFile: file, now: clock.now });
  const w = await setupBoard(api, clock);
  clock.advance(1000);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "first", labels: ["b", "a"], dueDate: "2026-04-01", assigneeId: w.admin.id });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "second", position: 0 });
  clock.advance(1000);
  await ok(api, 200, "POST", `/cards/${c1.id}/move`, { columnId: w.cols[1] }, w.member.token);
  const top = await ok(api, 201, "POST", `/cards/${c2.id}/comments`, { body: `hi @${w.viewer.handle}` }, w.member.token);
  await ok(api, 201, "POST", `/cards/${c2.id}/comments`, { body: "reply", parentId: top.id }, w.admin.token);
  await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: "http://127.0.0.1:9/h", events: ["card.moved"], active: false }, w.owner.token);
  await ok(api, 200, "PATCH", `/columns/${w.cols[2]}`, { wipLimit: 4, position: 0 }, w.owner.token);
  const reads: [string, string][] = [
    [w.member.token, "/me"],
    [w.member.token, "/teams"],
    [w.owner.token, `/teams/${w.team.id}`],
    [w.owner.token, `/teams/${w.team.id}/members`],
    [w.owner.token, `/teams/${w.team.id}/projects?archived=all`],
    [w.owner.token, `/projects/${w.project.id}/boards`],
    [w.owner.token, `/boards/${w.board.id}/cards`],
    [w.owner.token, `/cards/${c2.id}/comments`],
    [w.owner.token, `/teams/${w.team.id}/webhooks`],
    [w.owner.token, `/teams/${w.team.id}/audit?limit=100`],
    [w.viewer.token, "/me/mentions"],
  ];
  const before: any[] = [];
  for (const [tok, path] of reads) before.push(await ok(api, 200, "GET", path, undefined, tok));
  await api.close();
  const again = await startApp(t, { dataFile: file, now: clock.now });
  for (const [i, [tok, path]] of reads.entries()) {
    assert.deepEqual(await ok(again, 200, "GET", path, undefined, tok), before[i], `GET ${path} after the restart`);
  }
  await login(again, w.member.email, w.member.password);
  assertError(await again.call("POST", "/auth/login", { email: w.member.email, password: "wrong-password" }), 401, "invalid_credentials");
});

test("after a restart the next card number continues, and revoked or expired tokens stay invalid", async (t) => {
  const clock = new Clock();
  const file = join(tempDir(t), "tracker.json");
  const opts = { dataFile: file, now: clock.now, tokenTtlMs: 100_000 };
  const api = await startApp(t, opts);
  const w = await setupBoard(api, clock);
  for (const title of ["one", "two", "three"]) await createCard(api, w.cols[0], w.member, { title });
  const three = (await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token)).items[2];
  assertStatus(await api.call("DELETE", `/cards/${three.id}`, undefined, w.member.token), 204);
  const revoked = await login(api, w.admin.email, w.admin.password);
  assertStatus(await api.call("POST", "/auth/logout", undefined, revoked), 204);
  const early = w.viewer.token; // issued during setup, the oldest token here
  clock.advance(50_000);
  const fresh = await login(api, w.viewer.email, w.viewer.password);
  await api.close();
  clock.advance(60_000); // `early` is now past its ttl, `fresh` is not
  const again = await startApp(t, opts);
  const memberToken = await login(again, w.member.email, w.member.password);
  const four = await createCard(again, w.cols[0], { ...w.member, token: memberToken }, { title: "four" });
  assert.equal(four.number, 4, "3 was used before the restart");
  assert.equal(four.key, "ENG-4");
  assert.equal(four.position, 2);
  assertError(await again.call("GET", "/me", undefined, revoked), 401, "unauthorized", "revoked before the restart");
  assertError(await again.call("GET", "/me", undefined, early), 401, "unauthorized", "expired");
  assertStatus(await again.call("GET", "/me", undefined, fresh), 200, "an unexpired token still works");
});

test("the file never holds a plain-text password, and webhook secrets survive a restart", async (t) => {
  const file = join(tempDir(t), "tracker.json");
  const api = await startApp(t, { dataFile: file, webhooks: { retryDelaysMs: [], timeoutMs: 2000 } });
  const pw = "plain-text-marker-pw-7781";
  await ok(api, 201, "POST", "/auth/register", { email: "p@example.test", password: pw, name: "P", handle: "ppp" });
  const token = await login(api, "p@example.test", pw);
  assert.ok(!readFileSync(file, "utf8").includes(pw), "the password is in the file");
  const newPw = "second-marker-pw-9932";
  assertStatus(await api.call("POST", "/me/password", { currentPassword: pw, newPassword: newPw }, token), 204);
  assert.ok(!readFileSync(file, "utf8").includes(newPw), "the new password is in the file");
  const t2 = await login(api, "p@example.test", newPw);
  const rx = await startReceiver(t);
  const team = await ok(api, 201, "POST", "/teams", { name: "S" }, t2);
  const hook = await ok(api, 201, "POST", `/teams/${team.id}/webhooks`, { url: rx.url, events: ["*"] }, t2);
  await api.close();
  const again = await startApp(t, { dataFile: file, webhooks: { retryDelaysMs: [], timeoutMs: 2000 } });
  const t3 = await login(again, "p@example.test", newPw);
  await ok(again, 202, "POST", `/webhooks/${hook.id}/test`, undefined, t3);
  const [req] = await rx.waitForCount(1);
  assert.equal(req!.headers["x-tracker-signature"], sign(hook.secret, req!.raw), "signed with the secret from before the restart");
  await waitFor("the ping delivery to finish", async () => {
    const d = await ok(again, 200, "GET", `/webhooks/${hook.id}/deliveries`, undefined, t3);
    return d.items[0]?.status === "succeeded" ? true : undefined;
  });
});

test("a missing file is an empty state, and the file is created on the first write", async (t) => {
  const file = join(tempDir(t), "fresh.json");
  const api = await startApp(t, { dataFile: file });
  const health = await api.call("GET", "/health");
  assertStatus(health, 200);
  assert.deepEqual(health.body, { ok: true });
  assertError(await api.call("POST", "/auth/login", { email: "who@example.test", password: "whatever-1" }), 401, "invalid_credentials");
  await ok(api, 201, "POST", "/auth/register", { email: "first@example.test", password: "first-pass", name: "F", handle: "fff" });
  assert.equal(readData(file).version, 2);
  const token = await login(api, "first@example.test", "first-pass");
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, token)).items, []);
});

test("createApp throws synchronously on invalid JSON and on an unsupported version", async (t) => {
  const createApp = await loadCreateApp();
  const dir = tempDir(t);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, '{"version": 2, "users": [');
  assert.throws(() => createApp({ dataFile: broken }), "invalid JSON");
  const v3 = join(dir, "v3.json");
  writeFileSync(v3, JSON.stringify({ version: 3 }));
  assert.throws(() => createApp({ dataFile: v3 }), /unsupported data version/);
  const v0 = join(dir, "v0.json");
  writeFileSync(v0, JSON.stringify({ version: 0, users: [] }));
  assert.throws(() => createApp({ dataFile: v0 }), /unsupported data version/);
});
