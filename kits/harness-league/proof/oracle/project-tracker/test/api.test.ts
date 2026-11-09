import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createApp, type AppOptions } from "../src/app.ts";

type Json = any;

interface Client {
  base: string;
  call(method: string, path: string, opts?: { token?: string; body?: unknown; raw?: string }): Promise<{
    status: number;
    body: Json;
    headers: Headers;
  }>;
}

async function start(t: TestContext, options: AppOptions = {}): Promise<Client> {
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
      let body: string | undefined = opts.raw;
      if (opts.body !== undefined) {
        body = JSON.stringify(opts.body);
        headers["content-type"] = "application/json";
      }
      const res = await fetch(base + path, { method, headers, body });
      const text = await res.text();
      return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined, headers: res.headers };
    },
  };
}

async function user(c: Client, handle: string, password = "password123"): Promise<{ id: string; token: string }> {
  const email = `${handle}@example.com`;
  const reg = await c.call("POST", "/auth/register", { body: { email, password, name: handle, handle } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const login = await c.call("POST", "/auth/login", { body: { email, password } });
  assert.equal(login.status, 200);
  return { id: reg.body.id, token: login.body.token };
}

test("auth: register, login, me, password change revokes tokens", async (t) => {
  let clock = 1_000_000;
  const c = await start(t, { now: () => clock, tokenTtlMs: 1000 });
  const reg = await c.call("POST", "/auth/register", {
    body: { email: "  Ada@Example.com ", password: "password123", name: " Ada ", handle: "ada" },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.email, "ada@example.com");
  assert.equal(reg.body.name, "Ada");
  assert.equal(reg.body.passwordHash, undefined);
  const dupe = await c.call("POST", "/auth/register", {
    body: { email: "ADA@example.com", password: "password123", name: "x", handle: "ada" },
  });
  assert.equal(dupe.body.error.code, "email_taken");
  const badHandle = await c.call("POST", "/auth/register", {
    body: { email: "b@example.com", password: "password123", name: "x", handle: "Bob" },
  });
  assert.equal(badHandle.body.error.code, "invalid_body");
  assert.equal((await c.call("POST", "/auth/register", { raw: "{nope" })).body.error.code, "invalid_json");
  assert.equal((await c.call("POST", "/auth/register", { raw: "[]" })).body.error.code, "invalid_body");
  assert.equal((await c.call("POST", "/auth/register", { raw: "x".repeat(70_000) })).status, 413);

  const login = await c.call("POST", "/auth/login", { body: { email: "ada@EXAMPLE.com", password: "password123" } });
  assert.equal(login.status, 200);
  assert.equal(login.body.expiresAt, new Date(clock + 1000).toISOString());
  const wrong = await c.call("POST", "/auth/login", { body: { email: "ada@example.com", password: "nope-nope" } });
  assert.equal(wrong.body.error.code, "invalid_credentials");
  const token = login.body.token as string;
  assert.equal((await c.call("GET", "/me", { token })).body.handle, "ada");
  clock += 1000;
  assert.equal((await c.call("GET", "/me", { token })).status, 401);
  clock -= 1000;

  const t2 = (await c.call("POST", "/auth/login", { body: { email: "ada@example.com", password: "password123" } })).body.token;
  const wp = await c.call("POST", "/me/password", { token, body: { currentPassword: "nope", newPassword: "newpassword" } });
  assert.equal(wp.body.error.code, "wrong_password");
  const cp = await c.call("POST", "/me/password", {
    token,
    body: { currentPassword: "password123", newPassword: "newpassword" },
  });
  assert.equal(cp.status, 204);
  assert.equal((await c.call("GET", "/me", { token })).status, 401);
  assert.equal((await c.call("GET", "/me", { token: t2 })).status, 401);
  assert.equal((await c.call("DELETE", "/me")).status, 404);
});

test("teams, roles and the check order", async (t) => {
  const c = await start(t);
  const owner = await user(c, "owner");
  const viewer = await user(c, "viewer");
  const outsider = await user(c, "outsider");
  const team = (await c.call("POST", "/teams", { token: owner.token, body: { name: "Team" } })).body;
  assert.equal(team.myRole, "owner");
  const add = await c.call("POST", `/teams/${team.id}/members`, {
    token: owner.token,
    body: { email: "VIEWER@example.com", role: "viewer" },
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.role, "viewer");
  assert.equal(
    (await c.call("POST", `/teams/${team.id}/members`, { token: owner.token, body: { email: "zz@example.com", role: "viewer" } })).body
      .error.code,
    "user_not_found",
  );
  assert.equal((await c.call("GET", `/teams/${team.id}`, { token: outsider.token })).status, 404);
  assert.equal((await c.call("PATCH", `/teams/${team.id}`, { token: viewer.token, body: { name: "x" } })).status, 403);
  assert.equal((await c.call("PATCH", `/teams/${team.id}`, { token: outsider.token, raw: "[]" })).body.error.code, "invalid_body");
  assert.equal(
    (await c.call("DELETE", `/teams/${team.id}/members/${owner.id}`, { token: owner.token })).body.error.code,
    "owner_required",
  );
  const tr = await c.call("POST", `/teams/${team.id}/transfer`, { token: owner.token, body: { userId: viewer.id } });
  assert.equal(tr.body.myRole, "admin");
  assert.equal(tr.body.ownerId, viewer.id);
  const members = (await c.call("GET", `/teams/${team.id}/members`, { token: owner.token })).body.items;
  assert.deepEqual(
    members.map((m: Json) => m.role),
    ["admin", "owner"],
  );
});

test("boards, cards, positions, WIP limits, column delete", async (t) => {
  const c = await start(t);
  const a = await user(c, "alice");
  const team = (await c.call("POST", "/teams", { token: a.token, body: { name: "T" } })).body;
  const project = (await c.call("POST", `/teams/${team.id}/projects`, { token: a.token, body: { name: "P", key: "ENG" } })).body;
  assert.equal(
    (await c.call("POST", `/teams/${team.id}/projects`, { token: a.token, body: { name: "P", key: "ENG" } })).body.error.code,
    "key_taken",
  );
  const board = (await c.call("POST", `/projects/${project.id}/boards`, { token: a.token, body: { name: "B" } })).body;
  assert.deepEqual(
    board.columns.map((x: Json) => [x.name, x.position]),
    [["To do", 0], ["In progress", 1], ["Done", 2]],
  );
  const [todo, doing, done] = board.columns;
  await c.call("PATCH", `/columns/${doing.id}`, { token: a.token, body: { wipLimit: 1 } });
  const mk = async (title: string, extra: object = {}) =>
    (await c.call("POST", `/columns/${todo.id}/cards`, { token: a.token, body: { title, ...extra } })).body;
  const c1 = await mk("one", { labels: [" B", "a", "b"] });
  const c2 = await mk("two");
  const c0 = await mk("zero", { position: 0 });
  assert.deepEqual(c1.labels, ["a", "b"]);
  assert.equal(c1.key, "ENG-1");
  assert.equal(c0.number, 3);
  const listed = (await c.call("GET", `/boards/${board.id}/cards`, { token: a.token })).body.items;
  assert.deepEqual(
    listed.map((x: Json) => [x.title, x.position]),
    [["zero", 0], ["one", 1], ["two", 2]],
  );
  const mv = await c.call("POST", `/cards/${c1.id}/move`, { token: a.token, body: { columnId: doing.id } });
  assert.equal(mv.body.position, 0);
  const wip = await c.call("POST", `/cards/${c2.id}/move`, { token: a.token, body: { columnId: doing.id } });
  assert.equal(wip.body.error.code, "wip_limit_reached");
  const reorder = await c.call("POST", `/cards/${c2.id}/move`, { token: a.token, body: { columnId: todo.id, position: 0 } });
  assert.equal(reorder.body.position, 0);
  assert.equal((await c.call("DELETE", `/columns/${todo.id}`, { token: a.token })).body.error.code, "column_not_empty");
  assert.equal((await c.call("DELETE", `/columns/${todo.id}?moveTo=`, { token: a.token })).body.error.code, "invalid_query");
  assert.equal((await c.call("DELETE", `/columns/${todo.id}?moveTo=${doing.id}`, { token: a.token })).status, 204);
  const after = (await c.call("GET", `/boards/${board.id}`, { token: a.token })).body;
  assert.deepEqual(
    after.columns.map((x: Json) => [x.name, x.position]),
    [["In progress", 0], ["Done", 1]],
  );
  const inDoing = (await c.call("GET", `/boards/${board.id}/cards?columnId=${doing.id}`, { token: a.token })).body.items;
  assert.deepEqual(
    inDoing.map((x: Json) => [x.title, x.position]),
    [["one", 0], ["two", 1], ["zero", 2]],
  );
  await c.call("DELETE", `/columns/${doing.id}?moveTo=${done.id}`, { token: a.token });
  assert.equal((await c.call("DELETE", `/columns/${done.id}`, { token: a.token })).body.error.code, "last_column");
  await c.call("PATCH", `/projects/${project.id}`, { token: a.token, body: { archived: true } });
  assert.equal((await c.call("PATCH", `/cards/${c0.id}`, { token: a.token, body: { title: "x" } })).body.error.code, "project_archived");
  assert.equal((await c.call("PATCH", `/cards/${c0.id}`, { token: a.token, body: {} })).body.error.code, "invalid_body");
});

test("comments, mentions, search", async (t) => {
  const c = await start(t);
  const a = await user(c, "alice");
  const b = await user(c, "bob_b");
  const team = (await c.call("POST", "/teams", { token: a.token, body: { name: "T" } })).body;
  await c.call("POST", `/teams/${team.id}/members`, { token: a.token, body: { email: "bob_b@example.com", role: "member" } });
  const project = (await c.call("POST", `/teams/${team.id}/projects`, { token: a.token, body: { name: "P", key: "AB" } })).body;
  const board = (await c.call("POST", `/projects/${project.id}/boards`, { token: a.token, body: { name: "B" } })).body;
  const col = board.columns[0].id;
  const k1 = (await c.call("POST", `/columns/${col}/cards`, { token: a.token, body: { title: "Engine design", description: "engine" } })).body;
  const k2 = (await c.call("POST", `/columns/${col}/cards`, { token: a.token, body: { title: "Other", description: "eng" } })).body;
  const root = await c.call("POST", `/cards/${k2.id}/comments`, {
    token: a.token,
    body: { body: "hi @BOB_B, @alice and a@bob_b.com @bob_b engineering" },
  });
  assert.deepEqual(root.body.mentions, [b.id]);
  const reply = await c.call("POST", `/cards/${k2.id}/comments`, { token: b.token, body: { body: "ok", parentId: root.body.id } });
  assert.equal(reply.body.parentId, root.body.id);
  const wrongCard = await c.call("POST", `/cards/${k1.id}/comments`, { token: b.token, body: { body: "x", parentId: root.body.id } });
  assert.equal(wrongCard.body.error.code, "invalid_body");
  const tree = (await c.call("GET", `/cards/${k2.id}/comments`, { token: a.token })).body.items;
  assert.equal(tree.length, 1);
  assert.equal(tree[0].replies[0].id, reply.body.id);
  const mentions = (await c.call("GET", "/me/mentions", { token: b.token })).body;
  assert.deepEqual(mentions.items.map((m: Json) => m.commentId), [root.body.id]);
  assert.equal(mentions.nextCursor, null);
  assert.equal((await c.call("PATCH", `/comments/${root.body.id}`, { token: b.token, body: { body: "x" } })).status, 403);

  const s = (await c.call("GET", `/teams/${team.id}/search?q=eng`, { token: a.token })).body;
  // k1: title 1*3 + desc 1 = 4; k2: desc 1 + comment 1 = 2
  assert.deepEqual(s.items.map((x: Json) => x.id), [k1.id, k2.id]);
  assert.equal(s.total, 2);
  const p1 = (await c.call("GET", `/teams/${team.id}/search?limit=1`, { token: a.token })).body;
  assert.equal(p1.items.length, 1);
  const p2 = (await c.call("GET", `/teams/${team.id}/search?limit=1&cursor=${p1.nextCursor}`, { token: a.token })).body;
  assert.equal(p2.items[0].id, k2.id);
  assert.equal(p2.nextCursor, null);
  assert.equal((await c.call("GET", `/teams/${team.id}/search?cursor=bogus`, { token: a.token })).body.error.code, "invalid_query");

  assert.equal((await c.call("DELETE", `/comments/${root.body.id}`, { token: a.token })).status, 204);
  const gone = (await c.call("GET", `/comments/${root.body.id}`, { token: a.token })).body;
  assert.equal(gone.deleted, true);
  assert.equal(gone.body, "");
  assert.equal(gone.replies.length, 1);
  assert.equal((await c.call("GET", "/me/mentions", { token: b.token })).body.items.length, 0);
  const audit = (await c.call("GET", `/teams/${team.id}/audit?limit=2`, { token: a.token })).body;
  assert.deepEqual(audit.items.map((x: Json) => x.action), ["comment.deleted", "comment.created"]);
});

test("webhooks: signed deliveries with retries", async (t) => {
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  let failures = 1;
  const sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (ch) => chunks.push(ch));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.statusCode = failures-- > 0 ? 500 : 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => sink.close(() => resolve())));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;

  const c = await start(t, { webhooks: { retryDelaysMs: [50], timeoutMs: 500 } });
  const a = await user(c, "alice");
  const team = (await c.call("POST", "/teams", { token: a.token, body: { name: "T" } })).body;
  const hook = await c.call("POST", `/teams/${team.id}/webhooks`, {
    token: a.token,
    body: { url: sinkUrl, events: ["card.created", "card.created"] },
  });
  assert.equal(hook.status, 201);
  assert.ok(hook.body.secret.length >= 32);
  assert.deepEqual(hook.body.events, ["card.created"]);
  assert.equal((await c.call("GET", `/webhooks/${hook.body.id}`, { token: a.token })).body.secret, undefined);
  const project = (await c.call("POST", `/teams/${team.id}/projects`, { token: a.token, body: { name: "P", key: "AB" } })).body;
  const board = (await c.call("POST", `/projects/${project.id}/boards`, { token: a.token, body: { name: "B" } })).body;
  const card = (await c.call("POST", `/columns/${board.columns[0].id}/cards`, { token: a.token, body: { title: "x" } })).body;

  let deliveries: Json[] = [];
  for (let i = 0; i < 100; i++) {
    deliveries = (await c.call("GET", `/webhooks/${hook.body.id}/deliveries`, { token: a.token })).body.items;
    if (deliveries[0]?.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "succeeded");
  assert.equal(deliveries[0].attempts, 2);
  assert.equal(deliveries[0].lastStatusCode, 200);
  assert.equal(received.length, 2);
  assert.equal(received[0]!.body, received[1]!.body);
  assert.deepEqual([received[0]!.headers["x-tracker-attempt"], received[1]!.headers["x-tracker-attempt"]], ["1", "2"]);
  const sig = createHmac("sha256", hook.body.secret).update(received[0]!.body).digest("hex");
  assert.equal(received[0]!.headers["x-tracker-signature"], `sha256=${sig}`);
  const payload = JSON.parse(received[0]!.body);
  assert.equal(payload.event, "card.created");
  assert.equal(payload.id, deliveries[0].id);
  assert.deepEqual(payload.data.card, card);
});

test("rate limiting follows the spec example", async (t) => {
  let clock = 1_000_000;
  const c = await start(t, { now: () => clock, rateLimit: { limit: 2, windowMs: 60_000 } });
  const a = await user(c, "alice");
  const r1 = await c.call("GET", "/me", { token: a.token });
  const r2 = await c.call("GET", "/nope-me", { token: a.token });
  assert.equal(r2.headers.get("x-ratelimit-limit"), null);
  const r3 = await c.call("GET", "/me", { token: a.token });
  const r4 = await c.call("GET", "/me", { token: a.token });
  assert.deepEqual([r1.headers.get("x-ratelimit-remaining"), r3.headers.get("x-ratelimit-remaining")], ["1", "0"]);
  assert.equal(r4.status, 429);
  assert.equal(r4.headers.get("retry-after"), "20");
  assert.equal(r4.headers.get("x-ratelimit-reset"), "1020");
  clock = 1_020_000;
  assert.equal((await c.call("GET", "/me", { token: a.token })).status, 200);
});

test("persistence and 1.x migration", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tracker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "data.json");
  copyFileSync(new URL("../fixtures/tracker-v1.json", import.meta.url), file);
  const original = readFileSync(file);
  const c = await start(t, { dataFile: file });
  assert.deepEqual(readFileSync(`${file}.v1.bak`), original);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 2);
  const login = await c.call("POST", "/auth/login", { body: { email: "ada@lovelace.test", password: "difference-engine" } });
  assert.equal(login.status, 200);
  const me = (await c.call("GET", "/me", { token: login.body.token })).body;
  assert.equal(me.handle, "ada_2");
  const cards = (await c.call("GET", "/boards/b1/cards", { token: login.body.token })).body.items;
  assert.deepEqual(
    cards.map((x: Json) => x.key),
    ["ENG-7", "ENG-3", "ENG-1", "ENG-6", "ENG-5", "ENG-4", "ENG-9", "ENG-8"],
  );
  const created = await c.call("POST", `/columns/${cards[0].columnId}/cards`, { token: login.body.token, body: { title: "new" } });
  assert.equal(created.body.key, "ENG-12");

  // a second app on the same file sees the same state, and the token still works
  const c2 = await start(t, { dataFile: file });
  assert.equal((await c2.call("GET", `/cards/${created.body.id}`, { token: login.body.token })).body.key, "ENG-12");
  assert.equal(readFileSync(file, "utf8").includes("difference-engine"), false);

  writeFileSync(join(dir, "bad.json"), JSON.stringify({ version: 3 }));
  assert.throws(() => createApp({ dataFile: join(dir, "bad.json") }), /unsupported data version/);
  writeFileSync(join(dir, "broken.json"), "{");
  assert.throws(() => createApp({ dataFile: join(dir, "broken.json") }));
});

