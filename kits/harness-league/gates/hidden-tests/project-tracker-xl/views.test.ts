// Area `views`: instruction.md section 26 (Saved views): a named search (section 7) whose results are
// computed when read, with the label rewrites of section 16.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  assertError,
  auditLog,
  Clock,
  createCard,
  createProject,
  ok,
  setupBoard,
  type User,
} from "./helpers.ts";
import { archive, assertKeys, mkField, startApp } from "./helpers-pipeline.ts";

const mkView = (api: Api, teamId: string, by: User, body: Record<string, unknown>): Promise<any> => ok(api, 201, "POST", `/teams/${teamId}/views`, { name: "View", query: {}, ...body }, by.token);
const viewCards = (api: Api, viewId: string, token: string, q = ""): Promise<any> => ok(api, 200, "GET", `/views/${viewId}/cards${q === "" ? "" : `?${q}`}`, undefined, token);
const search = (api: Api, teamId: string, token: string, q: string): Promise<any> => ok(api, 200, "GET", `/teams/${teamId}/search?${q}`, undefined, token);
const ids = (items: any[]): string[] => items.map((c) => c.id);

test("a saved view has the documented shape: private by default, owned by its creator, the name trimmed", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  clock.advance(5000);
  const v = await mkView(api, w.team.id, w.member, { name: "  My bugs  ", query: { q: "bug", priority: "high" } });
  assertKeys(v, ["id", "teamId", "name", "query", "shared", "ownerId", "createdAt", "updatedAt"], "view");
  assert.deepEqual([v.teamId, v.name, v.query, v.shared, v.ownerId, v.createdAt, v.updatedAt], [w.team.id, "My bugs", { q: "bug", priority: "high" }, false, w.member.id, clock.iso(), clock.iso()]);
  assert.deepEqual(await ok(api, 200, "GET", `/views/${v.id}`, undefined, w.member.token), v);
});

test("a stored query keeps only the search parameters, with label values trimmed and lowercased", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const f = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const query = {
    q: "login",
    projectId: w.project.id,
    boardId: w.board.id,
    columnId: w.cols[0],
    assigneeId: "none",
    dueFrom: "2026-03-01",
    dueTo: "2026-03-31",
    priority: "urgent",
    sprintId: "none",
    category: "todo",
    label: [" Bug ", "UI"],
    blocked: false,
    includeArchived: true,
    fields: { [f.id]: "5" },
    limit: 5,
    sort: "title",
    "field.x": "y",
  };
  const v = await mkView(api, w.team.id, w.member, { query });
  const { limit: _l, sort: _s, "field.x": _f, ...kept } = query;
  assert.deepEqual(v.query, { ...kept, label: ["bug", "ui"] });
  const sparse = await mkView(api, w.team.id, w.member, { query: { unknown: 1 } });
  assert.deepEqual(sparse.query, {});
});

test("every query value must pass the search route's rule for its parameter, else 400 invalid_body; query must be an object", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const num = await mkField(api, w.project.id, w.owner, { name: "N", type: "number" });
  const box = await mkField(api, w.project.id, w.owner, { name: "C", type: "checkbox" });
  const path = `/teams/${w.team.id}/views`;
  const bad: unknown[] = [
    { q: 5 },
    { q: "x".repeat(201) },
    { q: "a b c d e f g h i j k" },
    { projectId: 3 },
    { label: "bug" },
    { label: [1] },
    { blocked: "true" },
    { includeArchived: "false" },
    { priority: "critical" },
    { category: "doing" },
    { dueFrom: "2026-02-30" },
    { dueTo: "tomorrow" },
    { fields: [] },
    { fields: { [num.id]: 5 } },
    { fields: { [num.id]: "five" } },
    { fields: { [box.id]: "yes" } },
  ];
  for (const query of bad) assertError(await api.call("POST", path, { name: "v", query }, w.member.token), 400, "invalid_body", JSON.stringify(query));
  for (const query of [undefined, null, [], "q=bug"]) assertError(await api.call("POST", path, { name: "v", query }, w.member.token), 400, "invalid_body", `query ${JSON.stringify(query)}`);
  for (const name of [undefined, "", "   ", "n".repeat(101), 7]) assertError(await api.call("POST", path, { name, query: {} }, w.member.token), 400, "invalid_body", `name ${JSON.stringify(name)}`);
  assertError(await api.call("POST", path, { name: "v", query: {}, shared: "yes" }, w.member.token), 400, "invalid_body");
  const fine = await mkView(api, w.team.id, w.member, { query: { fields: { "no-such-field": "anything", [box.id]: "false" }, projectId: "", q: "!!!" } });
  assert.deepEqual(fine.query.fields, { "no-such-field": "anything", [box.id]: "false" });
});

