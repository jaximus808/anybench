// Area `migration`: instruction.md sections 10.2-10.3, against the gate's own copy of the seeded
// 1.x file (fixtures/tracker-v1.json, identical to the workspace's input/fixtures/tracker-v1.json).
// Every expected value below is derived by hand from the fixture with the rules of section 10.3
// of workloads/project-tracker-xl/instruction.md.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { assertQuota, assertStatus, Clock, FIXTURE_V1, fixtureCopy, loadCreateApp, login, ok, signUp, startApp, type Api } from "./helpers.ts";

const T0 = Date.UTC(2025, 5, 1, 9, 0, 0);
const at = (offset: number): string => new Date(T0 + offset).toISOString();

const USERS: Record<string, { email: string; password: string; name: string; handle: string; createdAt: string }> = {
  u1: { email: "ada@example.com", password: "analytical-engine", name: "Ada Lovelace", handle: "ada", createdAt: at(-9000) },
  u2: { email: "grace.hopper+tracker@example.com", password: "compiler-1952", name: "Grace Hopper", handle: "grace_hopper_tracker", createdAt: at(-8000) },
  u3: { email: "ada@lovelace.test", password: "difference-engine", name: "Ada Byron", handle: "ada_2", createdAt: at(-7000) },
  u4: { email: "jo@example.com", password: "short-handle", name: "Jo Kim", handle: "jo_", createdAt: at(-6000) },
  u5: { email: "linus@example.com", password: "kernel-hacker", name: "Linus Torvalds", handle: "linus", createdAt: at(-5000) },
  u6: { email: "margaret.hamilton@apollo.example", password: "apollo-guidance", name: "Margaret Hamilton", handle: "margaret_hamilton", createdAt: at(-4000) },
  u7: { email: "outsider@example.com", password: "not-a-member", name: "Out Sider", handle: "outsider", createdAt: at(-3000) },
};

/** Starts an app on a fresh copy of the 1.x fixture, with a small fake clock for new records. */
async function migrated(t: TestContext): Promise<{ api: Api; file: string; as: (id: string) => Promise<string> }> {
  const file = fixtureCopy(t);
  const api = await startApp(t, { dataFile: file, now: () => 1000 });
  const tokens = new Map<string, string>();
  const as = async (id: string) => {
    if (!tokens.has(id)) tokens.set(id, await login(api, USERS[id]!.email, USERS[id]!.password));
    return tokens.get(id)!;
  };
  return { api, file, as };
}

test("a 1.x file is copied byte for byte to <dataFile>.v1.bak and rewritten as version 2 before createApp returns", async (t) => {
  const createApp = await loadCreateApp();
  const original = readFileSync(FIXTURE_V1);
  const file = fixtureCopy(t);
  const server = createApp({ dataFile: file, now: () => 1000 });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  // Not listening yet: the migration already happened.
  assert.ok(readFileSync(`${file}.v1.bak`).equals(original), "the .v1.bak is byte-identical to the 1.x file");
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(data.version, 2);
  for (const u of Object.values(USERS)) assert.ok(!readFileSync(file, "utf8").includes(u.password), "no plain-text password");
  // Loading the migrated file again is a plain version 2 load.
  const second = await startApp(t, { dataFile: file, now: () => 2000 });
  assert.ok(readFileSync(`${file}.v1.bak`).equals(original), "the backup is untouched by a version 2 load");
  const token = await login(second, USERS.u1!.email, USERS.u1!.password);
  assert.deepEqual((await ok(second, 200, "GET", "/teams", undefined, token)).items.map((x: any) => x.id), ["t1", "t2"]);
});

test("migrated users keep their ids and 1.x passwords; emails are trimmed and lowercased", async (t) => {
  const { api } = await migrated(t);
  for (const [id, u] of Object.entries(USERS)) {
    const login1 = await api.call("POST", "/auth/login", { email: u.email.toUpperCase(), password: u.password });
    assertStatus(login1, 200, `login ${id}`);
    const me = await ok(api, 200, "GET", "/me", undefined, login1.body.token);
    assert.deepEqual({ id: me.id, email: me.email, name: me.name, createdAt: me.createdAt }, { id, email: u.email, name: u.name, createdAt: u.createdAt }, id);
  }
  const wrong = await api.call("POST", "/auth/login", { email: USERS.u1!.email, password: USERS.u2!.password });
  assert.equal(wrong.status, 401);
  // New users get ids that do not collide with migrated ones.
  const fresh = await ok(api, 201, "POST", "/auth/register", { email: "new@example.test", password: "new-password", name: "New", handle: "newbie" });
  assert.ok(!Object.keys(USERS).includes(fresh.id), "a new id must not reuse a 1.x id");
  const dup = await api.call("POST", "/auth/register", { email: "ADA@example.com", password: "whatever-1", name: "Dup", handle: "dup" });
  assert.equal(dup.status, 409, "migrated emails are taken");
  assert.equal(dup.body?.error?.code, "email_taken");
});

