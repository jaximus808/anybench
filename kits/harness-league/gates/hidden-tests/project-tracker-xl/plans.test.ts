// Area `plans`: instruction.md section 13 (Plans and quotas), with the conventions of section 0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  type Api,
  addMember,
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
  FIXTURE_V1,
  fixtureCopy,
  login,
  ok,
  type Res,
  setupBoard,
  setupTeam,
  signUp,
  startApp,
  upload,
  type User,
} from "./helpers.ts";

const LIMIT_KEYS = ["projects", "cards", "members", "webhooks", "rules", "recurrences", "storageBytes"];
const FREE = { projects: 3, cards: 100, members: 5, webhooks: 2, rules: 3, recurrences: 2, storageBytes: 1048576 };
const TEAM = { projects: 20, cards: 5000, members: 50, webhooks: 10, rules: 50, recurrences: 20, storageBytes: 104857600 };
const BUSINESS = { projects: null, cards: null, members: null, webhooks: null, rules: null, recurrences: null, storageBytes: null };

const usage = (o: Partial<Record<string, number>> = {}) => ({ projects: 0, cards: 0, members: 1, webhooks: 0, rules: 0, recurrences: 0, storageBytes: 0, ...o });

const planOf = (api: Api, teamId: string, token: string): Promise<any> => ok(api, 200, "GET", `/teams/${teamId}/plan`, undefined, token);
const putPlan = (api: Api, teamId: string, plan: unknown, by: User | string, headers?: Record<string, string>): Promise<Res> =>
  api.call("PUT", `/teams/${teamId}/plan`, { plan }, typeof by === "string" ? by : by.token, headers ? { headers } : {});

const RULE = { trigger: { event: "card.due" }, actions: [{ type: "set_priority", priority: "low" }] };
const recurrence = (columnId: string, extra: Record<string, unknown> = {}) => ({
  columnId,
  schedule: { frequency: "daily", time: "09:00" },
  startDate: "2026-06-01",
  title: "Recurring",
  ...extra,
});

test("GET /plans is public and lists free, team and business with exactly the limits table, keys in table order", async (t) => {
  const api = await startApp(t);
  const res = await api.call("GET", "/plans");
  assertStatus(res, 200);
  assert.deepEqual(res.body, {
    items: [
      { id: "free", limits: FREE },
      { id: "team", limits: TEAM },
      { id: "business", limits: BUSINESS },
    ],
  });
  for (const p of res.body.items) assert.deepEqual(Object.keys(p.limits), LIMIT_KEYS, `${p.id} key order`);
  const u = await signUp(api);
  assert.deepEqual((await ok(api, 200, "GET", "/plans", undefined, u.token)).items.map((p: any) => p.id), ["free", "team", "business"]);
});

test("GET /teams/:teamId/plan answers plan, limits and usage with the seven keys in table order; a new team is on the free plan", async (t) => {
  const api = await startApp(t);
  const owner = await signUp(api);
  const outsider = await signUp(api);
  const team = await ok(api, 201, "POST", "/teams", { name: "T" }, owner.token);
  assert.equal(team.plan, "free");
  const p = await planOf(api, team.id, owner.token);
  assert.deepEqual(p, { plan: "free", limits: FREE, usage: usage() });
  assert.deepEqual(Object.keys(p), ["plan", "limits", "usage"]);
  assert.deepEqual(Object.keys(p.limits), LIMIT_KEYS);
  assert.deepEqual(Object.keys(p.usage), LIMIT_KEYS);
  assertError(await api.call("GET", `/teams/${team.id}/plan`, undefined, outsider.token), 404, "not_found");
  assertError(await api.call("GET", `/teams/${team.id}/plan`), 401, "unauthorized");
});

test("the defaultPlan option is the plan of every new team, shown on the team and its plan", async (t) => {
  const api = await startApp(t, { defaultPlan: "team" });
  const w = await setupTeam(api);
  assert.equal(w.team.plan, "team");
  const listed = await ok(api, 200, "GET", "/teams", undefined, w.viewer.token);
  assert.deepEqual(listed.items.map((x: any) => x.plan), ["team"]);
  const p = await planOf(api, w.team.id, w.viewer.token);
  assert.equal(p.plan, "team");
  assert.deepEqual(p.limits, TEAM);
  assert.deepEqual(p.usage, usage({ members: 4 }));
});

