// Area `fields`: instruction.md section 15 (Custom fields), with the conventions of section 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  assertDetails,
  assertError,
  assertQuota,
  assertStatus,
  auditLog,
  Clock,
  createApiKey,
  createBoard,
  createCard,
  createProject,
  createRule,
  eventLog,
  getCard,
  ok,
  type Res,
  setupBoard,
  startApp,
  type User,
} from "./helpers.ts";

const mkField = (api: Api, projectId: string, by: User, body: Record<string, unknown>): Promise<any> =>
  ok(api, 201, "POST", `/projects/${projectId}/fields`, body, by.token);

const putVal = (api: Api, cardId: string, fieldId: string, value: unknown, by: User): Promise<Res> =>
  api.call("PUT", `/cards/${cardId}/fields/${fieldId}`, { value }, by.token);

/** A JSON object text with its keys in exactly this order (ids may look like integers). */
const rawObj = (pairs: [string, unknown][]): string => `{${pairs.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`;

const ids = (items: any[]): string[] => items.map((c) => c.id);

async function search(api: Api, token: string, teamId: string, qs: string): Promise<Res> {
  return api.call("GET", `/teams/${teamId}/search?limit=100&${qs}`, undefined, token);
}

async function searchIds(api: Api, token: string, teamId: string, qs: string): Promise<string[]> {
  const res = await search(api, token, teamId, qs);
  assertStatus(res, 200, `search ${qs}`);
  return ids(res.body.items);
}

test("a field has the documented shape; select options are stored trimmed, other types store [], required defaults to false", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  clock.advance(5000);
  const text = await mkField(api, w.project.id, w.admin, { name: "  Customer  ", type: "text" });
  assert.deepEqual(Object.keys(text).sort(), ["createdAt", "id", "name", "options", "projectId", "required", "type", "updatedAt"]);
  assert.equal(typeof text.id, "string");
  assert.equal(text.projectId, w.project.id);
  assert.equal(text.name, "Customer");
  assert.equal(text.type, "text");
  assert.deepEqual(text.options, []);
  assert.equal(text.required, false);
  assert.equal(text.createdAt, clock.iso());
  assert.equal(text.updatedAt, text.createdAt);
  const sel = await mkField(api, w.project.id, w.owner, { name: "Stage", type: "select", options: [" alpha ", "beta", "gamma  "], required: true });
  assert.deepEqual(sel.options, ["alpha", "beta", "gamma"]);
  assert.equal(sel.required, true);
  const multi = await mkField(api, w.project.id, w.owner, { name: "Tags", type: "multiselect", options: ["b", "a"] });
  assert.deepEqual(multi.options, ["b", "a"], "options keep the given order");
  for (const type of ["number", "date", "checkbox", "user", "url"]) {
    const f = await mkField(api, w.project.id, w.owner, { name: `F ${type}`, type });
    assert.equal(f.type, type);
    assert.deepEqual(f.options, []);
  }
  assert.deepEqual(await ok(api, 200, "GET", `/fields/${sel.id}`, undefined, w.viewer.token), sel);
});

test("a field name is trimmed, 1 to 50 chars, and unique within its project compared case-insensitively", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await createProject(api, w.team.id, w.owner, "OPS");
  for (const name of ["", "   ", "x".repeat(51), 5, null]) {
    assertError(await api.call("POST", `/projects/${w.project.id}/fields`, { name, type: "text" }, w.owner.token), 400, "invalid_body", JSON.stringify(name));
  }
  assertError(await api.call("POST", `/projects/${w.project.id}/fields`, { type: "text" }, w.owner.token), 400, "invalid_body", "missing name");
  const long = await mkField(api, w.project.id, w.owner, { name: ` ${"y".repeat(50)} `, type: "text" });
  assert.equal(long.name, "y".repeat(50));
  await mkField(api, w.project.id, w.owner, { name: "Severity", type: "text" });
  for (const name of ["severity", " SEVERITY "]) {
    assertError(await api.call("POST", `/projects/${w.project.id}/fields`, { name, type: "number" }, w.owner.token), 409, "field_name_taken", name);
  }
  const elsewhere = await mkField(api, other.id, w.owner, { name: "Severity", type: "text" });
  assert.equal(elsewhere.projectId, other.id);
  const list = await ok(api, 200, "GET", `/projects/${w.project.id}/fields`, undefined, w.owner.token);
  assert.equal(list.items.length, 2);
});

