// Area `search`: instruction.md section 7 (Search): tokens, prefix match, score, filters, pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, collectPages, createBoard, createCard, createProject, ok, setupBoard, startApp, type Api, type User } from "./helpers.ts";

async function search(api: Api, u: User, teamId: string, query = ""): Promise<any> {
  return ok(api, 200, "GET", `/teams/${teamId}/search${query === "" ? "" : `?${query}`}`, undefined, u.token);
}
const ids = (res: any): string[] => res.items.map((c: any) => c.id);

test("q matches term prefixes in titles, descriptions and non-deleted comments; every term must match", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "Database migration plan" });
  const b = await createCard(api, w.cols[1], w.member, { title: "Ops", description: "Migrate the DATABASE tonight" });
  const c = await createCard(api, w.cols[2], w.member, { title: "Notes" });
  await ok(api, 201, "POST", `/cards/${c.id}/comments`, { body: "migration notes attached" }, w.member.token);
  const d = await createCard(api, w.cols[0], w.member, { title: "Unrelated" });
  const dead = await ok(api, 201, "POST", `/cards/${d.id}/comments`, { body: "migration database" }, w.member.token);
  assertStatusDelete(await api.call("DELETE", `/comments/${dead.id}`, undefined, w.member.token));
  const res = await search(api, w.viewer, w.team.id, "q=migra");
  assert.deepEqual(ids(res).sort(), [a.id, b.id, c.id].sort(), "deleted comments are not searched");
  assert.equal(res.total, 3);
  assert.deepEqual(ids(await search(api, w.viewer, w.team.id, "q=migra%20data")).sort(), [a.id, b.id].sort(), "every term must match");
  assert.deepEqual(ids(await search(api, w.viewer, w.team.id, "q=notes%20migration")), [c.id], "title and comment together");
  assert.deepEqual(ids(await search(api, w.viewer, w.team.id, "q=igration")), [], "infix is not a prefix");
  assert.deepEqual(ids(await search(api, w.viewer, w.team.id, "q=migrations")), [], "a term longer than the token");
  const item = res.items.find((x: any) => x.id === a.id);
  assert.deepEqual(item, await ok(api, 200, "GET", `/cards/${a.id}`, undefined, w.viewer.token), "items are full cards");
});

function assertStatusDelete(res: { status: number }): void {
  assert.equal(res.status, 204, "comment delete should answer 204");
}

test("score is the sum over terms of 3*t + d + c, highest first, ties by creation order", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const col = w.cols[0];
  const c1 = await createCard(api, col, w.member, { title: "alpha" }); // 3
  const c2 = await createCard(api, col, w.member, { title: "two", description: "alpha alpha, Alpha; ALPHA" }); // 4
  const c3 = await createCard(api, col, w.member, { title: "three" }); // c = 2
  await ok(api, 201, "POST", `/cards/${c3.id}/comments`, { body: "alpha" }, w.member.token);
  await ok(api, 201, "POST", `/cards/${c3.id}/comments`, { body: "alphabet soup" }, w.member.token);
  const dead = await ok(api, 201, "POST", `/cards/${c3.id}/comments`, { body: "alpha alpha alpha alpha" }, w.member.token);
  assertStatusDelete(await api.call("DELETE", `/comments/${dead.id}`, undefined, w.member.token));
  const c4 = await createCard(api, col, w.member, { title: "alpha", description: "alpha" }); // 4, after c2
  const c5 = await createCard(api, col, w.member, { title: "alphabetical alpha" }); // 6
  await createCard(api, col, w.member, { title: "beta only" });
  const res = await search(api, w.viewer, w.team.id, "q=alpha");
  assert.deepEqual(ids(res), [c5.id, c2.id, c4.id, c1.id, c3.id]);
  assert.equal(res.total, 5);
  const c7 = await createCard(api, col, w.member, { title: "alpha beta beta" }); // 3 + 6 = 9
  const c8 = await createCard(api, col, w.member, { title: "beta", description: "alpha" }); // 3 + 1 = 4
  assert.deepEqual(ids(await search(api, w.viewer, w.team.id, "q=bet%20alp")), [c7.id, c8.id]);
  assert.deepEqual(ids(await search(api, w.viewer, w.team.id, "q=alpha%20alpha")), [c5.id, c2.id, c4.id, c1.id, c7.id, c3.id, c8.id], "duplicate terms count once");
});

