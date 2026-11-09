// Area `persistence`: instruction.md section 10.1 (the version 2 data file), with the pipeline of
// section 0.8 (step 5 writes before the response) and the scheduler of section 0.9 (jobs persist).
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertError,
  assertStatus,
  Clock,
  createApiKey,
  createCard,
  createRule,
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

test("the data file holds version 2 and the new state, pipeline effects included, as soon as a mutating response arrives", async (t) => {
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
  // The file is written after the whole pipeline: a rule's change is in it when the response arrives.
  const project = await ok(api, 201, "POST", `/teams/${team.id}/projects`, { name: "P", key: "PER" }, token);
  const board = await ok(api, 201, "POST", `/projects/${project.id}/boards`, { name: "B" }, token);
  await ok(api, 201, "POST", `/teams/${team.id}/rules`, { name: "tag", trigger: { event: "card.created" }, actions: [{ type: "add_label", label: "ruleaddedqx" }] }, token);
  assert.ok(!readFileSync(file, "utf8").includes('"ruleaddedqx"]'), "no card carries the label yet");
  const card = await ok(api, 201, "POST", `/columns/${board.columns[0].id}/cards`, { title: "Durable card title" }, token);
  assert.deepEqual(card.labels, ["ruleaddedqx"]);
  const after = readFileSync(file, "utf8");
  assert.ok(after.includes("Durable card title"), "the card is in the file");
  assert.ok((after.match(/ruleaddedqx/g) ?? []).length >= 2, "the rule's label on the card is in the file, not only the rule");
  assert.doesNotThrow(() => JSON.parse(after), "the file is always complete JSON");
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
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.moved" }, actions: [{ type: "set_priority", priority: "high" }] });
  await ok(api, 200, "POST", `/cards/${c2.id}/move`, { columnId: w.cols[1] }, w.member.token);
  const field = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Size", type: "number" }, w.owner.token);
  await ok(api, 200, "PUT", `/cards/${c1.id}/fields/${field.id}`, { value: 8 }, w.member.token);
  await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "bug", color: "#FF0000" }, w.owner.token);
  await ok(api, 201, "POST", `/projects/${w.project.id}/sprints`, { name: "S1", startDate: "2026-03-02", endDate: "2026-03-13" }, w.owner.token);
  await createApiKey(api, w.member, { name: "ci", scope: "write", expiresAt: "2027-01-01T00:00:00Z" });
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
    [w.viewer.token, "/me/notifications?limit=100"],
    [w.member.token, "/me/api-keys"],
    [w.owner.token, `/cards/${c1.id}`],
    [w.owner.token, `/cards/${c2.id}/history`],
    [w.owner.token, `/cards/${c2.id}/watchers`],
    [w.owner.token, `/projects/${w.project.id}/fields`],
    [w.owner.token, `/projects/${w.project.id}/sprints`],
    [w.owner.token, `/teams/${w.team.id}/labels`],
    [w.owner.token, `/teams/${w.team.id}/rules`],
    [w.owner.token, `/rules/${rule.id}/runs?limit=100`],
    [w.owner.token, `/teams/${w.team.id}/plan`],
    [w.owner.token, `/teams/${w.team.id}/activity?limit=100`],
  ];
  const before: any[] = [];
  for (const [tok, path] of reads) before.push(await ok(api, 200, "GET", path, undefined, tok));
  await api.close();
  const again = await startApp(t, { dataFile: file, now: clock.now });
  assert.equal(before[reads.findIndex(([, p]) => p.startsWith(`/rules/`))].items.length, 1, "the move of c2 recorded one rule run");
  for (const [i, [tok, path]] of reads.entries()) {
    assert.deepEqual(await ok(again, 200, "GET", path, undefined, tok), before[i], `GET ${path} after the restart`);
  }
  await login(again, w.member.email, w.member.password);
  assertError(await again.call("POST", "/auth/login", { email: w.member.email, password: "wrong-password" }), 401, "invalid_credentials");
});

test("after a restart the next card number continues, unexpired tokens and API keys work, revoked, deleted or expired ones stay invalid", async (t) => {
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
  const keep = await createApiKey(api, w.member, { scope: "read" });
  const dropped = await createApiKey(api, w.member, { scope: "read" });
  assertStatus(await api.call("DELETE", `/me/api-keys/${dropped.id}`, undefined, w.member.token), 204);
  const expiring = await createApiKey(api, w.member, { scope: "read", expiresAt: new Date(clock.t + 500_000).toISOString() });
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
  const viaKey = await again.call("GET", "/me", undefined, keep.secret);
  assertStatus(viaKey, 200, "an API key still works");
  assert.equal(viaKey.body.id, w.member.id);
  assertError(await again.call("GET", "/me", undefined, dropped.secret), 401, "unauthorized", "a key deleted before the restart");
  assertStatus(await again.call("GET", "/me", undefined, expiring.secret), 200, "not expired yet");
  clock.advance(1_000_000);
  assertError(await again.call("GET", "/me", undefined, expiring.secret), 401, "unauthorized", "the key's expiresAt passed");
});