test("handles are derived from emails in file order, with collisions (_2) and padding of short handles", async (t) => {
  const { api, as } = await migrated(t);
  for (const [id, u] of Object.entries(USERS)) {
    const me = await ok(api, 200, "GET", "/me", undefined, await as(id));
    assert.equal(me.handle, u.handle, `${id} (${u.email})`);
  }
  const taken = await api.call("POST", "/auth/register", { email: "x@example.test", password: "password-x", name: "X", handle: "ada_2" });
  assert.equal(taken.status, 409, "derived handles are taken");
  assert.equal(taken.body?.error?.code, "handle_taken");
});

test("teams, roles (manager/editor/reader) and members are migrated, owner first, on the defaultPlan; the audit log starts empty", async (t) => {
  const { api, as } = await migrated(t);
  const u1 = await as("u1");
  const teams = await ok(api, 200, "GET", "/teams", undefined, u1);
  assert.deepEqual(teams.items, [
    { id: "t1", name: "Analytical Engines", ownerId: "u1", plan: "free", createdAt: at(0), myRole: "owner" },
    { id: "t2", name: "Apollo", ownerId: "u6", plan: "free", createdAt: at(500), myRole: "viewer" },
  ]);
  const member = (id: string, role: string, joined: number) => ({
    userId: id,
    email: USERS[id]!.email,
    name: USERS[id]!.name,
    handle: USERS[id]!.handle,
    role,
    joinedAt: at(joined),
  });
  assert.deepEqual((await ok(api, 200, "GET", "/teams/t1/members", undefined, u1)).items, [
    member("u1", "owner", 0),
    member("u2", "admin", 100),
    member("u3", "member", 200),
    member("u4", "viewer", 300),
    member("u6", "member", 400),
  ]);
  assert.deepEqual((await ok(api, 200, "GET", "/teams/t2/members", undefined, u1)).items, [member("u6", "owner", 500), member("u5", "member", 600), member("u1", "viewer", 700)]);
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, await as("u7"))).items, []);
  assert.deepEqual((await ok(api, 200, "GET", "/teams/t1/audit", undefined, u1)).items, []);
  const p = await ok(api, 200, "GET", "/teams/t1/projects?archived=all", undefined, u1);
  assert.deepEqual(p.items, [
    { id: "p1", teamId: "t1", name: "Engine", key: "ENG", description: "", archived: false, createdAt: at(800), updatedAt: at(800) },
    { id: "p2", teamId: "t1", name: "Notes", key: "NOTE", description: "", archived: true, createdAt: at(850), updatedAt: at(850) },
  ]);
  // New teams come after migrated ones, whatever the clock says.
  const mine = await ok(api, 201, "POST", "/teams", { name: "Later" }, u1);
  assert.deepEqual((await ok(api, 200, "GET", "/teams", undefined, u1)).items.map((x: any) => x.id), ["t1", "t2", mine.id]);
  // t1 migrated with 5 members, the free limit: the quota applies to new members from now on.
  const extra = await signUp(api);
  assertQuota(await api.call("POST", "/teams/t1/members", { email: extra.email, role: "viewer" }, u1), "members", 5, 5);
  // defaultPlan is the plan of every migrated team.
  const biz = await startApp(t, { dataFile: fixtureCopy(t), now: () => 1000, defaultPlan: "business" });
  const bizTeams = await ok(biz, 200, "GET", "/teams", undefined, await login(biz, USERS.u1!.email, USERS.u1!.password));
  assert.deepEqual(bizTeams.items.map((x: any) => x.plan), ["business", "business"]);
});