test("without q, and between equal scores, results come in card creation order", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c1 = await createCard(api, w.cols[2], w.member, { title: "same words" });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "same words" });
  const c3 = await createCard(api, w.cols[1], w.member, { title: "same words" });
  await ok(api, 200, "POST", `/cards/${c3.id}/move`, { columnId: w.cols[0], position: 0 }, w.member.token);
  await ok(api, 200, "POST", `/cards/${c1.id}/move`, { columnId: w.cols[0], position: 0 }, w.member.token);
  const other = await createBoard(api, w.project.id, w.owner);
  const c4 = await createCard(api, other.columns[0].id, w.member, { title: "different" });
  assert.deepEqual(ids(await search(api, w.member, w.team.id)), [c1.id, c2.id, c3.id, c4.id]);
  assert.deepEqual(ids(await search(api, w.member, w.team.id, "q=same")), [c1.id, c2.id, c3.id]);
  assert.equal((await search(api, w.member, w.team.id)).total, 4);
});

test("tokenizing lowercases and splits on every non-alphanumeric character; a q with no terms is no condition", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "Fix CI/CD-pipeline: v2!" });
  const b = await createCard(api, w.cols[0], w.member, { title: "café_au_lait" });
  const q = async (s: string) => ids(await search(api, w.viewer, w.team.id, `q=${encodeURIComponent(s)}`));
  assert.deepEqual(await q("cd"), [a.id]);
  assert.deepEqual(await q("PIPE"), [a.id]);
  assert.deepEqual(await q("ci/cd"), [a.id]);
  assert.deepEqual(await q("fix-ci v2"), [a.id]);
  assert.deepEqual(await q("pipelines"), []);
  assert.deepEqual(await q("ixx"), []);
  assert.deepEqual(await q("lait"), [b.id], "underscore splits");
  assert.deepEqual(await q("caf au"), [b.id], "é splits");
  assert.deepEqual(await q("!!!"), [a.id, b.id], "no terms: everything");
  assert.deepEqual(await q("   "), [a.id, b.id], "blank: everything");
  assert.deepEqual(ids(await search(api, w.viewer, w.team.id, "q=")), [a.id, b.id], "empty q");
});

test("projectId, boardId and columnId narrow the results; ids from elsewhere simply match nothing", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const b2 = await createBoard(api, w.project.id, w.owner);
  const p2 = await createProject(api, w.team.id, w.owner, "TWO");
  const b3 = await createBoard(api, p2.id, w.owner);
  const a = await createCard(api, w.cols[0], w.member, { title: "a" });
  const b = await createCard(api, w.cols[1], w.member, { title: "b" });
  const c = await createCard(api, b2.columns[0].id, w.member, { title: "c" });
  const d = await createCard(api, b3.columns[0].id, w.member, { title: "d" });
  const s = async (q: string) => ids(await search(api, w.viewer, w.team.id, q));
  assert.deepEqual(await s(`projectId=${w.project.id}`), [a.id, b.id, c.id]);
  assert.deepEqual(await s(`projectId=${p2.id}`), [d.id]);
  assert.deepEqual(await s(`boardId=${w.board.id}`), [a.id, b.id]);
  assert.deepEqual(await s(`columnId=${w.cols[1]}`), [b.id]);
  assert.deepEqual(await s(`projectId=${w.project.id}&boardId=${b3.id}`), [], "AND of conflicting filters");
  assert.deepEqual(await s("projectId=nope"), []);
  assert.deepEqual(await s("columnId=nope"), []);
  const otherTeam = await ok(api, 201, "POST", "/teams", { name: "Else" }, w.outsider.token);
  const op = await createProject(api, otherTeam.id, w.outsider, "ELSE");
  const ob = await createBoard(api, op.id, w.outsider);
  await createCard(api, ob.columns[0].id, w.outsider, { title: "a" });
  assert.deepEqual(await s(`projectId=${op.id}`), [], "another team's project");
  assert.deepEqual(await s(`boardId=${ob.id}&q=a`), []);
});