// The six readings instruction.md settles in one sentence each (TDM-211). No hidden test depends on
// them; these tests keep the reference solution on them.

test("an empty query value is present, not absent: checked by the parameter's own rule", async (t) => {
  const c = await start(t);
  const a = await user(c, "alice");
  const team = (await c.call("POST", "/teams", { token: a.token, body: { name: "T" } })).body;
  const project = (await c.call("POST", `/teams/${team.id}/projects`, { token: a.token, body: { name: "P", key: "AB" } })).body;
  const board = (await c.call("POST", `/projects/${project.id}/boards`, { token: a.token, body: { name: "B" } })).body;
  await c.call("POST", `/columns/${board.columns[0].id}/cards`, { token: a.token, body: { title: "one" } });
  for (const path of [
    "/me/mentions?limit=",
    "/me/mentions?cursor=",
    `/teams/${team.id}/projects?archived=`,
    `/teams/${team.id}/search?includeArchived=`,
    `/teams/${team.id}/search?dueFrom=`,
    `/teams/${team.id}/audit?limit=`,
  ]) {
    const r = await c.call("GET", path, { token: a.token });
    assert.equal(r.status, 400, path);
    assert.equal(r.body.error.code, "invalid_query", path);
  }
  const none = (await c.call("GET", `/teams/${team.id}/search?projectId=`, { token: a.token })).body;
  assert.deepEqual([none.items.length, none.total], [0, 0]);
  assert.deepEqual((await c.call("GET", `/teams/${team.id}/audit?action=`, { token: a.token })).body.items, []);
  assert.equal((await c.call("GET", `/teams/${team.id}/search?q=`, { token: a.token })).body.total, 1);
});