test("defaultPlan applies to migrated teams, whose usage is counted from the 1.x data and whose quotas apply from then on", async (t) => {
  const v1 = JSON.parse(readFileSync(FIXTURE_V1, "utf8"));
  const projects = v1.projects.filter((p: any) => p.teamId === "t1").map((p: any) => p.id);
  const boards = v1.boards.filter((b: any) => projects.includes(b.projectId)).map((b: any) => b.id);
  const cards = v1.cards.filter((c: any) => boards.includes(c.boardId)).length;
  const members = 1 + v1.teams.find((x: any) => x.id === "t1").members.length;
  const free = await startApp(t, { dataFile: fixtureCopy(t) });
  const ada = await login(free, "ada@example.com", "analytical-engine");
  const p = await planOf(free, "t1", ada);
  assert.equal(p.plan, "free");
  assert.deepEqual(p.usage, usage({ projects: projects.length, cards, members }));
  assert.equal(members, 5);
  const linus = await login(free, "linus@example.com", "kernel-hacker");
  const linusEmail = (await ok(free, 200, "GET", "/me", undefined, linus)).email;
  assertQuota(await free.call("POST", "/teams/t1/members", { email: linusEmail, role: "member" }, ada), "members", 5, 5);
  const business = await startApp(t, { dataFile: fixtureCopy(t), defaultPlan: "business" });
  const ada2 = await login(business, "ada@example.com", "analytical-engine");
  assert.equal((await planOf(business, "t1", ada2)).plan, "business");
  assert.deepEqual((await ok(business, 200, "GET", "/teams", undefined, ada2)).items.map((x: any) => x.plan), ["business", "business"]);
  assertStatus(await business.call("POST", "/teams/t1/members", { email: linusEmail, role: "member" }, ada2), 201);
});

test("usage counts archived projects and cards, inactive webhooks, disabled rules and inactive recurrences", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  await createCard(api, opsBoard.columns[0].id, w.member, { title: "in archived project" });
  await createCard(api, w.cols[0], w.member, { title: "live" });
  const shelved = await createCard(api, w.cols[0], w.member, { title: "shelved" });
  await ok(api, 200, "POST", `/cards/${shelved.id}/archive`, undefined, w.member.token);
  await ok(api, 200, "PATCH", `/projects/${ops.id}`, { archived: true }, w.owner.token);
  await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: "http://127.0.0.1:9/a", events: ["*"], active: false }, w.owner.token);
  await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: "http://127.0.0.1:9/b", events: ["card.created"] }, w.owner.token);
  await createRule(api, w.team.id, w.admin, { ...RULE, enabled: false });
  await createRule(api, w.team.id, w.admin, RULE);
  await ok(api, 201, "POST", `/boards/${w.board.id}/recurrences`, recurrence(w.cols[0], { active: false }), w.owner.token);
  await ok(api, 201, "POST", `/boards/${w.board.id}/recurrences`, recurrence(w.cols[0]), w.owner.token);
  const p = await planOf(api, w.team.id, w.viewer.token);
  assert.deepEqual(p.usage, { projects: 2, cards: 3, members: 4, webhooks: 2, rules: 2, recurrences: 2, storageBytes: 0 });
});

test("storageBytes is the size of the distinct sha256 values among the team's attachments; a delete frees bytes only when no copy is left", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const other = await setupBoard(api);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1" });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "c2" });
  const elsewhere = await createCard(api, other.cols[0], other.member, { title: "e" });
  const a = new Uint8Array(100).fill(1);
  const b = new Uint8Array(50).fill(2);
  const a1 = await upload(api, c1.id, w.member.token, a, "a.bin");
  const a2 = await upload(api, c2.id, w.member.token, a, "a-copy.bin");
  const b1 = await upload(api, c2.id, w.member.token, b, "b.bin");
  for (const r of [a1, a2, b1]) assertStatus(r, 201);
  assertStatus(await upload(api, elsewhere.id, other.member.token, new Uint8Array(70).fill(3)), 201);
  const storage = async () => (await planOf(api, w.team.id, w.member.token)).usage.storageBytes;
  assert.equal(await storage(), 150);
  await ok(api, 204, "DELETE", `/attachments/${a1.body.id}`, undefined, w.member.token);
  assert.equal(await storage(), 150, "another attachment still holds those bytes");
  await ok(api, 204, "DELETE", `/attachments/${a2.body.id}`, undefined, w.member.token);
  assert.equal(await storage(), 50);
  assert.equal((await planOf(api, other.team.id, other.member.token)).usage.storageBytes, 70);
});

