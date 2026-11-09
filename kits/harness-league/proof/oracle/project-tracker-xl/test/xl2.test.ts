// Smoke tests for sections 24-32 (reference self-check).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Clock, assertError, createCard, createProject, createBoard, eventLog, getCard, ok, setupBoard, startApp, upload, signUp,
} from "./support.ts";

const T = 1e12;

test("export json round-trips through the team import; csv export and import", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T, defaultPlan: "team" });
  const w = await setupBoard(api, clock);
  const f1 = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Size", type: "number" }, w.admin.token);
  const f2 = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Who", type: "user" }, w.admin.token);
  const f3 = await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: "Tags", type: "multiselect", options: ["x", "y", "z"] }, w.admin.token);
  const a = await createCard(api, w.cols[0], w.member, { title: "Alpha, \"quoted\"", description: "line1\nline2", labels: ["b", "a"], assigneeId: w.member.id, points: 3, customFields: { [f1.id]: 2.5, [f2.id]: w.viewer.id, [f3.id]: ["z", "x"] } });
  const b = await createCard(api, w.cols[2], w.member, { title: "lead", description: " lead space", dueDate: "2026-05-01", priority: "high" });
  await ok(api, 201, "POST", `/cards/${a.id}/checklist`, { text: "c1" }, w.member.token);
  await ok(api, 200, "POST", `/cards/${b.id}/archive`, undefined, w.member.token);
  const doc = await ok(api, 200, "GET", `/projects/${w.project.id}/export`, undefined, w.viewer.token);
  assert.deepEqual(Object.keys(doc), ["format", "version", "project", "fields", "boards", "cards"]);
  assert.deepEqual(doc.cards[0], {
    number: 1, board: 0, column: 0, position: 0, title: "Alpha, \"quoted\"", description: "line1\nline2", assignee: w.member.email, labels: ["a", "b"],
    dueDate: null, priority: "none", points: 3, customFields: { Size: 2.5, Who: w.viewer.email, Tags: ["x", "z"] }, checklist: [{ text: "c1", done: false }], archived: false,
  });
  assert.equal(doc.cards[1].position, null);
  const proj = await ok(api, 201, "POST", `/teams/${w.team.id}/import`, { document: doc, key: "IMP" }, w.admin.token);
  assert.equal(proj.key, "IMP");
  const doc2 = await ok(api, 200, "GET", `/projects/${proj.id}/export`, undefined, w.viewer.token);
  assert.deepEqual(doc2, { ...doc, project: { ...doc.project, key: "IMP" } });
  assertError(await api.call("POST", `/teams/${w.team.id}/import`, { document: doc }, w.admin.token), 409, "key_taken");
  const bad = structuredClone(doc);
  bad.cards[1].title = "";
  const r = await api.call("POST", `/teams/${w.team.id}/import`, { document: bad, key: "BAD" }, w.admin.token);
  assertError(r, 400, "import_invalid");
  assert.deepEqual(r.body.error.details, { errors: [{ path: "/cards/1/title", code: "invalid_value" }] });
  const csv = await api.call("GET", `/projects/${w.project.id}/export?format=csv`, undefined, w.viewer.token);
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(csv.text,
    "number,key,board,column,title,description,assignee,labels,dueDate,priority,points,archived,field:Size,field:Who,field:Tags\r\n" +
    `1,ENG-1,Board,To do,"Alpha, ""quoted""","line1\nline2",${w.member.email},a;b,,none,3,false,2.5,${w.viewer.email},x;z\r\n` +
    `2,ENG-2,Board,Done,lead," lead space",,,2026-05-01,high,,true,,,\r\n`);
  // CSV import: update 1 (move to In progress), create one, an error run first
  const errs = await api.call("POST", `/projects/${w.project.id}/import`, { csv: "number,board,column,title,points,bogus\n9,Board,Nope,,4,x\n" }, w.admin.token);
  assert.deepEqual(errs.body.error.details, { errors: [{ row: 0, column: "bogus", code: "unknown_column" }] });
  const errs2 = await api.call("POST", `/projects/${w.project.id}/import`, { csv: "number,board,column,title,points\n9,Board,Nope,,4\n,Board,To do,ok,\n1,Nope,X,t,\n" }, w.admin.token);
  assert.deepEqual(errs2.body.error.details, { errors: [
    { row: 1, column: "number", code: "not_found" }, { row: 1, column: "column", code: "not_found" }, { row: 1, column: "title", code: "invalid_value" }, { row: 1, column: "points", code: "invalid_value" },
    { row: 3, column: "board", code: "not_found" },
  ] });
  const res = await ok(api, 200, "POST", `/projects/${w.project.id}/import`, { csv: "number,board,column,title,labels\r\n1,Board,In progress,Alpha2,q;r\r\n,Board,Done,New one,\r\n" }, w.admin.token);
  assert.deepEqual(res, { created: 1, updated: 1, dryRun: false });
  const a2 = await getCard(api, a.id, w.viewer.token);
  assert.equal(a2.title, "Alpha2");
  assert.equal(a2.columnId, w.cols[1]);
  assert.deepEqual(a2.labels, ["q", "r"]);
  const hist = await ok(api, 200, "GET", `/cards/${a.id}/history`, undefined, w.viewer.token);
  assert.equal(hist.items.length, 2);
  const mal = await api.call("POST", `/projects/${w.project.id}/import`, { csv: "board,column,title\nBoard,To do\n" }, w.admin.token);
  assert.deepEqual(mal.body.error.details, { errors: [{ row: 1, column: null, code: "malformed" }] });
  const empty = await api.call("POST", `/projects/${w.project.id}/import`, { csv: "" }, w.admin.token);
  assert.deepEqual(empty.body.error.details.errors.map((e: any) => e.column), ["board", "column", "title"]);
});

