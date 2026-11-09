// Area `html`: instruction.md section 32 (HTML pages). Pages are checked for the elements and
// attributes the contract fixes; other markup may be added anywhere, so the checks look for those
// exact strings rather than comparing whole documents.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  assertError,
  Clock,
  createApiKey,
  createBoard,
  createCard,
  createProject,
  ok,
  type Res,
  setupBoard,
} from "./helpers.ts";
import { archive, comment, startApp } from "./helpers-pipeline.ts";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

async function page(api: Api, path: string, token: string): Promise<{ res: Res; title: string; body: string }> {
  const res = await api.call("GET", path, undefined, token);
  assert.equal(res.status, 200, `${path}: ${res.text.slice(0, 200)}`);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8", path);
  const text = res.text.trim();
  assert.ok(text.startsWith("<!doctype html>"), `${path}: starts with <!doctype html>`);
  for (const part of ['<html lang="en">', "<head>", '<meta charset="utf-8">', "</head>", "<body>", "</body>"]) assert.ok(text.includes(part), `${path}: has ${part}`);
  assert.ok(text.endsWith("</html>"), `${path}: ends with </html>`);
  const title = /<title>([^<]*)<\/title>/.exec(text)?.[1];
  assert.equal(typeof title, "string", `${path}: a <title>`);
  const body = text.slice(text.indexOf("<body>"), text.lastIndexOf("</body>"));
  return { res, title: title as string, body };
}

/** The board page's sections: column id, category, and the chunk of markup up to the next section. */
function sections(body: string): { id: string; category: string; html: string }[] {
  const re = /<section data-column-id="([^"]*)" data-category="([^"]*)">/g;
  const marks = [...body.matchAll(re)];
  return marks.map((m, i) => ({ id: m[1], category: m[2], html: body.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : body.length) }));
}

/** The li items of a board section: card id, key, and the markup up to the next li. */
function items(html: string): { id: string; key: string; html: string }[] {
  const marks = [...html.matchAll(/<li data-card-id="([^"]*)" data-key="([^"]*)">/g)];
  return marks.map((m, i) => ({ id: m[1], key: m[2], html: html.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : html.length) }));
}

/** The card page's dd fields in order: [name, inner html]. */
const ddFields = (body: string): [string, string][] => [...body.matchAll(/<dd data-field="([^"]*)">([\s\S]*?)<\/dd>/g)].map((m) => [m[1], m[2]]);

/** The comment tree of a card page as [commentId, parentCommentId | null] in document order. */
function commentTree(body: string): [string, string | null][] {
  const start = body.indexOf('<ol class="comments">');
  assert.ok(start >= 0, 'the card page has <ol class="comments">');
  const out: [string, string | null][] = [];
  const stack: string[] = [];
  let olDepth = 0;
  for (const m of body.slice(start).matchAll(/<ol\b[^>]*>|<\/ol>|<li data-comment-id="([^"]*)">|<\/li>/g)) {
    if (m[0].startsWith("<ol")) olDepth += 1;
    else if (m[0] === "</ol>") {
      olDepth -= 1;
      if (olDepth === 0) break;
    } else if (m[1] !== undefined) {
      out.push([m[1], stack.at(-1) ?? null]);
      stack.push(m[1]);
    } else stack.pop();
  }
  return out;
}

test("the board page: title '<board> · <key>', one section per column by position, cards by position with title, assignee and labels", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const a = await createCard(api, w.cols[0], w.member, { title: "Alpha", assigneeId: w.admin.id, labels: ["ui", "bug"] });
  const b = await createCard(api, w.cols[0], w.member, { title: "Beta", position: 0 });
  const c = await createCard(api, w.cols[2], w.member, { title: "Gamma", labels: ["x"] });
  await ok(api, 200, "PATCH", `/columns/${w.cols[2]}`, { position: 0 }, w.owner.token);
  const { title, body } = await page(api, `/html/boards/${w.board.id}`, w.viewer.token);
  assert.equal(title, "Board · ENG");
  const secs = sections(body);
  assert.deepEqual(secs.map((s) => [s.id, s.category]), [[w.cols[2], "done"], [w.cols[0], "todo"], [w.cols[1], "in_progress"]]);
  assert.ok(secs[1].html.includes("<h2>To do</h2>"));
  assert.ok(secs[0].html.includes("<h2>Done</h2>"));
  assert.deepEqual(items(secs[1].html).map((i) => [i.id, i.key]), [[b.id, b.key], [a.id, a.key]]);
  assert.deepEqual(items(secs[0].html).map((i) => i.id), [c.id]);
  assert.deepEqual(items(secs[2].html), []);
  const alpha = items(secs[1].html)[1].html;
  const order = ['<span class="title">Alpha</span>', `<span class="assignee" data-user-id="${w.admin.id}">@${w.admin.handle}</span>`, '<span class="label">bug</span>', '<span class="label">ui</span>'].map((s) => alpha.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `the Alpha item has its spans: ${alpha.slice(0, 400)}`);
  assert.deepEqual([...order].sort((x, y) => x - y), order, "title, then assignee, then labels in order");
  const beta = items(secs[1].html)[0].html;
  assert.ok(!beta.includes('class="assignee"') && !beta.includes('class="label"'), "no assignee or label spans for an unassigned, unlabelled card");
});