test("the projects quota: a free team's fourth project is 409 quota_exceeded, checked after validation and key_taken, archived projects counting", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/projects`;
  await createProject(api, w.team.id, w.owner, "AAA");
  const b = await createProject(api, w.team.id, w.owner, "BBB");
  const c = await createProject(api, w.team.id, w.owner, "CCC");
  await ok(api, 200, "PATCH", `/projects/${b.id}`, { archived: true }, w.owner.token);
  assertError(await api.call("POST", path, { name: "D", key: "bad" }, w.owner.token), 400, "invalid_body", "validation first");
  assertError(await api.call("POST", path, { name: "D", key: "BBB" }, w.owner.token), 409, "key_taken", "key_taken before the quota");
  assertQuota(await api.call("POST", path, { name: "D", key: "DDD" }, w.owner.token), "projects", 3, 3);
  const list = await ok(api, 200, "GET", `${path}?archived=all`, undefined, w.owner.token);
  assert.equal(list.items.length, 3, "nothing was created");
  await ok(api, 204, "DELETE", `/projects/${c.id}`, undefined, w.owner.token);
  await createProject(api, w.team.id, w.owner, "DDD");
  assert.equal((await planOf(api, w.team.id, w.owner.token)).usage.projects, 3);
});

test("the cards quota counts every card of the team, archived ones included, and comes before wip_limit_reached, also on template instantiation", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const ops = await createProject(api, w.team.id, w.owner, "OPS");
  const opsBoard = await createBoard(api, ops.id, w.owner);
  await createCard(api, opsBoard.columns[0].id, w.member, { title: "ops card" });
  await ok(api, 200, "PATCH", `/columns/${w.cols[1]}`, { wipLimit: 1 }, w.owner.token);
  await createCard(api, w.cols[1], w.member, { title: "fills the wip column" });
  const made: any[] = [];
  for (let i = 0; i < 98; i++) made.push(await createCard(api, w.cols[0], w.member, { title: `c${i}` }));
  await ok(api, 200, "POST", `/cards/${made[0].id}/archive`, undefined, w.member.token);
  assert.equal((await planOf(api, w.team.id, w.member.token)).usage.cards, 100);
  const tpl = await ok(api, 201, "POST", `/projects/${w.project.id}/templates`, { name: "T", title: "From template" }, w.owner.token);
  assertError(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "" }, w.member.token), 400, "invalid_body", "validation first");
  assertQuota(await api.call("POST", `/columns/${w.cols[0]}/cards`, { title: "101st" }, w.member.token), "cards", 100, 100);
  assertQuota(await api.call("POST", `/columns/${w.cols[1]}/cards`, { title: "101st" }, w.member.token), "cards", 100, 100, "quota before WIP");
  assertQuota(await api.call("POST", `/templates/${tpl.id}/cards`, { columnId: w.cols[0] }, w.member.token), "cards", 100, 100, "template");
  await ok(api, 204, "DELETE", `/cards/${made[0].id}`, undefined, w.member.token);
  await createCard(api, w.cols[0], w.member, { title: "fits again" });
  assertError(await api.call("POST", `/columns/${w.cols[1]}/cards`, { title: "wip" }, w.member.token), 409, "quota_exceeded");
});

test("the members quota: a free team holds 5 members; it is checked after user_not_found and already_member", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const fifth = await signUp(api);
  const sixth = await signUp(api);
  const path = `/teams/${w.team.id}/members`;
  await addMember(api, w.team.id, w.owner, fifth, "member");
  assertError(await api.call("POST", path, { email: sixth.email, role: "owner" }, w.owner.token), 400, "invalid_body", "validation first");
  assertError(await api.call("POST", path, { email: "nobody@example.test", role: "member" }, w.owner.token), 404, "user_not_found");
  assertError(await api.call("POST", path, { email: fifth.email, role: "member" }, w.owner.token), 409, "already_member");
  assertQuota(await api.call("POST", path, { email: sixth.email, role: "viewer" }, w.admin.token), "members", 5, 5);
  assert.equal((await ok(api, 200, "GET", path, undefined, w.owner.token)).items.length, 5);
  await ok(api, 204, "DELETE", `/teams/${w.team.id}/members/${w.viewer.id}`, undefined, w.owner.token);
  await addMember(api, w.team.id, w.owner, sixth, "viewer");
  assert.equal((await planOf(api, w.team.id, w.owner.token)).usage.members, 5);
});

test("pending invitations count toward the members quota on create, not counting one to the same email; accept checks the members alone", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const x = await signUp(api);
  const y = await signUp(api);
  const path = `/teams/${w.team.id}/invites`;
  await ok(api, 201, "POST", path, { email: x.email, role: "member" }, w.owner.token);
  assertQuota(await api.call("POST", path, { email: y.email, role: "member" }, w.owner.token), "members", 5, 5, "4 members + 1 pending");
  const again = await ok(api, 201, "POST", path, { email: x.email, role: "viewer" }, w.owner.token);
  assert.equal((await planOf(api, w.team.id, w.owner.token)).usage.members, 4, "pending invitations are not members");
  const member = await ok(api, 200, "POST", `/invites/${again.token}/accept`, undefined, x.token);
  assert.equal(member.userId, x.id);
  assert.equal(member.role, "viewer");
  assert.equal((await planOf(api, w.team.id, w.owner.token)).usage.members, 5);
  assertQuota(await api.call("POST", path, { email: y.email, role: "member" }, w.owner.token), "members", 5, 5, "5 members");
});

test("the webhooks quota is checked after validation: a free team holds 2 webhooks, inactive ones included", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/webhooks`;
  const first = await ok(api, 201, "POST", path, { url: "http://127.0.0.1:9/a", events: ["*"], active: false }, w.admin.token);
  await ok(api, 201, "POST", path, { url: "http://127.0.0.1:9/b", events: ["*"] }, w.admin.token);
  assertError(await api.call("POST", path, { url: "not a url", events: ["*"] }, w.admin.token), 400, "invalid_body");
  assertError(await api.call("POST", path, { url: "http://127.0.0.1:9/c", events: ["card.exploded"] }, w.admin.token), 400, "invalid_body");
  assertQuota(await api.call("POST", path, { url: "http://127.0.0.1:9/c", events: ["*"] }, w.admin.token), "webhooks", 2, 2);
  await ok(api, 204, "DELETE", `/webhooks/${first.id}`, undefined, w.admin.token);
  await ok(api, 201, "POST", path, { url: "http://127.0.0.1:9/c", events: ["*"] }, w.admin.token);
});

