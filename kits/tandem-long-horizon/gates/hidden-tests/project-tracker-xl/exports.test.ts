// Area `exports`: instruction.md section 27 (Import and export): the JSON project document, CSV
// export, CSV import into a project and project-document import into a team.
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
  createBoard,
  createCard,
  createProject,
  createRule,
  eventLog,
  getCard,
  ok,
  type Res,
  setupBoard,
  setupTeam,
  type World,
} from "./helpers.ts";
import { addItem, archive, history, mkField, ruleRuns, startApp, watcherIds } from "./helpers-pipeline.ts";

const exportJson = async (api: Api, projectId: string, token: string): Promise<any> => ok(api, 200, "GET", `/projects/${projectId}/export`, undefined, token);
const exportCsv = async (api: Api, projectId: string, token: string): Promise<Res> => {
  const res = await api.call("GET", `/projects/${projectId}/export?format=csv`, undefined, token);
  assertStatus(res, 200, "CSV export");
  return res;
};
const importCsv = (api: Api, projectId: string, token: string, csv: string, extra: Record<string, unknown> = {}): Promise<Res> =>
  api.call("POST", `/projects/${projectId}/import`, { csv, ...extra }, token);
const importDoc = (api: Api, teamId: string, token: string, body: Record<string, unknown>): Promise<Res> => api.call("POST", `/teams/${teamId}/import`, body, token);
const crlf = (...rows: string[]): string => rows.map((r) => `${r}\r\n`).join("");
const importErrors = (res: Res, errors: unknown[], what = ""): void => assertDetails(res, 400, "import_invalid", { errors }, what);

const HEADER = "number,key,board,column,title,description,assignee,labels,dueDate,priority,points,archived";

interface Fixture {
  fields: Record<string, any>;
  ops: any;
  cards: Record<string, any>;
}

/**
 * Project ENG with eight fields, its default board (In progress WIP 2) and a second board "Ops board"
 * (Inbox, Done), and cards 1, 2, 4 and 5 (3 was deleted; 5 is archived).
 */
async function buildProject(api: Api, w: World & { project: any; board: any; cols: string[] }): Promise<Fixture> {
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { description: 'Main, "core" project' }, w.owner.token);
  const fields: Record<string, any> = {};
  for (const [name, body] of [
    ["Severity", { type: "select", options: ["low", "high"] }],
    ["Estimate", { type: "number" }],
    ["Target", { type: "date" }],
    ["Tags", { type: "multiselect", options: ["a", "b", "c"] }],
    ["Reviewed", { type: "checkbox" }],
    ["Owner", { type: "user" }],
    ["Link", { type: "url" }],
    ["Notes", { type: "text" }],
  ] as const) {
    fields[name] = await mkField(api, w.project.id, w.owner, { name, ...body });
  }
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 2 }, w.owner.token);
  const ops = await createBoard(api, w.project.id, w.owner, { name: "Ops board", columns: ["Inbox", "Done"] });
  const f = (n: string) => fields[n].id;
  const c1 = await createCard(api, w.cols[0], w.member, {
    title: "First",
    assigneeId: w.member.id,
    labels: ["ui", "bug"],
    dueDate: "2026-04-01",
    priority: "high",
    points: 3,
    customFields: {
      [f("Severity")]: "high",
      [f("Estimate")]: 2.5,
      [f("Target")]: "2026-05-01",
      [f("Tags")]: ["c", "a"],
      [f("Reviewed")]: false,
      [f("Owner")]: w.admin.id,
      [f("Link")]: "https://x.test/a?b=1",
      [f("Notes")]: "  note  ",
    },
  });
  const two = await addItem(api, c1.id, w.member, "two");
  const one = await addItem(api, c1.id, w.member, "one", { position: 0 });
  await ok(api, 200, "PATCH", `/checklist/${one.id}`, { done: true }, w.member.token);
  assert.ok(two.id);
  const c2 = await createCard(api, w.cols[2], w.member, { title: "Second, with comma", description: "Line1\nLine2" });
  const c3 = await createCard(api, w.cols[0], w.member, { title: "deleted" });
  await ok(api, 204, "DELETE", `/cards/${c3.id}`, undefined, w.member.token);
  const c4 = await createCard(api, ops.columns[0].id, w.member, { title: 'Say "hi"', description: " padded ", priority: "low", points: 0 });
  const c5 = await createCard(api, w.cols[1], w.member, { title: "Archived one" });
  await archive(api, c5.id, w.member);
  return { fields, ops, cards: { c1, c2, c4, c5 } };
}

