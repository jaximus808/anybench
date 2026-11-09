// The points instruction.md settles in one sentence each (2.0 contract, TDM-238): each test checks
// the reading the reference takes.
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { test } from "node:test";
import { Clock, assertError, createCard, createRule, getCard, ok, setupBoard, startApp } from "./support.ts";

const T = 1e12;

test("an Idempotency-Key sent with an empty value or a non-ASCII character is 400 invalid_header", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const empty = await api.call("POST", "/teams", { name: "T" }, w.owner.token, { headers: { "idempotency-key": "" } });
  assertError(empty, 400, "invalid_header", "empty value");
  const url = new URL(api.base);
  // fetch refuses a non-ASCII header value: write the request by hand.
  const raw = await new Promise<string>((resolve, reject) => {
    const body = JSON.stringify({ name: "T" });
    const sock = createConnection({ host: url.hostname, port: Number(url.port) }, () => {
      sock.write(
        Buffer.concat([
          Buffer.from(`POST /teams HTTP/1.1\r\nhost: ${url.host}\r\nauthorization: Bearer ${w.owner.token}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\nidempotency-key: caf`),
          Buffer.from([0xc3, 0xa9]),
          Buffer.from(`\r\n\r\n${body}`),
        ]),
      );
    });
    let out = "";
    sock.on("data", (d) => (out += d.toString("latin1")));
    sock.on("end", () => resolve(out));
    sock.on("error", reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400 /);
  assert.match(raw, /"code":"invalid_header"/);
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, w.owner.token)).items.length, 1, "nothing was created");
});

test("archived cards that follow ?moveTo keep their completedAt; restore then applies the target's rule", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T });
  const w = await setupBoard(api, clock);
  const done = await createCard(api, w.cols[2], w.member, { title: "done then archived" });
  assert.equal(done.completedAt, clock.iso());
  const doneAt = done.completedAt;
  await ok(api, 200, "POST", `/cards/${done.id}/archive`, undefined, w.member.token);
  clock.advance(60_000);
  await ok(api, 204, "DELETE", `/columns/${w.cols[2]}?moveTo=${w.cols[0]}`, undefined, w.admin.token);
  const moved = await getCard(api, done.id, w.member.token);
  assert.deepEqual([moved.columnId, moved.completedAt, moved.archived], [w.cols[0], doneAt, true]);
  const restored = await ok(api, 200, "POST", `/cards/${done.id}/restore`, {}, w.member.token);
  assert.deepEqual([restored.columnId, restored.completedAt], [w.cols[0], null]);
});

test("a label rewrite replaces a view's label value in place, drops a repeat, and leaves other views alone", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const bug = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "bug" }, w.owner.token);
  const zed = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "zed" }, w.owner.token);
  const holds = await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "v", query: { label: ["zed", "bug", "ui"] } }, w.member.token);
  const repeats = await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "r", query: { label: ["ui", "UI", "x"] } }, w.member.token);
  assert.deepEqual(repeats.query.label, ["ui", "ui", "x"], "stored trimmed and lowercased, as given");
  await ok(api, 200, "PATCH", `/labels/${bug.id}`, { name: "defect" }, w.owner.token);
  assert.deepEqual((await ok(api, 200, "GET", `/views/${holds.id}`, undefined, w.member.token)).query.label, ["zed", "defect", "ui"], "not sorted");
  assert.deepEqual((await ok(api, 200, "GET", `/views/${repeats.id}`, undefined, w.member.token)).query.label, ["ui", "ui", "x"], "a view without the name is untouched");
  await ok(api, 200, "POST", `/labels/${zed.id}/merge`, { intoLabelId: bug.id }, w.owner.token);
  assert.deepEqual((await ok(api, 200, "GET", `/views/${holds.id}`, undefined, w.member.token)).query.label, ["defect", "ui"], "the merge's repeat is dropped");
});

test("PATCH sprintId on a card frozen in a completed sprint: a completed sprint id is 400, a valid value is 409", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s1 = await ok(api, 201, "POST", `/projects/${w.project.id}/sprints`, { name: "S1", startDate: "2026-03-01", endDate: "2026-03-07" }, w.owner.token);
  const s2 = await ok(api, 201, "POST", `/projects/${w.project.id}/sprints`, { name: "S2", startDate: "2026-03-08", endDate: "2026-03-14" }, w.owner.token);
  const card = await createCard(api, w.cols[2], w.member, { title: "kept", sprintId: s1.id });
  await ok(api, 200, "POST", `/sprints/${s1.id}/start`, undefined, w.owner.token);
  await ok(api, 200, "POST", `/sprints/${s1.id}/complete`, {}, w.owner.token);
  assertError(await api.call("PATCH", `/cards/${card.id}`, { sprintId: s1.id }, w.member.token), 400, "invalid_body", "a completed sprint");
  assertError(await api.call("PATCH", `/cards/${card.id}`, { sprintId: null }, w.member.token), 409, "sprint_state", "null");
  assertError(await api.call("PATCH", `/cards/${card.id}`, { sprintId: s2.id }, w.member.token), 409, "sprint_state", "a planned sprint");
});

