// Area `projects`: instruction.md section 3 (Projects), including the archived read-only rule.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, assertStatus, Clock, createCard, createProject, ok, setupBoard, setupTeam, startApp } from "./helpers.ts";

test("POST project answers the project shape with archived false and description defaulting to empty", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  clock.advance(1000);
  const res = await api.call("POST", `/teams/${w.team.id}/projects`, { name: "  Engine  ", key: "ENG" }, w.admin.token);
  assertStatus(res, 201);
  assert.equal(typeof res.body.id, "string");
  assert.equal(res.body.teamId, w.team.id);
  assert.equal(res.body.name, "Engine");
  assert.equal(res.body.key, "ENG");
  assert.equal(res.body.description, "");
  assert.equal(res.body.archived, false);
  assert.equal(res.body.createdAt, clock.iso());
  assert.equal(res.body.updatedAt, clock.iso());
  const withDesc = await createProject(api, w.team.id, w.owner, "OPS", { description: "d".repeat(2000) });
  assert.equal(withDesc.description.length, 2000);
  assert.deepEqual(await ok(api, 200, "GET", `/projects/${res.body.id}`, undefined, w.viewer.token), res.body);
  assertError(await api.call("POST", `/teams/${w.team.id}/projects`, { name: "P", key: "MEM" }, w.member.token), 403, "forbidden", "member");
  assertError(await api.call("POST", `/teams/${w.team.id}/projects`, { name: "P", key: "VIE" }, w.viewer.token), 403, "forbidden", "viewer");
  assertError(await api.call("POST", `/teams/${w.team.id}/projects`, { name: " ", key: "XYZ" }, w.owner.token), 400, "invalid_body", "blank name");
  assertError(await api.call("POST", `/teams/${w.team.id}/projects`, { name: "P", key: "XYZ", description: "d".repeat(2001) }, w.owner.token), 400, "invalid_body", "long description");
  assertError(await api.call("GET", `/projects/${res.body.id}`, undefined, w.outsider.token), 404, "not_found", "outsider");
  assertError(await api.call("GET", "/projects/nope", undefined, w.owner.token), 404, "not_found");
});

test("a key must match ^[A-Z][A-Z0-9]{1,5}$ exactly", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/projects`;
  for (const key of ["A", "eng", "Eng", "1AB", "ABCDEFG", "AB-C", "AB C", " ENG", "", 12]) {
    assertError(await api.call("POST", path, { name: "P", key }, w.owner.token), 400, "invalid_body", `key ${JSON.stringify(key)}`);
  }
  assertError(await api.call("POST", path, { name: "P" }, w.owner.token), 400, "invalid_body", "missing key");
  for (const key of ["A1", "AB", "ABCDE6", "Z99999"]) {
    const res = await api.call("POST", path, { name: "P", key }, w.owner.token);
    assertStatus(res, 201, `key ${key}`);
    assert.equal(res.body.key, key);
  }
});

test("keys are unique within a team, archived projects included; another team may reuse a key", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const first = await createProject(api, w.team.id, w.owner, "ENG");
  assertError(await api.call("POST", `/teams/${w.team.id}/projects`, { name: "Again", key: "ENG" }, w.owner.token), 409, "key_taken");
  await ok(api, 200, "PATCH", `/projects/${first.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", `/teams/${w.team.id}/projects`, { name: "Again", key: "ENG" }, w.owner.token), 409, "key_taken", "archived holder");
  // Validation (step 7) comes before key_taken (step 8).
  assertError(await api.call("POST", `/teams/${w.team.id}/projects`, { name: "", key: "ENG" }, w.owner.token), 400, "invalid_body");
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.outsider.token);
  const reuse = await api.call("POST", `/teams/${other.id}/projects`, { name: "Theirs", key: "ENG" }, w.outsider.token);
  assertStatus(reuse, 201, "same key in another team");
  assert.equal(reuse.body.teamId, other.id);
});

