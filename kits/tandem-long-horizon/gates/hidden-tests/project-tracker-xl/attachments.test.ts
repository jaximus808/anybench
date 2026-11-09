// Area `attachments`: instruction.md section 24 (Attachments), with the storage quota of section 13
// and the body rules of section 0.1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Api,
  assertError,
  assertQuota,
  assertStatus,
  auditLog,
  Clock,
  createApiKey,
  createBoard,
  createCard,
  createProject,
  eventLog,
  ok,
  setupBoard,
  tempDir,
  upload,
} from "./helpers.ts";
import { archive, assertKeys, feed, startApp } from "./helpers-pipeline.ts";

const MiB = 1_048_576;
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed = 1): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};
const storage = async (api: Api, teamId: string, token: string): Promise<number> => (await ok(api, 200, "GET", `/teams/${teamId}/plan`, undefined, token)).usage.storageBytes;
const content = (api: Api, id: string, token: string, headers: Record<string, string> = {}) => fetch(`${api.base}/attachments/${id}/content`, { headers: { authorization: `Bearer ${token}`, ...headers } });

test("an upload answers the attachment: trimmed filename, content type from the header up to ';', size, sha256, uploader and timestamps", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  clock.advance(5000);
  const res = await upload(api, card.id, w.member.token, "hello world", "  notes.txt  ", " Text/Plain ; charset=utf-8");
  assertStatus(res, 201);
  const a = res.body;
  assertKeys(a, ["id", "cardId", "filename", "contentType", "size", "sha256", "uploadedBy", "createdAt", "updatedAt"], "attachment");
  assert.deepEqual(
    [a.cardId, a.filename, a.contentType, a.size, a.sha256, a.uploadedBy, a.createdAt, a.updatedAt],
    [card.id, "notes.txt", "text/plain", 11, sha("hello world"), w.member.id, clock.iso(), clock.iso()],
  );
  assert.deepEqual(await ok(api, 200, "GET", `/attachments/${a.id}`, undefined, w.viewer.token), a);
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${card.id}/attachments`, undefined, w.viewer.token)).items, [a]);
});

test("the content type is application/octet-stream when the header is absent or empty before ';', otherwise lowercased", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const none = await api.call("POST", `/cards/${card.id}/attachments?filename=raw.bin`, undefined, w.member.token, { raw: bytes(10), noContentType: true });
  assertStatus(none, 201);
  assert.equal(none.body.contentType, "application/octet-stream");
  const empty = await upload(api, card.id, w.member.token, bytes(10, 2), "e.bin", " ; charset=x");
  assert.equal(empty.body.contentType, "application/octet-stream");
  const svg = await upload(api, card.id, w.member.token, "<svg/>", "i.svg", "IMAGE/SVG+XML");
  assert.equal(svg.body.contentType, "image/svg+xml");
  const json = await upload(api, card.id, w.member.token, '{"a":1}', "data.json", "application/json");
  assert.equal(json.body.contentType, "application/json");
});

test("filename is trimmed, 1 to 255 chars, without / or \\ or control characters, else 400 invalid_query, checked before the body", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const post = (q: string, raw: Uint8Array = bytes(4)) => api.call("POST", `/cards/${card.id}/attachments${q}`, undefined, w.member.token, { raw, headers: { "content-type": "application/octet-stream" } });
  for (const q of ["", "?filename=", "?filename=%20%20", `?filename=${"f".repeat(256)}`, "?filename=a%2Fb", "?filename=a%5Cb", "?filename=a%01b", "?filename=tab%09name"]) {
    assertError(await post(q), 400, "invalid_query", q);
  }
  assertError(await post("?filename=", new Uint8Array(0)), 400, "invalid_query", "the filename comes before the empty body");
  const long = await post(`?filename=${"f".repeat(255)}`);
  assertStatus(long, 201);
  const accents = await post(`?filename=${encodeURIComponent(" résumé (final).pdf ")}`);
  assert.equal(accents.body.filename, "résumé (final).pdf");
  assert.equal((await ok(api, 200, "GET", `/cards/${card.id}/attachments`, undefined, w.member.token)).items.length, 2);
});

test("an empty upload is 400 invalid_body; the bytes are never parsed as JSON", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assertError(await upload(api, card.id, w.member.token, new Uint8Array(0), "empty.txt"), 400, "invalid_body");
  for (const text of ["{not json", "[1,2]", '"string"', "   "]) {
    const res = await upload(api, card.id, w.member.token, text, "x.txt", "application/json");
    assertStatus(res, 201, JSON.stringify(text));
    assert.equal(res.body.size, Buffer.byteLength(text));
  }
});

test("uploads take up to 1 MiB: exactly 1048576 bytes is accepted, one more is 413 body_too_large before the path and the role are checked", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const big = bytes(MiB + 1);
  assertError(await upload(api, card.id, w.member.token, big, "big.bin"), 413, "body_too_large");
  assertError(await upload(api, "no-such-card", w.member.token, big, "big.bin"), 413, "body_too_large", "step 4 before step 5");
  assertError(await upload(api, card.id, w.viewer.token, big, "big.bin"), 413, "body_too_large", "step 4 before step 6");
  assertError(await upload(api, card.id, w.member.token, big, ""), 413, "body_too_large", "step 4 before the filename");
  const exact = await upload(api, card.id, w.member.token, bytes(MiB), "exact.bin");
  assertStatus(exact, 201);
  assert.equal(exact.body.size, MiB);
  assert.equal(await storage(api, w.team.id, w.owner.token), MiB);
});

test("GET content answers the exact bytes with content-type, content-length and the quoted sha256 as etag", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const all = new Uint8Array(512);
  for (let i = 0; i < 512; i++) all[i] = i & 0xff;
  const a = (await upload(api, card.id, w.member.token, all, "all.bin", "Application/X-Custom; v=1")).body;
  const res = await content(api, a.id, w.viewer.token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/x-custom");
  assert.equal(res.headers.get("content-length"), "512");
  assert.equal(res.headers.get("etag"), `"${sha(all)}"`);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), all);
});

test("If-None-Match equal to the etag or * answers 304 with the etag and no body; anything else gets the bytes", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = (await upload(api, card.id, w.member.token, "cache me", "c.txt", "text/plain")).body;
  const etag = `"${a.sha256}"`;
  for (const inm of [etag, "*"]) {
    const res = await content(api, a.id, w.member.token, { "if-none-match": inm });
    assert.equal(res.status, 304, inm);
    assert.equal(res.headers.get("etag"), etag);
    assert.equal(await res.text(), "");
  }
  for (const inm of [`"${"0".repeat(64)}"`, a.sha256, `W/${etag}`]) {
    const res = await content(api, a.id, w.member.token, { "if-none-match": inm });
    assert.equal(res.status, 200, inm);
    assert.equal(await res.text(), "cache me");
  }
});

test("attachments list oldest first; viewers read and download, get 403 on writes; non-members and unknown ids get 404", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = (await upload(api, card.id, w.member.token, "a", "a.txt")).body;
  clock.advance(1000);
  const b = (await upload(api, card.id, w.admin.token, "b", "b.txt")).body;
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${card.id}/attachments`, undefined, w.viewer.token)).items.map((x: any) => x.id), [a.id, b.id]);
  assert.equal((await content(api, a.id, w.viewer.token)).status, 200);
  assertError(await upload(api, card.id, w.viewer.token, "v", "v.txt"), 403, "forbidden");
  assertError(await api.call("PATCH", `/attachments/${a.id}`, { filename: "x" }, w.viewer.token), 403, "forbidden");
  assertError(await api.call("DELETE", `/attachments/${a.id}`, undefined, w.viewer.token), 403, "forbidden");
  for (const [m, p] of [["GET", `/attachments/${a.id}`], ["GET", `/attachments/${a.id}/content`], ["GET", `/cards/${card.id}/attachments`], ["DELETE", `/attachments/${a.id}`]] as const) {
    assertError(await api.call(m, p, undefined, w.outsider.token), 404, "not_found", `${m} ${p}`);
  }
  assertError(await api.call("GET", "/attachments/no-such-attachment", undefined, w.owner.token), 404, "not_found");
  const cnt = await api.call("GET", "/attachments/no-such-attachment/content", undefined, w.owner.token);
  assertError(cnt, 404, "not_found");
  assert.match(cnt.headers.get("content-type") ?? "", /^application\/json/, "errors are JSON");
});