function expectedDoc(w: World): any {
  const plain = { assignee: null, labels: [], dueDate: null, priority: "none", points: null, customFields: {}, checklist: [], archived: false };
  return {
    format: "project-tracker/project",
    version: 1,
    project: { name: "Project ENG", key: "ENG", description: 'Main, "core" project' },
    fields: [
      { name: "Severity", type: "select", options: ["low", "high"], required: false },
      { name: "Estimate", type: "number", options: [], required: false },
      { name: "Target", type: "date", options: [], required: false },
      { name: "Tags", type: "multiselect", options: ["a", "b", "c"], required: false },
      { name: "Reviewed", type: "checkbox", options: [], required: false },
      { name: "Owner", type: "user", options: [], required: false },
      { name: "Link", type: "url", options: [], required: false },
      { name: "Notes", type: "text", options: [], required: false },
    ],
    boards: [
      {
        name: "Board",
        columns: [
          { name: "To do", category: "todo", wipLimit: null },
          { name: "In progress", category: "in_progress", wipLimit: 2 },
          { name: "Done", category: "done", wipLimit: null },
        ],
      },
      { name: "Ops board", columns: [{ name: "Inbox", category: "todo", wipLimit: null }, { name: "Done", category: "done", wipLimit: null }] },
    ],
    cards: [
      {
        number: 1,
        board: 0,
        column: 0,
        position: 0,
        title: "First",
        description: "",
        assignee: w.member.email,
        labels: ["bug", "ui"],
        dueDate: "2026-04-01",
        priority: "high",
        points: 3,
        customFields: { Severity: "high", Estimate: 2.5, Target: "2026-05-01", Tags: ["a", "c"], Reviewed: false, Owner: w.admin.email, Link: "https://x.test/a?b=1", Notes: "note" },
        checklist: [{ text: "one", done: true }, { text: "two", done: false }],
        archived: false,
      },
      { number: 2, board: 0, column: 2, position: 0, title: "Second, with comma", description: "Line1\nLine2", ...plain },
      { number: 4, board: 1, column: 0, position: 0, title: 'Say "hi"', description: " padded ", ...plain, priority: "low", points: 0 },
      { number: 5, board: 0, column: 1, position: null, title: "Archived one", description: "", ...plain, archived: true },
    ],
  };
}

test("the JSON export is the project document, with every key in the documented order", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await buildProject(api, w);
  const res = await api.call("GET", `/projects/${w.project.id}/export`, undefined, w.viewer.token);
  assertStatus(res, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json; charset=utf-8$/i);
  assert.equal(JSON.stringify(res.body), JSON.stringify(expectedDoc(w)), "the same values in the same key order");
  const explicit = await ok(api, 200, "GET", `/projects/${w.project.id}/export?format=json`, undefined, w.viewer.token);
  assert.deepEqual(explicit, res.body);
});

test("export cards: board and column indexes, position null when archived, emails for people, field values by name, checklist by position", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const fx = await buildProject(api, w);
  const doc = await exportJson(api, w.project.id, w.member.token);
  assert.deepEqual(doc.cards.map((c: any) => c.number), [1, 2, 4, 5], "by number, archived included, gaps kept");
  assert.deepEqual(Object.keys(doc.cards[0]), ["number", "board", "column", "position", "title", "description", "assignee", "labels", "dueDate", "priority", "points", "customFields", "checklist", "archived"]);
  assert.deepEqual(Object.keys(doc.cards[0].customFields), ["Severity", "Estimate", "Target", "Tags", "Reviewed", "Owner", "Link", "Notes"], "field creation order");
  assert.deepEqual([doc.cards[2].board, doc.cards[2].column], [1, 0]);
  assert.deepEqual([doc.cards[3].position, doc.cards[3].archived, doc.cards[3].column], [null, true, 1]);
  await createCard(api, fx.ops.columns[0].id, w.member, { title: "before", position: 0 });
  const after = await exportJson(api, w.project.id, w.member.token);
  assert.deepEqual([after.cards[2].number, after.cards[2].position, after.cards[4].number, after.cards[4].position], [4, 1, 6, 0]);
});

test("an empty project exports empty lists; viewers export, non-members get 404, format must be json or csv", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const empty = await createProject(api, w.team.id, w.owner, "EMP", { description: "nothing here" });
  const doc = await exportJson(api, empty.id, w.viewer.token);
  assert.equal(JSON.stringify(doc), JSON.stringify({ format: "project-tracker/project", version: 1, project: { name: "Project EMP", key: "EMP", description: "nothing here" }, fields: [], boards: [], cards: [] }));
  for (const q of ["format=xml", "format=", "format=JSON"]) assertError(await api.call("GET", `/projects/${empty.id}/export?${q}`, undefined, w.viewer.token), 400, "invalid_query", q);
  assertError(await api.call("GET", `/projects/${empty.id}/export`, undefined, w.outsider.token), 404, "not_found");
  await ok(api, 200, "PATCH", `/projects/${empty.id}`, { archived: true }, w.owner.token);
  assert.equal((await exportJson(api, empty.id, w.viewer.token)).project.key, "EMP", "an archived project still exports");
});

test("the CSV export has the documented header with one field: column per field, CRLF row ends, no BOM and a text/csv content type", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await buildProject(api, w);
  const res = await exportCsv(api, w.project.id, w.viewer.token);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.ok(!res.text.startsWith("﻿"), "no BOM");
  assert.ok(res.text.endsWith("\r\n"), "the last row ends with CRLF too");
  const header = res.text.slice(0, res.text.indexOf("\r\n"));
  assert.equal(header, `${HEADER},field:Severity,field:Estimate,field:Target,field:Tags,field:Reviewed,field:Owner,field:Link,field:Notes`);
  const empty = await createProject(api, w.team.id, w.owner, "EMP");
  assert.equal((await exportCsv(api, empty.id, w.viewer.token)).text, `${HEADER}\r\n`);
});

