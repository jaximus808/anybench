// Sections 1-4, 8, 11, 12, 13: auth, teams, projects, boards, webhooks, audit, API keys, plans.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { LIMIT_KEYS, PLAN_LIMITS, byCreated, byJoined, byAt, mk, newestFirst } from "./core.ts";
import { EVENTS } from "./webhooks.ts";
import * as v from "./util.ts";
import { E, HttpError, has, newId, sha256 } from "./util.ts";

const KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;
const EVENT_NAMES = new Set<string>(EVENTS);

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key))));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  if (expected.length === 0) return false;
  const key = await scryptAsync(password, salt, expected.length);
  return timingSafeEqual(key, expected);
}

export function parseRole(value: unknown): string {
  if (value !== "admin" && value !== "member" && value !== "viewer") throw E.body("role must be one of admin, member, viewer");
  return value;
}
function parseEvents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw E.body("events must be a non-empty array");
  for (const e of value) if (typeof e !== "string" || (e !== "*" && !EVENT_NAMES.has(e))) throw E.body(`unknown event: ${String(e)}`);
  if (value.includes("*")) return ["*"];
  return [...new Set(value as string[])].sort();
}
function parseUrl(value: unknown): string {
  if (!v.isHttpUrl(value)) throw E.body("url must be an absolute http or https URL");
  return value as string;
}