test("a private view is visible only to its owner, whatever the others' role; the list holds the caller's views and the shared ones, oldest first", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const mine = await mkView(api, w.team.id, w.member, { name: "mine" });
  clock.advance(1000);
  const shared = await mkView(api, w.team.id, w.admin, { name: "shared", shared: true });
  clock.advance(1000);
  const ownerPrivate = await mkView(api, w.team.id, w.owner, { name: "owner's" });
  for (const u of [w.owner, w.admin, w.viewer]) {
    for (const [m, p] of [["GET", `/views/${mine.id}`], ["GET", `/views/${mine.id}/cards`], ["PATCH", `/views/${mine.id}`], ["DELETE", `/views/${mine.id}`]] as const) {
      assertError(await api.call(m, p, m === "PATCH" ? { name: "x" } : undefined, u.token), 404, "not_found", `${u.handle} ${m} ${p}`);
    }
  }
  const listFor = async (u: User) => (await ok(api, 200, "GET", `/teams/${w.team.id}/views`, undefined, u.token)).items.map((v: any) => v.id);
  assert.deepEqual(await listFor(w.member), [mine.id, shared.id]);
  assert.deepEqual(await listFor(w.owner), [shared.id, ownerPrivate.id]);
  assert.deepEqual(await listFor(w.viewer), [shared.id]);
  await ok(api, 200, "GET", `/views/${shared.id}`, undefined, w.viewer.token);
});

test("a viewer may save private views but gets 403 forbidden for shared: true; members may share", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const v = await mkView(api, w.team.id, w.viewer, { name: "viewer's" });
  assert.equal(v.ownerId, w.viewer.id);
  assertError(await api.call("POST", `/teams/${w.team.id}/views`, { name: "s", query: {}, shared: true }, w.viewer.token), 403, "forbidden");
  assertError(await api.call("POST", `/teams/${w.team.id}/views`, { name: "", query: {}, shared: true }, w.viewer.token), 403, "forbidden", "the role check comes before validation");
  const m = await mkView(api, w.team.id, w.member, { name: "member's", shared: true });
  assert.equal(m.shared, true);
  assertError(await api.call("PATCH", `/views/${v.id}`, { shared: true }, w.viewer.token), 403, "forbidden");
  const renamed = await ok(api, 200, "PATCH", `/views/${v.id}`, { name: "renamed", shared: false }, w.viewer.token);
  assert.equal(renamed.name, "renamed");
});

test("PATCH rights: the owner always, admin+ on a shared view; other members get 403 on a shared view they do not own", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const shared = await mkView(api, w.team.id, w.member, { name: "team bugs", shared: true, query: { label: ["bug"] } });
  const other = await mkView(api, w.team.id, w.admin, { name: "admin's", shared: true });
  clock.advance(1000);
  const byAdmin = await ok(api, 200, "PATCH", `/views/${shared.id}`, { name: "renamed by admin" }, w.admin.token);
  assert.deepEqual([byAdmin.name, byAdmin.ownerId, byAdmin.updatedAt], ["renamed by admin", w.member.id, clock.iso()]);
  assertError(await api.call("PATCH", `/views/${other.id}`, { name: "x" }, w.member.token), 403, "forbidden");
  assertError(await api.call("PATCH", `/views/${other.id}`, { name: "x" }, w.viewer.token), 403, "forbidden");
  const unshared = await ok(api, 200, "PATCH", `/views/${shared.id}`, { shared: false }, w.member.token);
  assert.equal(unshared.shared, false);
  assertError(await api.call("PATCH", `/views/${shared.id}`, { name: "y" }, w.admin.token), 404, "not_found", "now private");
  assertError(await api.call("PATCH", `/views/${other.id}`, {}, w.admin.token), 400, "invalid_body", "a PATCH needs an updatable field");
});