test("CSV cells: names for board and column, emails, ; joined lists, true/false, String(n) numbers, empty for null, and the documented quoting", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await buildProject(api, w);
  const res = await exportCsv(api, w.project.id, w.viewer.token);
  const expected = crlf(
    `${HEADER},field:Severity,field:Estimate,field:Target,field:Tags,field:Reviewed,field:Owner,field:Link,field:Notes`,
    `1,ENG-1,Board,To do,First,,${w.member.email},bug;ui,2026-04-01,high,3,false,high,2.5,2026-05-01,a;c,false,${w.admin.email},https://x.test/a?b=1,note`,
    `2,ENG-2,Board,Done,"Second, with comma","Line1\nLine2",,,,none,,false,,,,,,,,`,
    `4,ENG-4,Ops board,Inbox,"Say ""hi"""," padded ",,,,low,0,false,,,,,,,,`,
    `5,ENG-5,Board,In progress,Archived one,,,,,none,,true,,,,,,,,`,
  );
  assert.equal(res.text, expected);
});

test("CSV quoting: a cell is quoted only when it has a comma, a quote, CR or LF, or starts or ends with a space", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const notes = await mkField(api, w.project.id, w.owner, { name: "Notes", type: "text" });
  const values = ["plain text", "a,b", 'say "x"', "cr\rhere", "lf\nhere", "inner space", "semi;colon", "tab\there", "ünïcødé"];
  for (const v of values) await createCard(api, w.cols[0], w.member, { title: "t", customFields: { [notes.id]: v } });
  await createCard(api, w.cols[0], w.member, { title: "d", description: " both " });
  const rows = (await exportCsv(api, w.project.id, w.member.token)).text.split("\r\n");
  const lastCells = rows.slice(1, values.length + 1).map((r) => r.slice(r.lastIndexOf(",false,") + ",false,".length));
  assert.deepEqual(lastCells, ["plain text", '"a,b"', '"say ""x"""', '"cr\rhere"', '"lf\nhere"', "inner space", "semi;colon", "tab\there", "ünïcødé"]);
  const descRow = rows[values.length + 1];
  assert.equal(descRow, `10,ENG-10,Board,To do,d," both ",,,,none,,false,`);
});

test("CSV export lists every card by number, archived ones included, across all boards of the project", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const b2 = await createBoard(api, w.project.id, w.owner, { name: "Second" });
  const a = await createCard(api, b2.columns[1].id, w.member, { title: "on b2" });
  const b = await createCard(api, w.cols[0], w.member, { title: "on b1" });
  await archive(api, a.id, w.member);
  const lines = (await exportCsv(api, w.project.id, w.member.token)).text.trimEnd().split("\r\n");
  assert.deepEqual(lines.slice(1), [`1,ENG-1,Second,In progress,on b2,,,,,none,,true`, `2,ENG-2,Board,To do,on b1,,,,,none,,false`]);
  assert.equal(b.number, 2);
});

test("a CSV import creates a card per row with an empty number, at the end of its column, as one audited change with no events, rules or watchers", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, defaultPlan: "team" });
  const w = await setupBoard(api, clock);
  const est = await mkField(api, w.project.id, w.owner, { name: "Estimate", type: "number" });
  const existing = await createCard(api, w.cols[1], w.member, { title: "existing" });
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "add_label", label: "rule" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  clock.advance(1000);
  const csv = crlf(
    "board,column,title,labels,priority,points,dueDate,assignee,field:Estimate",
    `Board,In progress,Imported one,b;A,high,5,2026-04-10,${w.member.email},3`,
    `Board,In progress,"Imported, two",,,,,,`,
  );
  const res = await importCsv(api, w.project.id, w.admin.token, csv);
  assertStatus(res, 200);
  assert.deepEqual(res.body, { created: 2, updated: 0, dryRun: false });
  const col = (await ok(api, 200, "GET", `/boards/${w.board.id}/cards?columnId=${w.cols[1]}`, undefined, w.member.token)).items;
  assert.deepEqual(col.map((c: any) => [c.title, c.position]), [["existing", 0], ["Imported one", 1], ["Imported, two", 2]]);
  const [, one, two] = col;
  assert.deepEqual([one.labels, one.priority, one.points, one.dueDate, one.assigneeId, one.customFields], [["a", "b"], "high", 5, "2026-04-10", w.member.id, { [est.id]: 3 }]);
  assert.deepEqual([two.labels, two.priority, two.points, two.dueDate, two.assigneeId, two.customFields], [[], "none", null, null, null, {}]);
  assert.deepEqual([one.number, two.number], [existing.number + 1, existing.number + 2]);
  assert.deepEqual(await log.names(), []);
  assert.deepEqual(await ruleRuns(api, w.admin.token, rule.id), []);
  assert.deepEqual(await watcherIds(api, w.member.token, one.id), []);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.details, e.at]), [["project.imported", "project", w.project.id, w.admin.id, { created: 2, updated: 0 }, clock.iso()]]);
});