export function registerBasics(A: any): void {
  const S = A.state;
  const { route, values, seq } = A;
  const ok = (status: number, body?: any, extra: any = {}) => ({ status, body, ...extra });

  route("GET", "/health", { public: true }, () => ok(200, { ok: true }));

  // ---- 1. auth
  route("POST", "/auth/register", { public: true, body: "json" }, async (c: any) => {
    const email = v.email(c.body.email);
    const password = v.plain(c.body.password, "password", 8, 200);
    const name = v.trimmed(c.body.name, "name", 1, 100);
    if (typeof c.body.handle !== "string" || !v.HANDLE_RE.test(c.body.handle)) throw E.body("handle must match ^[a-z0-9_]{3,20}$");
    const handle = c.body.handle;
    const conflicts = () => {
      if (A.userByEmail(email)) throw E.conflict("email_taken", "email is already registered");
      if (A.userByHandle(handle)) throw E.conflict("handle_taken", "handle is already taken");
    };
    conflicts();
    const passwordHash = await hashPassword(password);
    conflicts();
    const user = { id: newId("usr"), email, name, handle, passwordHash, createdAt: c.nowIso, seq: seq() };
    S.users.set(user.id, user);
    return ok(201, A.userView(user));
  });

  route("POST", "/auth/login", { public: true, body: "json" }, async (c: any) => {
    const { email, password } = c.body;
    if (typeof email !== "string" || typeof password !== "string") throw E.body("email and password must be strings");
    const user = A.userByEmail(email.trim().toLowerCase());
    if (user === undefined || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, "invalid_credentials", "unknown email or wrong password");
    }
    const token = randomBytes(24).toString("hex");
    const hash = sha256(token);
    S.tokens.set(hash, { hash, userId: user.id, issuedAt: c.nowMs });
    return ok(200, { token, expiresAt: new Date(c.nowMs + A.opts.tokenTtlMs).toISOString() });
  });

  route("POST", "/auth/logout", { keyDenied: true }, (c: any) => {
    S.tokens.delete(c.tokenHash);
    return ok(204);
  });
  route("GET", "/me", {}, (c: any) => ok(200, A.userView(c.user)));
  route("PATCH", "/me", { body: "json", keyDenied: true }, (c: any) => {
    v.patchFields(c.body, ["name", "handle"]);
    const name = has(c.body, "name") ? v.trimmed(c.body.name, "name", 1, 100) : undefined;
    let handle: string | undefined;
    if (has(c.body, "handle")) {
      if (typeof c.body.handle !== "string" || !v.HANDLE_RE.test(c.body.handle)) throw E.body("handle must match ^[a-z0-9_]{3,20}$");
      handle = c.body.handle;
      const other = A.userByHandle(handle);
      if (other !== undefined && other.id !== c.user.id) throw E.conflict("handle_taken", "handle is already taken");
    }
    if (name !== undefined) c.user.name = name;
    if (handle !== undefined) c.user.handle = handle;
    return ok(200, A.userView(c.user));
  });
  route("POST", "/me/password", { body: "json", keyDenied: true }, async (c: any) => {
    if (typeof c.body.currentPassword !== "string") throw E.body("currentPassword must be a string");
    const next = v.plain(c.body.newPassword, "newPassword", 8, 200);
    if (!(await verifyPassword(c.body.currentPassword, c.user.passwordHash))) throw new HttpError(400, "wrong_password", "currentPassword is wrong");
    c.user.passwordHash = await hashPassword(next);
    for (const [h, t] of [...S.tokens]) if (t.userId === c.user.id) S.tokens.delete(h);
    return ok(204);
  });

  // ---- 2. teams
  route("POST", "/teams", { body: "json", teamKeyDenied: true }, (c: any) => {
    const name = v.trimmed(c.body.name, "name", 1, 100);
    const team = { id: newId("team"), name, ownerId: c.user.id, plan: A.opts.defaultPlan, createdAt: c.nowIso, seq: seq() };
    S.teams.set(team.id, team);
    S.members.set(mk(team.id, c.user.id), { teamId: team.id, userId: c.user.id, role: "owner", joinedAt: c.nowIso, seq: seq() });
    A.audit(c.chg, team.id, "team.created", "team", team.id);
    return ok(201, A.teamView(team, "owner"));
  });
  route("GET", "/teams", {}, (c: any) => {
    const items = values("teams")
      .filter((t: any) => A.membership(c, t.id))
      .sort(byCreated)
      .map((t: any) => A.teamView(t, A.membership(c, t.id).role));
    return ok(200, { items });
  });
  route("GET", "/teams/:teamId", {}, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    return ok(200, A.teamView(team, member.role));
  });
  route("PATCH", "/teams/:teamId", { body: "json", admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const fields = v.patchFields(c.body, ["name"]);
    team.name = v.trimmed(c.body.name, "name", 1, 100);
    A.audit(c.chg, team.id, "team.updated", "team", team.id, { fields });
    return ok(200, A.teamView(team, member.role));
  });
  route("DELETE", "/teams/:teamId", { admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "owner");
    A.deleteTeamRecords(team);
    return ok(204);
  });
  route("GET", "/teams/:teamId/members", {}, (c: any) => {
    const { team } = A.vTeam(c, c.params.teamId);
    return ok(200, { items: A.membersOfTeam(team.id).map(A.memberView) });
  });
  route("POST", "/teams/:teamId/members", { body: "json", admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const email = v.email(c.body.email);
    const role = parseRole(c.body.role);
    const user = A.userByEmail(email);
    if (user === undefined) throw new HttpError(404, "user_not_found", "no user has this email");
    if (S.members.has(mk(team.id, user.id))) throw E.conflict("already_member", "the user is already a member");
    A.checkQuota(team.id, "members");
    const added = { teamId: team.id, userId: user.id, role, joinedAt: c.nowIso, seq: seq() };
    S.members.set(mk(team.id, user.id), added);
    for (const inv of values("invites")) {
      if (inv.teamId === team.id && inv.email === user.email && inv.status === "pending") {
        inv.status = "accepted";
        inv.acceptedAt = c.nowIso;
      }
    }
    A.audit(c.chg, team.id, "member.added", "member", user.id, { role });
    A.emit(c.chg, team.id, "member.added", { member: A.memberView(added) });
    return ok(201, () => A.memberView(added));
  });
  route("PATCH", "/teams/:teamId/members/:userId", { body: "json", admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    const target = S.members.get(mk(team.id, c.params.userId));
    if (target === undefined) throw E.notFound("member not found");
    A.needRole(member, "admin");
    v.patchFields(c.body, ["role"]);
    const role = parseRole(c.body.role);
    if (target.role === "owner") throw E.conflict("owner_required", "the owner's role cannot change");
    const from = target.role;
    target.role = role;
    A.audit(c.chg, team.id, "member.role_changed", "member", target.userId, { from, to: role });
    return ok(200, A.memberView(target));
  });
  route("DELETE", "/teams/:teamId/members/:userId", { admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    const target = S.members.get(mk(team.id, c.params.userId));
    if (target === undefined) throw E.notFound("member not found");
    if (target.userId !== c.user.id) A.needRole(member, "admin");
    if (target.role === "owner") throw E.conflict("owner_required", "the owner cannot be removed");
    S.members.delete(mk(team.id, target.userId));
    A.leaveTeamCascade(team.id, target.userId);
    A.audit(c.chg, team.id, "member.removed", "member", target.userId);
    A.emit(c.chg, team.id, "member.removed", { userId: target.userId });
    return ok(204);
  });
  route("POST", "/teams/:teamId/transfer", { body: "json", admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "owner");
    const userId = c.body.userId;
    const target = typeof userId === "string" ? S.members.get(mk(team.id, userId)) : undefined;
    if (target === undefined || target.userId === c.user.id) throw E.body("userId must name another member of the team");
    target.role = "owner";
    member.role = "admin";
    team.ownerId = target.userId;
    A.audit(c.chg, team.id, "team.transferred", "team", team.id, { from: c.user.id, to: target.userId });
    return ok(200, A.teamView(team, "admin"));
  });

  // ---- 13. plans
  const planBody = (team: any) => ({ plan: team.plan, limits: { ...PLAN_LIMITS[team.plan] }, usage: A.usage(team.id) });
  route("GET", "/plans", { public: true }, () =>
    ok(200, { items: ["free", "team", "business"].map((id) => ({ id, limits: { ...PLAN_LIMITS[id] } })) }),
  );
  route("GET", "/teams/:teamId/plan", {}, (c: any) => ok(200, planBody(A.vTeam(c, c.params.teamId).team)));
  route("PUT", "/teams/:teamId/plan", { body: "json", admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "owner");
    const plan = c.body.plan;
    if (plan !== "free" && plan !== "team" && plan !== "business") throw E.body("plan must be free, team or business");
    if (plan === team.plan) return ok(200, planBody(team));
    const usage = A.usage(team.id);
    const limits = PLAN_LIMITS[plan]!;
    const over = LIMIT_KEYS.filter((k) => limits[k] !== null && usage[k] > limits[k]!);
    if (over.length > 0) throw E.conflict("downgrade_blocked", "usage is above the new plan's limits", { resources: over });
    const from = team.plan;
    team.plan = plan;
    A.audit(c.chg, team.id, "team.plan_changed", "team", team.id, { from, to: plan });
    return ok(200, planBody(team));
  });

  // ---- 3. projects
  route("POST", "/teams/:teamId/projects", { body: "json", admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const name = v.trimmed(c.body.name, "name", 1, 100);
    const key = c.body.key;
    if (typeof key !== "string" || !KEY_RE.test(key)) throw E.body("key must match ^[A-Z][A-Z0-9]{1,5}$");
    const description = has(c.body, "description") ? v.plain(c.body.description, "description", 0, 2000) : "";
    if (A.projectsOfTeam(team.id).some((p: any) => p.key === key)) throw E.conflict("key_taken", "the team already has a project with this key");
    A.checkQuota(team.id, "projects");
    const project = {
      id: newId("prj"), teamId: team.id, name, key, description, archived: false, createdAt: c.nowIso, updatedAt: c.nowIso, nextNumber: 1, seq: seq(),
    };
    S.projects.set(project.id, project);
    A.audit(c.chg, team.id, "project.created", "project", project.id);
    return ok(201, A.projectView(project));
  });
  route("GET", "/teams/:teamId/projects", {}, (c: any) => {
    const { team } = A.vTeam(c, c.params.teamId);
    const archived = c.query.get("archived") ?? "false";
    if (archived !== "false" && archived !== "true" && archived !== "all") throw E.query("archived must be false, true or all");
    const items = A.projectsOfTeam(team.id)
      .filter((p: any) => archived === "all" || p.archived === (archived === "true"))
      .sort(byCreated)
      .map(A.projectView);
    return ok(200, { items });
  });
  route("GET", "/projects/:projectId", {}, (c: any) => ok(200, A.projectView(A.vProject(c, c.params.projectId).project)));
  route("PATCH", "/projects/:projectId", { body: "json", admin: true }, (c: any) => {
    const { project, member } = A.vProject(c, c.params.projectId);
    A.needRole(member, "admin");
    if (has(c.body, "key")) throw E.body("a project key never changes");
    const fields = v.patchFields(c.body, ["name", "description", "archived"]);
    const name = has(c.body, "name") ? v.trimmed(c.body.name, "name", 1, 100) : undefined;
    const description = has(c.body, "description") ? v.plain(c.body.description, "description", 0, 2000) : undefined;
    const archived = has(c.body, "archived") ? v.bool(c.body.archived, "archived") : undefined;
    if (name !== undefined) project.name = name;
    if (description !== undefined) project.description = description;
    if (archived !== undefined) project.archived = archived;
    project.updatedAt = c.nowIso;
    A.audit(c.chg, project.teamId, "project.updated", "project", project.id, { fields });
    return ok(200, A.projectView(project));
  });
  route("DELETE", "/projects/:projectId", { admin: true }, (c: any) => {
    const { project, member } = A.vProject(c, c.params.projectId);
    A.needRole(member, "admin");
    A.deleteProjectRecords(project);
    A.audit(c.chg, project.teamId, "project.deleted", "project", project.id);
    return ok(204);
  });

  // ---- 4. boards and columns
  const categoryFor = (i: number, n: number) => (n === 1 ? "todo" : i === 0 ? "todo" : i === n - 1 ? "done" : "in_progress");
  route("POST", "/projects/:projectId/boards", { body: "json", admin: true }, (c: any) => {
    const { project, member } = A.vProject(c, c.params.projectId);
    A.needRole(member, "admin");
    const name = v.trimmed(c.body.name, "name", 1, 50);
    let names = ["To do", "In progress", "Done"];
    if (has(c.body, "columns")) {
      const cols = c.body.columns;
      if (!Array.isArray(cols) || cols.length < 1 || cols.length > 20) throw E.body("columns must be an array of 1 to 20 names");
      names = cols.map((x: unknown, i: number) => v.trimmed(x, `columns[${i}]`, 1, 50));
    }
    A.notArchived(project);
    const board = { id: newId("brd"), projectId: project.id, name, createdAt: c.nowIso, seq: seq() };
    S.boards.set(board.id, board);
    names.forEach((colName, position) => {
      const col = { id: newId("col"), boardId: board.id, name: colName, position, wipLimit: null, category: categoryFor(position, names.length) };
      S.columns.set(col.id, col);
    });
    A.audit(c.chg, project.teamId, "board.created", "board", board.id);
    return ok(201, A.boardView(board));
  });
  route("GET", "/projects/:projectId/boards", {}, (c: any) => {
    const { project } = A.vProject(c, c.params.projectId);
    return ok(200, { items: values("boards").filter((b: any) => b.projectId === project.id).sort(byCreated).map(A.boardView) });
  });
  route("GET", "/boards/:boardId", {}, (c: any) => ok(200, A.boardView(A.vBoard(c, c.params.boardId).board)));
  route("PATCH", "/boards/:boardId", { body: "json", admin: true }, (c: any) => {
    const { board, project, member } = A.vBoard(c, c.params.boardId);
    A.needRole(member, "admin");
    const fields = v.patchFields(c.body, ["name"]);
    const name = v.trimmed(c.body.name, "name", 1, 50);
    A.notArchived(project);
    board.name = name;
    A.audit(c.chg, project.teamId, "board.updated", "board", board.id, { fields });
    return ok(200, A.boardView(board));
  });
  route("DELETE", "/boards/:boardId", { admin: true }, (c: any) => {
    const { board, project, member } = A.vBoard(c, c.params.boardId);
    A.needRole(member, "admin");
    A.notArchived(project);
    A.deleteBoardRecords(board);
    A.audit(c.chg, project.teamId, "board.deleted", "board", board.id);
    return ok(204);
  });
  const category = (x: unknown) => {
    if (typeof x !== "string" || !v.CATEGORIES.includes(x)) throw E.body("category must be todo, in_progress or done");
    return x;
  };
  route("POST", "/boards/:boardId/columns", { body: "json", admin: true }, (c: any) => {
    const { board, project, member } = A.vBoard(c, c.params.boardId);
    A.needRole(member, "admin");
    const name = v.trimmed(c.body.name, "name", 1, 50);
    const cols = A.columnsOfBoard(board.id);
    const position = has(c.body, "position") ? v.integer(c.body.position, "position", 0, cols.length) : cols.length;
    const wipLimit = has(c.body, "wipLimit") ? v.wipLimit(c.body.wipLimit) : null;
    const cat = has(c.body, "category") ? category(c.body.category) : "todo";
    A.notArchived(project);
    const col = { id: newId("col"), boardId: board.id, name, position, wipLimit, category: cat };
    S.columns.set(col.id, col);
    cols.splice(position, 0, col);
    A.renumber(cols);
    A.audit(c.chg, project.teamId, "column.created", "column", col.id);
    return ok(201, A.columnView(col));
  });
  const applyCategory = (column: any, cat: string, nowIso: string) => {
    const wasDone = column.category === "done";
    column.category = cat;
    const isDone = cat === "done";
    if (wasDone === isDone) return;
    for (const card of A.cardsInColumn(column.id)) {
      if (isDone && card.completedAt === null) card.completedAt = nowIso;
      if (!isDone) card.completedAt = null;
    }
  };
  route("PATCH", "/columns/:columnId", { body: "json", admin: true }, (c: any) => {
    const { column, board, project, member } = A.vColumn(c, c.params.columnId);
    A.needRole(member, "admin");
    const fields = v.patchFields(c.body, ["name", "position", "wipLimit", "category"]);
    const cols = A.columnsOfBoard(board.id);
    const name = has(c.body, "name") ? v.trimmed(c.body.name, "name", 1, 50) : undefined;
    const position = has(c.body, "position") ? v.integer(c.body.position, "position", 0, cols.length - 1) : undefined;
    const hasWip = has(c.body, "wipLimit");
    const wipLimit = hasWip ? v.wipLimit(c.body.wipLimit) : null;
    const cat = has(c.body, "category") ? category(c.body.category) : undefined;
    A.notArchived(project);
    if (name !== undefined) column.name = name;
    if (hasWip) column.wipLimit = wipLimit;
    if (cat !== undefined) applyCategory(column, cat, c.nowIso);
    if (position !== undefined) {
      const rest = cols.filter((x: any) => x !== column);
      rest.splice(position, 0, column);
      A.renumber(rest);
    }
    A.audit(c.chg, project.teamId, "column.updated", "column", column.id, { fields });
    return ok(200, A.columnView(column));
  });
  route("DELETE", "/columns/:columnId", { admin: true }, (c: any) => {
    const { column, board, project, member } = A.vColumn(c, c.params.columnId);
    A.needRole(member, "admin");
    let target: any;
    if (c.query.has("moveTo")) {
      const t = S.columns.get(c.query.get("moveTo"));
      if (t === undefined || t.boardId !== board.id || t.id === column.id) throw E.query("moveTo must name another column of the same board");
      target = t;
    }
    A.notArchived(project);
    const cols = A.columnsOfBoard(board.id);
    if (cols.length <= 1) throw E.conflict("last_column", "a board's last column cannot be deleted");
    const cards = A.cardsInColumn(column.id);
    if (cards.length > 0 && target === undefined) throw E.conflict("column_not_empty", "the column still has cards; pass ?moveTo=");
    if (target !== undefined) {
      const base = A.cardsInColumn(target.id).length;
      cards.forEach((card: any, i: number) => {
        A.completionOnEnter(card, column.id, target.id, c.nowIso);
        card.columnId = target.id;
        card.position = base + i;
      });
    }
    S.columns.delete(column.id);
    const rest = cols.filter((x: any) => x !== column);
    A.renumber(rest);
    const fallback = target ?? rest[0];
    for (const card of values("cards")) if (card.columnId === column.id && card.archived) card.columnId = fallback.id;
    for (const r of values("recurrences")) {
      if (r.columnId !== column.id) continue;
      if (target !== undefined) r.columnId = target.id;
      else S.recurrences.delete(r.id);
    }
    A.disableReferencing("columns", new Set([column.id]));
    A.audit(c.chg, project.teamId, "column.deleted", "column", column.id);
    return ok(204);
  });

  // ---- 8. webhooks
  const webhookView = (w: any) => ({ id: w.id, teamId: w.teamId, url: w.url, events: [...w.events], active: w.active, createdAt: w.createdAt, updatedAt: w.updatedAt });
  const vWebhook = (c: any) => {
    const webhook = S.webhooks.get(c.params.webhookId);
    if (webhook === undefined) throw E.notFound("webhook not found");
    const r = A.vTeam(c, webhook.teamId);
    A.needRole(r.member, "admin");
    return { webhook, ...r };
  };
  route("POST", "/teams/:teamId/webhooks", { body: "json", admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const url = parseUrl(c.body.url);
    const events = parseEvents(c.body.events);
    const secret = has(c.body, "secret") ? v.plain(c.body.secret, "secret", 16, 200) : randomBytes(32).toString("hex");
    const active = has(c.body, "active") ? v.bool(c.body.active, "active") : true;
    A.checkQuota(team.id, "webhooks");
    const w = { id: newId("whk"), teamId: team.id, url, events, active, secret, createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq() };
    S.webhooks.set(w.id, w);
    A.audit(c.chg, team.id, "webhook.created", "webhook", w.id);
    return ok(201, { ...webhookView(w), secret });
  });
  route("GET", "/teams/:teamId/webhooks", { admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    return ok(200, { items: values("webhooks").filter((w: any) => w.teamId === team.id).sort(byCreated).map(webhookView) });
  });
  route("GET", "/webhooks/:webhookId", { admin: true }, (c: any) => ok(200, webhookView(vWebhook(c).webhook)));
  route("PATCH", "/webhooks/:webhookId", { body: "json", admin: true }, (c: any) => {
    const { webhook } = vWebhook(c);
    const fields = v.patchFields(c.body, ["url", "events", "active"]);
    const url = has(c.body, "url") ? parseUrl(c.body.url) : undefined;
    const events = has(c.body, "events") ? parseEvents(c.body.events) : undefined;
    const active = has(c.body, "active") ? v.bool(c.body.active, "active") : undefined;
    if (url !== undefined) webhook.url = url;
    if (events !== undefined) webhook.events = events;
    if (active !== undefined) webhook.active = active;
    webhook.updatedAt = c.nowIso;
    A.audit(c.chg, webhook.teamId, "webhook.updated", "webhook", webhook.id, { fields });
    return ok(200, webhookView(webhook));
  });
  route("DELETE", "/webhooks/:webhookId", { admin: true }, (c: any) => {
    const { webhook } = vWebhook(c);
    S.webhooks.delete(webhook.id);
    A.engine.dropWebhook(webhook.id);
    A.audit(c.chg, webhook.teamId, "webhook.deleted", "webhook", webhook.id);
    return ok(204);
  });
  route("POST", "/webhooks/:webhookId/rotate-secret", { admin: true }, (c: any) => {
    const { webhook } = vWebhook(c);
    webhook.secret = randomBytes(32).toString("hex");
    webhook.updatedAt = c.nowIso;
    A.audit(c.chg, webhook.teamId, "webhook.secret_rotated", "webhook", webhook.id);
    return ok(200, { ...webhookView(webhook), secret: webhook.secret });
  });
  route("POST", "/webhooks/:webhookId/test", { admin: true }, (c: any) => {
    const { webhook } = vWebhook(c);
    const deliveryId = A.createDelivery(webhook, "ping", {
      event: "ping", teamId: webhook.teamId, actorId: c.user.id, via: null, occurredAt: c.nowIso, data: { webhookId: webhook.id },
    }, c.nowIso);
    return ok(202, { deliveryId });
  });
  route("GET", "/webhooks/:webhookId/deliveries", { admin: true }, (c: any) => {
    const { webhook } = vWebhook(c);
    const pg = A.paging(c.query, `deliveries:${webhook.id}`);
    const list = [...A.engine.deliveries.values()].filter((d: any) => d.webhookId === webhook.id).sort(newestFirst(byCreated));
    return ok(200, pg.page(list, (d: any) => ({
      id: d.id, webhookId: d.webhookId, event: d.event, status: d.status, attempts: d.attempts, lastStatusCode: d.lastStatusCode,
      lastError: d.lastError, createdAt: d.createdAt,
    })));
  });

  // ---- 11. audit
  route("GET", "/teams/:teamId/audit", { admin: true }, (c: any) => {
    const { team, member } = A.vTeam(c, c.params.teamId);
    A.needRole(member, "admin");
    const action = c.query.get("action");
    const actorId = c.query.get("actorId");
    const pg = A.paging(c.query, `audit:${team.id}`);
    const list = values("audit")
      .filter((a: any) => a.teamId === team.id && (action === null || a.action === action) && (actorId === null || a.actorId === actorId))
      .sort(newestFirst(byAt));
    return ok(200, pg.page(list, (a: any) => ({
      id: a.id, teamId: a.teamId, actorId: a.actorId, via: a.via, action: a.action, targetType: a.targetType, targetId: a.targetId,
      details: a.details, at: a.at,
    })));
  });

  // ---- 12. API keys
  const keyView = (k: any) => ({ id: k.id, name: k.name, scope: k.scope, teamId: k.teamId, prefix: k.prefix, expiresAt: k.expiresAt, createdAt: k.createdAt, updatedAt: k.updatedAt });
  const parseExpires = (x: unknown, nowMs: number): string | null => {
    if (x === null) return null;
    if (typeof x !== "string") throw E.body("expiresAt must be null or a date string");
    const ms = Date.parse(x);
    if (Number.isNaN(ms) || ms <= nowMs) throw E.body("expiresAt must be later than now");
    return new Date(ms).toISOString();
  };
  const ownKey = (c: any) => {
    const k = S.apiKeys.get(c.params.keyId);
    if (k === undefined || k.userId !== c.user.id) throw E.notFound("API key not found");
    return k;
  };
  route("POST", "/me/api-keys", { body: "json", keyDenied: true }, (c: any) => {
    const name = v.trimmed(c.body.name, "name", 1, 100);
    const scope = c.body.scope;
    if (scope !== "read" && scope !== "write" && scope !== "admin") throw E.body("scope must be read, write or admin");
    let teamId: string | null = null;
    if (has(c.body, "teamId") && c.body.teamId !== null) {
      if (typeof c.body.teamId !== "string" || !S.teams.has(c.body.teamId) || !S.members.has(mk(c.body.teamId, c.user.id))) {
        throw E.body("teamId must be a team you are a member of");
      }
      teamId = c.body.teamId;
    }
    const expiresAt = has(c.body, "expiresAt") ? parseExpires(c.body.expiresAt, c.nowMs) : null;
    const used = values("apiKeys").filter((k: any) => k.userId === c.user.id).length;
    if (used >= 20) throw E.quota("apiKeys", 20, used);
    const secret = `trk_${v.alnum(40)}`;
    const k = {
      id: newId("key"), userId: c.user.id, name, scope, teamId, prefix: secret.slice(0, 12), hash: sha256(secret), expiresAt,
      createdAt: c.nowIso, updatedAt: c.nowIso, seq: seq(),
    };
    S.apiKeys.set(k.id, k);
    return ok(201, { ...keyView(k), secret });
  });
  route("GET", "/me/api-keys", { keyDenied: true }, (c: any) =>
    ok(200, { items: values("apiKeys").filter((k: any) => k.userId === c.user.id).sort(byCreated).map(keyView) }),
  );
  route("GET", "/me/api-keys/:keyId", { keyDenied: true }, (c: any) => ok(200, keyView(ownKey(c))));
  route("PATCH", "/me/api-keys/:keyId", { body: "json", keyDenied: true }, (c: any) => {
    const k = ownKey(c);
    if (has(c.body, "scope") || has(c.body, "teamId")) throw E.body("scope and teamId never change");
    v.patchFields(c.body, ["name", "expiresAt"]);
    const name = has(c.body, "name") ? v.trimmed(c.body.name, "name", 1, 100) : undefined;
    const hasExp = has(c.body, "expiresAt");
    const expiresAt = hasExp ? parseExpires(c.body.expiresAt, c.nowMs) : null;
    if (name !== undefined) k.name = name;
    if (hasExp) k.expiresAt = expiresAt;
    k.updatedAt = c.nowIso;
    return ok(200, keyView(k));
  });
  route("DELETE", "/me/api-keys/:keyId", { keyDenied: true }, (c: any) => {
    const k = ownKey(c);
    S.apiKeys.delete(k.id);
    return ok(204);
  });

  void byJoined;
}