test("the file never holds a plain-text password or API key secret, and webhook secrets survive a restart", async (t) => {
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
  const key = await ok(api, 201, "POST", "/me/api-keys", { name: "k", scope: "admin" }, t2);
  assert.ok(!readFileSync(file, "utf8").includes(key.secret), "the API key secret is in the file");
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
  assert.equal(existsSync(file), false, "createApp does not create the file");
  const health = await api.call("GET", "/health");
  assertStatus(health, 200);
  assert.deepEqual(health.body, { ok: true });
  assertError(await api.call("POST", "/auth/login", { email: "who@example.test", password: "whatever-1" }), 401, "invalid_credentials");
  assert.equal(existsSync(file), false, "reads and failed requests do not create it");
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

test("pending jobs survive a restart: a due job and a recurrence run when they are due on the new app", async (t) => {
  const clock = new Clock(Date.UTC(2026, 2, 1, 12, 0, 0));
  const file = join(tempDir(t), "tracker.json");
  const api = await startApp(t, { dataFile: file, now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "due later", dueDate: "2026-03-03" });
  const rec = await ok(
    api,
    201,
    "POST",
    `/boards/${w.board.id}/recurrences`,
    { columnId: w.cols[1], schedule: { frequency: "daily", time: "09:00" }, startDate: "2026-03-02", title: "Standup {{date}}" },
    w.admin.token,
  );
  assert.equal(rec.nextRunAt, "2026-03-02T09:00:00.000Z");
  await api.close();
  clock.set(Date.parse("2026-03-03T00:00:01.000Z"));
  const again = await startApp(t, { dataFile: file, now: clock.now });
  assertStatus(await again.call("GET", "/health"), 200);
  const after = await ok(again, 200, "GET", `/recurrences/${rec.id}`, undefined, w.admin.token);
  assert.equal(after.lastRunAt, clock.iso(), "the recurrence ran on the first request after the restart");
  assert.equal(after.lastError, null);
  assert.equal(after.nextRunAt, "2026-03-03T09:00:00.000Z");
  const made = await ok(again, 200, "GET", `/cards/${after.lastCardId}`, undefined, w.admin.token);
  assert.equal(made.title, "Standup 2026-03-03");
  assert.equal(made.columnId, w.cols[1]);
  assert.equal(made.number, 2, "numbering continued");
  const activity = await ok(again, 200, "GET", `/cards/${card.id}/activity`, undefined, w.member.token);
  const due = activity.items.filter((e: any) => e.event === "card.due");
  assert.equal(due.length, 1, "the due job ran once after the restart");
  assert.deepEqual([due[0].actorId, due[0].via, due[0].at], [null, { type: "schedule" }, clock.iso()]);
});

test("rate-limit counters, delivery records, idempotent responses and cursors do not survive a restart", async (t) => {
  const clock = new Clock(7_000_000);
  const file = join(tempDir(t), "tracker.json");
  const opts = { dataFile: file, now: clock.now, rateLimit: { limit: 6, windowMs: 3_600_000 }, webhooks: { retryDelaysMs: [], timeoutMs: 2000 } };
  const api = await startApp(t, opts);
  const rx = await startReceiver(t);
  await ok(api, 201, "POST", "/auth/register", { email: "r@example.test", password: "restart-pass", name: "R", handle: "rrr" });
  const token = await login(api, "r@example.test", "restart-pass");
  const team = await ok(api, 201, "POST", "/teams", { name: "Once" }, token, { idem: "same-key" });
  const hook = await ok(api, 201, "POST", `/teams/${team.id}/webhooks`, { url: rx.url, events: ["*"] }, token);
  await ok(api, 202, "POST", `/webhooks/${hook.id}/test`, undefined, token);
  await rx.waitForCount(1);
  assert.equal((await ok(api, 200, "GET", `/webhooks/${hook.id}/deliveries`, undefined, token)).items.length, 1);
  const page = await ok(api, 200, "GET", `/teams/${team.id}/audit?limit=1`, undefined, token);
  assert.equal(typeof page.nextCursor, "string");
  assertStatus(await api.call("GET", "/me", undefined, token), 200);
  assertError(await api.call("GET", "/me", undefined, token), 429, "rate_limited");
  await api.close();
  const again = await startApp(t, opts);
  const me = await again.call("GET", "/me", undefined, token);
  assertStatus(me, 200, "the counter starts over");
  assert.equal(me.headers.get("x-ratelimit-remaining"), "5");
  assert.deepEqual((await ok(again, 200, "GET", `/webhooks/${hook.id}/deliveries`, undefined, token)).items, [], "delivery records live in memory only");
  const second = await again.call("POST", "/teams", { name: "Once" }, token, { idem: "same-key" });
  assertStatus(second, 201, "the stored response is gone, so the request runs again");
  assert.equal(second.headers.get("idempotency-replayed"), null);
  assert.notEqual(second.body.id, team.id);
  assert.equal((await ok(again, 200, "GET", "/teams", undefined, token)).items.length, 2);
  assertError(await again.call("GET", `/teams/${team.id}/audit?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`, undefined, token), 400, "invalid_query", "a cursor from before the restart");
});