test("DELETE rights: the owner, or admin+ when the view is shared; deleted views are gone for everyone", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const s1 = await mkView(api, w.team.id, w.member, { name: "s1", shared: true });
  const s2 = await mkView(api, w.team.id, w.member, { name: "s2", shared: true });
  const p = await mkView(api, w.team.id, w.viewer, { name: "p" });
  const adminShared = await mkView(api, w.team.id, w.admin, { name: "a", shared: true });
  assertError(await api.call("DELETE", `/views/${adminShared.id}`, undefined, w.member.token), 403, "forbidden");
  await ok(api, 204, "DELETE", `/views/${s1.id}`, undefined, w.owner.token);
  await ok(api, 204, "DELETE", `/views/${s2.id}`, undefined, w.member.token);
  await ok(api, 204, "DELETE", `/views/${p.id}`, undefined, w.viewer.token);
  for (const v of [s1, s2, p]) assertError(await api.call("GET", `/views/${v.id}`, undefined, w.member.token), 404, "not_found");
  assert.deepEqual((await ok(api, 200, "GET", `/teams/${w.team.id}/views`, undefined, w.member.token)).items.map((v: any) => v.id), [adminShared.id]);
});

test("GET /views/:viewId/cards answers exactly what the search route answers for the stored query", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  for (const [title, extra] of [
    ["Login bug", { labels: ["bug"], priority: "high" }],
    ["Login page", { labels: ["ui"], priority: "high" }],
    ["Logout bug", { labels: ["bug"], priority: "low", assigneeId: w.member.id }],
    ["bug bug login", { labels: ["bug"], priority: "high", dueDate: "2026-03-10" }],
  ] as const) {
    await createCard(api, w.cols[0], w.member, { title, ...extra });
  }
  const cases: [Record<string, unknown>, string][] = [
    [{ q: "login" }, "q=login"],
    [{ q: "bug", label: ["BUG"] }, "q=bug&label=bug"],
    [{ priority: "high", projectId: w.project.id }, `priority=high&projectId=${w.project.id}`],
    [{ assigneeId: "none", category: "todo" }, "assigneeId=none&category=todo"],
    [{ dueFrom: "2026-03-01", dueTo: "2026-03-31" }, "dueFrom=2026-03-01&dueTo=2026-03-31"],
    [{ projectId: ops.id }, `projectId=${ops.id}`],
    [{}, ""],
  ];
  for (const [query, qs] of cases) {
    const v = await mkView(api, w.team.id, w.member, { query });
    const fromView = await viewCards(api, v.id, w.member.token);
    const fromSearch = await ok(api, 200, "GET", `/teams/${w.team.id}/search${qs === "" ? "" : `?${qs}`}`, undefined, w.member.token);
    assert.deepEqual(fromView, fromSearch, JSON.stringify(query));
    assertKeys(fromView, ["items", "total", "nextCursor"], "view cards");
  }
});

test("view cards paginate with limit and cursor like search, with total over every page; a bad limit is 400 invalid_query", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const made: any[] = [];
  for (let i = 0; i < 5; i++) made.push(await createCard(api, w.cols[0], w.member, { title: `task ${i}` }));
  const v = await mkView(api, w.team.id, w.member, { query: { q: "task" }, shared: true });
  const p1 = await viewCards(api, v.id, w.viewer.token, "limit=2");
  assert.deepEqual([ids(p1.items), p1.total], [[made[0].id, made[1].id], 5]);
  const p2 = await viewCards(api, v.id, w.viewer.token, `limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`);
  const p3 = await viewCards(api, v.id, w.viewer.token, `limit=2&cursor=${encodeURIComponent(p2.nextCursor)}`);
  assert.deepEqual([...ids(p2.items), ...ids(p3.items)], [made[2].id, made[3].id, made[4].id]);
  assert.equal(p3.nextCursor, null);
  for (const q of ["limit=0", "limit=101", "limit=x", "cursor=nope"]) assertError(await api.call("GET", `/views/${v.id}/cards?${q}`, undefined, w.viewer.token), 400, "invalid_query", q);
});

