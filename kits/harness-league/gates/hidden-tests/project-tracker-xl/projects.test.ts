// Area `projects`: instruction.md section 3 (Projects), including the archived read-only rule and
// the delete cascade, with the check order of section 0.3 and the quotas of section 13.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertError,
  assertQuota,
  assertStatus,
  Clock,
  createBoard,
  createCard,
  createProject,
  createRule,
  ok,
  setupBoard,
  setupTeam,
  startApp,
  upload,
} from "./helpers.ts";

test("POST project answers the project shape with archived false and description defaulting to empty", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  clock.advance(1000);
  const res = await api.call("POST", `/teams/${w.team.id}/projects`, { name: "  Engine  ", key: "ENG" }, w.admin.token);
  assertStatus(res, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ["archived", "createdAt", "description", "id", "key", "name", "teamId", "updatedAt"]);
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
  const api = await startApp(t, { defaultPlan: "business" });
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/projects`;
  for (const key of ["A", "eng", "Eng", "1AB", "ABCDEFG", "AB-C", "AB C", " ENG", "", 12, null]) {
    assertError(await api.call("POST", path, { name: "P", key }, w.owner.token), 400, "invalid_body", `key ${JSON.stringify(key)}`);
  }
  assertError(await api.call("POST", path, { name: "P" }, w.owner.token), 400, "invalid_body", "missing key");
  for (const key of ["A1", "AB", "ABCDE6", "Z99999"]) {
    const res = await api.call("POST", path, { name: "P", key }, w.owner.token);
    assertStatus(res, 201, `key ${key}`);
    assert.equal(res.body.key, key);
  }
});

test("keys are unique within a team (archived included) and freed by delete; the projects quota comes after key_taken", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/projects`;
  const first = await createProject(api, w.team.id, w.owner, "ENG");
  assertError(await api.call("POST", path, { name: "Again", key: "ENG" }, w.owner.token), 409, "key_taken");
  await ok(api, 200, "PATCH", `/projects/${first.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", path, { name: "Again", key: "ENG" }, w.owner.token), 409, "key_taken", "archived holder");
  // Validation (step 7) comes before key_taken (step 8).
  assertError(await api.call("POST", path, { name: "", key: "ENG" }, w.owner.token), 400, "invalid_body");
  const second = await createProject(api, w.team.id, w.owner, "OPS");
  await createProject(api, w.team.id, w.owner, "WEB");
  // Free plan: 3 projects, archived ones counted. key_taken wins over the quota.
  assertError(await api.call("POST", path, { name: "Again", key: "OPS" }, w.owner.token), 409, "key_taken", "key_taken before quota_exceeded");
  assertQuota(await api.call("POST", path, { name: "Fourth", key: "NEW" }, w.owner.token), "projects", 3, 3, "4th project on free");
  // Deleting a project frees its key and its slot.
  assertStatus(await api.call("DELETE", `/projects/${second.id}`, undefined, w.owner.token), 204);
  const reused = await createProject(api, w.team.id, w.owner, "OPS");
  assert.notEqual(reused.id, second.id, "ids are never reused");
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
  clock.advance(1000);
  const same = await ok(api, 200, "PATCH", `/projects/${p.id}`, { archived: true }, w.owner.token);
  assert.equal(same.updatedAt, clock.iso(), "updatedAt moves even when the values are unchanged");
  assertError(await api.call("PATCH", `/projects/${p.id}`, { key: "NEW" }, w.owner.token), 400, "invalid_body", "key alone");
  assertError(await api.call("PATCH", `/projects/${p.id}`, { name: "x", key: "ENG" }, w.owner.token), 400, "invalid_body", "key with other fields");
  assertError(await api.call("PATCH", `/projects/${p.id}`, {}, w.owner.token), 400, "invalid_body", "empty");
  assertError(await api.call("PATCH", `/projects/${p.id}`, { archived: "yes" }, w.owner.token), 400, "invalid_body", "archived not boolean");
  assertError(await api.call("PATCH", `/projects/${p.id}`, { description: 5 }, w.owner.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/projects/${p.id}`, { name: "x" }, w.member.token), 403, "forbidden", "member");
  const now = await ok(api, 200, "GET", `/projects/${p.id}`, undefined, w.viewer.token);
  assert.equal(now.name, "Renamed");
  assert.equal(now.updatedAt, same.updatedAt, "failed PATCHes change nothing");
});