test("storageBytes counts distinct sha256 values: known bytes upload whatever the usage, new bytes past the limit are quota_exceeded", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1" });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "c2" });
  const A = bytes(600 * 1024, 1);
  await upload(api, c1.id, w.member.token, A, "a.bin");
  assertQuota(await upload(api, c1.id, w.member.token, bytes(600 * 1024, 2), "b.bin"), "storageBytes", MiB, 600 * 1024);
  assertStatus(await upload(api, c2.id, w.member.token, A, "a-again.bin"), 201, "the same bytes on another card add nothing");
  assert.equal(await storage(api, w.team.id, w.owner.token), 600 * 1024);
  assertStatus(await upload(api, c2.id, w.member.token, bytes(MiB - 600 * 1024, 3), "fill.bin"), 201);
  assert.equal(await storage(api, w.team.id, w.owner.token), MiB);
  assertStatus(await upload(api, c1.id, w.member.token, A, "a-third.bin"), 201, "known bytes pass even at the limit");
  assertQuota(await upload(api, c1.id, w.member.token, new Uint8Array([7]), "one.bin"), "storageBytes", MiB, MiB);
  assertError(await upload(api, c1.id, w.member.token, new Uint8Array(0), "one.bin"), 400, "invalid_body", "validation before the quota");
});