test("a view's results are computed when read: cards created, changed or archived later are reflected", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const v = await mkView(api, w.team.id, w.member, { query: { label: ["urgent"] } });
  assert.deepEqual((await viewCards(api, v.id, w.member.token)).items, []);
  const a = await createCard(api, w.cols[0], w.member, { title: "a", labels: ["urgent"] });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  await ok(api, 200, "PATCH", `/cards/${b.id}`, { labels: ["urgent"] }, w.member.token);
  assert.deepEqual(ids((await viewCards(api, v.id, w.member.token)).items), [a.id, b.id]);
  await archive(api, a.id, w.member);
  const now = await viewCards(api, v.id, w.member.token);
  assert.deepEqual([ids(now.items), now.total], [[b.id], 1]);
});

test("view queries honour blocked, includeArchived and category like the search route", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await ok(api, 201, "POST", `/projects/${ops.id}/boards`, { name: "B" }, w.owner.token);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[0], w.member, { title: "b" });
  const done = await createCard(api, w.cols[2], w.member, { title: "done" });
  const o = await createCard(api, opsBoard.columns[0].id, w.member, { title: "o" });
  await ok(api, 201, "POST", `/cards/${a.id}/blockers`, { blockerId: b.id }, w.member.token);
  await ok(api, 200, "PATCH", `/projects/${ops.id}`, { archived: true }, w.owner.token);
  const blocked = await mkView(api, w.team.id, w.member, { query: { blocked: true } });
  const unblocked = await mkView(api, w.team.id, w.member, { query: { blocked: false } });
  const withArchived = await mkView(api, w.team.id, w.member, { query: { includeArchived: true } });
  const doneOnly = await mkView(api, w.team.id, w.member, { query: { category: "done" } });
  assert.deepEqual(ids((await viewCards(api, blocked.id, w.member.token)).items), [a.id]);
  assert.deepEqual(ids((await viewCards(api, unblocked.id, w.member.token)).items), [b.id, done.id]);
  assert.deepEqual(ids((await viewCards(api, withArchived.id, w.member.token)).items), [a.id, b.id, done.id, o.id]);
  assert.deepEqual(ids((await viewCards(api, doneOnly.id, w.member.token)).items), [done.id]);
});

test("a fields condition works like field.<id>; once the field is deleted the condition stays and matches nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const sev = await mkField(api, w.project.id, w.owner, { name: "Severity", type: "select", options: ["low", "high"] });
  const a = await createCard(api, w.cols[0], w.member, { title: "a", customFields: { [sev.id]: "high" } });
  await createCard(api, w.cols[0], w.member, { title: "b", customFields: { [sev.id]: "low" } });
  const v = await mkView(api, w.team.id, w.member, { query: { fields: { [sev.id]: "high" } } });
  const viaSearch = await search(api, w.team.id, w.member.token, `field.${sev.id}=high`);
  assert.deepEqual(await viewCards(api, v.id, w.member.token), viaSearch);
  assert.deepEqual(ids(viaSearch.items), [a.id]);
  await ok(api, 204, "DELETE", `/fields/${sev.id}`, undefined, w.owner.token);
  const after = await ok(api, 200, "GET", `/views/${v.id}`, undefined, w.member.token);
  assert.deepEqual(after.query, { fields: { [sev.id]: "high" } });
  assert.deepEqual(await viewCards(api, v.id, w.member.token), { items: [], total: 0, nextCursor: null });
});