test("GET projects filters by ?archived=false|true|all (default false), oldest first; other values are 400 invalid_query", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, defaultPlan: "team" });
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
  for (const q of ["yes", "TRUE", "1", ""]) {
    assertError(await api.call("GET", `/teams/${w.team.id}/projects?archived=${q}`, undefined, w.owner.token), 400, "invalid_query", JSON.stringify(q));
  }
});

test("an archived project answers 409 project_archived on every write inside it; watching still works and reads are unchanged", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const pid = w.project.id;
  const card = await createCard(api, w.cols[0], w.member, { title: "frozen" });
  const card2 = await createCard(api, w.cols[0], w.member, { title: "other" });
  const field = await ok(api, 201, "POST", `/projects/${pid}/fields`, { name: "Size", type: "number" }, w.admin.token);
  const sprint = await ok(api, 201, "POST", `/projects/${pid}/sprints`, { name: "S1", startDate: "2026-03-02", endDate: "2026-03-13" }, w.admin.token);
  const item = await ok(api, 201, "POST", `/cards/${card.id}/checklist`, { text: "step" }, w.member.token);
  const tpl = await ok(api, 201, "POST", `/projects/${pid}/templates`, { name: "T", title: "templated" }, w.admin.token);
  await ok(api, 200, "PATCH", `/projects/${pid}`, { archived: true }, w.admin.token);
  const before = await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.viewer.token);
  const writes: [string, string, unknown?][] = [
    ["POST", `/projects/${pid}/boards`, { name: "New" }],
    ["PATCH", `/boards/${w.board.id}`, { name: "New name" }],
    ["DELETE", `/boards/${w.board.id}`],
    ["POST", `/boards/${w.board.id}/columns`, { name: "Extra" }],
    ["PATCH", `/columns/${w.cols[2]}`, { name: "Finished" }],
    ["DELETE", `/columns/${w.cols[2]}`],
    ["POST", `/columns/${w.cols[0]}/cards`, { title: "new" }],
    ["PATCH", `/cards/${card.id}`, { title: "changed" }],
    ["POST", `/cards/${card.id}/move`, { columnId: w.cols[1] }],
    ["POST", `/cards/${card.id}/archive`],
    ["POST", `/cards/${card.id}/restore`, {}],
    ["DELETE", `/cards/${card.id}`],
    ["POST", `/cards/${card.id}/comments`, { body: "hi" }],
    ["PUT", `/cards/${card.id}/fields/${field.id}`, { value: 3 }],
    ["POST", `/projects/${pid}/fields`, { name: "Other", type: "text" }],
    ["PATCH", `/fields/${field.id}`, { name: "Renamed" }],
    ["DELETE", `/fields/${field.id}`],
    ["POST", `/cards/${card.id}/checklist`, { text: "more" }],
    ["PATCH", `/checklist/${item.id}`, { done: true }],
    ["DELETE", `/checklist/${item.id}`],
    ["POST", `/cards/${card.id}/blockers`, { blockerId: card2.id }],
    ["POST", `/projects/${pid}/sprints`, { name: "S2", startDate: "2026-03-16", endDate: "2026-03-27" }],
    ["PATCH", `/sprints/${sprint.id}`, { goal: "g" }],
    ["POST", `/sprints/${sprint.id}/start`],
    ["POST", `/sprints/${sprint.id}/cards`, { cardIds: [card.id] }],
    ["POST", `/projects/${pid}/templates`, { name: "T2", title: "t" }],
    ["POST", `/templates/${tpl.id}/cards`, { columnId: w.cols[0] }],
    ["POST", `/boards/${w.board.id}/recurrences`, { columnId: w.cols[0], schedule: { frequency: "daily", time: "09:00" }, startDate: "2026-03-02", title: "daily" }],
    ["POST", `/cards/${card.id}/time-entries`, { minutes: 5 }],
    ["POST", `/cards/${card.id}/timer/start`],
    ["POST", `/projects/${pid}/import`, { csv: "board,column,title\r\nBoard,To do,imported\r\n" }],
  ];
  for (const [method, path, body] of writes) assertError(await api.call(method, path, body, w.owner.token), 409, "project_archived", `${method} ${path}`);
  assertError(
    await upload(api, card.id, w.owner.token, "bytes", "a.txt", "text/plain"),
    409,
    "project_archived",
    "attachment upload",
  );
  // Watching is one of the writes that still work.
  assertStatus(await api.call("POST", `/cards/${card.id}/watch`, undefined, w.viewer.token), 204, "watch");
  assertStatus(await api.call("DELETE", `/cards/${card.id}/watch`, undefined, w.viewer.token), 204, "unwatch");
  // Nothing changed.
  assert.deepEqual(await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.viewer.token), before);
  assert.equal((await ok(api, 200, "GET", `/boards/${w.board.id}`, undefined, w.viewer.token)).columns.length, 3);
  assert.equal((await ok(api, 200, "GET", `/projects/${pid}/boards`, undefined, w.viewer.token)).items.length, 1);
  assert.deepEqual((await ok(api, 200, "GET", `/projects/${pid}/fields`, undefined, w.viewer.token)).items.map((f: any) => f.name), ["Size"]);
  assert.equal((await ok(api, 200, "GET", `/sprints/${sprint.id}`, undefined, w.viewer.token)).state, "planned");
  assert.deepEqual((await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.viewer.token)).items.map((c: any) => c.id), [card.id, card2.id]);
});