test("the board page leaves archived cards out", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const kept = await createCard(api, w.cols[0], w.member, { title: "kept" });
  const gone = await createCard(api, w.cols[0], w.member, { title: "gone" });
  await archive(api, gone.id, w.member);
  const { body } = await page(api, `/html/boards/${w.board.id}`, w.member.token);
  assert.deepEqual(items(sections(body)[0].html).map((i) => i.id), [kept.id]);
  assert.ok(!body.includes(gone.id));
});

test("the card page: title '<key> <title>', an article with h1 and the dl fields column, assignee, priority, points, dueDate, labels in order", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[1], w.member, { title: "Fix it", assigneeId: w.member.id, labels: ["ui", "bug"], priority: "high", points: 5, dueDate: "2026-04-01" });
  const { title, body } = await page(api, `/html/cards/${card.id}`, w.viewer.token);
  assert.equal(title, `${card.key} Fix it`);
  assert.ok(body.includes(`<article data-card-id="${card.id}">`));
  assert.ok(body.includes("<h1>Fix it</h1>"));
  assert.deepEqual(ddFields(body), [["column", "In progress"], ["assignee", `@${w.member.handle}`], ["priority", "high"], ["points", "5"], ["dueDate", "2026-04-01"], ["labels", "bug, ui"]]);
  const bare = await createCard(api, w.cols[0], w.member, { title: "Bare" });
  assert.deepEqual(ddFields((await page(api, `/html/cards/${bare.id}`, w.viewer.token)).body), [["column", "To do"], ["assignee", ""], ["priority", "none"], ["points", ""], ["dueDate", ""], ["labels", ""]]);
});

test("the card page writes the description escaped, each newline as <br>", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "d", description: "first <line>\nsecond & last\n\nend" });
  const { body } = await page(api, `/html/cards/${card.id}`, w.member.token);
  const desc = /<div class="description">([\s\S]*?)<\/div>/.exec(body)?.[1];
  assert.equal(desc, "first &lt;line&gt;<br>second &amp; last<br><br>end");
});

test("the card page holds the comment trees, oldest first, replies nested to any depth, a deleted comment shown as <em>deleted</em>", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const a = await comment(api, card.id, w.member, "first");
  clock.advance(1000);
  const b = await comment(api, card.id, w.admin, "second <b>");
  clock.advance(1000);
  const a1 = await comment(api, card.id, w.admin, "reply to first", a.id);
  clock.advance(1000);
  const a11 = await comment(api, card.id, w.member, "deeper", a1.id);
  clock.advance(1000);
  const a2 = await comment(api, card.id, w.owner, "another reply", a.id);
  await ok(api, 204, "DELETE", `/comments/${a1.id}`, undefined, w.admin.token);
  const { body } = await page(api, `/html/cards/${card.id}`, w.viewer.token);
  assert.deepEqual(commentTree(body), [[a.id, null], [a1.id, a.id], [a11.id, a1.id], [a2.id, a.id], [b.id, null]]);
  assert.ok(body.includes('<p class="body">second &lt;b&gt;</p>'));
  assert.ok(body.includes('<p class="body"><em>deleted</em></p>'));
  assert.ok(!body.includes("reply to first"), "a deleted comment's body is gone");
  assert.ok(body.includes('<p class="body">deeper</p>'));
});

test("escaping: & < > \" ' become &amp; &lt; &gt; &quot; &#39; in titles and text, and nothing else is replaced", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const name = `Tom & Jerry's <b> "board"`;
  const board = await createBoard(api, w.project.id, w.owner, { name, columns: [`Col <1> & "two"`] });
  const cardTitle = "a/b=c é `x` ; # % <script>alert('x')</script>";
  const card = await createCard(api, board.columns[0].id, w.member, { title: cardTitle, labels: [`<b>&"'`] });
  const bp = await page(api, `/html/boards/${board.id}`, w.member.token);
  assert.equal(bp.title, `${esc(name)} · ENG`);
  assert.equal(bp.title, "Tom &amp; Jerry&#39;s &lt;b&gt; &quot;board&quot; · ENG");
  assert.ok(bp.body.includes(`<h2>Col &lt;1&gt; &amp; &quot;two&quot;</h2>`));
  assert.ok(bp.body.includes(`<span class="title">${esc(cardTitle)}</span>`));
  assert.ok(bp.body.includes(`<span class="label">&lt;b&gt;&amp;&quot;&#39;</span>`));
  assert.ok(!bp.body.includes("<script>"), "user text never becomes markup");
  const cp = await page(api, `/html/cards/${card.id}`, w.member.token);
  assert.equal(cp.title, `${card.key} a/b=c é \`x\` ; # % &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;`);
  assert.ok(cp.body.includes(`<h1>${esc(cardTitle)}</h1>`));
});