test("the rules quota is checked after validation: a free team holds 3 rules, disabled ones included", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const path = `/teams/${w.team.id}/rules`;
  const first = await createRule(api, w.team.id, w.admin, { ...RULE, enabled: false });
  await createRule(api, w.team.id, w.admin, RULE);
  await createRule(api, w.team.id, w.owner, RULE);
  assertError(await api.call("POST", path, { name: "r", trigger: { event: "card.exploded" }, actions: RULE.actions }, w.admin.token), 400, "invalid_body");
  assertQuota(await api.call("POST", path, { name: "r", ...RULE }, w.admin.token), "rules", 3, 3);
  await ok(api, 204, "DELETE", `/rules/${first.id}`, undefined, w.admin.token);
  await createRule(api, w.team.id, w.admin, RULE);
  assert.equal((await planOf(api, w.team.id, w.admin.token)).usage.rules, 3);
});

test("the recurrences quota is checked after validation: a free team holds 2 recurrences, inactive ones included", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const path = `/boards/${w.board.id}/recurrences`;
  const first = await ok(api, 201, "POST", path, recurrence(w.cols[0], { active: false }), w.owner.token);
  await ok(api, 201, "POST", path, recurrence(w.cols[1]), w.owner.token);
  assertError(await api.call("POST", path, recurrence(w.cols[0], { schedule: { frequency: "hourly", time: "09:00" } }), w.owner.token), 400, "invalid_body");
  assertQuota(await api.call("POST", path, recurrence(w.cols[0]), w.owner.token), "recurrences", 2, 2);
  await ok(api, 204, "DELETE", `/recurrences/${first.id}`, undefined, w.owner.token);
  await ok(api, 201, "POST", path, recurrence(w.cols[0]), w.owner.token);
});