test("in an archived project comment writes are refused, a running timer can be stopped and its entry deleted; unarchiving restores writes", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const comment = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "hello" }, w.member.token);
  await ok(api, 200, "POST", `/cards/${card.id}/timer/start`, undefined, w.member.token);
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", `/cards/${card.id}/comments`, { body: "more" }, w.member.token), 409, "project_archived", "new comment");
  assertError(await api.call("PATCH", `/comments/${comment.id}`, { body: "edit" }, w.member.token), 409, "project_archived", "edit");
  assertError(await api.call("DELETE", `/comments/${comment.id}`, undefined, w.member.token), 409, "project_archived", "delete");
  clock.advance(30 * 60_000);
  const entry = await ok(api, 201, "POST", `/cards/${card.id}/timer/stop`, undefined, w.member.token);
  assert.equal(entry.minutes, 30, "stopping the timer works in an archived project");
  assert.equal(entry.source, "timer");
  assert.equal((await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.member.token)).minutesLogged, 30);
  assertStatus(await api.call("DELETE", `/time-entries/${entry.id}`, undefined, w.member.token), 204, "deleting a time entry works too");
  const renamed = await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { name: "Still archived" }, w.owner.token);
  assert.equal(renamed.archived, true);
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: false }, w.owner.token);
  assertStatus(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "thawed" }, w.member.token), 201, "card after unarchive");
  const edited = await api.call("PATCH", `/comments/${comment.id}`, { body: "edit" }, w.member.token);
  assertStatus(edited, 200, "comment after unarchive");
  assert.equal(edited.body.body, "edit");
  assert.equal((await ok(api, 200, "GET", `/cards/${card.id}`, undefined, w.member.token)).minutesLogged, 0);
});

test("project_archived is checked after visibility, role and validation (steps 5-8) and before the route's other 409s", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await ok(api, 200, "PATCH", `/columns/${w.cols[0]}`, { wipLimit: 1 }, w.owner.token);
  const card = await createCard(api, w.cols[0], w.member, { title: "fills the column" });
  await ok(api, 200, "POST", `/cards/${card.id}/archive`, undefined, w.member.token);
  await createCard(api, w.cols[0], w.member, { title: "fills it again" });
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  const col = `/columns/${w.cols[0]}/cards`;
  assertError(await api.call("POST", col, { title: "x" }, w.outsider.token), 404, "not_found", "outsider");
  assertError(await api.call("POST", col, { title: "x" }, w.viewer.token), 403, "forbidden", "viewer");
  assertError(await api.call("POST", col, { title: "" }, w.member.token), 400, "invalid_body", "invalid title");
  assertError(await api.call("POST", col, { title: "x", assigneeId: w.viewer.id }, w.member.token), 400, "invalid_assignee", "viewer assignee");
  assertError(await api.call("POST", col, { title: "x" }, w.member.token), 409, "project_archived", "before wip_limit_reached");
  assertError(await api.call("PATCH", `/cards/${card.id}`, { title: "x" }, w.member.token), 409, "project_archived", "before card_archived");
  assertError(await api.call("POST", `/projects/${w.project.id}/boards`, { name: "B" }, w.member.token), 403, "forbidden", "member board");
  assertError(await api.call("POST", `/projects/${w.project.id}/boards`, { name: "" }, w.admin.token), 400, "invalid_body", "invalid board");
});