test("reports: summary, cycle time, flow, time, workload; html pages", async (t) => {
  const clock = new Clock(Date.UTC(2026, 2, 1, 12, 0, 0));
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T });
  const w = await setupBoard(api, clock);
  const a = await createCard(api, w.cols[0], w.member, { title: "a <b>", points: 5, assigneeId: w.member.id, labels: ["x"], dueDate: "2026-02-01" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b", points: 3 });
  clock.advance(3_600_000);
  await ok(api, 200, "POST", `/cards/${a.id}/move`, { columnId: w.cols[1] }, w.member.token);
  clock.advance(7_200_000);
  await ok(api, 200, "POST", `/cards/${a.id}/move`, { columnId: w.cols[2] }, w.member.token);
  const s = await ok(api, 200, "GET", `/projects/${w.project.id}/reports/summary`, undefined, w.viewer.token);
  assert.deepEqual(s, {
    cards: 2, byCategory: { todo: 1, in_progress: 0, done: 1 }, byPriority: { none: 2, low: 0, medium: 0, high: 0, urgent: 0 },
    byAssignee: [{ assigneeId: null, open: 1, done: 0 }, { assigneeId: w.member.id, open: 0, done: 1 }], byLabel: [{ label: "x", count: 1 }],
    overdue: 0, blocked: 0, points: { total: 8, done: 5 },
  });
  const ct = await ok(api, 200, "GET", `/projects/${w.project.id}/reports/cycle-time`, undefined, w.viewer.token);
  assert.equal(ct.count, 1);
  assert.equal(ct.items[0].cycleTimeMs, 7_200_000);
  assert.equal(ct.medianMs, 7_200_000);
  const flow = await ok(api, 200, "GET", `/projects/${w.project.id}/reports/flow?from=2026-02-28&to=2026-03-02`, undefined, w.viewer.token);
  assert.deepEqual(flow.days, [
    { date: "2026-02-28", todo: 0, in_progress: 0, done: 0 }, { date: "2026-03-01", todo: 1, in_progress: 0, done: 1 }, { date: "2026-03-02", todo: 1, in_progress: 0, done: 1 },
  ]);
  assertError(await api.call("GET", `/projects/${w.project.id}/reports/flow?from=2026-02-28`, undefined, w.viewer.token), 400, "invalid_query");
  await ok(api, 201, "POST", `/cards/${b.id}/time-entries`, { minutes: 30 }, w.member.token);
  await ok(api, 200, "POST", `/cards/${b.id}/timer/start`, undefined, w.admin.token);
  assertError(await api.call("POST", `/cards/${a.id}/timer/start`, undefined, w.admin.token), 409, "timer_running");
  clock.advance(90_000 * 60);
  const e = await ok(api, 201, "POST", `/cards/${b.id}/timer/stop`, undefined, w.admin.token);
  assert.equal(e.minutes, 90);
  assert.equal(e.source, "timer");
  const tr = await ok(api, 200, "GET", `/projects/${w.project.id}/reports/time`, undefined, w.viewer.token);
  assert.equal(tr.totalMinutes, 120);
  assert.equal((await getCard(api, b.id, w.viewer.token)).minutesLogged, 120);
  const wl = await ok(api, 200, "GET", `/teams/${w.team.id}/reports/workload`, undefined, w.viewer.token);
  assert.deepEqual(wl.items.map((i: any) => i.userId), [w.owner.id, w.admin.id, w.member.id]);
  const html = await api.call("GET", `/html/boards/${w.board.id}`, undefined, w.viewer.token);
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  assert.ok(html.text.startsWith("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Board · ENG</title>"));
  assert.ok(html.text.includes(`<li data-card-id="${b.id}" data-key="ENG-2"><span class="title">b</span></li>`));
  const card = await api.call("GET", `/html/cards/${a.id}`, undefined, w.viewer.token);
  assert.ok(card.text.includes("<title>ENG-1 a &lt;b&gt;</title>"));
  assert.ok(card.text.includes(`<dd data-field="assignee">@${w.member.handle}</dd>`));
  const sum = await api.call("GET", `/html/projects/${w.project.id}/summary`, undefined, w.viewer.token);
  assert.ok(sum.text.includes('<tr data-category="done"><th>done</th><td>1</td></tr>'));
});