test("a CSV row with a number updates that card: every column present is set, another column moves it to the end there, history and completedAt follow", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const a = await createCard(api, w.cols[0], w.member, { title: "Old", priority: "low", labels: ["x"], points: 2 });
  const b = await createCard(api, w.cols[0], w.member, { title: "Stays", labels: ["keep"] });
  await createCard(api, w.cols[2], w.member, { title: "already done" });
  const log = await eventLog(t, api, w.team.id, w.admin);
  clock.advance(60_000);
  const csv = crlf("number,board,column,title,priority,labels,dueDate", `${a.number},Board,Done,New title,urgent,,`, `${b.number},Board,To do,Stays too,none,keep;more,2026-03-05`);
  assert.deepEqual((await importCsv(api, w.project.id, w.owner.token, csv)).body, { created: 0, updated: 2, dryRun: false });
  const na = await getCard(api, a.id, w.member.token);
  assert.deepEqual([na.title, na.priority, na.labels, na.points, na.columnId, na.position, na.completedAt, na.updatedAt], ["New title", "urgent", [], 2, w.cols[2], 1, clock.iso(), clock.iso()]);
  assert.deepEqual(await history(api, w.member.token, a.id), [[null, w.cols[0]], [w.cols[0], w.cols[2]]]);
  const nb = await getCard(api, b.id, w.member.token);
  assert.deepEqual([nb.title, nb.labels, nb.dueDate, nb.columnId, nb.position], ["Stays too", ["keep", "more"], "2026-03-05", w.cols[0], 0]);
  assert.deepEqual(await history(api, w.member.token, b.id), [[null, w.cols[0]]], "the same column is not a move");
  clock.set(Date.parse("2026-03-05T00:00:00.000Z"));
  await ok(api, 200, "GET", "/health");
  assert.deepEqual(await log.names(), ["card.due"], "the import emitted nothing; the dueDate it set scheduled the due job");
});

test("a CSV row for an archived card updates its other cells but does not move it; it stays archived", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[1], w.member, { title: "Archived" });
  await archive(api, card.id, w.member);
  const res = await importCsv(api, w.project.id, w.owner.token, crlf("number,board,column,title,archived", `${card.number},Board,Done,Renamed,false`));
  assert.deepEqual(res.body, { created: 0, updated: 1, dryRun: false });
  const now = await getCard(api, card.id, w.member.token);
  assert.deepEqual([now.title, now.archived, now.columnId, now.position], ["Renamed", true, w.cols[1], null]);
  importErrors(await importCsv(api, w.project.id, w.owner.token, crlf("number,board,column,title", `${card.number},Board,Nowhere,Renamed`)), [{ row: 1, column: "column", code: "not_found" }], "the cells must still resolve");
});

test("CSV header errors are row 0: unknown or repeated columns in header order, then the missing board, column and title", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await mkField(api, w.project.id, w.owner, { name: "Estimate", type: "number" });
  const cases: [string, unknown[]][] = [
    ["board,column,title,bogus,title\r\n", [{ row: 0, column: "bogus", code: "unknown_column" }, { row: 0, column: "title", code: "unknown_column" }]],
    ["title,labels\r\n", [{ row: 0, column: "board", code: "missing_column" }, { row: 0, column: "column", code: "missing_column" }]],
    ["", [{ row: 0, column: "board", code: "missing_column" }, { row: 0, column: "column", code: "missing_column" }, { row: 0, column: "title", code: "missing_column" }]],
    ["board,column,title,field:Nope,field:Estimate,field:estimate\r\n", [{ row: 0, column: "field:Nope", code: "unknown_column" }, { row: 0, column: "field:estimate", code: "unknown_column" }]],
    ["zzz,title\r\n", [{ row: 0, column: "zzz", code: "unknown_column" }, { row: 0, column: "board", code: "missing_column" }, { row: 0, column: "column", code: "missing_column" }]],
    ['board,"column,title\r\n', [{ row: 0, column: null, code: "malformed" }]],
  ];
  for (const [csv, errors] of cases) importErrors(await importCsv(api, w.project.id, w.owner.token, csv), errors, JSON.stringify(csv));
  const ok1 = await importCsv(api, w.project.id, w.owner.token, "title,key,column,board,archived,field:Estimate\n");
  assert.deepEqual(ok1.body, { created: 0, updated: 0, dryRun: false }, "any order; key and archived are accepted and ignored");
});

test("CSV row errors are all reported, by row and then header place, field_required last in its row, and nothing changes", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await mkField(api, w.project.id, w.owner, { name: "Estimate", type: "number" });
  const must = await mkField(api, w.project.id, w.owner, { name: "Must", type: "text", required: true });
  const one = await createCard(api, w.cols[0], w.member, { title: "one", customFields: { [must.id]: "v" } });
  const two = await createCard(api, w.cols[0], w.member, { title: "two", customFields: { [must.id]: "v" } });
  const csv = crlf(
    "number,board,column,title,points,assignee,field:Estimate,field:Must",
    ",Board,Nowhere,T1,4,,x,",
    "99,Board,To do,T2,,,,v",
    ",Nope,Nowhere,T3,,,,v",
    `${one.number},Board,To do,,,,,v`,
    `${one.number},Board,To do,T5,,,,v`,
    `,Board,To do,T6,,${w.viewer.email},,v`,
    `${two.number},Board,To do,T7,,,,`,
  );
  importErrors(await importCsv(api, w.project.id, w.owner.token, csv), [
    { row: 1, column: "column", code: "not_found" },
    { row: 1, column: "points", code: "invalid_value" },
    { row: 1, column: "field:Estimate", code: "invalid_value" },
    { row: 1, column: "field:Must", code: "field_required" },
    { row: 2, column: "number", code: "not_found" },
    { row: 3, column: "board", code: "not_found" },
    { row: 4, column: "title", code: "invalid_value" },
    { row: 5, column: "number", code: "duplicate_row" },
    { row: 6, column: "assignee", code: "invalid_assignee" },
    { row: 7, column: "field:Must", code: "field_required" },
  ]);
  assert.deepEqual((await getCard(api, one.id, w.member.token)).title, "one");
  assert.equal((await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token)).items.length, 2);
  importErrors(await importCsv(api, w.project.id, w.owner.token, crlf("board,column,title", "Board,To do,new")), [{ row: 1, column: null, code: "field_required" }], "the required field's column is absent");
});