test("the storageBytes quota: an upload that would pass 1 MiB is quota_exceeded, but bytes the team already stores always pass", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  const c1 = await createCard(api, w.cols[0], w.member, { title: "c1" });
  const c2 = await createCard(api, w.cols[0], w.member, { title: "c2" });
  const big = new Uint8Array(700_000).fill(7);
  assertStatus(await upload(api, c1.id, w.member.token, big, "big.bin"), 201);
  const other = new Uint8Array(400_000).fill(8);
  assertQuota(await upload(api, c2.id, w.member.token, other, "other.bin"), "storageBytes", 1048576, 700000);
  assertStatus(await upload(api, c2.id, w.member.token, big, "same-bytes.bin"), 201, "no new bytes");
  assertStatus(await upload(api, c2.id, w.member.token, new Uint8Array(348_576).fill(9), "exact.bin"), 201, "exactly the limit is fine");
  assert.equal((await planOf(api, w.team.id, w.member.token)).usage.storageBytes, 1048576);
  assertQuota(await upload(api, c2.id, w.member.token, new Uint8Array(1).fill(1), "one.bin"), "storageBytes", 1048576, 1048576);
  const list = await ok(api, 200, "GET", `/cards/${c2.id}/attachments`, undefined, w.member.token);
  assert.deepEqual(list.items.map((a: any) => a.filename), ["same-bytes.bin", "exact.bin"]);
});

test("the fixed checklistItems limit: 50 items per card is quota_exceeded with resource checklistItems, whatever the plan", async (t) => {
  const api = await startApp(t, { defaultPlan: "business" });
  const w = await setupBoard(api);
  const card = await createCard(api, w.cols[0], w.member, { title: "c" });
  const other = await createCard(api, w.cols[0], w.member, { title: "d" });
  for (let i = 0; i < 50; i++) await ok(api, 201, "POST", `/cards/${card.id}/checklist`, { text: `item ${i}` }, w.member.token);
  assertError(await api.call("POST", `/cards/${card.id}/checklist`, { text: "" }, w.member.token), 400, "invalid_body", "validation first");
  assertQuota(await api.call("POST", `/cards/${card.id}/checklist`, { text: "51st" }, w.member.token), "checklistItems", 50, 50);
  await ok(api, 201, "POST", `/cards/${other.id}/checklist`, { text: "another card" }, w.member.token);
  const items = await ok(api, 200, "GET", `/cards/${card.id}/checklist`, undefined, w.member.token);
  assert.equal(items.items.length, 50);
});

test("the fixed apiKeys limit: 20 keys per user is quota_exceeded with resource apiKeys, whatever the plan", async (t) => {
  const api = await startApp(t, { defaultPlan: "business" });
  const w = await setupTeam(api);
  const keys: any[] = [];
  for (let i = 0; i < 20; i++) keys.push(await createApiKey(api, w.member, { name: `k${i}`, scope: "read" }));
  assertError(await api.call("POST", "/me/api-keys", { name: "", scope: "read" }, w.member.token), 400, "invalid_body", "validation first");
  assertQuota(await api.call("POST", "/me/api-keys", { name: "k20", scope: "read" }, w.member.token), "apiKeys", 20, 20);
  await createApiKey(api, w.admin, { scope: "read" });
  await ok(api, 204, "DELETE", `/me/api-keys/${keys[0].id}`, undefined, w.member.token);
  await createApiKey(api, w.member, { name: "k20", scope: "read" });
  assert.equal((await ok(api, 200, "GET", "/me/api-keys", undefined, w.member.token)).items.length, 20);
});