test("boards get their columns, WIP limits and categories by position; cards land in their column, or the first one, ordered by `order`", async (t) => {
  const { api, as } = await migrated(t);
  const u1 = await as("u1");
  const b1 = await ok(api, 200, "GET", "/boards/b1", undefined, u1);
  assert.equal(b1.projectId, "p1");
  assert.equal(b1.name, "Main");
  assert.equal(b1.createdAt, at(950));
  assert.deepEqual(b1.columns.map((c: any) => [c.name, c.position, c.wipLimit, c.boardId, c.category]), [
    ["To do", 0, null, "b1", "todo"],
    ["Doing", 1, 2, "b1", "in_progress"],
    ["Done", 2, null, "b1", "done"],
  ]);
  const [todo, doing, done] = b1.columns.map((c: any) => c.id);
  const cards = (await ok(api, 200, "GET", "/boards/b1/cards", undefined, u1)).items;
  assert.deepEqual(cards.map((c: any) => [c.id, c.columnId, c.position]), [
    ["c6", todo, 0], // column "Review" does not exist: first column; order 0.25
    ["c2", todo, 1], // order 0.5
    ["c1", todo, 2], // order 1
    ["c4", doing, 0], // order 1
    ["c3", doing, 1], // order 2, earlier in the file than c5
    ["c5", doing, 2], // order 2; Doing starts above its limit of 2
    ["c8", done, 0], // order 5
    ["c7", done, 1], // order 10
  ]);
  const boards = (await ok(api, 200, "GET", "/projects/p1/boards", undefined, u1)).items;
  assert.deepEqual(boards.map((b: any) => b.id), ["b1", "b4"]);
  assert.deepEqual(boards[1].columns.map((c: any) => [c.name, c.position, c.wipLimit, c.category]), [
    ["Ideas", 0, null, "todo"],
    ["Reading", 1, null, "done"],
  ]);
  const b2 = await ok(api, 200, "GET", "/boards/b2", undefined, u1);
  assert.deepEqual(b2.columns.map((c: any) => c.category), ["todo", "done"]);
  assert.deepEqual((await ok(api, 200, "GET", "/boards/b4/cards", undefined, u1)).items.map((c: any) => [c.id, c.position]), [
    ["c11", 0],
    ["c9", 1],
    ["c10", 0],
  ]);
  const b3 = await ok(api, 200, "GET", "/boards/b3/cards", undefined, await as("u6"));
  assert.deepEqual(b3.items.map((c: any) => c.id), ["c14", "c17", "c15", "c16"]);
  assert.deepEqual((await ok(api, 200, "GET", "/boards/b3", undefined, await as("u6"))).columns.map((c: any) => c.category), ["todo", "in_progress", "done"]);
  // Migration did not enforce the limit, but new cards respect it.
  const blocked = await api.call("POST", `/cards/c1/move`, { columnId: doing }, u1);
  assert.equal(blocked.status, 409, "Doing is already over its limit");
  assert.equal(blocked.body?.error?.code, "wip_limit_reached");
});