test("a row with the wrong number of cells or an unterminated quote is the only error reported, and parsing stops there", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  importErrors(await importCsv(api, w.project.id, w.owner.token, crlf("board,column,title", "Board,Nope,T1", "Board,To do", "Board,To do,\"open")), [{ row: 2, column: null, code: "malformed" }]);
  importErrors(await importCsv(api, w.project.id, w.owner.token, 'board,column,title\nBoard,To do,"never closed\nBoard,To do,x\n'), [{ row: 1, column: null, code: "malformed" }]);
  importErrors(await importCsv(api, w.project.id, w.owner.token, crlf("board,column,title", "Board,To do,a,extra")), [{ row: 1, column: null, code: "malformed" }]);
  const res = await importCsv(api, w.project.id, w.owner.token, 'board,column,title,description\nBoard,To do,"multi\nline","say ""hi"", ok"\n');
  assert.deepEqual(res.body, { created: 1, updated: 0, dryRun: false }, "LF row ends; a quoted line break is inside the cell");
  const [card] = (await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token)).items;
  assert.deepEqual([card.title, card.description], ["multi\nline", 'say "hi", ok']);
});

test("dryRun checks everything the same way but changes nothing and appends no audit entry", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "orig" });
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  const csv = crlf("number,board,column,title", ",Board,To do,new", `${card.number},Board,Done,changed`);
  assert.deepEqual((await importCsv(api, w.project.id, w.owner.token, csv, { dryRun: true })).body, { created: 1, updated: 1, dryRun: true });
  assert.deepEqual((await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token)).items.map((c: any) => [c.title, c.columnId]), [["orig", w.cols[0]]]);
  assert.equal((await auditLog(api, w.owner.token, w.team.id)).length, base);
  importErrors(await importCsv(api, w.project.id, w.owner.token, crlf("board,column,title", "Board,Nope,x"), { dryRun: true }), [{ row: 1, column: "column", code: "not_found" }]);
});

test("imports ignore WIP limits and blocked, then check the cards quota for the created cards: 409 quota_exceeded imports nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 1 }, w.owner.token);
  const a = await createCard(api, w.cols[1], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  await ok(api, 201, "POST", `/cards/${a.id}/blockers`, { blockerId: b.id }, w.member.token);
  const res = await importCsv(api, w.project.id, w.owner.token, crlf("number,board,column,title", ",Board,In progress,over the limit", `${a.number},Board,Done,a`));
  assert.deepEqual(res.body, { created: 1, updated: 1, dryRun: false });
  assert.equal((await getCard(api, a.id, w.member.token)).columnId, w.cols[2], "a blocked card moved into done by an import");
  for (let i = 0; i < 96; i++) await createCard(api, w.cols[0], w.member, { title: `c${i}` });
  const quota = await importCsv(api, w.project.id, w.owner.token, crlf("number,board,column,title", ",Board,To do,x", ",Board,To do,y", `${b.number},Board,To do,b renamed`));
  assertQuota(quota, "cards", 100, 99);
  assert.equal((await getCard(api, b.id, w.member.token)).title, "b", "nothing imported");
});

test("a CSV export imported back into the same project updates every card and changes no value", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const fx = await buildProject(api, w);
  const csv = (await exportCsv(api, w.project.id, w.owner.token)).text;
  const before = await exportJson(api, w.project.id, w.owner.token);
  const res = await importCsv(api, w.project.id, w.owner.token, csv);
  assert.deepEqual(res.body, { created: 0, updated: 4, dryRun: false });
  const after = await exportJson(api, w.project.id, w.owner.token);
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.equal((await getCard(api, fx.cards.c5.id, w.owner.token)).archived, true);
});