test("the fixed fields limit: 30 custom fields per project is quota_exceeded with resource fields, even on the business plan", async (t) => {
  const api = await startApp(t, { defaultPlan: "business" });
  const w = await setupBoard(api);
  const p = await planOf(api, w.team.id, w.owner.token);
  assert.deepEqual(p.limits, BUSINESS);
  for (let i = 0; i < 30; i++) await ok(api, 201, "POST", `/projects/${w.project.id}/fields`, { name: `f${i}`, type: "checkbox" }, w.owner.token);
  assertQuota(await api.call("POST", `/projects/${w.project.id}/fields`, { name: "f30", type: "checkbox" }, w.owner.token), "fields", 30, 30);
  assert.deepEqual(Object.keys((await planOf(api, w.team.id, w.owner.token)).usage), LIMIT_KEYS, "fields are not a plan usage");
});

test("PUT plan upgrades and downgrades and answers the new plan, limits and usage; the team shows the new plan", async (t) => {
  const api = await startApp(t);
  const w = await setupBoard(api);
  await createCard(api, w.cols[0], w.member, { title: "c" });
  const expected = usage({ projects: 1, cards: 1, members: 4 });
  const up = await putPlan(api, w.team.id, "business", w.owner);
  assertStatus(up, 200);
  assert.deepEqual(up.body, { plan: "business", limits: BUSINESS, usage: expected });
  assert.equal((await ok(api, 200, "GET", `/teams/${w.team.id}`, undefined, w.viewer.token)).plan, "business");
  const mid = await putPlan(api, w.team.id, "team", w.owner);
  assert.deepEqual(mid.body, { plan: "team", limits: TEAM, usage: expected });
  const down = await putPlan(api, w.team.id, "free", w.owner);
  assert.deepEqual(down.body, { plan: "free", limits: FREE, usage: expected });
  assert.deepEqual(await planOf(api, w.team.id, w.viewer.token), down.body);
  assert.equal((await ok(api, 200, "GET", "/teams", undefined, w.member.token)).items[0].plan, "free");
});

test("PUT plan is owner only (403 for admins, members and viewers, 404 for non-members) and plan must be free, team or business", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  for (const u of [w.admin, w.member, w.viewer]) assertError(await putPlan(api, w.team.id, "team", u), 403, "forbidden", u.handle);
  assertError(await putPlan(api, w.team.id, "nope", w.admin), 403, "forbidden", "role before validation");
  assertError(await putPlan(api, w.team.id, "team", w.outsider), 404, "not_found");
  for (const plan of ["enterprise", "Free", "", 1, null]) assertError(await putPlan(api, w.team.id, plan, w.owner), 400, "invalid_body", JSON.stringify(plan));
  assertError(await api.call("PUT", `/teams/${w.team.id}/plan`, {}, w.owner.token), 400, "invalid_body", "missing plan");
  assert.equal((await planOf(api, w.team.id, w.owner.token)).plan, "free");
});

test("a downgrade over the new limits is 409 downgrade_blocked listing those limits in table order, and changes nothing", async (t) => {
  const api = await startApp(t, { defaultPlan: "business" });
  const w = await setupTeam(api);
  for (const key of ["AAA", "BBB", "CCC", "DDD"]) await createProject(api, w.team.id, w.owner, key);
  for (let i = 0; i < 2; i++) await addMember(api, w.team.id, w.owner, await signUp(api), "viewer");
  for (const p of ["a", "b", "c"]) await ok(api, 201, "POST", `/teams/${w.team.id}/webhooks`, { url: `http://127.0.0.1:9/${p}`, events: ["*"] }, w.owner.token);
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  assertDetails(await putPlan(api, w.team.id, "free", w.owner), 409, "downgrade_blocked", { resources: ["projects", "members", "webhooks"] });
  assert.equal((await planOf(api, w.team.id, w.owner.token)).plan, "business");
  assert.equal((await auditLog(api, w.owner.token, w.team.id)).length, base, "nothing audited");
  const toTeam = await putPlan(api, w.team.id, "team", w.owner);
  assertStatus(toTeam, 200);
  assert.deepEqual(toTeam.body.usage, usage({ projects: 4, members: 6, webhooks: 3 }));
  assertDetails(await putPlan(api, w.team.id, "free", w.owner), 409, "downgrade_blocked", { resources: ["projects", "members", "webhooks"] });
});