test("card fields: labels from tags, dueDate from UTC timestamps, description from notes, assignee only for owner/admin/member, 2.0 defaults", async (t) => {
  const { api, as } = await migrated(t);
  const u1 = await as("u1");
  const u6 = await as("u6");
  const card = async (id: string, tok = u1) => ok(api, 200, "GET", `/cards/${id}`, undefined, tok);
  const todo = (await ok(api, 200, "GET", "/boards/b1", undefined, u1)).columns[0].id;
  assert.deepEqual(await card("c1"), {
    id: "c1",
    number: 1,
    key: "ENG-1",
    boardId: "b1",
    columnId: todo,
    position: 2,
    title: "Design the mill",
    description: "The mill performs arithmetic on numbers taken from the store.",
    assigneeId: "u3",
    labels: ["design", "mill"],
    dueDate: null,
    priority: "none",
    points: null,
    sprintId: null,
    customFields: {},
    checklist: { total: 0, done: 0 },
    blocked: false,
    completedAt: null,
    minutesLogged: 0,
    archived: false,
    archivedAt: null,
    createdBy: "u1",
    createdAt: at(1000),
    updatedAt: at(1000),
  });
  const expect: [string, Partial<Record<string, unknown>>, string?][] = [
    ["c2", { labels: ["io"], assigneeId: null, description: "" }], // u4 is a viewer (reader)
    ["c3", { labels: ["storage", "urgent"], assigneeId: "u2", dueDate: "2026-01-01" }],
    ["c4", { labels: [], assigneeId: "u3", dueDate: "2026-01-01", createdBy: "u2" }], // 23:30 UTC is still Jan 1
    ["c5", { labels: ["algorithm"], assigneeId: "u1" }],
    ["c6", { labels: ["printer", "review"], assigneeId: null }], // u7 is not a member
    ["c7", { labels: [], assigneeId: null, dueDate: null }],
    ["c8", { labels: ["procurement"], assigneeId: "u6", dueDate: "2025-07-15" }],
    ["c9", { labels: ["idea", "music"] }],
    ["c14", { labels: ["executive", "urgent"], assigneeId: "u5", dueDate: "2026-07-20" }, "u6"],
    ["c15", { labels: ["hardware"], assigneeId: null }, "u6"], // u1 is a viewer of t2
    ["c16", { labels: ["alarm", "urgent"], assigneeId: "u6" }, "u6"],
  ];
  for (const [id, want, who] of expect) {
    const got = await card(id, who === "u6" ? u6 : u1);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `${id}.${k}`);
  }
  // completedAt is the createdAt of cards in a done column (the last of several columns).
  const completed: [string, string | null, string?][] = [
    ["c7", at(6000)],
    ["c8", at(6000)],
    ["c10", at(7000)],
    ["c13", at(1100)],
    ["c16", at(1400), "u6"],
    ["c3", null],
    ["c9", null],
    ["c14", null, "u6"],
  ];
  for (const [id, want, who] of completed) assert.equal((await card(id, who === "u6" ? u6 : u1)).completedAt, want, `${id}.completedAt`);
  // Card history starts with one entry, at the card's createdAt.
  assert.deepEqual((await ok(api, 200, "GET", "/cards/c6/history", undefined, u1)).items, [{ fromColumnId: null, toColumnId: todo, at: at(5000) }]);
  // Archived 1.x projects stay archived and read-only.
  const c12 = await card("c12");
  assert.equal(c12.key, "NOTE-1");
  const frozen = await api.call("PATCH", "/cards/c12", { title: "x" }, u1);
  assert.equal(frozen.body?.error?.code, "project_archived");
});

test("card numbers follow createdAt per project, ties in file order; the next number continues and new cards sort last", async (t) => {
  const { api, as } = await migrated(t);
  const u1 = await as("u1");
  const u6 = await as("u6");
  const keyOf = async (id: string, tok: string) => (await ok(api, 200, "GET", `/cards/${id}`, undefined, tok)).key;
  const p1: [string, string][] = [
    ["c1", "ENG-1"],
    ["c9", "ENG-2"],
    ["c2", "ENG-3"],
    ["c5", "ENG-4"],
    ["c3", "ENG-5"],
    ["c4", "ENG-6"],
    ["c6", "ENG-7"],
    ["c7", "ENG-8"], // same createdAt as c8, earlier in the file
    ["c8", "ENG-9"],
    ["c10", "ENG-10"],
    ["c11", "ENG-11"],
  ];
  for (const [id, key] of p1) assert.equal(await keyOf(id, u1), key, id);
  for (const [id, key] of [["c12", "NOTE-1"], ["c13", "NOTE-2"]]) assert.equal(await keyOf(id!, u1), key, id);
  for (const [id, key] of [["c14", "AGC-1"], ["c15", "AGC-2"], ["c16", "AGC-3"], ["c17", "AGC-4"]]) assert.equal(await keyOf(id!, u6), key, id);
  const b1 = await ok(api, 200, "GET", "/boards/b1", undefined, u1);
  const fresh = await ok(api, 201, "POST", `/columns/${b1.columns[0].id}/cards`, { title: "after the migration" }, u1);
  assert.equal(fresh.number, 12);
  assert.equal(fresh.key, "ENG-12");
  assert.equal(fresh.position, 3);
  assert.ok(!["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12", "c13", "c14", "c15", "c16", "c17"].includes(fresh.id), "a new id must not reuse a 1.x id");
  const b3 = await ok(api, 200, "GET", "/boards/b3", undefined, u6);
  assert.equal((await ok(api, 201, "POST", `/columns/${b3.columns[1].id}/cards`, { title: "agc" }, u6)).key, "AGC-5");
  // Creation order: migrated cards by createdAt (ties in file order), then the new card, though its createdAt (1000 ms) is older.
  const all = await ok(api, 200, "GET", "/teams/t1/search?limit=100", undefined, u1);
  assert.deepEqual(all.items.map((c: any) => c.id), ["c1", "c9", "c2", "c5", "c3", "c4", "c6", "c7", "c8", "c10", "c11", fresh.id]);
});