test("a cursor belongs to the app that issued it: after a restart it answers 400 invalid_query", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tracker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "data.json");
  const c1 = await start(t, { dataFile: file });
  const a = await user(c1, "alice");
  const team = (await c1.call("POST", "/teams", { token: a.token, body: { name: "T" } })).body;
  await c1.call("PATCH", `/teams/${team.id}`, { token: a.token, body: { name: "T2" } });
  const first = (await c1.call("GET", `/teams/${team.id}/audit?limit=1`, { token: a.token })).body;
  assert.equal(typeof first.nextCursor, "string");
  const page = `/teams/${team.id}/audit?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`;
  assert.equal((await c1.call("GET", page, { token: a.token })).status, 200);
  const c2 = await start(t, { dataFile: file });
  const r = await c2.call("GET", page, { token: a.token });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "invalid_query");
});

test("deleting a project frees its key", async (t) => {
  const c = await start(t);
  const a = await user(c, "alice");
  const team = (await c.call("POST", "/teams", { token: a.token, body: { name: "T" } })).body;
  const p1 = (await c.call("POST", `/teams/${team.id}/projects`, { token: a.token, body: { name: "P", key: "ENG" } })).body;
  assert.equal((await c.call("DELETE", `/projects/${p1.id}`, { token: a.token })).status, 204);
  const p2 = await c.call("POST", `/teams/${team.id}/projects`, { token: a.token, body: { name: "P again", key: "ENG" } });
  assert.equal(p2.status, 201);
  assert.notEqual(p2.body.id, p1.id);
});