test("setting the plan the team already has answers 200, changes nothing and appends no audit entry, whatever the usage", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  for (const key of ["AAA", "BBB", "CCC"]) await createProject(api, w.team.id, w.owner, key);
  await addMember(api, w.team.id, w.owner, await signUp(api), "viewer");
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  const same = await putPlan(api, w.team.id, "free", w.owner);
  assertStatus(same, 200);
  assert.deepEqual(same.body, { plan: "free", limits: FREE, usage: usage({ projects: 3, members: 5 }) });
  assert.equal((await auditLog(api, w.owner.token, w.team.id)).length, base);
  await ok(api, 200, "PUT", `/teams/${w.team.id}/plan`, { plan: "business" }, w.owner.token);
  const base2 = (await auditLog(api, w.owner.token, w.team.id)).length;
  assertStatus(await putPlan(api, w.team.id, "business", w.owner), 200);
  assert.equal((await auditLog(api, w.owner.token, w.team.id)).length, base2);
});

test("a plan change is audited as team.plan_changed with from and to, and quotas follow the new plan at once", async (t) => {
  const clock = new Clock();
  const api = await startApp(t, { now: clock.now });
  const w = await setupTeam(api, clock);
  for (const key of ["AAA", "BBB", "CCC"]) await createProject(api, w.team.id, w.owner, key);
  const path = `/teams/${w.team.id}/projects`;
  assertQuota(await api.call("POST", path, { name: "D", key: "DDD" }, w.owner.token), "projects", 3, 3);
  const base = (await auditLog(api, w.owner.token, w.team.id)).length;
  clock.advance(1000);
  await ok(api, 200, "PUT", `/teams/${w.team.id}/plan`, { plan: "team" }, w.owner.token);
  const d = await createProject(api, w.team.id, w.owner, "DDD");
  assertDetails(await putPlan(api, w.team.id, "free", w.owner), 409, "downgrade_blocked", { resources: ["projects"] });
  const entries = (await auditLog(api, w.owner.token, w.team.id)).slice(base);
  assert.deepEqual(
    entries.map((e) => [e.action, e.targetType, e.targetId, e.actorId, e.via, e.details]),
    [
      ["team.plan_changed", "team", w.team.id, w.owner.id, null, { from: "free", to: "team" }],
      ["project.created", "project", d.id, w.owner.id, null, {}],
    ],
  );
  assert.equal(entries[0].at, clock.iso());
});

test("PUT plan needs an admin-scoped key before 404 and ignores Idempotency-Key; a POST refused by a quota stores no idempotent response", async (t) => {
  const api = await startApp(t);
  const w = await setupTeam(api);
  const writeKey = (await createApiKey(api, w.owner, { scope: "write" })).secret;
  const adminKey = (await createApiKey(api, w.owner, { scope: "admin" })).secret;
  const adminsKey = (await createApiKey(api, w.admin, { scope: "admin" })).secret;
  assertError(await putPlan(api, "no-such-team", "team", writeKey), 403, "insufficient_scope", "owner route, before 404");
  assertError(await putPlan(api, w.team.id, "team", writeKey), 403, "insufficient_scope");
  assertError(await putPlan(api, w.team.id, "team", adminsKey), 403, "forbidden", "an admin's key is still an admin");
  await ok(api, 200, "GET", `/teams/${w.team.id}/plan`, undefined, (await createApiKey(api, w.viewer, { scope: "read" })).secret);
  for (const key of ["AAA", "BBB", "CCC"]) await createProject(api, w.team.id, w.owner, key);
  const path = `/teams/${w.team.id}/projects`;
  const body = { name: "D", key: "DDD" };
  assertQuota(await api.call("POST", path, body, w.owner.token, { idem: "proj-d" }), "projects", 3, 3);
  const put = await putPlan(api, w.team.id, "team", adminKey, { "idempotency-key": "not valid!" });
  assertStatus(put, 200, "PUT ignores the header");
  const created = await api.call("POST", path, body, w.owner.token, { idem: "proj-d" });
  assertStatus(created, 201, "the refused request stored nothing");
  assert.equal(created.headers.get("idempotency-replayed"), null);
  const replay = await api.call("POST", path, body, w.owner.token, { idem: "proj-d" });
  assertStatus(replay, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal((await planOf(api, w.team.id, w.owner.token)).usage.projects, 4);
});