test("deleting an attachment frees its bytes only when no other attachment of the team has the same sha256", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1" });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "c2" });
  const x = (await upload(api, c1.id, w.member.token, bytes(1000, 9), "x1")).body;
  const y = (await upload(api, c2.id, w.member.token, bytes(1000, 9), "x2")).body;
  const z = (await upload(api, c2.id, w.member.token, bytes(300, 5), "z")).body;
  assert.equal(x.sha256, y.sha256);
  assert.equal(await storage(api, w.team.id, w.owner.token), 1300);
  assertStatus(await api.call("DELETE", `/attachments/${x.id}`, undefined, w.member.token), 204);
  assert.equal(await storage(api, w.team.id, w.owner.token), 1300, "y still stores those bytes");
  await ok(api, 204, "DELETE", `/attachments/${y.id}`, undefined, w.member.token);
  assert.equal(await storage(api, w.team.id, w.owner.token), 300);
  assertError(await api.call("GET", `/attachments/${y.id}`, undefined, w.member.token), 404, "not_found");
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${c2.id}/attachments`, undefined, w.member.token)).items.map((a: any) => a.id), [z.id]);
});

test("deleting a card or a project deletes its attachments and frees their bytes", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = (await upload(api, card.id, w.member.token, bytes(2000), "a")).body;
  await ok(api, 204, "DELETE", `/cards/${card.id}`, undefined, w.member.token);
  assertError(await api.call("GET", `/attachments/${a.id}`, undefined, w.member.token), 404, "not_found");
  assertError(await api.call("GET", `/attachments/${a.id}/content`, undefined, w.member.token), 404, "not_found");
  assert.equal(await storage(api, w.team.id, w.owner.token), 0);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const ob = await createBoard(api, ops.id, w.owner);
  const oc = await createCard(api, ob.columns[0].id, w.member, { title: "o" });
  await upload(api, oc.id, w.member.token, bytes(5000, 4), "o");
  assert.equal(await storage(api, w.team.id, w.owner.token), 5000);
  await ok(api, 204, "DELETE", `/projects/${ops.id}`, undefined, w.owner.token);
  assert.equal(await storage(api, w.team.id, w.owner.token), 0);
});

test("PATCH renames an attachment by the upload's filename rule (400 invalid_body here), moving updatedAt; it is audited with its fields", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = (await upload(api, card.id, w.member.token, "x", "old.txt")).body;
  clock.advance(60_000);
  const p = await ok(api, 200, "PATCH", `/attachments/${a.id}`, { filename: "  new name.txt  " }, w.admin.token);
  assert.deepEqual([p.filename, p.updatedAt, p.createdAt, p.uploadedBy, p.sha256], ["new name.txt", clock.iso(), a.createdAt, w.member.id, a.sha256]);
  for (const filename of ["", "  ", "a/b", "a\\b", "x".repeat(256), "a\u0007", 5, null]) {
    assertError(await api.call("PATCH", `/attachments/${a.id}`, { filename }, w.member.token), 400, "invalid_body", JSON.stringify(filename));
  }
  assertError(await api.call("PATCH", `/attachments/${a.id}`, {}, w.member.token), 400, "invalid_body", "empty PATCH");
  const entry = (await auditLog(api, w.admin.token, w.team.id)).at(-1);
  assert.deepEqual([entry.action, entry.targetType, entry.targetId, entry.actorId, entry.details], ["attachment.updated", "attachment", a.id, w.admin.id, { fields: ["filename"] }]);
});

test("an upload emits attachment.added with the attachment and is audited with { sha256, size }; rename and delete emit nothing", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(1000);
  const a = (await upload(api, card.id, w.member.token, "payload", "p.txt", "text/plain")).body;
  await ok(api, 200, "PATCH", `/attachments/${a.id}`, { filename: "q.txt" }, w.member.token);
  await ok(api, 204, "DELETE", `/attachments/${a.id}`, undefined, w.member.token);
  assert.deepEqual(await log.names(), ["attachment.added"]);
  const [ev] = await log.events(1);
  assert.deepEqual([ev.actorId, ev.via, ev.occurredAt, ev.data], [w.member.id, null, clock.iso(), { attachment: a }]);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetId, e.details]), [
    ["attachment.added", a.id, { sha256: sha("payload"), size: 7 }],
    ["attachment.updated", a.id, { fields: ["filename"] }],
    ["attachment.deleted", a.id, {}],
  ]);
});

test("attachment writes on an archived card are card_archived and in an archived project project_archived, first; downloads still work", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = (await upload(api, card.id, w.member.token, "keep", "k.txt")).body;
  await archive(api, card.id, w.member);
  assertError(await upload(api, card.id, w.member.token, "new", "n.txt"), 409, "card_archived");
  assertError(await api.call("PATCH", `/attachments/${a.id}`, { filename: "x" }, w.member.token), 409, "card_archived");
  assertError(await api.call("DELETE", `/attachments/${a.id}`, undefined, w.member.token), 409, "card_archived");
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await upload(api, card.id, w.member.token, "new", "n.txt"), 409, "project_archived");
  assertError(await api.call("DELETE", `/attachments/${a.id}`, undefined, w.member.token), 409, "project_archived");
  assertError(await upload(api, card.id, w.member.token, "new", "a/b"), 400, "invalid_query", "validation before the 409s");
  const res = await content(api, a.id, w.viewer.token);
  assert.equal(await res.text(), "keep");
});

test("an upload with an Idempotency-Key is replayed for the same bytes on the same path, whatever the query, and conflicts for other bytes", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const first = await upload(api, card.id, w.member.token, "same bytes", "one.txt", "text/plain", { idem: "up-1" });
  assertStatus(first, 201);
  const again = await upload(api, card.id, w.member.token, "same bytes", "two.txt", "text/plain", { idem: "up-1" });
  assert.equal(again.status, 201);
  assert.equal(again.text, first.text, "the path for idempotency has no query string");
  assert.equal(again.headers.get("idempotency-replayed"), "true");
  assertError(await upload(api, card.id, w.member.token, "other bytes", "one.txt", "text/plain", { idem: "up-1" }), 409, "idempotency_conflict");
  assert.equal((await ok(api, 200, "GET", `/cards/${card.id}/attachments`, undefined, w.member.token)).items.length, 1);
});

test("API keys: a read key downloads but gets 403 insufficient_scope on uploads even for an unknown card; a write key uploads as its owner", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = (await upload(api, card.id, w.member.token, "doc", "d.txt")).body;
  const readKey = (await createApiKey(api, w.member, { scope: "read" })).secret;
  const writeKey = (await createApiKey(api, w.member, { scope: "write" })).secret;
  assert.equal(await (await content(api, a.id, readKey)).text(), "doc");
  assertError(await upload(api, card.id, readKey, "x", "x.txt"), 403, "insufficient_scope");
  assertError(await upload(api, "no-such-card", readKey, "x", "x.txt"), 403, "insufficient_scope", "3a before step 5");
  const res = await upload(api, card.id, writeKey, "y", "y.txt");
  assertStatus(res, 201);
  assert.equal(res.body.uploadedBy, w.member.id);
});

test("storage is counted per team: the same bytes in another team count there too", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await setupBoard(api);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c" });
  const c2 = await createCard(api, other.cols[0], other.member, { title: "d" });
  await upload(api, c1.id, w.member.token, bytes(4096, 6), "a");
  await upload(api, c2.id, other.member.token, bytes(4096, 6), "a");
  await upload(api, c2.id, other.member.token, bytes(100, 7), "b");
  assert.equal(await storage(api, w.team.id, w.owner.token), 4096);
  assert.equal(await storage(api, other.team.id, other.owner.token), 4196);
});

test("an attachment's card and team scope its routes: an attachment of another card is still reachable by id but only inside its team", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = (await upload(api, card.id, w.member.token, "mine", "m.txt")).body;
  assertError(await api.call("GET", `/attachments/${a.id}`, undefined, other.owner.token), 404, "not_found");
  assertError(await api.call("PATCH", `/attachments/${a.id}`, { filename: "x" }, other.owner.token), 404, "not_found");
  const card2 = await createCard(api, w.cols[1], w.member, { title: "d" });
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${card2.id}/attachments`, undefined, w.member.token)).items, []);
  assert.equal((await ok(api, 200, "GET", `/attachments/${a.id}`, undefined, w.viewer.token)).cardId, card.id);
});