test("invites, views, attachments, restore", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now, tokenTtlMs: T });
  const w = await setupBoard(api, clock);
  const newbie = await signUp(api);
  const inv = await ok(api, 201, "POST", `/teams/${w.team.id}/invites`, { email: newbie.email.toUpperCase(), role: "member" }, w.admin.token);
  assert.equal(inv.status, "pending");
  assert.equal(typeof inv.token, "string");
  const mine = await ok(api, 200, "GET", "/me/invites", undefined, newbie.token);
  assert.equal(mine.items.length, 1);
  assert.equal((await ok(api, 200, "GET", "/me/notifications", undefined, newbie.token)).items[0].type, "invite");
  assertError(await api.call("POST", `/invites/${inv.token}/accept`, undefined, w.outsider.token), 403, "forbidden");
  assertError(await api.call("POST", `/teams/${w.team.id}/invites`, { email: w.outsider.email, role: "viewer" }, w.admin.token), 409, "quota_exceeded");
  const m = await ok(api, 200, "POST", `/invites/${inv.token}/accept`, undefined, newbie.token);
  assert.equal(m.role, "member");
  assertError(await api.call("POST", `/invites/${inv.token}/accept`, undefined, newbie.token), 409, "invite_used");
  // views
  const card = await createCard(api, w.cols[0], w.member, { title: "find me", labels: ["k"] });
  await createCard(api, w.cols[0], w.member, { title: "other" });
  const view = await ok(api, 201, "POST", `/teams/${w.team.id}/views`, { name: "mine", query: { q: "find", label: [" K "], junk: 1 } }, w.viewer.token);
  assert.deepEqual(view.query, { q: "find", label: ["k"] });
  assertError(await api.call("POST", `/teams/${w.team.id}/views`, { name: "s", query: {}, shared: true }, w.viewer.token), 403, "forbidden");
  assertError(await api.call("GET", `/views/${view.id}`, undefined, w.member.token), 404, "not_found");
  const vc = await ok(api, 200, "GET", `/views/${view.id}/cards`, undefined, w.viewer.token);
  assert.deepEqual([vc.total, vc.items[0].id], [1, card.id]);
  const lbl = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "k" }, w.admin.token);
  await ok(api, 200, "PATCH", `/labels/${lbl.id}`, { name: "kk" }, w.admin.token);
  assert.deepEqual((await ok(api, 200, "GET", `/views/${view.id}`, undefined, w.viewer.token)).query.label, ["kk"]);
  assertError(await api.call("POST", `/teams/${w.team.id}/views`, { name: "s", query: { priority: "bad" } }, w.viewer.token), 400, "invalid_body");
  // attachments
  const up = await upload(api, card.id, w.member.token, "hello", "a.txt", "Text/Plain; charset=utf-8");
  assert.equal(up.status, 201);
  assert.equal(up.body.contentType, "text/plain");
  assert.equal(up.body.size, 5);
  const content = await api.call("GET", `/attachments/${up.body.id}/content`, undefined, w.viewer.token);
  assert.equal(content.text, "hello");
  assert.equal(content.headers.get("etag"), `"${up.body.sha256}"`);
  const nm = await api.call("GET", `/attachments/${up.body.id}/content`, undefined, w.viewer.token, { headers: { "if-none-match": `"${up.body.sha256}"` } });
  assert.equal(nm.status, 304);
  assertError(await upload(api, card.id, w.member.token, "", "a.txt"), 400, "invalid_body");
  assertError(await upload(api, card.id, w.member.token, "x", "a/b"), 400, "invalid_query");
  const big = new Uint8Array(1048576);
  const u1 = await upload(api, card.id, w.member.token, big, "big.bin");
  assertError(u1, 409, "quota_exceeded");
  assert.deepEqual(u1.body.error.details, { resource: "storageBytes", limit: 1048576, used: 5 });
  // archive and restore
  await ok(api, 200, "POST", `/cards/${card.id}/archive`, undefined, w.member.token);
  assertError(await api.call("POST", `/cards/${card.id}/comments`, { body: "x" }, w.member.token), 409, "card_archived");
  const restored = await ok(api, 200, "POST", `/cards/${card.id}/restore`, { columnId: w.cols[2], position: 0 }, w.member.token);
  assert.equal(restored.columnId, w.cols[2]);
  assert.equal(restored.archived, false);
  assert.notEqual(restored.completedAt, null);
  assertError(await api.call("POST", `/cards/${card.id}/restore`, {}, w.member.token), 409, "card_not_archived");
  const hist = (await ok(api, 200, "GET", `/cards/${card.id}/history`, undefined, w.viewer.token)).items;
  assert.deepEqual(hist.map((h: any) => [h.fromColumnId, h.toColumnId]), [[null, w.cols[0]], [w.cols[0], w.cols[2]]]);
});