test("DELETE project removes everything in it: boards, cards, fields, sprints, templates, dependencies, storage, and disables rules on it", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const pid = w.project.id;
  const card = await createCard(api, w.cols[1], w.member, { title: "gone" });
  const comment = await ok(api, 201, "POST", `/cards/${card.id}/comments`, { body: "gone too" }, w.member.token);
  const field = await ok(api, 201, "POST", `/projects/${pid}/fields`, { name: "Size", type: "number" }, w.admin.token);
  const sprint = await ok(api, 201, "POST", `/projects/${pid}/sprints`, { name: "S1", startDate: "2026-03-02", endDate: "2026-03-13" }, w.admin.token);
  const tpl = await ok(api, 201, "POST", `/projects/${pid}/templates`, { name: "T", title: "t" }, w.admin.token);
  const att = await upload(api, card.id, w.member.token, "0123456789", "ten.txt", "text/plain");
  assertStatus(att, 201);
  const keep = await createProject(api, w.team.id, w.owner, "KEEP");
  const keepBoard = await createBoard(api, keep.id, w.owner);
  const survivor = await createCard(api, keepBoard.columns[0].id, w.member, { title: "survivor" });
  await ok(api, 201, "POST", `/cards/${survivor.id}/blockers`, { blockerId: card.id }, w.member.token);
  assert.equal((await ok(api, 200, "GET", `/cards/${survivor.id}`, undefined, w.member.token)).blocked, true);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created", projectId: pid }, actions: [{ type: "set_priority", priority: "high" }] });
  const planBefore = await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.owner.token);
  assert.deepEqual([planBefore.usage.projects, planBefore.usage.cards, planBefore.usage.storageBytes], [2, 2, 10]);
  assertError(await api.call("DELETE", `/projects/${pid}`, undefined, w.member.token), 403, "forbidden");
  const res = await api.call("DELETE", `/projects/${pid}`, undefined, w.admin.token);
  assertStatus(res, 204);
  assert.equal(res.text, "");
  for (const path of [`/projects/${pid}`, `/boards/${w.board.id}`, `/cards/${card.id}`, `/comments/${comment.id}`, `/fields/${field.id}`, `/sprints/${sprint.id}`, `/templates/${tpl.id}`, `/attachments/${att.body.id}`]) {
    assertError(await api.call("GET", path, undefined, w.owner.token), 404, "not_found", path);
  }
  assertError(await api.call("DELETE", `/projects/${pid}`, undefined, w.admin.token), 404, "not_found", "twice");
  const list = await ok(api, 200, "GET", `/teams/${w.team.id}/projects?archived=all`, undefined, w.owner.token);
  assert.deepEqual(list.items.map((p: any) => p.id), [keep.id]);
  const after = await ok(api, 200, "GET", `/cards/${survivor.id}`, undefined, w.member.token);
  assert.equal(after.blocked, false, "the dependency on the deleted card is gone");
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${survivor.id}/blockers`, undefined, w.member.token)).items, []);
  const plan = await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, w.owner.token);
  assert.deepEqual([plan.usage.projects, plan.usage.cards, plan.usage.storageBytes], [1, 1, 0], "usage after the delete");
  assert.equal((await ok(api, 200, "GET", `/rules/${rule.id}`, undefined, w.owner.token)).enabled, false, "a rule referencing the project is disabled");
});