test("project import body rules: csv a string, dryRun a boolean, admin+, 409 project_archived, and the 1 MiB body limit of the import routes", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const path = `/projects/${w.project.id}/import`;
  for (const body of [{}, { csv: 5 }, { csv: ["a"] }, { csv: "", dryRun: "yes" }]) assertError(await api.call("POST", path, body, w.owner.token), 400, "invalid_body", JSON.stringify(body));
  assertError(await api.call("POST", path, { csv: "board,column,title\n" }, w.member.token), 403, "forbidden");
  const padded = await api.call("POST", path, { csv: "board,column,title\n", dryRun: true, pad: "x".repeat(200_000) }, w.owner.token);
  assert.deepEqual(padded.body, { created: 0, updated: 0, dryRun: true }, "200 KB is within the import routes' 1 MiB limit");
  assertError(await api.call("POST", path, { csv: "board,column,title\n", pad: "x".repeat(1_048_577) }, w.owner.token), 413, "body_too_large");
  await ok(api, 200, "PATCH", `/projects/${w.project.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", path, { csv: "board,column,title\n" }, w.owner.token), 409, "project_archived");
});

test("CSV import cells per field type: numbers by Number, checkbox true/false, user and assignee emails, ; split lists; bad cells are invalid_value", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const n = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const c = await mkField(api, w.project.id, w.owner, { name: "C", type: "checkbox" });
  const u = await mkField(api, w.project.id, w.owner, { name: "U", type: "user" });
  const m = await mkField(api, w.project.id, w.owner, { name: "M", type: "multiselect", options: ["x", "y"] });
  const d = await mkField(api, w.project.id, w.owner, { name: "D", type: "date" });
  const header = "board,column,title,field:N,field:C,field:U,field:M,field:D";
  const res = await importCsv(api, w.project.id, w.owner.token, crlf(header, `Board,To do,t,1e3,true,${w.viewer.email.toUpperCase()},y;x;y,2026-06-30`, "Board,To do,u,-0.5,false,,,"));
  assert.deepEqual(res.body, { created: 2, updated: 0, dryRun: false });
  const [first, second] = (await ok(api, 200, "GET", `/boards/${w.board.id}/cards`, undefined, w.member.token)).items;
  assert.deepEqual(first.customFields, { [n.id]: 1000, [c.id]: true, [u.id]: w.viewer.id, [m.id]: ["x", "y"], [d.id]: "2026-06-30" });
  assert.deepEqual(second.customFields, { [n.id]: -0.5, [c.id]: false });
  importErrors(await importCsv(api, w.project.id, w.owner.token, crlf(header, `Board,To do,t,abc,yes,${w.outsider.email},z,2026-02-30`)), [
    { row: 1, column: "field:N", code: "invalid_value" },
    { row: 1, column: "field:C", code: "invalid_value" },
    { row: 1, column: "field:U", code: "invalid_value" },
    { row: 1, column: "field:M", code: "invalid_value" },
    { row: 1, column: "field:D", code: "invalid_value" },
  ]);
});

/** A valid project document for `w`'s people. */
function sampleDoc(w: World): any {
  const card = (over: Record<string, unknown>) => ({
    number: 1,
    board: 0,
    column: 0,
    position: 0,
    title: "T",
    description: "",
    assignee: null,
    labels: [],
    dueDate: null,
    priority: "none",
    points: null,
    customFields: {},
    checklist: [],
    archived: false,
    ...over,
  });
  return {
    format: "project-tracker/project",
    version: 1,
    project: { name: "Imported", key: "IMP", description: "from a file" },
    fields: [
      { name: "Severity", type: "select", options: ["low", "high"], required: true },
      { name: "Owner", type: "user", options: [], required: false },
      { name: "Checked", type: "checkbox", options: [], required: false },
    ],
    boards: [
      {
        name: "Main",
        columns: [
          { name: "Todo", category: "todo", wipLimit: null },
          { name: "Doing", category: "in_progress", wipLimit: 1 },
          { name: "Done", category: "done", wipLimit: null },
        ],
      },
    ],
    cards: [
      card({ number: 3, position: 1, title: "Third", assignee: w.member.email, labels: ["a"], dueDate: "2026-04-01", priority: "low", points: 2, customFields: { Severity: "high", Owner: w.viewer.email, Checked: true }, checklist: [{ text: "x", done: true }, { text: "y", done: false }] }),
      card({ number: 7, position: 0, title: "Seventh", customFields: { Severity: "low" } }),
      card({ number: 5, column: 2, position: 0, title: "Fifth done", customFields: { Severity: "low" } }),
      card({ number: 1, column: 1, position: null, title: "Archived", archived: true }),
      card({ number: 2, column: 1, position: 0, title: "Doing A", customFields: { Severity: "low" } }),
      card({ number: 4, column: 1, position: 0, title: "Doing B", customFields: { Severity: "low" } }),
    ],
  };
}

test("a team import creates the project with its fields, boards and cards: numbers kept, positions by position then document order, archived and done cards", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  clock.advance(5000);
  const res = await importDoc(api, w.team.id, w.admin.token, { document: sampleDoc(w) });
  assertStatus(res, 201);
  const p = res.body;
  assert.deepEqual([p.teamId, p.name, p.key, p.description, p.archived, p.createdAt], [w.team.id, "Imported", "IMP", "from a file", false, clock.iso()]);
  const [board] = (await ok(api, 200, "GET", `/projects/${p.id}/boards`, undefined, w.viewer.token)).items;
  assert.deepEqual(board.columns.map((c: any) => [c.name, c.category, c.wipLimit, c.position]), [["Todo", "todo", null, 0], ["Doing", "in_progress", 1, 1], ["Done", "done", null, 2]]);
  const cards = (await ok(api, 200, "GET", `/boards/${board.id}/cards`, undefined, w.viewer.token)).items;
  assert.deepEqual(cards.map((c: any) => [c.number, c.key, c.position]), [[7, "IMP-7", 0], [3, "IMP-3", 1], [2, "IMP-2", 0], [4, "IMP-4", 1], [5, "IMP-5", 0]]);
  const third = cards[1];
  assert.deepEqual([third.assigneeId, third.labels, third.dueDate, third.priority, third.points, third.createdBy, third.sprintId, third.completedAt], [w.member.id, ["a"], "2026-04-01", "low", 2, w.admin.id, null, null]);
  assert.deepEqual(third.checklist, { total: 2, done: 1 });
  const items = (await ok(api, 200, "GET", `/cards/${third.id}/checklist`, undefined, w.viewer.token)).items;
  assert.deepEqual(items.map((i: any) => [i.text, i.done, i.doneAt, i.doneBy]), [["x", true, clock.iso(), w.admin.id], ["y", false, null, null]]);
  assert.equal(cards[4].completedAt, clock.iso(), "completedAt follows the column");
  const trash = (await ok(api, 200, "GET", `/projects/${p.id}/trash`, undefined, w.viewer.token)).items;
  assert.deepEqual(trash.map((c: any) => [c.number, c.archived, c.archivedAt, c.position]), [[1, true, clock.iso(), null]]);
  assert.deepEqual(await history(api, w.viewer.token, third.id), [[null, board.columns[0].id]]);
  assert.deepEqual(await watcherIds(api, w.viewer.token, third.id), []);
  const next = await createCard(api, board.columns[0].id, w.member, { title: "next", customFields: { [(await ok(api, 200, "GET", `/projects/${p.id}/fields`, undefined, w.owner.token)).items[0].id]: "low" } });
  assert.equal(next.number, 8, "the next number is one more than the highest");
});

test("team import: key and name may be overridden (body rules apply), the key used must be free, and document must be an object", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  await createProject(api, w.team.id, w.owner, "IMP");
  for (const body of [{}, { document: [] }, { document: "x" }, { document: sampleDoc(w), key: "imp" }, { document: sampleDoc(w), key: "TOOLONGKEY" }, { document: sampleDoc(w), name: "  " }]) {
    assertError(await importDoc(api, w.team.id, w.owner.token, body), 400, "invalid_body", JSON.stringify(body).slice(0, 60));
  }
  assertError(await importDoc(api, w.team.id, w.owner.token, { document: sampleDoc(w) }), 409, "key_taken");
  const res = await importDoc(api, w.team.id, w.owner.token, { document: sampleDoc(w), key: "COPY", name: "  Copy  " });
  assertStatus(res, 201);
  assert.deepEqual([res.body.key, res.body.name], ["COPY", "Copy"]);
  const broken = { ...sampleDoc(w), project: { name: "x", key: "bad", description: "" } };
  importErrors(await importDoc(api, w.team.id, w.owner.token, { document: broken, key: "NEW" }), [{ path: "/project/key", code: "invalid_value" }], "overridden values are checked too");
  assertError(await importDoc(api, w.team.id, w.member.token, { document: sampleDoc(w), key: "MEM" }), 403, "forbidden");
});

test("team import validation answers the first broken value in document order as a JSON Pointer", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const cases: [string, (d: any) => void][] = [
    ["/format", (d) => (d.format = "project-tracker/board")],
    ["/version", (d) => (d.version = 2)],
    ["/project/description", (d) => delete d.project.description],
    ["/fields/1/name", (d) => (d.fields[1].name = "SEVERITY")],
    ["/fields/2/options", (d) => (d.fields[2].options = ["x"])],
    ["/boards/0/columns/2/category", (d) => (d.boards[0].columns[2].category = "doing")],
    ["/boards/0/columns", (d) => (d.boards[0].columns = [])],
    ["/cards/0/board", (d) => (d.cards[0].board = 1)],
    ["/cards/1/title", (d) => (d.cards[1].title = "  ")],
    ["/cards/3/position", (d) => (d.cards[3].position = 0)],
    ["/cards/2/number", (d) => (d.cards[2].number = 3)],
    ["/cards/0/customFields/Severity", (d) => (d.cards[0].customFields.Severity = "medium")],
    ["/cards/0/checklist/1/done", (d) => (d.cards[0].checklist[1].done = "no")],
    ["/project/key", (d) => {
      d.project.key = "x";
      d.cards[0].title = "";
    }],
  ];
  for (const [path, mutate] of cases) {
    const d = sampleDoc(w);
    mutate(d);
    importErrors(await importDoc(api, w.team.id, w.owner.token, { document: d }), [{ path, code: "invalid_value" }], path);
  }
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}/projects`, undefined, w.owner.token)).items.length, 0);
});