test("label rename, merge and delete rewrite the label values of stored queries, as cascades", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const bug = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "bug" }, w.owner.token);
  const ui = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "ui" }, w.owner.token);
  const zed = await ok(api, 201, "POST", `/teams/${w.team.id}/labels`, { name: "zed" }, w.owner.token);
  const v = await mkView(api, w.team.id, w.member, { query: { label: ["bug", "other", "ui"], q: "x" } });
  clock.advance(60_000);
  await ok(api, 200, "PATCH", `/labels/${bug.id}`, { name: "defect" }, w.owner.token);
  let now = await ok(api, 200, "GET", `/views/${v.id}`, undefined, w.member.token);
  assert.deepEqual(now.query, { label: ["defect", "other", "ui"], q: "x" });
  await ok(api, 200, "POST", `/labels/${ui.id}/merge`, { intoLabelId: zed.id }, w.owner.token);
  now = await ok(api, 200, "GET", `/views/${v.id}`, undefined, w.member.token);
  assert.deepEqual(now.query.label, ["defect", "other", "zed"]);
  await ok(api, 204, "DELETE", `/labels/${bug.id}`, undefined, w.owner.token);
  now = await ok(api, 200, "GET", `/views/${v.id}`, undefined, w.member.token);
  assert.deepEqual(now.query.label, ["other", "zed"]);
  assert.equal(now.updatedAt, v.updatedAt);
});

test("when a member leaves the team their private views are deleted; their shared views stay", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const priv = await mkView(api, w.team.id, w.member, { name: "private" });
  const shared = await mkView(api, w.team.id, w.member, { name: "shared", shared: true });
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.admin.token);
  const list = await ok(api, 200, "GET", `/teams/${w.team.id}/views`, undefined, w.admin.token);
  assert.deepEqual(list.items.map((v: any) => [v.id, v.ownerId]), [[shared.id, w.member.id]]);
  await ok(api, 201, "POST", `/teams/${w.team.id}/members`, { email: w.member.email, role: "member" }, w.owner.token);
  assertError(await api.call("GET", `/views/${priv.id}`, undefined, w.member.token), 404, "not_found");
});

test("PATCH replaces the query and moves updatedAt; view writes are audited as view.created, view.updated with fields, view.deleted", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  const v = await mkView(api, w.team.id, w.member, { query: { q: "a", priority: "high" } });
  clock.advance(1000);
  const p = await ok(api, 200, "PATCH", `/views/${v.id}`, { query: { label: ["X"] }, name: "renamed" }, w.member.token);
  assert.deepEqual([p.query, p.name, p.updatedAt, p.createdAt], [{ label: ["x"] }, "renamed", clock.iso(), v.createdAt]);
  assertError(await api.call("PATCH", `/views/${v.id}`, { query: { priority: "nope" } }, w.member.token), 400, "invalid_body");
  await ok(api, 204, "DELETE", `/views/${v.id}`, undefined, w.member.token);
  const entries = (await auditLog(api, w.owner.token, w.team.id)).slice(base);
  assert.deepEqual(entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.details]), [
    ["view.created", "view", v.id, w.member.id, {}],
    ["view.updated", "view", v.id, w.member.id, { fields: ["name", "query"] }],
    ["view.deleted", "view", v.id, w.member.id, {}],
  ]);
});

test("non-members get 404 for a team's views and for any view of it; a view of another team is invisible", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await setupBoard(api);
  const shared = await mkView(api, w.team.id, w.member, { shared: true });
  assertError(await api.call("GET", `/teams/${w.team.id}/views`, undefined, w.outsider.token), 404, "not_found");
  assertError(await api.call("POST", `/teams/${w.team.id}/views`, { name: "v", query: {} }, w.outsider.token), 404, "not_found");
  for (const path of [`/views/${shared.id}`, `/views/${shared.id}/cards`]) {
    assertError(await api.call("GET", path, undefined, other.owner.token), 404, "not_found", path);
  }
  assertError(await api.call("DELETE", `/views/${shared.id}`, undefined, other.owner.token), 404, "not_found");
  assertError(await api.call("GET", "/views/no-such-view", undefined, w.owner.token), 404, "not_found");
});