test("comments keep parentId only for a parent on the same card, and mentions are recomputed with the migrated handles", async (t) => {
  const { api, as } = await migrated(t);
  const u1 = await as("u1");
  const u6 = await as("u6");
  const tree = (c: any): any => ({ id: c.id, parentId: c.parentId, authorId: c.authorId, body: c.body, mentions: c.mentions, deleted: c.deleted, replies: c.replies.map(tree) });
  const c3 = await ok(api, 200, "GET", "/cards/c3/comments", undefined, u1);
  assert.deepEqual(c3.items.map(tree), [
    {
      id: "m1",
      parentId: null,
      authorId: "u1",
      body: "@grace_hopper_tracker can you size the store? cc @ada_2",
      mentions: ["u2", "u3"],
      deleted: false,
      replies: [
        {
          id: "m2",
          parentId: "m1",
          authorId: "u2",
          body: "Sized at 1000 x 50 digits. @Ada see the notes.",
          mentions: ["u1"],
          deleted: false,
          replies: [{ id: "m3", parentId: "m2", authorId: "u3", body: "Thanks @grace_hopper_tracker", mentions: ["u2"], deleted: false, replies: [] }],
        },
      ],
    },
    { id: "m4", parentId: null, authorId: "u1", body: "Email me at ada@example.com, not @nobody_here", mentions: [], deleted: false, replies: [] },
  ]);
  const m1 = await ok(api, 200, "GET", "/comments/m1", undefined, u1);
  assert.equal(m1.createdAt, at(10000));
  assert.equal(m1.updatedAt, at(10000));
  assert.equal(m1.cardId, "c3");
  const c5 = await ok(api, 200, "GET", "/cards/c5/comments", undefined, u1);
  assert.deepEqual(c5.items.map((c: any) => [c.id, c.mentions]), [["m5", []], ["m6", []]], "self-mention and a non-member");
  const c14 = await ok(api, 200, "GET", "/cards/c14/comments", undefined, u6);
  assert.deepEqual(c14.items.map((c: any) => [c.id, c.parentId, c.mentions]), [["m7", null, ["u5"]], ["m8", null, []]], "m8 replied to a missing comment");
  const m9 = await ok(api, 200, "GET", "/comments/m9", undefined, u6);
  assert.deepEqual([m9.parentId, m9.mentions], [null, ["u6"]], "m9 replied to a comment on another card");
  assert.deepEqual((await ok(api, 200, "GET", "/comments/m10", undefined, u1)).mentions, ["u2"], "the author's own handle is ignored");
  const mentions = await ok(api, 200, "GET", "/me/mentions", undefined, await as("u2"));
  assert.deepEqual(mentions.items, [
    { commentId: "m10", cardId: "c1", teamId: "t1", authorId: "u4", createdAt: at(19000) },
    { commentId: "m3", cardId: "c3", teamId: "t1", authorId: "u3", createdAt: at(12000) },
    { commentId: "m1", cardId: "c3", teamId: "t1", authorId: "u1", createdAt: at(10000) },
  ]);
  assert.deepEqual((await ok(api, 200, "GET", "/me/mentions", undefined, await as("u5"))).items.map((m: any) => m.commentId), ["m7"]);
});

test("a migrated card gets a due job only when the start of its dueDate is later than now() at load", async (t) => {
  const clock = new Clock(Date.UTC(2026, 0, 1, 12, 0, 0));
  const api = await startApp(t, { dataFile: fixtureCopy(t), now: clock.now });
  const u1 = await login(api, USERS.u1!.email, USERS.u1!.password);
  const u6 = await login(api, USERS.u6!.email, USERS.u6!.password);
  // c3 and c4 are due 2026-01-01, which started before the load; c14 is due 2026-07-20.
  clock.set(Date.UTC(2026, 6, 20, 0, 0, 1));
  assertStatus(await api.call("GET", "/health"), 200);
  const t2 = await ok(api, 200, "GET", "/teams/t2/activity", undefined, u6);
  assert.deepEqual(t2.items.map((e: any) => [e.event, e.cardId, e.actorId, e.via, e.at]), [["card.due", "c14", null, { type: "schedule" }, clock.iso()]]);
  assert.deepEqual((await ok(api, 200, "GET", "/teams/t1/activity", undefined, u1)).items, [], "no due job for c3, c4 or c8; migration adds no activity");
  clock.advance(86_400_000);
  assertStatus(await api.call("GET", "/health"), 200);
  assert.equal((await ok(api, 200, "GET", "/teams/t2/activity", undefined, u6)).items.length, 1, "the job ran once");
});