test("createApp does not create a missing data file; the first state-changing request does", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tracker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "nested", "data.json");
  const c = await start(t, { dataFile: file });
  assert.equal((await c.call("GET", "/health")).status, 200);
  assert.equal(existsSync(file), false);
  await user(c, "alice");
  assert.equal(existsSync(file), true);
});

test("a webhook attempt is answered when the status arrives, not after the body", async (t) => {
  const sink = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial body, never finished");
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    sink.closeAllConnections();
    return new Promise<void>((resolve) => sink.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
  const c = await start(t, { webhooks: { retryDelaysMs: [50], timeoutMs: 300 } });
  const a = await user(c, "alice");
  const team = (await c.call("POST", "/teams", { token: a.token, body: { name: "T" } })).body;
  const hook = (await c.call("POST", `/teams/${team.id}/webhooks`, { token: a.token, body: { url, events: ["*"] } })).body;
  const { deliveryId } = (await c.call("POST", `/webhooks/${hook.id}/test`, { token: a.token })).body;
  let d: Json;
  for (let i = 0; i < 100; i++) {
    d = (await c.call("GET", `/webhooks/${hook.id}/deliveries`, { token: a.token })).body.items[0];
    if (d.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  // Wait past the timeout: a late body (or none) never turns a 2xx into a failure.
  await new Promise((r) => setTimeout(r, 400));
  d = (await c.call("GET", `/webhooks/${hook.id}/deliveries`, { token: a.token })).body.items[0];
  assert.deepEqual([d.id, d.status, d.attempts, d.lastStatusCode, d.lastError], [deliveryId, "succeeded", 1, 200, null]);
});

test("leaving a team keeps comments' mentions, so a rejoining user sees them again", async (t) => {
  const c = await start(t);
  const a = await user(c, "alice");
  const b = await user(c, "bob_b");
  const team = (await c.call("POST", "/teams", { token: a.token, body: { name: "T" } })).body;
  const add = { email: "bob_b@example.com", role: "member" };
  await c.call("POST", `/teams/${team.id}/members`, { token: a.token, body: add });
  const project = (await c.call("POST", `/teams/${team.id}/projects`, { token: a.token, body: { name: "P", key: "AB" } })).body;
  const board = (await c.call("POST", `/projects/${project.id}/boards`, { token: a.token, body: { name: "B" } })).body;
  const card = (await c.call("POST", `/columns/${board.columns[0].id}/cards`, { token: a.token, body: { title: "x" } })).body;
  const comment = (await c.call("POST", `/cards/${card.id}/comments`, { token: a.token, body: { body: "hey @bob_b" } })).body;
  const mentioned = async () => (await c.call("GET", "/me/mentions", { token: b.token })).body.items.map((m: Json) => m.commentId);
  assert.deepEqual(await mentioned(), [comment.id]);
  assert.equal((await c.call("DELETE", `/teams/${team.id}/members/${b.id}`, { token: b.token })).status, 204);
  assert.deepEqual(await mentioned(), []);
  assert.deepEqual((await c.call("GET", `/comments/${comment.id}`, { token: a.token })).body.mentions, [b.id]);
  await c.call("POST", `/teams/${team.id}/members`, { token: a.token, body: add });
  assert.deepEqual(await mentioned(), [comment.id]);
});