test("conditions: multiselect contains takes one option; is_set takes no value or null; text values are trimmed, titles are not", async (t) => {
  const api = await startApp(t, { defaultPlan: "team" });
  const w = await setupBoard(api);
  const M = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "M", type: "multiselect", options: ["x", "y"] }, w.owner.token);
  const X = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "X", type: "text" }, w.owner.token);
  const act = [{ type: "set_priority", priority: "high" }];
  const trigger = { event: "card.created" };
  const tryRule = (cond: unknown) => api.call("POST", `/teams/${w.team.id}/rules`, { name: "r", trigger, conditions: [cond], actions: act }, w.admin.token);
  for (const bad of [
    { field: `customFields.${M.id}`, op: "contains", value: ["x"] },
    { field: `customFields.${M.id}`, op: "contains", value: "z" },
    { field: `customFields.${M.id}`, op: "is_set", value: "x" },
    { field: "dueDate", op: "is_set", value: false },
  ]) {
    assertError(await tryRule(bad), 400, "invalid_body", JSON.stringify(bad));
  }
  const r = await createRule(api, w.team.id, w.admin, {
    trigger,
    conditions: [
      { field: `customFields.${M.id}`, op: "contains", value: "x" },
      { field: `customFields.${M.id}`, op: "not_contains", value: "y" },
      { field: `customFields.${X.id}`, op: "eq", value: "  hello " },
      { field: "title", op: "contains", value: " login" },
      { field: `customFields.${X.id}`, op: "is_set", value: null },
      { field: "dueDate", op: "is_not_set" },
    ],
    actions: act,
  });
  assert.deepEqual(r.conditions.map((c: any) => c.value), ["x", "y", "hello", " login", null, null]);
  const card = await createCard(api, w.cols[0], w.member, { title: "Fix login", customFields: { [M.id]: ["x"], [X.id]: "hello" } });
  const test1 = await ok(api, 200, "POST", `/rules/${r.id}/test`, { cardId: card.id }, w.admin.token);
  assert.deepEqual(test1.conditions, [true, true, true, true, true, true]);
  const other = await createCard(api, w.cols[0], w.member, { title: "login", customFields: { [M.id]: ["x", "y"], [X.id]: "hello" } });
  const test2 = await ok(api, 200, "POST", `/rules/${r.id}/test`, { cardId: other.id }, w.admin.token);
  assert.deepEqual(test2.conditions, [true, false, true, false, true, true], "the title value keeps its leading space");
});

test("CSV import: header errors alone; not_found and duplicate_row rows are checked but get no field_required; created cards are the caller's", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const must = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Must", type: "text", required: true }, w.owner.token);
  const one = await createCard(api, w.cols[0], w.member, { title: "one", customFields: { [must.id]: "v" } });
  const imp = (csv: string) => api.call("POST", `/projects/${w.project.id}/import`, { csv }, w.admin.token);
  const header = await imp("board,column,title,bogus\r\nNope,Nope,,x\r\n");
  assertError(header, 400, "import_invalid");
  assert.deepEqual(header.body.error.details.errors, [{ row: 0, column: "bogus", code: "unknown_column" }], "no data row is checked");
  const rows = await imp(
    ["number,board,column,title,points,field:Must", `${one.number},Board,To do,a,,v`, `${one.number},Board,Nope,b,4,`, "99,Board,To do,c,,", ""].join("\r\n"),
  );
  assertError(rows, 400, "import_invalid");
  assert.deepEqual(rows.body.error.details.errors, [
    { row: 2, column: "number", code: "duplicate_row" },
    { row: 2, column: "column", code: "not_found" },
    { row: 2, column: "points", code: "invalid_value" },
    { row: 3, column: "number", code: "not_found" },
  ]);
  assert.deepEqual(await ok(api, 200, "POST", `/projects/${w.project.id}/import`, { csv: "board,column,title,field:Must\r\nBoard,To do,new,v\r\n" }, w.admin.token), { created: 1, updated: 0, dryRun: false });
  const cards = (await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token)).items;
  const made = cards.find((c: any) => c.title === "new");
  assert.equal(made.createdBy, w.admin.id);
  assert.deepEqual((await ok(api, 200, "GET", `/cards/${made.id}/watchers`, undefined, w.member.token)).items, [], "imports create no watchers");
});