test("team import drops people who are not members: an assignee must be member+, a user value any member", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const d = sampleDoc(w);
  d.cards[0].assignee = w.viewer.email;
  d.cards[1].assignee = w.outsider.email;
  d.cards[1].customFields.Owner = w.outsider.email;
  d.cards[2].assignee = "nobody@example.test";
  const p = (await importDoc(api, w.team.id, w.owner.token, { document: d })).body;
  const doc = await exportJson(api, p.id, w.owner.token);
  const byNumber = new Map(doc.cards.map((c: any) => [c.number, c]));
  assert.deepEqual([byNumber.get(3).assignee, byNumber.get(7).assignee, byNumber.get(5).assignee], [null, null, null]);
  assert.deepEqual(byNumber.get(3).customFields, { Severity: "high", Owner: w.viewer.email, Checked: true }, "a viewer is a member");
  assert.deepEqual(byNumber.get(7).customFields, { Severity: "low" }, "a non-member's user value is dropped");
});

test("team import checks key_taken, then the projects quota, then the cards quota; it is one audited change with no events, rules or watchers", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const rule = await createRule(api, w.team.id, w.admin, { trigger: { event: "card.created" }, actions: [{ type: "add_label", label: "x" }] });
  const log = await eventLog(t, api, w.team.id, w.admin);
  const base = (await auditLog(api, w.admin.token, w.team.id)).length;
  const res = await importDoc(api, w.team.id, w.admin.token, { document: sampleDoc(w) });
  assertStatus(res, 201);
  const entries = (await auditLog(api, w.admin.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.details]), [["project.created", "project", res.body.id, w.admin.id, { imported: true }]]);
  assert.deepEqual(await log.names(), []);
  assert.deepEqual(await ruleRuns(api, w.admin.token, rule.id), []);
  clock.set(Date.parse("2026-04-01T00:00:00.000Z"));
  await ok(api, 200, "GET", "/health");
  assert.deepEqual(await log.names(), ["card.deleted", "card.due"], "the archived card is purged 30 days after its archivedAt; the future dueDate scheduled the due job");
  await createProject(api, w.team.id, w.owner, "THR");
  const d = sampleDoc(w);
  assertError(await importDoc(api, w.team.id, w.admin.token, { document: d }), 409, "key_taken", "before the projects quota");
  assertQuota(await importDoc(api, w.team.id, w.admin.token, { document: d, key: "FOUR" }), "projects", 3, 3);
  await ok(api, 204, "DELETE", `/projects/${w.project.id}`, undefined, w.owner.token);
  const many = sampleDoc(w);
  many.cards = Array.from({ length: 96 }, (_, i) => ({ ...many.cards[1], number: i + 1, position: i }));
  assertQuota(await importDoc(api, w.team.id, w.admin.token, { document: many, key: "MANY" }), "cards", 100, 5, "5 imported cards left after the purge, plus 96 would be 101");
});