test("PATCH updates name, description and archived and moves updatedAt; a key in the body is 400", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  const p = await createProject(api, w.team.id, w.owner, "ENG", { description: "old" });
  clock.advance(7000);
  const res = await api.call("PATCH", `/projects/${p.id}`, { name: " Renamed ", description: "new", unknownField: 1 }, w.admin.token);
  assertStatus(res, 200);
  assert.equal(res.body.name, "Renamed");
  assert.equal(res.body.description, "new");
  assert.equal(res.body.key, "ENG");
  assert.equal(res.body.createdAt, p.createdAt);
  assert.equal(res.body.updatedAt, clock.iso());
  clock.advance(1000);
  const archived = await ok(api, 200, "PATCH", `/projects/${p.id}`, { archived: true }, w.owner.token);
  assert.equal(archived.archived, true);
  assert.equal(archived.updatedAt, clock.iso());
  assertError(await api.call("PATCH", `/projects/${p.id}`, { key: "NEW" }, w.owner.token), 400, "invalid_body", "key alone");
  assertError(await api.call("PATCH", `/projects/${p.id}`, { name: "x", key: "ENG" }, w.owner.token), 400, "invalid_body", "key with other fields");
  assertError(await api.call("PATCH", `/projects/${p.id}`, {}, w.owner.token), 400, "invalid_body", "empty");
  assertError(await api.call("PATCH", `/projects/${p.id}`, { archived: "yes" }, w.owner.token), 400, "invalid_body", "archived not boolean");
  assertError(await api.call("PATCH", `/projects/${p.id}`, { description: 5 }, w.owner.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/projects/${p.id}`, { name: "x" }, w.member.token), 403, "forbidden", "member");
  const now = await ok(api, 200, "GET", `/projects/${p.id}`, undefined, w.viewer.token);
  assert.equal(now.name, "Renamed");
  assert.equal(now.updatedAt, archived.updatedAt, "failed PATCHes change nothing");
});

test("GET projects filters by ?archived=false|true|all (default false), oldest first; other values are 400 invalid_query", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  const ids: string[] = [];
  for (const key of ["AAA", "BBB", "CCC", "DDD"]) {
    clock.advance(1000);
    ids.push((await createProject(api, w.team.id, w.owner, key)).id);
  }
  await ok(api, 200, "PATCH", `/projects/${ids[1]}`, { archived: true }, w.owner.token);
  await ok(api, 200, "PATCH", `/projects/${ids[3]}`, { archived: true }, w.owner.token);
  const list = async (q: string) => (await ok(api, 200, "GET", `/teams/${w.team.id}/projects${q}`, undefined, w.viewer.token)).items.map((p: any) => p.id);
  assert.deepEqual(await list(""), [ids[0], ids[2]]);
  assert.deepEqual(await list("?archived=false"), [ids[0], ids[2]]);
  assert.deepEqual(await list("?archived=true"), [ids[1], ids[3]]);
  assert.deepEqual(await list("?archived=all"), ids);
  assert.deepEqual(await list("?archived=all&other=ignored"), ids);
  for (const q of ["yes", "TRUE", "1"]) {
    assertError(await api.call("GET", `/teams/${w.team.id}/projects?archived=${q}`, undefined, w.owner.token), 400, "invalid_query", q);
  }
});

test("an archived project answers 409 project_archived on board, column and card writes; reads still work", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "frozen" });
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.admin.token);
  const writes: [string, string, unknown?][] = [
    ["POST", `/projects/${w.project.id}/boards`, { name: "New" }],
    ["PATCH", `/boards/${w.board.id}`, { name: "New name" }],
    ["DELETE", `/boards/${w.board.id}`],
    ["POST", `/boards/${w.board.id}/columns`, { name: "Extra" }],
    ["PATCH", `/columns/${w.cols[2]}`, { name: "Finished" }],
    ["DELETE", `/columns/${w.cols[2]}`],
    ["POST", `/columns/${w.cols[0]}/cards`, { title: "new" }],
    ["PATCH", `/cards/${card.id}`, { title: "changed" }],
    ["POST", `/cards/${card.id}/move`, { columnId: w.cols[1] }],
    ["DELETE", `/cards/${card.id}`],
  ];
  for (const [method, path, body] of writes) assertError(await api.call(method, path, body, w.owner.token), 409, "project_archived", `${method} ${path}`);
  assert.equal((await ok(api, 200, "GET", `/boards/${w.board.id}`, undefined, w.viewer.token)).columns.length, 3);
  const still = await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.viewer.token);
  assert.equal(still.title, "frozen");
  assert.equal(still.columnId, w.cols[0]);
  assert.equal((await ok(api, 200, "GET", `/projects/${w.project.id}/boards`, undefined, w.viewer.token)).items.length, 1);
});

test("an archived project rejects comment writes; renaming and unarchiving it still work and restore writes", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const comment = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "hello" }, w.member.token);
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", `/cards/${card.id}/comments`, { body: "more" }, w.member.token), 409, "project_archived", "new comment");
  assertError(await api.call("PATCH", `/comments/${comment.id}`, { body: "edit" }, w.member.token), 409, "project_archived", "edit");
  assertError(await api.call("DELETE", `/comments/${comment.id}`, undefined, w.member.token), 409, "project_archived", "delete");
  const renamed = await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { name: "Still archived" }, w.owner.token);
  assert.equal(renamed.archived, true);
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: false }, w.owner.token);
  assertStatus(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "thawed" }, w.member.token), 201, "card after unarchive");
  assertStatus(await api.call("PATCH", `/comments/${comment.id}`, { body: "edit" }, w.member.token), 200, "comment after unarchive");
});

test("project_archived is checked after visibility, role and validation (steps 5-8)", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await ok(api, 200, "PATCH", `/columns/${w.cols[0]}`, { wipLimit: 1 }, w.owner.token);
  await createCard(api, w.cols[0], w.member, { title: "fills the column" });
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  const col = `/columns/${w.cols[0]}/cards`;
  assertError(await api.call("POST", col, { title: "x" }, w.outsider.token), 404, "not_found", "outsider");
  assertError(await api.call("POST", col, { title: "x" }, w.viewer.token), 403, "forbidden", "viewer");
  assertError(await api.call("POST", col, { title: "" }, w.member.token), 400, "invalid_body", "invalid title");
  assertError(await api.call("POST", col, { title: "x", assigneeId: w.viewer.id }, w.member.token), 400, "invalid_assignee", "viewer assignee");
  assertError(await api.call("POST", col, { title: "x" }, w.member.token), 409, "project_archived", "before wip_limit_reached");
  assertError(await api.call("POST", `/projects/${w.project.id}/boards`, { name: "B" }, w.member.token), 403, "forbidden", "member board");
  assertError(await api.call("POST", `/projects/${w.project.id}/boards`, { name: "" }, w.admin.token), 400, "invalid_body", "invalid board");
});

test("DELETE project removes its boards, cards and comments; members cannot delete", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[1], w.member, { title: "gone" });
  const comment = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "gone too" }, w.member.token);
  const keep = await createProject(api, w.team.id, w.owner, "KEEP");
  assertError(await api.call("DELETE", `/projects/${w.project.id}`, undefined, w.member.token), 403, "forbidden");
  const res = await api.call("DELETE", `/projects/${w.project.id}`, undefined, w.admin.token);
  assertStatus(res, 204);
  assert.equal(res.text, "");
  assertError(await api.call("GET", `/projects/${w.project.id}`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/boards/${w.board.id}`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/cards/${card.id}`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", `/comments/${comment.id}`, undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("DELETE", `/projects/${w.project.id}`, undefined, w.admin.token), 404, "not_found", "twice");
  const list = await ok(api, 200, "GET", `/teams/${w.team.id}/projects?archived=all`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((p: any) => p.id), [keep.id]);
});