test("type must be one of the eight types and never changes: a PATCH with type is 400 invalid_body", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  for (const type of ["string", "Text", "", 1, null]) {
    assertError(await api.call("POST", `/projects/${w.project.id}/fields`, { name: "F", type }, w.owner.token), 400, "invalid_body", JSON.stringify(type));
  }
  assertError(await api.call("POST", `/projects/${w.project.id}/fields`, { name: "F" }, w.owner.token), 400, "invalid_body", "missing type");
  const f = await mkField(api, w.project.id, w.owner, { name: "F", type: "text" });
  assertError(await api.call("PATCH", `/fields/${f.id}`, { type: "number" }, w.owner.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/fields/${f.id}`, { type: "text", name: "New" }, w.owner.token), 400, "invalid_body", "type with another field");
  const after = await ok(api, 200, "GET", `/fields/${f.id}`, undefined, w.owner.token);
  assert.equal(after.type, "text");
  assert.equal(after.name, "F");
});

test("options are required for select and multiselect (1 to 50 distinct trimmed strings of 1 to 50 chars) and forbidden for other types", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const path = `/projects/${w.project.id}/fields`;
  const bad: [string, Record<string, unknown>][] = [
    ["select without options", { name: "A", type: "select" }],
    ["multiselect without options", { name: "A", type: "multiselect" }],
    ["empty options", { name: "A", type: "select", options: [] }],
    ["51 options", { name: "A", type: "select", options: Array.from({ length: 51 }, (_, i) => `o${i}`) }],
    ["duplicate after trimming", { name: "A", type: "multiselect", options: [" a", "a "] }],
    ["blank option", { name: "A", type: "select", options: ["a", "   "] }],
    ["51-char option", { name: "A", type: "select", options: ["z".repeat(51)] }],
    ["non-string option", { name: "A", type: "select", options: ["a", 2] }],
    ["options not an array", { name: "A", type: "select", options: "a,b" }],
    ["text with options", { name: "A", type: "text", options: ["a"] }],
    ["text with empty options", { name: "A", type: "text", options: [] }],
    ["checkbox with options", { name: "A", type: "checkbox", options: ["yes"] }],
    ["required not a boolean", { name: "A", type: "text", required: "yes" }],
  ];
  for (const [what, body] of bad) assertError(await api.call("POST", path, body, w.owner.token), 400, "invalid_body", what);
  const fifty = Array.from({ length: 50 }, (_, i) => `${"o".repeat(48)}${String(i).padStart(2, "0")}`);
  const f = await mkField(api, w.project.id, w.owner, { name: "Big", type: "select", options: fifty });
  assert.deepEqual(f.options, fifty);
  const cased = await mkField(api, w.project.id, w.owner, { name: "Cased", type: "multiselect", options: ["a", "A"] });
  assert.deepEqual(cased.options, ["a", "A"], "distinct is compared exactly");
  const list = await ok(api, 200, "GET", path, undefined, w.owner.token);
  assert.deepEqual(ids(list.items), [f.id, cased.id], "no invalid field was created");
});

test("fields list oldest first; viewers read, members and viewers get 403 on definition writes, non-members 404", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const made: string[] = [];
  for (const name of ["Zeta", "Alpha", "Mid"]) {
    clock.advance(1000);
    made.push((await mkField(api, w.project.id, w.admin, { name, type: "text" })).id);
  }
  const list = await ok(api, 200, "GET", `/projects/${w.project.id}/fields`, undefined, w.viewer.token);
  assert.deepEqual(ids(list.items), made, "creation order, not name order");
  await ok(api, 200, "GET", `/fields/${made[0]}`, undefined, w.viewer.token);
  for (const u of [w.member, w.viewer]) {
    assertError(await api.call("POST", `/projects/${w.project.id}/fields`, { name: "New", type: "text" }, u.token), 403, "forbidden", "POST");
    assertError(await api.call("POST", `/projects/${w.project.id}/fields`, {}, u.token), 403, "forbidden", "role before validation");
    assertError(await api.call("PATCH", `/fields/${made[0]}`, { name: "New" }, u.token), 403, "forbidden", "PATCH");
    assertError(await api.call("DELETE", `/fields/${made[0]}`, undefined, u.token), 403, "forbidden", "DELETE");
  }
  assertError(await api.call("GET", `/projects/${w.project.id}/fields`, undefined, w.outsider.token), 404, "not_found");
  assertError(await api.call("GET", `/fields/${made[0]}`, undefined, w.outsider.token), 404, "not_found");
  assertError(await api.call("POST", `/projects/${w.project.id}/fields`, { name: "X", type: "text" }, w.outsider.token), 404, "not_found");
  assertError(await api.call("GET", `/fields/no-such-field`, undefined, w.owner.token), 404, "not_found");
});

test("PATCH a field renames it, sets required and options, and moves updatedAt; a name another field holds is field_name_taken", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const a = await mkField(api, w.project.id, w.admin, { name: "Alpha", type: "text" });
  const b = await mkField(api, w.project.id, w.admin, { name: "Beta", type: "select", options: ["a", "b"] });
  clock.advance(60_000);
  assertError(await api.call("PATCH", `/fields/${a.id}`, { name: "BETA" }, w.admin.token), 409, "field_name_taken");
  const renamed = await ok(api, 200, "PATCH", `/fields/${a.id}`, { name: " ALPHA " }, w.admin.token);
  assert.equal(renamed.name, "ALPHA", "its own name in another case is fine");
  assert.equal(renamed.updatedAt, clock.iso());
  assert.equal(renamed.createdAt, a.createdAt);
  clock.advance(1000);
  const req = await ok(api, 200, "PATCH", `/fields/${a.id}`, { required: true }, w.admin.token);
  assert.equal(req.required, true);
  assert.equal(req.updatedAt, clock.iso());
  assertError(await api.call("PATCH", `/fields/${a.id}`, { options: ["x"] }, w.admin.token), 400, "invalid_body", "options on a text field");
  const opts = await ok(api, 200, "PATCH", `/fields/${b.id}`, { options: [" c ", "a"] }, w.admin.token);
  assert.deepEqual(opts.options, ["c", "a"]);
  assertError(await api.call("PATCH", `/fields/${b.id}`, { options: [] }, w.admin.token), 400, "invalid_body", "empty options");
  assertError(await api.call("PATCH", `/fields/${a.id}`, {}, w.admin.token), 400, "invalid_body", "no updatable field");
  assertError(await api.call("PATCH", `/fields/${a.id}`, { required: "no" }, w.admin.token), 400, "invalid_body");
  assertError(await api.call("PATCH", `/fields/${a.id}`, { name: "  " }, w.admin.token), 400, "invalid_body");
  const now = await ok(api, 200, "GET", `/fields/${a.id}`, undefined, w.admin.token);
  assert.equal(now.name, "ALPHA");
  assert.equal(now.required, true);
});

test("at most 30 fields per project: the quota is checked after field_name_taken and freed by a delete", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await createProject(api, w.team.id, w.owner, "OPS");
  const made: any[] = [];
  for (let i = 0; i < 30; i++) made.push(await mkField(api, w.project.id, w.owner, { name: `F${i}`, type: "text" }));
  const path = `/projects/${w.project.id}/fields`;
  assertError(await api.call("POST", path, { name: "f0", type: "text" }, w.owner.token), 409, "field_name_taken", "name before quota");
  assertError(await api.call("POST", path, { name: "F30", type: "bogus" }, w.owner.token), 400, "invalid_body", "validation before quota");
  assertQuota(await api.call("POST", path, { name: "F30", type: "text" }, w.owner.token), "fields", 30, 30);
  await mkField(api, other.id, w.owner, { name: "F30", type: "text" });
  await ok(api, 204, "DELETE", `/fields/${made[0].id}`, undefined, w.owner.token);
  await mkField(api, w.project.id, w.owner, { name: "F30", type: "text" });
  const list = await ok(api, 200, "GET", path, undefined, w.owner.token);
  assert.equal(list.items.length, 30);
});

test("text values are trimmed to 1 to 500 chars; number values must be finite JSON numbers", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const tx = await mkField(api, w.project.id, w.owner, { name: "Text", type: "text" });
  const num = await mkField(api, w.project.id, w.owner, { name: "Num", type: "number" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const r1 = await putVal(api, card.id, tx.id, "  hello  ", w.member);
  assertStatus(r1, 200);
  assert.equal(r1.body.id, card.id, "PUT answers the card");
  assert.equal(r1.body.customFields[tx.id], "hello");
  for (const v of ["", "   ", "x".repeat(501), 5, true, ["a"]]) {
    assertDetails(await putVal(api, card.id, tx.id, v, w.member), 400, "invalid_field_value", { fieldId: tx.id }, `text ${JSON.stringify(v).slice(0, 20)}`);
  }
  assertStatus(await putVal(api, card.id, tx.id, "x".repeat(500), w.member), 200);
  for (const v of [3.25, 0, -7]) {
    const r = await putVal(api, card.id, num.id, v, w.member);
    assertStatus(r, 200);
    assert.equal(r.body.customFields[num.id], v);
  }
  for (const v of ["3", true, [1], {}]) {
    assertDetails(await putVal(api, card.id, num.id, v, w.member), 400, "invalid_field_value", { fieldId: num.id }, `number ${JSON.stringify(v)}`);
  }
  const inf = await api.call("PUT", `/cards/${card.id}/fields/${num.id}`, undefined, w.member.token, { raw: '{"value":1e400}' });
  assertDetails(inf, 400, "invalid_field_value", { fieldId: num.id }, "1e400 parses to Infinity");
  const after = await getCard(api, card.id, w.member.token);
  assert.deepEqual(after.customFields, { [tx.id]: "x".repeat(500), [num.id]: -7 });
});

test("date values are real YYYY-MM-DD dates; checkbox values are booleans and false is a stored value", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const dt = await mkField(api, w.project.id, w.owner, { name: "When", type: "date" });
  const cb = await mkField(api, w.project.id, w.owner, { name: "Done?", type: "checkbox" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  for (const v of ["2026-02-28", "2024-02-29"]) assertStatus(await putVal(api, card.id, dt.id, v, w.member), 200, v);
  for (const v of ["2026-02-30", "2025-02-29", "2026-2-3", "2026-02-28T00:00:00Z", 20260228, "tomorrow"]) {
    assertDetails(await putVal(api, card.id, dt.id, v, w.member), 400, "invalid_field_value", { fieldId: dt.id }, String(v));
  }
  const r = await putVal(api, card.id, cb.id, false, w.member);
  assertStatus(r, 200);
  assert.equal(r.body.customFields[cb.id], false);
  assert.ok(Object.hasOwn(r.body.customFields, cb.id), "false is a value, not an unset field");
  for (const v of ["true", 1, 0, "false"]) {
    assertDetails(await putVal(api, card.id, cb.id, v, w.member), 400, "invalid_field_value", { fieldId: cb.id }, JSON.stringify(v));
  }
  const after = await getCard(api, card.id, w.member.token);
  assert.deepEqual(after.customFields, { [dt.id]: "2024-02-29", [cb.id]: false });
});

test("select values equal an option exactly; multiselect values are non-empty arrays of options, de-duplicated in options order", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const sel = await mkField(api, w.project.id, w.owner, { name: "Level", type: "select", options: ["Low", "High"] });
  const ms = await mkField(api, w.project.id, w.owner, { name: "Colors", type: "multiselect", options: ["red", "green", "blue"] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assertStatus(await putVal(api, card.id, sel.id, "High", w.member), 200);
  for (const v of ["high", "Medium", ["High"], " High"]) {
    assertDetails(await putVal(api, card.id, sel.id, v, w.member), 400, "invalid_field_value", { fieldId: sel.id }, JSON.stringify(v));
  }
  const r = await putVal(api, card.id, ms.id, ["blue", "red", "blue"], w.member);
  assertStatus(r, 200);
  assert.deepEqual(r.body.customFields[ms.id], ["red", "blue"]);
  for (const v of [[], ["red", "pink"], "red", [1]]) {
    assertDetails(await putVal(api, card.id, ms.id, v, w.member), 400, "invalid_field_value", { fieldId: ms.id }, JSON.stringify(v));
  }
  const after = await getCard(api, card.id, w.member.token);
  assert.deepEqual(after.customFields, { [sel.id]: "High", [ms.id]: ["red", "blue"] });
});

test("user values are ids of current team members in any role; url values are absolute http or https URLs of at most 2000 chars", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const us = await mkField(api, w.project.id, w.owner, { name: "Reviewer", type: "user" });
  const ur = await mkField(api, w.project.id, w.owner, { name: "Link", type: "url" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  for (const u of [w.owner, w.viewer]) assertStatus(await putVal(api, card.id, us.id, u.id, w.member), 200, "any role");
  for (const v of [w.outsider.id, "no-such-user", 5]) {
    assertDetails(await putVal(api, card.id, us.id, v, w.member), 400, "invalid_field_value", { fieldId: us.id }, String(v));
  }
  const base = "https://example.com/";
  assert.equal(base.length, 20);
  for (const v of ["https://example.com/x", "http://127.0.0.1:8080/a?b=c", base + "a".repeat(1980)]) {
    assertStatus(await putVal(api, card.id, ur.id, v, w.member), 200, v.slice(0, 40));
  }
  for (const v of ["ftp://example.com/x", "example.com/x", "/relative", base + "a".repeat(1981), 42]) {
    assertDetails(await putVal(api, card.id, ur.id, v, w.member), 400, "invalid_field_value", { fieldId: ur.id }, String(v).slice(0, 40));
  }
  const after = await getCard(api, card.id, w.member.token);
  assert.deepEqual(after.customFields, { [us.id]: w.viewer.id, [ur.id]: base + "a".repeat(1980) });
});

test("invalid_field_value names the first offending key in body order, unknown keys and keys of other projects included", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await createProject(api, w.team.id, w.owner, "OPS");
  const tx = await mkField(api, w.project.id, w.owner, { name: "T", type: "text" });
  const num = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const foreign = await mkField(api, other.id, w.owner, { name: "O", type: "text" });
  const create = (cf: string) => api.call("POST", `/columns/${w.cols[0]}/cards`, undefined, w.member.token, { raw: `{"title":"c","customFields":${cf}}` });
  const cases: [[string, unknown][], string][] = [
    [[[tx.id, "ok"], [num.id, "nope"], [foreign.id, "x"]], num.id],
    [[[foreign.id, "x"], [num.id, "nope"]], foreign.id],
    [[["zzz-unknown", null], [num.id, "nope"]], "zzz-unknown"],
    [[[num.id, 1], [foreign.id, null]], foreign.id],
  ];
  for (const [pairs, first] of cases) assertDetails(await create(rawObj(pairs)), 400, "invalid_field_value", { fieldId: first }, rawObj(pairs));
  const board = await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token);
  assert.equal(board.items.length, 0, "nothing was created");
  const good = await create(rawObj([[tx.id, "ok"], [num.id, 4]]));
  assertStatus(good, 201);
  const patch = await api.call("PATCH", `/cards/${good.body.id}`, undefined, w.member.token, {
    raw: `{"customFields":${rawObj([[num.id, 5], [tx.id, ""]])}}`,
  });
  assertDetails(patch, 400, "invalid_field_value", { fieldId: tx.id }, "PATCH");
  assert.deepEqual((await getCard(api, good.body.id, w.member.token)).customFields, { [tx.id]: "ok", [num.id]: 4 }, "a failed PATCH changes nothing");
});

test("on card create customFields must be an object, null for a field of the project is ignored, and the default is {}", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const tx = await mkField(api, w.project.id, w.owner, { name: "T", type: "text" });
  const num = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  for (const cf of [[], "x", 5]) {
    assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "c", customFields: cf }, w.member.token), 400, "invalid_body", JSON.stringify(cf));
  }
  const plain = await createCard(api, w.cols[0], w.member, { title: "plain" });
  assert.deepEqual(plain.customFields, {});
  const c = await createCard(api, w.cols[0], w.member, { title: "c", customFields: { [tx.id]: null, [num.id]: 2 } });
  assert.deepEqual(c.customFields, { [num.id]: 2 });
  assert.deepEqual((await getCard(api, c.id, w.viewer.token)).customFields, { [num.id]: 2 });
});

test("PATCH merges customFields: a value sets that field, null removes it, keys not given are kept", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const tx = await mkField(api, w.project.id, w.owner, { name: "T", type: "text" });
  const num = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const c = await createCard(api, w.cols[0], w.member, { title: "c", customFields: { [tx.id]: "a", [num.id]: 1 } });
  let r = await ok(api, 200, "PATCH", `/cards/${c.id}`, { customFields: { [num.id]: 2 } }, w.member.token);
  assert.deepEqual(r.customFields, { [tx.id]: "a", [num.id]: 2 });
  r = await ok(api, 200, "PATCH", `/cards/${c.id}`, { customFields: { [tx.id]: null } }, w.member.token);
  assert.deepEqual(r.customFields, { [num.id]: 2 });
  r = await ok(api, 200, "PATCH", `/cards/${c.id}`, { customFields: { [tx.id]: null } }, w.member.token);
  assert.deepEqual(r.customFields, { [num.id]: 2 }, "removing an unset value is fine");
  clock.advance(1000);
  r = await ok(api, 200, "PATCH", `/cards/${c.id}`, { customFields: {} }, w.member.token);
  assert.deepEqual(r.customFields, { [num.id]: 2 });
  assert.equal(r.updatedAt, clock.iso(), "customFields is an updatable field, so {} is a valid PATCH");
  r = await ok(api, 200, "PATCH", `/cards/${c.id}`, { title: "renamed" }, w.member.token);
  assert.deepEqual(r.customFields, { [num.id]: 2 });
});

test("PUT and DELETE of a card value answer the card, move updatedAt and emit card.updated with fields [customFields], even with nothing to change", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const tx = await mkField(api, w.project.id, w.owner, { name: "T", type: "text" });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const before = (await auditLog(api, w.admin.token, w.team.id)).length;
  const stamps: string[] = [];
  const steps: [string, unknown][] = [
    ["PUT", "x"],
    ["PUT", "x"],
    ["DELETE", undefined],
    ["DELETE", undefined],
  ];
  for (const [method, value] of steps) {
    clock.advance(1000);
    const res = await api.call(method, `/cards/${card.id}/fields/${tx.id}`, method === "PUT" ? { value } : undefined, w.member.token);
    assertStatus(res, 200, method);
    assert.equal(res.body.id, card.id);
    assert.equal(res.body.updatedAt, clock.iso(), `${method} moves updatedAt`);
    stamps.push(clock.iso());
  }
  assert.deepEqual(await log.names(), ["card.created", "card.updated", "card.updated", "card.updated", "card.updated"]);
  const events = (await log.events(5)).slice(1);
  assert.deepEqual(events.map((e) => e.data.fields), [["customFields"], ["customFields"], ["customFields"], ["customFields"]]);
  assert.deepEqual(events.map((e) => e.data.card.customFields), [{ [tx.id]: "x" }, { [tx.id]: "x" }, {}, {}]);
  assert.deepEqual(events.map((e) => e.occurredAt), stamps);
  for (const e of events) {
    assert.equal(e.actorId, w.member.id);
    assert.equal(e.via, null);
  }
  const audit = (await auditLog(api, w.admin.token, w.team.id)).slice(before);
  assert.deepEqual(
    audit.map((a) => [a.action, a.targetType, a.targetId, a.details]),
    Array.from({ length: 4 }, () => ["card.updated", "card", card.id, { fields: ["customFields"] }]),
  );
});

test("PUT needs a non-null value; a field of another project, an unknown field or an unknown card is 404 not_found first", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await createProject(api, w.team.id, w.owner, "OPS");
  const tx = await mkField(api, w.project.id, w.owner, { name: "T", type: "text" });
  const foreign = await mkField(api, other.id, w.owner, { name: "T", type: "text" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c", customFields: { [tx.id]: "keep" } });
  assertError(await putVal(api, card.id, tx.id, null, w.member), 400, "invalid_body", "null value");
  assertError(await api.call("PUT", `/cards/${card.id}/fields/${tx.id}`, {}, w.member.token), 400, "invalid_body", "missing value");
  assertError(await api.call("PUT", `/cards/${card.id}/fields/${tx.id}`, undefined, w.member.token, { raw: "[1]" }), 400, "invalid_body", "array body");
  assertError(await putVal(api, card.id, foreign.id, "x", w.member), 404, "not_found", "field of another project");
  assertError(await putVal(api, card.id, foreign.id, null, w.member), 404, "not_found", "404 comes before body validation");
  assertError(await putVal(api, card.id, "no-such-field", "x", w.member), 404, "not_found");
  assertError(await putVal(api, "no-such-card", tx.id, "x", w.member), 404, "not_found");
  assertError(await api.call("DELETE", `/cards/${card.id}/fields/${foreign.id}`, undefined, w.member.token), 404, "not_found");
  assertError(await putVal(api, card.id, tx.id, "x", w.viewer), 403, "forbidden", "viewer");
  assertError(await putVal(api, card.id, tx.id, "x", w.outsider), 404, "not_found", "outsider");
  assert.deepEqual((await getCard(api, card.id, w.member.token)).customFields, { [tx.id]: "keep" });
});

test("card create validation order: invalid_body, then invalid_assignee, then invalid_field_value, then field_required", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const req = await mkField(api, w.project.id, w.owner, { name: "Req", type: "text", required: true });
  const num = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const path = `/columns/${w.cols[0]}/cards`;
  const body: Record<string, unknown> = { title: "c", priority: "huge", assigneeId: w.viewer.id, customFields: { [num.id]: "bad" } };
  assertError(await api.call("POST", path, body, w.member.token), 400, "invalid_body");
  body.priority = "high";
  assertError(await api.call("POST", path, body, w.member.token), 400, "invalid_assignee");
  body.assigneeId = w.member.id;
  assertDetails(await api.call("POST", path, body, w.member.token), 400, "invalid_field_value", { fieldId: num.id });
  body.customFields = { [num.id]: 3 };
  assertDetails(await api.call("POST", path, body, w.member.token), 400, "field_required", { fieldId: req.id });
  body.customFields = { [num.id]: 3, [req.id]: "here" };
  const card = await ok(api, 201, "POST", path, body, w.member.token);
  assert.deepEqual(card.customFields, { [num.id]: 3, [req.id]: "here" });
  assertError(await api.call("PATCH", `/cards/${card.id}`, { assigneeId: w.viewer.id, customFields: { [num.id]: "bad" } }, w.member.token), 400, "invalid_assignee", "PATCH");
  assertDetails(await api.call("PATCH", `/cards/${card.id}`, { customFields: { [num.id]: "bad", [req.id]: null } }, w.member.token), 400, "invalid_field_value", { fieldId: num.id }, "PATCH");
});

test("a required field without a value on card create is 400 field_required naming the first missing field in creation order", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await mkField(api, w.project.id, w.owner, { name: "A", type: "text", required: true });
  await mkField(api, w.project.id, w.owner, { name: "B", type: "number" });
  const c = await mkField(api, w.project.id, w.owner, { name: "C", type: "date", required: true });
  const path = `/columns/${w.cols[0]}/cards`;
  assertDetails(await api.call("POST", path, { title: "x" }, w.member.token), 400, "field_required", { fieldId: a.id });
  assertDetails(await api.call("POST", path, { title: "x", customFields: { [a.id]: "v" } }, w.member.token), 400, "field_required", { fieldId: c.id });
  assertDetails(await api.call("POST", path, { title: "x", customFields: { [c.id]: "2026-01-01", [a.id]: null } }, w.member.token), 400, "field_required", { fieldId: a.id }, "null is ignored on create");
  const card = await ok(api, 201, "POST", path, { title: "x", customFields: { [c.id]: "2026-01-01", [a.id]: "v" } }, w.member.token);
  assert.deepEqual(card.customFields, { [c.id]: "2026-01-01", [a.id]: "v" });
});

test("removing a required value by PATCH null or DELETE is field_required; making a field required checks nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const f = await mkField(api, w.project.id, w.owner, { name: "F", type: "text" });
  const bare = await createCard(api, w.cols[0], w.member, { title: "bare" });
  const valued = await createCard(api, w.cols[0], w.member, { title: "valued", customFields: { [f.id]: "v" } });
  const patched = await ok(api, 200, "PATCH", `/fields/${f.id}`, { required: true }, w.owner.token);
  assert.equal(patched.required, true);
  assert.deepEqual((await getCard(api, bare.id, w.member.token)).customFields, {}, "existing cards keep no value");
  await ok(api, 200, "PATCH", `/cards/${bare.id}`, { title: "still bare" }, w.member.token);
  assertDetails(await api.call("PATCH", `/cards/${valued.id}`, { customFields: { [f.id]: null } }, w.member.token), 400, "field_required", { fieldId: f.id });
  assertDetails(await api.call("DELETE", `/cards/${valued.id}/fields/${f.id}`, undefined, w.member.token), 400, "field_required", { fieldId: f.id });
  assert.deepEqual((await getCard(api, valued.id, w.member.token)).customFields, { [f.id]: "v" });
  assertStatus(await putVal(api, valued.id, f.id, "w", w.member), 200);
  await ok(api, 200, "PATCH", `/fields/${f.id}`, { required: false }, w.owner.token);
  const cleared = await ok(api, 200, "DELETE", `/cards/${valued.id}/fields/${f.id}`, undefined, w.member.token);
  assert.deepEqual(cleared.customFields, {});
});

test("a PATCH of options removes stale select and multiselect values from cards and templates, without updatedAt changes or events", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const sel = await mkField(api, w.project.id, w.owner, { name: "Sel", type: "select", options: ["a", "b", "c"] });
  const ms = await mkField(api, w.project.id, w.owner, { name: "Multi", type: "multiselect", options: ["x", "y", "z"] });
  const c1 = await createCard(api, w.cols[0], w.member, { title: "one", customFields: { [sel.id]: "b", [ms.id]: ["x", "y"] } });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "two", customFields: { [sel.id]: "a", [ms.id]: ["y"] } });
  const tpl = await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "T", title: "From template", customFields: { [sel.id]: "b", [ms.id]: ["y"] } }, w.owner.token);
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(60_000);
  await ok(api, 200, "PATCH", `/fields/${sel.id}`, { options: ["a", "c"] }, w.owner.token);
  await ok(api, 200, "PATCH", `/fields/${ms.id}`, { options: ["x", "z"] }, w.owner.token);
  const n1 = await getCard(api, c1.id, w.member.token);
  const n2 = await getCard(api, c2.id, w.member.token);
  assert.deepEqual(n1.customFields, { [ms.id]: ["x"] });
  assert.deepEqual(n2.customFields, { [sel.id]: "a" }, "an emptied multiselect is unset");
  assert.equal(n1.updatedAt, c1.updatedAt);
  assert.equal(n2.updatedAt, c2.updatedAt);
  const t2 = await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.member.token);
  assert.deepEqual(t2.customFields, {});
  assert.equal(t2.updatedAt, tpl.updatedAt);
  assert.deepEqual(await log.names(), [], "cascades emit nothing");
});

test("deleting a field removes its values from cards and templates and disables the rules that reference it", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const f = await mkField(api, w.project.id, w.owner, { name: "F", type: "text" });
  const keep = await mkField(api, w.project.id, w.owner, { name: "Keep", type: "number" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c", customFields: { [f.id]: "v", [keep.id]: 1 } });
  const tpl = await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "T", title: "T", customFields: { [f.id]: "t", [keep.id]: 2 } }, w.owner.token);
  const byCond = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.updated" }, conditions: [{ field: `customFields.${f.id}`, op: "is_set" }], actions: [{ type: "set_priority", priority: "high" }] });
  const byAction = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.moved" }, actions: [{ type: "set_field", fieldId: f.id, value: "auto" }] });
  const other = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.updated" }, conditions: [{ field: `customFields.${keep.id}`, op: "is_set" }], actions: [{ type: "set_priority", priority: "low" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(60_000);
  await ok(api, 204, "DELETE", `/fields/${f.id}`, undefined, w.owner.token);
  assertError(await api.call("GET", `/fields/${f.id}`, undefined, w.owner.token), 404, "not_found");
  const list = await ok(api, 200, "GET", `/projects/${w.project.id}/fields`, undefined, w.owner.token);
  assert.deepEqual(ids(list.items), [keep.id]);
  const now = await getCard(api, card.id, w.member.token);
  assert.deepEqual(now.customFields, { [keep.id]: 1 });
  assert.equal(now.updatedAt, card.updatedAt);
  assert.deepEqual((await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.owner.token)).customFields, { [keep.id]: 2 });
  const r1 = await ok(api, 200, "GET", `/rules/${byCond.id}`, undefined, w.owner.token);
  const r2 = await ok(api, 200, "GET", `/rules/${byAction.id}`, undefined, w.owner.token);
  const r3 = await ok(api, 200, "GET", `/rules/${other.id}`, undefined, w.owner.token);
  assert.equal(r1.enabled, false);
  assert.equal(r2.enabled, false);
  assert.equal(r3.enabled, true);
  assert.deepEqual(r1.conditions, byCond.conditions, "the definition is unchanged");
  assert.deepEqual(r2.actions, byAction.actions);
  assert.equal(r1.updatedAt, byCond.updatedAt, "auto-disabling never moves updatedAt");
  assert.deepEqual(await log.names(), []);
  assertError(await putVal(api, card.id, f.id, "x", w.member), 404, "not_found");
});

test("search field.<id> on text, select, date, url and user matches the value exactly; multiselect matches containment and repeats must all match", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const p = w.project.id;
  const tx = await mkField(api, p, w.owner, { name: "Tx", type: "text" });
  const sl = await mkField(api, p, w.owner, { name: "Sl", type: "select", options: ["a", "b"] });
  const dt = await mkField(api, p, w.owner, { name: "Dt", type: "date" });
  const ur = await mkField(api, p, w.owner, { name: "Ur", type: "url" });
  const us = await mkField(api, p, w.owner, { name: "Us", type: "user" });
  const ms = await mkField(api, p, w.owner, { name: "Ms", type: "multiselect", options: ["x", "y", "z"] });
  const c1 = await createCard(api, w.cols[0], w.member, {
    title: "one",
    customFields: { [tx.id]: "Alpha", [sl.id]: "a", [dt.id]: "2026-05-01", [ur.id]: "https://e.test/1", [us.id]: w.member.id, [ms.id]: ["x", "y"] },
  });
  const c2 = await createCard(api, w.cols[1], w.member, {
    title: "two",
    customFields: { [tx.id]: "alpha", [sl.id]: "b", [dt.id]: "2026-05-02", [ur.id]: "https://e.test/2", [us.id]: w.viewer.id, [ms.id]: ["y"] },
  });
  await createCard(api, w.cols[0], w.member, { title: "three" });
  const q = (qs: string) => searchIds(api, w.viewer.token, w.team.id, qs);
  const enc = encodeURIComponent;
  assert.deepEqual(await q(`field.${tx.id}=Alpha`), [c1.id], "text is exact and case-sensitive");
  assert.deepEqual(await q(`field.${sl.id}=b`), [c2.id]);
  assert.deepEqual(await q(`field.${dt.id}=2026-05-01`), [c1.id]);
  assert.deepEqual(await q(`field.${ur.id}=${enc("https://e.test/2")}`), [c2.id]);
  assert.deepEqual(await q(`field.${us.id}=${enc(w.member.id)}`), [c1.id]);
  assert.deepEqual(await q(`field.${ms.id}=y`), [c1.id, c2.id]);
  assert.deepEqual(await q(`field.${ms.id}=y&field.${ms.id}=x`), [c1.id]);
  assert.deepEqual(await q(`field.${ms.id}=z`), []);
  assert.deepEqual(await q(`field.${tx.id}=Alpha&field.${sl.id}=b`), []);
  const res = await search(api, w.viewer.token, w.team.id, `field.${ms.id}=y&columnId=${w.cols[1]}`);
  assertStatus(res, 200);
  assert.deepEqual(ids(res.body.items), [c2.id]);
  assert.equal(res.body.total, 1);
});

test("search field.<id> on number and checkbox validates the value; checkbox false matches false or unset only in the field's project; unknown fields match nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  const num = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const cb = await mkField(api, w.project.id, w.owner, { name: "Cb", type: "checkbox" });
  const a = await createCard(api, w.cols[0], w.member, { title: "a", customFields: { [cb.id]: true, [num.id]: 3 } });
  const b = await createCard(api, w.cols[0], w.member, { title: "b", customFields: { [cb.id]: false, [num.id]: 3.5 } });
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  await createCard(api, opsBoard.columns[0].id, w.member, { title: "d" });
  const q = (qs: string) => searchIds(api, w.member.token, w.team.id, qs);
  assert.deepEqual(await q(`field.${cb.id}=true`), [a.id]);
  assert.deepEqual(await q(`field.${cb.id}=false`), [b.id, c.id], "unset counts as false, but only in the field's project");
  assert.deepEqual(await q(`field.${num.id}=3`), [a.id]);
  assert.deepEqual(await q(`field.${num.id}=3.0`), [a.id], "compared as numbers");
  assert.deepEqual(await q(`field.${num.id}=3.5`), [b.id]);
  for (const qs of [`field.${cb.id}=TRUE`, `field.${cb.id}=`, `field.${cb.id}=1`, `field.${num.id}=abc`, `field.${num.id}=`, `field.${num.id}=Infinity`]) {
    assertError(await search(api, w.member.token, w.team.id, qs), 400, "invalid_query", qs);
  }
  const unknown = await search(api, w.member.token, w.team.id, "field.no-such-field=abc");
  assertStatus(unknown, 200);
  assert.deepEqual(unknown.body.items, []);
  assert.equal(unknown.body.total, 0);
});

test("a set_field rule action succeeds, is a noop when the value is already there, and fails invalid_field_value once its option is removed", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const sel = await mkField(api, w.project.id, w.owner, { name: "Sel", type: "select", options: ["a", "b", "c"] });
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.updated", fields: ["title"] }, actions: [{ type: "set_field", fieldId: sel.id, value: "b" }] });
  const card = await createCard(api, w.cols[0], w.member, { title: "c0" });
  const r1 = await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "c1" }, w.member.token);
  assert.equal(r1.customFields[sel.id], "b", "the response shows the state after the rules ran");
  await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "c2" }, w.member.token);
  await ok(api, 200, "PATCH", `/fields/${sel.id}`, { options: ["a", "c"] }, w.owner.token);
  assert.deepEqual((await getCard(api, card.id, w.member.token)).customFields, {});
  const r3 = await ok(api, 200, "PATCH", `/cards/${card.id}`, { title: "c3" }, w.member.token);
  assert.deepEqual(r3.customFields, {});
  const runs = await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token);
  assert.deepEqual(
    runs.items.map((r: any) => [r.ruleId, r.event, r.cardId, r.depth, r.status, r.error, r.actions]),
    [
      [rule.id, "card.updated", card.id, 0, "failed", "invalid_field_value", [{ type: "set_field", status: "failed", error: "invalid_field_value" }]],
      [rule.id, "card.updated", card.id, 0, "succeeded", null, [{ type: "set_field", status: "noop", error: null }]],
      [rule.id, "card.updated", card.id, 0, "succeeded", null, [{ type: "set_field", status: "succeeded", error: null }]],
    ],
  );
});

test("when a user leaves the team, user-type field values naming them are removed from cards and templates by cascade", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const us = await mkField(api, w.project.id, w.owner, { name: "Owner", type: "user" });
  const tx = await mkField(api, w.project.id, w.owner, { name: "Note", type: "text" });
  const c1 = await createCard(api, w.cols[0], w.admin, { title: "one", customFields: { [us.id]: w.member.id, [tx.id]: "n" } });
  const c2 = await createCard(api, w.cols[0], w.admin, { title: "two", customFields: { [us.id]: w.viewer.id } });
  const tpl = await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "T", title: "T", customFields: { [us.id]: w.member.id } }, w.owner.token);
  clock.advance(60_000);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.owner.token);
  const n1 = await getCard(api, c1.id, w.admin.token);
  assert.deepEqual(n1.customFields, { [tx.id]: "n" });
  assert.equal(n1.updatedAt, c1.updatedAt);
  assert.deepEqual((await getCard(api, c2.id, w.admin.token)).customFields, { [us.id]: w.viewer.id });
  const t2 = await ok(api, 200, "GET", `/templates/${tpl.id}`, undefined, w.admin.token);
  assert.deepEqual(t2.customFields, {});
  assert.equal(t2.updatedAt, tpl.updatedAt);
  assertDetails(await putVal(api, c2.id, us.id, w.member.id, w.admin), 400, "invalid_field_value", { fieldId: us.id }, "no longer a member");
});

test("field writes are audited: field.created, field.updated with the sorted body fields, field.deleted; a failed write adds nothing", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  clock.advance(1000);
  const f = await mkField(api, w.project.id, w.admin, { name: "F", type: "select", options: ["a"] });
  const g = await mkField(api, w.project.id, w.admin, { name: "G", type: "text" });
  clock.advance(1000);
  await ok(api, 200, "PATCH", `/fields/${f.id}`, { required: true, name: "Renamed", options: ["a", "b"] }, w.admin.token);
  assertError(await api.call("PATCH", `/fields/${g.id}`, { name: "renamed" }, w.admin.token), 409, "field_name_taken");
  await ok(api, 200, "PATCH", `/fields/${g.id}`, { required: false }, w.owner.token);
  clock.advance(1000);
  await ok(api, 204, "DELETE", `/fields/${g.id}`, undefined, w.owner.token);
  const entries = (await auditLog(api, w.owner.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.via, e.details]),
    [
      ["field.created", "field", f.id, w.admin.id, null, {}],
      ["field.created", "field", g.id, w.admin.id, null, {}],
      ["field.updated", "field", f.id, w.admin.id, null, { fields: ["name", "options", "required"] }],
      ["field.updated", "field", g.id, w.owner.id, null, { fields: ["required"] }],
      ["field.deleted", "field", g.id, w.owner.id, null, {}],
    ],
  );
  assert.equal(entries[4].at, clock.iso());
  assert.equal(entries[4].teamId, w.team.id);
});

test("an archived project answers 409 project_archived on field definitions and values; an archived card answers card_archived; validation comes first", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const f = await mkField(api, w.project.id, w.owner, { name: "F", type: "number" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c", customFields: { [f.id]: 1 } });
  const shelved = await createCard(api, w.cols[0], w.member, { title: "shelved", customFields: { [f.id]: 2 } });
  await ok(api, 200, "POST", `/cards/${shelved.id}/archive`, undefined, w.member.token);
  assertError(await putVal(api, shelved.id, f.id, 3, w.member), 409, "card_archived");
  assertError(await api.call("DELETE", `/cards/${shelved.id}/fields/${f.id}`, undefined, w.member.token), 409, "card_archived");
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", `/projects/${w.project.id}/fields`, { name: "G", type: "text" }, w.owner.token), 409, "project_archived", "create");
  assertError(await api.call("PATCH", `/fields/${f.id}`, { name: "G" }, w.owner.token), 409, "project_archived", "PATCH");
  assertError(await api.call("DELETE", `/fields/${f.id}`, undefined, w.owner.token), 409, "project_archived", "DELETE");
  assertError(await putVal(api, card.id, f.id, 5, w.member), 409, "project_archived", "PUT");
  assertError(await api.call("DELETE", `/cards/${card.id}/fields/${f.id}`, undefined, w.member.token), 409, "project_archived", "DELETE value");
  assertError(await putVal(api, shelved.id, f.id, 5, w.member), 409, "project_archived", "project_archived before card_archived");
  assertDetails(await putVal(api, card.id, f.id, "five", w.member), 400, "invalid_field_value", { fieldId: f.id }, "validation before 409");
  const list = await ok(api, 200, "GET", `/projects/${w.project.id}/fields`, undefined, w.viewer.token);
  assert.equal(list.items.length, 1);
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: false }, w.owner.token);
  const r = await putVal(api, card.id, f.id, 5, w.member);
  assertStatus(r, 200);
  assert.equal(r.body.customFields[f.id], 5);
});

test("API keys: field definitions need an admin key, checked before 404; value writes need write scope; a key acts with its owner's current role", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const f = await mkField(api, w.project.id, w.owner, { name: "F", type: "text" });
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const writeKey = (await createApiKey(api, w.owner, { scope: "write" })).secret;
  const readKey = (await createApiKey(api, w.owner, { scope: "read" })).secret;
  const adminKey = (await createApiKey(api, w.owner, { scope: "admin" })).secret;
  assertError(await api.call("POST", `/projects/no-such-project/fields`, { name: "G", type: "text" }, writeKey), 403, "insufficient_scope", "before 404");
  assertError(await api.call("POST", `/projects/${w.project.id}/fields`, { name: "G", type: "text" }, writeKey), 403, "insufficient_scope");
  assertError(await api.call("PATCH", `/fields/${f.id}`, { name: "G" }, writeKey), 403, "insufficient_scope");
  assertError(await api.call("DELETE", `/fields/${f.id}`, undefined, writeKey), 403, "insufficient_scope");
  assertError(await api.call("POST", `/projects/no-such-project/fields`, { name: "G", type: "text" }, adminKey), 404, "not_found");
  const g = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "G", type: "text" }, adminKey);
  assertError(await putVal(api, card.id, f.id, "x", { ...w.owner, token: readKey }), 403, "insufficient_scope", "read key on PUT");
  await ok(api, 200, "GET", `/projects/${w.project.id}/fields`, undefined, readKey);
  await ok(api, 200, "GET", `/fields/${g.id}`, undefined, readKey);
  assertStatus(await putVal(api, card.id, f.id, "x", { ...w.owner, token: writeKey }), 200);
  const audit = await auditLog(api, w.owner.token, w.team.id);
  assert.equal(audit.at(-1).actorId, w.owner.id, "a key acts as its owner");
  assert.equal(audit.at(-2).action, "field.created");
  const memberAdminKey = (await createApiKey(api, w.member, { scope: "admin" })).secret;
  assertError(await api.call("POST", `/projects/${w.project.id}/fields`, { name: "H", type: "text" }, memberAdminKey), 403, "forbidden", "an admin-scoped key of a member is still a member");
});

test("an Idempotency-Key replay of POST fields answers the stored field and creates nothing; another body with the key is idempotency_conflict", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const path = `/projects/${w.project.id}/fields`;
  const body = { name: "Points", type: "number" };
  const first = await api.call("POST", path, body, w.admin.token, { idem: "field-1" });
  assertStatus(first, 201);
  clock.advance(1000);
  const again = await api.call("POST", path, body, w.admin.token, { idem: "field-1" });
  assertStatus(again, 201);
  assert.equal(again.text, first.text, "the stored body bytes");
  assert.equal(again.headers.get("idempotency-replayed"), "true");
  assertError(await api.call("POST", path, { name: "Other", type: "text" }, w.admin.token, { idem: "field-1" }), 409, "idempotency_conflict");
  assertError(await api.call("POST", path, body, w.admin.token), 409, "field_name_taken", "without the key it really runs");
  assertError(await api.call("POST", path, body, w.owner.token, { idem: "field-1" }), 409, "field_name_taken", "another user's key is unrelated");
  const list = await ok(api, 200, "GET", path, undefined, w.admin.token);
  assert.deepEqual(ids(list.items), [first.body.id]);
  const created = (await auditLog(api, w.admin.token, w.team.id)).filter((e) => e.action === "field.created");
  assert.equal(created.length, 1);
});

test("a set_field action runs as the rule's creator: its own audit entry and a card.updated event via the rule, after the request's", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const f = await mkField(api, w.project.id, w.owner, { name: "Origin", type: "text" });
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "set_field", fieldId: f.id, value: "  auto  " }] });
  assert.deepEqual(rule.actions, [{ type: "set_field", fieldId: f.id, value: "auto" }], "stored normalised");
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(1000);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.deepEqual(card.customFields, { [f.id]: "auto" }, "the response shows the state after step 3");
  const runs = await ok(api, 200, "GET", `/rules/${rule.id}/runs`, undefined, w.admin.token);
  assert.equal(runs.items.length, 1);
  const runId = runs.items[0].id;
  const via = { type: "rule", ruleId: rule.id, runId };
  assert.deepEqual(await log.names(), ["card.created", "card.updated"]);
  const [created, updated] = await log.events(2);
  assert.deepEqual(created.data.card.customFields, {}, "the card.created snapshot predates the rule");
  assert.equal(created.actorId, w.member.id);
  assert.equal(created.via, null);
  assert.deepEqual(updated.data.fields, ["customFields"]);
  assert.deepEqual(updated.data.card.customFields, { [f.id]: "auto" });
  assert.equal(updated.actorId, w.admin.id);
  assert.deepEqual(updated.via, via);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetId, e.actorId, e.via, e.details]),
    [
      ["card.created", card.id, w.member.id, null, {}],
      ["card.updated", card.id, w.admin.id, via, { fields: ["customFields"] }],
    ],
  );
});