test("round trip: a project exported as JSON and imported under another key exports back to the same document but for key and name", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await buildProject(api, w);
  const doc = await exportJson(api, w.project.id, w.owner.token);
  const res = await importDoc(api, w.team.id, w.owner.token, { document: doc, key: "COPY", name: "Copy of ENG" });
  assertStatus(res, 201);
  const again = await exportJson(api, res.body.id, w.owner.token);
  assert.equal(JSON.stringify(again), JSON.stringify({ ...doc, project: { ...doc.project, name: "Copy of ENG", key: "COPY" } }));
  const plain = await importDoc(api, w.team.id, w.owner.token, { document: { ...doc, project: { ...doc.project, key: "SAME" } } });
  assert.equal(JSON.stringify(await exportJson(api, plain.body.id, w.owner.token)), JSON.stringify({ ...doc, project: { ...doc.project, key: "SAME" } }));
});

test("CSV export writes numbers as String(n), checkbox false as false and unset values as empty cells", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const n = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const c = await mkField(api, w.project.id, w.owner, { name: "C", type: "checkbox" });
  for (const [v, box] of [[0, false], [-1.5, true], [1e21, undefined], [0.1 + 0.2, undefined]] as const) {
    await createCard(api, w.cols[0], w.member, { title: "t", points: 0, customFields: box === undefined ? { [n.id]: v } : { [n.id]: v, [c.id]: box } });
  }
  await createCard(api, w.cols[0], w.member, { title: "unset" });
  const lines = (await exportCsv(api, w.project.id, w.member.token)).text.trimEnd().split("\r\n");
  assert.equal(lines[0], `${HEADER},field:N,field:C`);
  assert.deepEqual(lines.slice(1).map((l) => l.split(",").slice(10)), [
    ["0", "false", "0", "false"],
    ["0", "false", "-1.5", "true"],
    ["0", "false", "1e+21", ""],
    ["0", "false", "0.30000000000000004", ""],
    ["", "false", "", ""],
  ]);
});

test("a team import of a document without fields, boards or cards creates an empty project whose first card is number 1", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const document = { format: "project-tracker/project", version: 1, project: { name: "Blank", key: "BLK", description: "" }, fields: [], boards: [], cards: [] };
  const res = await importDoc(api, w.team.id, w.admin.token, { document });
  assertStatus(res, 201);
  assert.equal(JSON.stringify(await exportJson(api, res.body.id, w.viewer.token)), JSON.stringify(document));
  const board = await createBoard(api, res.body.id, w.owner);
  const card = await createCard(api, board.columns[0].id, w.member, { title: "first" });
  assert.deepEqual([card.number, card.key], [1, "BLK-1"]);
  importErrors(await importDoc(api, w.team.id, w.admin.token, { document: { ...document, cards: undefined, project: { ...document.project, key: "BL2" } } }), [{ path: "/cards", code: "invalid_value" }], "a missing key is a broken value");
});