test("the summary page: title 'Summary · <key>' and a summary table row per category with the summary report's counts", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await createCard(api, w.cols[0], w.member, { title: "a" });
  await createCard(api, w.cols[0], w.member, { title: "b" });
  await createCard(api, w.cols[2], w.member, { title: "c" });
  const gone = await createCard(api, w.cols[1], w.member, { title: "archived" });
  await archive(api, gone.id, w.member);
  const { title, body } = await page(api, `/html/projects/${w.project.id}/summary`, w.viewer.token);
  assert.equal(title, "Summary · ENG");
  assert.ok(body.includes('<table data-report="summary">'));
  const rows = [...body.matchAll(/<tr data-category="([^"]*)"><th>([^<]*)<\/th><td>([^<]*)<\/td><\/tr>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(rows, [["todo", "todo", "2"], ["in_progress", "in_progress", "0"], ["done", "done", "1"]]);
});

test("the notifications page lists the caller's visible notifications newest first with type and read state, at most 50", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupBoard(api, clock);
  const card = await createCard(api, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  clock.advance(1000);
  await comment(api, card.id, w.owner, `hi @${w.member.handle}`);
  const list = (await ok(api, 200, "GET", "/me/notifications", undefined, w.member.token)).items;
  await ok(api, 200, "POST", `/me/notifications/${list[1].id}/read`, undefined, w.member.token);
  const { title, body } = await page(api, "/html/me/notifications", w.member.token);
  assert.equal(title, "Notifications");
  assert.ok(body.includes('<ul data-notifications="">'));
  const lis = [...body.matchAll(/<li data-notification-id="([^"]*)" data-type="([^"]*)" data-read="([^"]*)">/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(lis, [[list[0].id, "mention", "false"], [list[1].id, "assigned", "true"]]);
  for (let i = 0; i < 52; i++) await createCard(api, w.cols[0], w.owner, { title: `n${i}`, assigneeId: w.member.id });
  const many = await page(api, "/html/me/notifications", w.member.token);
  const ids = [...many.body.matchAll(/<li data-notification-id="([^"]*)"/g)].map((m) => m[1]);
  const newest = (await ok(api, 200, "GET", "/me/notifications?limit=50", undefined, w.member.token)).items.map((n: any) => n.id);
  assert.deepEqual(ids, newest);
});

test("HTML routes answer errors as JSON: 401 without a token, 404 for unknown or invisible resources", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const unauth = await api.call("GET", `/html/boards/${w.board.id}`);
  assertError(unauth, 401, "unauthorized");
  assert.match(unauth.headers.get("content-type") ?? "", /^application\/json/);
  for (const path of [`/html/boards/${w.board.id}`, `/html/cards/${card.id}`, `/html/projects/${w.project.id}/summary`]) {
    const res = await api.call("GET", path, undefined, w.outsider.token);
    assertError(res, 404, "not_found", path);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/, path);
  }
  assertError(await api.call("GET", "/html/cards/no-such-card", undefined, w.owner.token), 404, "not_found");
  assertError(await api.call("GET", "/html/boards/no-such-board", undefined, w.owner.token), 404, "not_found");
});

test("pages authenticate like any route: a read API key gets them, and the board page of another project is reachable by its own id only", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const ob = await createBoard(api, ops.id, w.owner, { name: "Ops" });
  const key = (await createApiKey(api, w.viewer, { scope: "read" })).secret;
  const { title } = await page(api, `/html/boards/${ob.id}`, key);
  assert.equal(title, "Ops · OPS");
  await page(api, "/html/me/notifications", key);
  const card = await createCard(api, ob.columns[0].id, w.member, { title: "o" });
  assert.equal((await page(api, `/html/cards/${card.id}`, key)).title, `OPS-1 o`);
});

test("the card page shows a deleted comment that has replies with the replies kept, and a card without comments has an empty comments list", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  assert.deepEqual(commentTree((await page(api, `/html/cards/${card.id}`, w.member.token)).body), []);
  const top = await comment(api, card.id, w.member, "top");
  const reply = await comment(api, card.id, w.admin, "reply", top.id);
  await ok(api, 204, "DELETE", `/comments/${top.id}`, undefined, w.member.token);
  const { body } = await page(api, `/html/cards/${card.id}`, w.member.token);
  assert.deepEqual(commentTree(body), [[top.id, null], [reply.id, top.id]]);
  assert.ok(body.includes('<p class="body"><em>deleted</em></p>') && body.includes('<p class="body">reply</p>'));
});

test("the notifications page shows only visible notifications: those of a team the caller left disappear, invitations always show", async (t) => {
  const api = await startApp(t, { defaultPlan: "team" });
  const w = await setupBoard(api);
  await createCard(api, w.cols[0], w.owner, { title: "c", assigneeId: w.member.id });
  const other = await ok(api, 201, "POST", "/teams", { name: "Other" }, w.admin.token);
  await ok(api, 201, "POST", `/teams/${other.id}/invites`, { email: w.member.email, role: "viewer" }, w.admin.token);
  const typesOn = async () => [...(await page(api, "/html/me/notifications", w.member.token)).body.matchAll(/data-type="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(await typesOn(), ["invite", "assigned"]);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.member.id}`, undefined, w.member.token);
  assert.deepEqual(await typesOn(), ["invite"]);
});