test("assigneeId filters by assignee, and assigneeId=none means unassigned", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "a", assigneeId: w.member.id });
  const b = await createCard(api, w.cols[0], w.member, { title: "b", assigneeId: w.admin.id });
  const c = await createCard(api, w.cols[0], w.member, { title: "c" });
  const d = await createCard(api, w.cols[1], w.member, { title: "d", assigneeId: w.member.id });
  await ok(api, 200, "PATCH", `/cards/${b.id}`, { assigneeId: null }, w.member.token);
  const s = async (q: string) => ids(await search(api, w.viewer, w.team.id, q));
  assert.deepEqual(await s(`assigneeId=${w.member.id}`), [a.id, d.id]);
  assert.deepEqual(await s("assigneeId=none"), [b.id, c.id]);
  assert.deepEqual(await s(`assigneeId=${w.admin.id}`), []);
  assert.deepEqual(await s("assigneeId=nobody"), []);
  assert.deepEqual(await s(`assigneeId=${w.member.id}&columnId=${w.cols[1]}`), [d.id]);
});

test("label may repeat; values are trimmed and lowercased and the card must have every label", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "a", labels: ["bug", "ui"] });
  const b = await createCard(api, w.cols[0], w.member, { title: "b", labels: ["Bug"] });
  const c = await createCard(api, w.cols[0], w.member, { title: "c", labels: ["ui", "ux"] });
  await createCard(api, w.cols[0], w.member, { title: "d" });
  const s = async (q: string) => ids(await search(api, w.viewer, w.team.id, q));
  assert.deepEqual(await s("label=bug"), [a.id, b.id]);
  assert.deepEqual(await s("label=bug&label=ui"), [a.id]);
  assert.deepEqual(await s("label=%20BUG%20"), [a.id, b.id]);
  assert.deepEqual(await s("label=ui&label=UX"), [c.id]);
  assert.deepEqual(await s("label=u"), [], "labels match exactly, not by prefix");
  assert.deepEqual(await s("label=bug&label=ux"), []);
});

test("dueFrom and dueTo are inclusive and exclude cards without a dueDate; bad dates are 400 invalid_query", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const d1 = await createCard(api, w.cols[0], w.member, { title: "d1", dueDate: "2026-01-01" });
  const d15 = await createCard(api, w.cols[0], w.member, { title: "d15", dueDate: "2026-01-15" });
  const d31 = await createCard(api, w.cols[0], w.member, { title: "d31", dueDate: "2026-01-31" });
  const none = await createCard(api, w.cols[0], w.member, { title: "none" });
  const dFeb = await createCard(api, w.cols[0], w.member, { title: "feb", dueDate: "2026-02-01" });
  const s = async (q: string) => ids(await search(api, w.viewer, w.team.id, q));
  assert.deepEqual(await s(""), [d1.id, d15.id, d31.id, none.id, dFeb.id]);
  assert.deepEqual(await s("dueFrom=2026-01-15"), [d15.id, d31.id, dFeb.id]);
  assert.deepEqual(await s("dueTo=2026-01-15"), [d1.id, d15.id]);
  assert.deepEqual(await s("dueFrom=2026-01-15&dueTo=2026-01-15"), [d15.id]);
  assert.deepEqual(await s("dueFrom=2026-01-02&dueTo=2026-01-31"), [d15.id, d31.id]);
  assert.deepEqual(await s("dueFrom=2026-03-01"), []);
  for (const q of ["dueFrom=2026-02-30", "dueTo=2026-1-5", "dueFrom=yesterday", "dueTo=2026-01-01T00:00:00Z"]) {
    assertError(await api.call("GET", `/teams/${w.team.id}/search?${q}`, undefined, w.viewer.token), 400, "invalid_query", q);
  }
});

test("cards of archived projects are searched only with includeArchived=true", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const live = await createCard(api, w.cols[0], w.member, { title: "rocket" });
  const old = await createProject(api, w.team.id, w.owner, "OLD");
  const oldBoard = await createBoard(api, old.id, w.owner);
  const frozen = await createCard(api, oldBoard.columns[0].id, w.member, { title: "rocket fuel" });
  await ok(api, 200, "PATCH", `/projects/${old.id}`, { archived: true }, w.owner.token);
  const s = async (q: string) => search(api, w.viewer, w.team.id, q);
  assert.deepEqual(ids(await s("q=rocket")), [live.id]);
  assert.deepEqual(ids(await s("q=rocket&includeArchived=false")), [live.id]);
  const withArchived = await s("q=rocket&includeArchived=true");
  assert.deepEqual(ids(withArchived), [live.id, frozen.id], "equal scores: creation order");
  assert.equal(withArchived.total, 2);
  assert.deepEqual(ids(await s(`projectId=${old.id}`)), [], "the filter alone does not include archived cards");
  assert.deepEqual(ids(await s(`projectId=${old.id}&includeArchived=true`)), [frozen.id]);
  for (const v of ["yes", "TRUE", "1"]) {
    assertError(await api.call("GET", `/teams/${w.team.id}/search?includeArchived=${v}`, undefined, w.viewer.token), 400, "invalid_query", `includeArchived=${v}`);
  }
});