test("a large binary upload round-trips byte for byte", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const data = bytes(700_000, 11);
  const a = (await upload(api, card.id, w.member.token, data, "blob.bin", "application/octet-stream")).body;
  assert.deepEqual([a.size, a.sha256], [700_000, sha(data)]);
  const res = await content(api, a.id, w.member.token);
  assert.equal(res.headers.get("content-length"), "700000");
  const got = new Uint8Array(await res.arrayBuffer());
  assert.equal(sha(got), sha(data));
});

test("attachments and their bytes survive a restart", async (t) => {
  const dataFile = join(tempDir(t), "tracker.json");
  const api1 = await startApp(t, { dataFile });
  const w = await setupBoard(api1);
  const card = await createCard(api1, w.cols[0], w.member, { title: "c" });
  const data = bytes(3000, 13);
  const a = (await upload(api1, card.id, w.member.token, data, "keep.bin", "application/x-keep")).body;
  await api1.close();
  const api2 = await startApp(t, { dataFile });
  assert.deepEqual(await ok(api2, 200, "GET", `/attachments/${a.id}`, undefined, w.member.token), a);
  const res = await content(api2, a.id, w.member.token);
  assert.equal(res.headers.get("content-type"), "application/x-keep");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), data);
  assert.equal(await storage(api2, w.team.id, w.owner.token), 3000);
});

test("attachment.added reaches the activity feeds of its card and project", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = (await upload(api, card.id, w.member.token, "act", "a.txt")).body;
  const cardFeed = await feed(api, w.viewer.token, `/cards/${card.id}/activity`);
  const last = cardFeed.at(-1);
  assert.deepEqual([last.event, last.cardId, last.projectId, last.actorId, last.data], ["attachment.added", card.id, w.project.id, w.member.id, { attachment: a }]);
  const projectFeed = await feed(api, w.viewer.token, `/projects/${w.project.id}/activity`);
  assert.equal(projectFeed.at(-1).event, "attachment.added");
});

test("uploads use the 1 MiB limit only on their own route: a JSON route still rejects bodies over 64 KiB", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const text = "x".repeat(70_000);
  assertStatus(await upload(api, card.id, w.member.token, text, "big.txt", "text/plain"), 201);
  assertError(await api.call("POST", `/cards/${card.id}/comments`, { body: text }, w.member.token), 413, "body_too_large");
});