test("cursor pagination visits every match exactly once, in order, with total on every page", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const words = ["task", "task task", "tasks", "other", "task", "task task task", "taskforce", "nope", "task"];
  for (const [i, title] of words.entries()) await createCard(api, w.cols[i % 3], w.member, { title });
  const full = await search(api, w.viewer, w.team.id, "q=task&limit=100");
  assert.equal(full.items.length, 7);
  assert.equal(full.total, 7);
  assert.equal(full.nextCursor, null);
  const { items, pages } = await collectPages(api, w.viewer.token, `/teams/${w.team.id}/search?q=task`, 3);
  assert.deepEqual(items.map((c: any) => c.id), ids(full));
  assert.deepEqual(pages.map((p) => p.items.length), [3, 3, 1]);
  for (const p of pages) assert.equal(p.total, 7, "total counts every page's matches");
  const firstDefault = await search(api, w.viewer, w.team.id);
  assert.equal(firstDefault.items.length, 9);
  assert.equal(firstDefault.total, 9);
  for (let i = 0; i < 14; i++) await createCard(api, w.cols[0], w.member, { title: `filler ${i}` });
  const def = await search(api, w.viewer, w.team.id);
  assert.equal(def.items.length, 20, "default limit 20");
  assert.equal(def.total, 23);
  assert.equal(typeof def.nextCursor, "string");
});

test("invalid queries answer 400 invalid_query: limit, cursor, q length and term count", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await createCard(api, w.cols[0], w.member, { title: "a b c d e f g h i j" });
  const path = `/teams/${w.team.id}/search`;
  const ten = "a b c d e f g h i j";
  const bad = ["limit=0", "limit=101", "limit=ten", "limit=1.5", "cursor=not-a-cursor", `q=${"x".repeat(201)}`, `q=${encodeURIComponent(`${ten} k`)}`];
  for (const q of bad) assertError(await api.call("GET", `${path}?${q}`, undefined, w.viewer.token), 400, "invalid_query", q.slice(0, 40));
  const okQueries = [`q=${"x".repeat(200)}`, `q=${encodeURIComponent(ten)}`, `q=${encodeURIComponent(`${ten} a B c`)}`, "limit=1", "limit=100"];
  for (const q of okQueries) {
    const res = await api.call("GET", `${path}?${q}`, undefined, w.viewer.token);
    assert.equal(res.status, 200, `${q.slice(0, 40)} should be accepted, got ${res.status} ${res.text.slice(0, 200)}`);
  }
  assert.deepEqual(ids(await search(api, w.viewer, w.team.id, `q=${encodeURIComponent(`${ten} a B c`)}`)).length, 1, "duplicates removed: 10 distinct terms");
});

test("search never returns another team's cards; viewers may search, non-members get 404", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const mine = await createCard(api, w.cols[0], w.member, { title: "shared word" });
  const otherTeam = await ok(api, 201, "POST", "/teams", { name: "Else" }, w.outsider.token);
  const op = await createProject(api, otherTeam.id, w.outsider, "ENG");
  const ob = await createBoard(api, op.id, w.outsider);
  const theirs = await createCard(api, ob.columns[0].id, w.outsider, { title: "shared word" });
  assert.deepEqual(ids(await search(api, w.viewer, w.team.id, "q=shared")), [mine.id]);
  assert.deepEqual(ids(await search(api, w.outsider, otherTeam.id, "q=shared")), [theirs.id]);
  assert.deepEqual(ids(await search(api, w.owner, w.team.id)), [mine.id]);
  assertError(await api.call("GET", `/teams/${otherTeam.id}/search?q=shared`, undefined, w.member.token), 404, "not_found", "not a member");
  assertError(await api.call("GET", `/teams/${w.team.id}/search?limit=0`, undefined, w.outsider.token), 404, "not_found", "visibility before query validation");
  assertError(await api.call("GET", "/teams/nope/search", undefined, w.owner.token), 404, "not_found");
});
