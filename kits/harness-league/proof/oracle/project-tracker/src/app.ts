import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HttpError, errors, readRaw, sendEmpty, sendError, sendJson } from "./http.ts";
import { Router } from "./router.ts";
import * as v from "./validate.ts";
import {
  ROLE_RANK,
  computeMentions,
  creationOrder,
  emptyState,
  loadState,
  memberKey,
  newId,
  saveState,
  type AuditRec,
  type BoardRec,
  type CardRec,
  type ColumnRec,
  type CommentRec,
  type MemberRec,
  type ProjectRec,
  type Role,
  type TeamRec,
  type UserRec,
  type WebhookRec,
} from "./store.ts";
import { DeliveryEngine, EVENTS, type DeliveryRec } from "./webhooks.ts";

export interface RateLimitOptions {
  /** Requests allowed per token in one window. */
  limit: number;
  /** Window length in milliseconds. Windows are fixed: floor(now() / windowMs). */
  windowMs: number;
}

export interface WebhookOptions {
  /** Wait before each retry, in milliseconds. Attempts = 1 + retryDelaysMs.length. */
  retryDelaysMs?: number[];
  /** How long one delivery attempt may take before it counts as failed. */
  timeoutMs?: number;
}

export interface AppOptions {
  /** Where to persist state as JSON. Omit to keep everything in memory. */
  dataFile?: string;
  /** The clock, in milliseconds since the epoch. Default: Date.now. */
  now?: () => number;
  /** How long a login token is valid. Default: 86_400_000 (24 hours). */
  tokenTtlMs?: number;
  /** Per-token rate limit. Default: { limit: 1000, windowMs: 60_000 }. */
  rateLimit?: RateLimitOptions;
  /** Outgoing webhook delivery. Default: { retryDelaysMs: [1000, 5000, 30000], timeoutMs: 5000 }. */
  webhooks?: WebhookOptions;
}

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  /** The JSON object body (routes that take a body), else `{}`. */
  body: v.Body;
  /** The caller (authenticated routes only). */
  user: UserRec;
  tokenHash: string;
  nowMs: number;
  nowIso: string;
}

interface Result {
  status: number;
  body?: unknown;
}

interface RouteDef {
  auth: boolean;
  body: boolean;
  fn: (c: Ctx) => Result | Promise<Result>;
}

const KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;
const EVENT_NAMES = new Set<string>(EVENTS);
const ASSIGNABLE_ROLES = ["admin", "member", "viewer"] as const;

const ok = (status: number, body?: unknown): Result => ({ status, body });

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Verifies `scrypt$<saltHex>$<keyHex>` (the 1.x format, also used for new hashes). */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  if (expected.length === 0) return false;
  const key = await scryptAsync(password, salt, expected.length);
  return timingSafeEqual(key, expected);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function parseRole(value: unknown): Role {
  if (typeof value !== "string" || !(ASSIGNABLE_ROLES as readonly string[]).includes(value)) {
    throw errors.invalidBody("role must be one of admin, member, viewer");
  }
  return value as Role;
}

function parseWebhookUrl(value: unknown): string {
  if (typeof value !== "string") throw errors.invalidBody("url must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw errors.invalidBody("url must be an absolute http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw errors.invalidBody("url must be an absolute http or https URL");
  }
  return value;
}

function parseEvents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw errors.invalidBody("events must be a non-empty array");
  for (const e of value) {
    if (typeof e !== "string" || (e !== "*" && !EVENT_NAMES.has(e))) {
      throw errors.invalidBody(`unknown event: ${String(e)}`);
    }
  }
  const names = value as string[];
  if (names.includes("*")) return ["*"];
  return [...new Set(names)].sort();
}

const byCreatedAt = creationOrder<{ createdAt: string; seq: number; mig?: boolean }>((x) => x.createdAt);
const byJoinedAt = creationOrder<MemberRec>((x) => x.joinedAt);
const byAt = creationOrder<AuditRec>((x) => x.at);

export function createApp(options: AppOptions = {}): Server {
  const now = options.now ?? Date.now;
  const tokenTtlMs = options.tokenTtlMs ?? 86_400_000;
  const rateLimitMax = options.rateLimit?.limit ?? 1000;
  const rateWindowMs = options.rateLimit?.windowMs ?? 60_000;
  const dataFile = options.dataFile;
  const state = dataFile === undefined ? emptyState() : loadState(dataFile);
  const engine = new DeliveryEngine({
    retryDelaysMs: options.webhooks?.retryDelaysMs ?? [1000, 5000, 30000],
    timeoutMs: options.webhooks?.timeoutMs ?? 5000,
    lookup: (id) => state.webhooks.get(id),
  });
  const rateCounters = new Map<string, { start: number; count: number }>();
  const cursorKey = randomBytes(32);
  let deliverySeq = 0;
  const router = new Router<RouteDef>();

  const commit = (): void => {
    if (dataFile !== undefined) saveState(dataFile, state);
  };
  const nextSeq = (): number => ++state.seq;

  // ---- lookups -------------------------------------------------------------------------------

  const findUserByEmail = (email: string): UserRec | undefined => {
    for (const u of state.users.values()) if (u.email === email) return u;
    return undefined;
  };
  const findUserByHandle = (handle: string): UserRec | undefined => {
    for (const u of state.users.values()) if (u.handle === handle) return u;
    return undefined;
  };
  const projectOfBoard = (boardId: string): ProjectRec => {
    const board = state.boards.get(boardId)!;
    return state.projects.get(board.projectId)!;
  };
  const columnsOfBoard = (boardId: string): ColumnRec[] =>
    [...state.columns.values()].filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const cardsOfColumn = (columnId: string): CardRec[] =>
    [...state.cards.values()].filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);
  const cardsOfTeam = (teamId: string): CardRec[] =>
    [...state.cards.values()].filter((c) => projectOfBoard(c.boardId).teamId === teamId);
  const renumber = (items: { position: number }[]): void => items.forEach((x, i) => (x.position = i));

  // ---- views ---------------------------------------------------------------------------------

  const userView = (u: UserRec) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    handle: u.handle,
    createdAt: u.createdAt,
  });
  const teamView = (t: TeamRec, myRole: Role) => ({
    id: t.id,
    name: t.name,
    ownerId: t.ownerId,
    createdAt: t.createdAt,
    myRole,
  });
  const memberView = (m: MemberRec) => {
    const u = state.users.get(m.userId);
    return {
      userId: m.userId,
      email: u?.email ?? "",
      name: u?.name ?? "",
      handle: u?.handle ?? "",
      role: m.role,
      joinedAt: m.joinedAt,
    };
  };
  const projectView = (p: ProjectRec) => ({
    id: p.id,
    teamId: p.teamId,
    name: p.name,
    key: p.key,
    description: p.description,
    archived: p.archived,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });
  const columnView = (c: ColumnRec) => ({
    id: c.id,
    boardId: c.boardId,
    name: c.name,
    position: c.position,
    wipLimit: c.wipLimit,
  });
  const boardView = (b: BoardRec) => ({
    id: b.id,
    projectId: b.projectId,
    name: b.name,
    columns: columnsOfBoard(b.id).map(columnView),
    createdAt: b.createdAt,
  });
  const cardView = (c: CardRec) => ({
    id: c.id,
    number: c.number,
    key: `${projectOfBoard(c.boardId).key}-${c.number}`,
    boardId: c.boardId,
    columnId: c.columnId,
    position: c.position,
    title: c.title,
    description: c.description,
    assigneeId: c.assigneeId,
    labels: [...c.labels],
    dueDate: c.dueDate,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });
  /** The comments of a card grouped by parentId, each group oldest first. */
  const commentGroups = (cardId: string): Map<string | null, CommentRec[]> => {
    const groups = new Map<string | null, CommentRec[]>();
    const list = [...state.comments.values()].filter((c) => c.cardId === cardId).sort(byCreatedAt);
    for (const c of list) {
      const group = groups.get(c.parentId);
      if (group === undefined) groups.set(c.parentId, [c]);
      else group.push(c);
    }
    return groups;
  };
  type CommentView = {
    id: string;
    cardId: string;
    parentId: string | null;
    authorId: string;
    body: string;
    mentions: string[];
    deleted: boolean;
    createdAt: string;
    updatedAt: string;
    replies: CommentView[];
  };
  const commentView = (c: CommentRec, groups: Map<string | null, CommentRec[]>): CommentView => ({
    id: c.id,
    cardId: c.cardId,
    parentId: c.parentId,
    authorId: c.authorId,
    body: c.body,
    mentions: [...c.mentions],
    deleted: c.deleted,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    replies: (groups.get(c.id) ?? []).map((r) => commentView(r, groups)),
  });
  const webhookView = (w: WebhookRec) => ({
    id: w.id,
    teamId: w.teamId,
    url: w.url,
    events: [...w.events],
    active: w.active,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });
  const deliveryView = (d: DeliveryRec) => ({
    id: d.id,
    webhookId: d.webhookId,
    event: d.event,
    status: d.status,
    attempts: d.attempts,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    createdAt: d.createdAt,
  });
  const auditView = (a: AuditRec) => ({
    id: a.id,
    teamId: a.teamId,
    actorId: a.actorId,
    action: a.action,
    targetType: a.targetType,
    targetId: a.targetId,
    details: a.details,
    at: a.at,
  });

  // ---- path resources (step 5) and roles (step 6) --------------------------------------------

  const visibleTeam = (c: Ctx, teamId: string, what = "team") => {
    const team = state.teams.get(teamId);
    const member = team === undefined ? undefined : state.members.get(memberKey(teamId, c.user.id));
    if (team === undefined || member === undefined) throw errors.notFound(`${what} not found`);
    return { team, member };
  };
  const visibleProject = (c: Ctx, projectId: string, what = "project") => {
    const project = state.projects.get(projectId);
    if (project === undefined) throw errors.notFound(`${what} not found`);
    return { project, ...visibleTeam(c, project.teamId, what) };
  };
  const visibleBoard = (c: Ctx, boardId: string, what = "board") => {
    const board = state.boards.get(boardId);
    if (board === undefined) throw errors.notFound(`${what} not found`);
    return { board, ...visibleProject(c, board.projectId, what) };
  };
  const visibleColumn = (c: Ctx, columnId: string) => {
    const column = state.columns.get(columnId);
    if (column === undefined) throw errors.notFound("column not found");
    return { column, ...visibleBoard(c, column.boardId, "column") };
  };
  const visibleCard = (c: Ctx, cardId: string) => {
    const card = state.cards.get(cardId);
    if (card === undefined) throw errors.notFound("card not found");
    return { card, ...visibleBoard(c, card.boardId, "card") };
  };
  const visibleComment = (c: Ctx, commentId: string) => {
    const comment = state.comments.get(commentId);
    if (comment === undefined) throw errors.notFound("comment not found");
    const { card, ...rest } = visibleCard(c, comment.cardId);
    return { comment, card, ...rest };
  };
  const visibleWebhook = (c: Ctx, webhookId: string) => {
    const webhook = state.webhooks.get(webhookId);
    if (webhook === undefined) throw errors.notFound("webhook not found");
    return { webhook, ...visibleTeam(c, webhook.teamId, "webhook") };
  };
  const needRole = (member: MemberRec, min: Role): void => {
    if (ROLE_RANK[member.role] < ROLE_RANK[min]) throw errors.forbidden(`requires the ${min} role or higher`);
  };
  const notArchived = (project: ProjectRec): void => {
    if (project.archived) throw errors.conflict("project_archived", "the project is archived");
  };
  const checkAssignee = (teamId: string, assigneeId: string | null): void => {
    if (assigneeId === null) return;
    const m = state.members.get(memberKey(teamId, assigneeId));
    if (m === undefined || m.role === "viewer") {
      throw new HttpError(400, "invalid_assignee", "assigneeId must be a team member with role owner, admin or member");
    }
  };

  // ---- side effects --------------------------------------------------------------------------

  const audit = (
    c: Ctx,
    teamId: string,
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown> = {},
  ): void => {
    const rec: AuditRec = {
      id: newId("aud", state.audit),
      teamId,
      actorId: c.user.id,
      action,
      targetType,
      targetId,
      details,
      at: c.nowIso,
      seq: nextSeq(),
    };
    state.audit.set(rec.id, rec);
  };

  const createDelivery = (w: WebhookRec, event: string, c: Ctx, data: unknown): string => {
    const id = newId("dlv", engine.deliveries);
    const payload = Buffer.from(
      JSON.stringify({ id, event, teamId: w.teamId, actorId: c.user.id, occurredAt: c.nowIso, data }),
    );
    engine.add({
      id,
      webhookId: w.id,
      teamId: w.teamId,
      event,
      status: "pending",
      attempts: 0,
      lastStatusCode: null,
      lastError: null,
      createdAt: c.nowIso,
      seq: ++deliverySeq,
      payload,
    });
    return id;
  };

  const emit = (c: Ctx, teamId: string, event: string, data: unknown): void => {
    const hooks = [...state.webhooks.values()].filter((w) => w.teamId === teamId).sort(byCreatedAt);
    for (const w of hooks) {
      if (w.active && (w.events.includes("*") || w.events.includes(event))) createDelivery(w, event, c, data);
    }
  };

  // ---- cascades ------------------------------------------------------------------------------

  const deleteCardRecords = (card: CardRec): void => {
    for (const cm of [...state.comments.values()]) if (cm.cardId === card.id) state.comments.delete(cm.id);
    state.cards.delete(card.id);
  };
  const deleteBoardRecords = (board: BoardRec): void => {
    for (const card of [...state.cards.values()]) if (card.boardId === board.id) deleteCardRecords(card);
    for (const col of [...state.columns.values()]) if (col.boardId === board.id) state.columns.delete(col.id);
    state.boards.delete(board.id);
  };
  const deleteProjectRecords = (project: ProjectRec): void => {
    for (const board of [...state.boards.values()]) if (board.projectId === project.id) deleteBoardRecords(board);
    state.projects.delete(project.id);
  };
  const deleteTeamRecords = (team: TeamRec): void => {
    for (const p of [...state.projects.values()]) if (p.teamId === team.id) deleteProjectRecords(p);
    for (const [k, m] of [...state.members]) if (m.teamId === team.id) state.members.delete(k);
    for (const w of [...state.webhooks.values()]) {
      if (w.teamId !== team.id) continue;
      state.webhooks.delete(w.id);
      engine.dropWebhook(w.id);
    }
    for (const a of [...state.audit.values()]) if (a.teamId === team.id) state.audit.delete(a.id);
    state.teams.delete(team.id);
  };

  // ---- pagination ----------------------------------------------------------------------------

  const signCursor = (payload: string): string =>
    createHmac("sha256", cursorKey).update(payload).digest("base64url");
  const makeCursor = (scope: string, offset: number): string => {
    const payload = Buffer.from(JSON.stringify({ s: scope, o: offset })).toString("base64url");
    return `${payload}.${signCursor(payload)}`;
  };
  const readCursor = (scope: string, cursor: string): number => {
    const invalid = errors.invalidQuery("cursor is not valid");
    const dot = cursor.indexOf(".");
    if (dot <= 0) throw invalid;
    const payload = cursor.slice(0, dot);
    if (cursor.slice(dot + 1) !== signCursor(payload)) throw invalid;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw invalid;
    }
    if (!v.isObject(parsed) || parsed.s !== scope) throw invalid;
    const offset = parsed.o;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw invalid;
    return offset;
  };
  /** Parses ?limit= and ?cursor= (step 7). */
  const paging = (c: Ctx, scope: string) => {
    let limit = 20;
    const rawLimit = c.query.get("limit");
    if (rawLimit !== null) {
      if (!/^[0-9]+$/.test(rawLimit)) throw errors.invalidQuery("limit must be an integer from 1 to 100");
      limit = Number(rawLimit);
      if (limit < 1 || limit > 100) throw errors.invalidQuery("limit must be an integer from 1 to 100");
    }
    const rawCursor = c.query.get("cursor");
    const offset = rawCursor === null ? 0 : readCursor(scope, rawCursor);
    return {
      page<T, R>(all: T[], view: (x: T) => R): { items: R[]; nextCursor: string | null } {
        const slice = all.slice(offset, offset + limit);
        const end = offset + slice.length;
        return { items: slice.map(view), nextCursor: end < all.length ? makeCursor(scope, end) : null };
      },
    };
  };

  // ---- auth and rate limiting ----------------------------------------------------------------

  const authenticate = (req: IncomingMessage, nowMs: number): { user: UserRec; tokenHash: string } | null => {
    const header = req.headers.authorization;
    if (typeof header !== "string") return null;
    const m = /^Bearer +(\S+) *$/i.exec(header);
    if (m === null) return null;
    const tokenHash = sha256(m[1]!);
    const token = state.tokens.get(tokenHash);
    if (token === undefined || nowMs >= token.issuedAt + tokenTtlMs) return null;
    const user = state.users.get(token.userId);
    return user === undefined ? null : { user, tokenHash };
  };

  /** Counts the request against the token's window; false means 429. Sets the headers. */
  const rateLimit = (res: ServerResponse, tokenHash: string, nowMs: number): boolean => {
    const start = Math.floor(nowMs / rateWindowMs) * rateWindowMs;
    const end = start + rateWindowMs;
    let entry = rateCounters.get(tokenHash);
    if (entry === undefined || entry.start !== start) {
      entry = { start, count: 0 };
      rateCounters.set(tokenHash, entry);
    }
    res.setHeader("x-ratelimit-limit", String(rateLimitMax));
    res.setHeader("x-ratelimit-reset", String(Math.ceil(end / 1000)));
    if (entry.count >= rateLimitMax) {
      res.setHeader("x-ratelimit-remaining", "0");
      res.setHeader("retry-after", String(Math.max(1, Math.ceil((end - nowMs) / 1000))));
      return false;
    }
    entry.count++;
    res.setHeader("x-ratelimit-remaining", String(rateLimitMax - entry.count));
    return true;
  };

  // ---- routes --------------------------------------------------------------------------------

  const route = (
    method: string,
    path: string,
    opts: { auth?: boolean; body?: boolean },
    fn: RouteDef["fn"],
  ): void => {
    router.add(method, path, { auth: opts.auth ?? true, body: opts.body ?? false, fn });
  };

  route("GET", "/health", { auth: false }, () => ok(200, { ok: true }));

  // ---- 1. accounts and auth

  route("POST", "/auth/register", { auth: false, body: true }, async (c) => {
    const email = v.email(c.body.email);
    const password = v.password(c.body.password, "password");
    const name = v.trimmed(c.body.name, "name", 1, 100);
    const handle = v.handle(c.body.handle);
    const conflicts = () => {
      if (findUserByEmail(email) !== undefined) throw errors.conflict("email_taken", "email is already registered");
      if (findUserByHandle(handle) !== undefined) throw errors.conflict("handle_taken", "handle is already taken");
    };
    conflicts();
    const passwordHash = await hashPassword(password);
    conflicts();
    const user: UserRec = {
      id: newId("usr", state.users),
      email,
      name,
      handle,
      passwordHash,
      createdAt: c.nowIso,
      seq: nextSeq(),
    };
    state.users.set(user.id, user);
    commit();
    return ok(201, userView(user));
  });

  route("POST", "/auth/login", { auth: false, body: true }, async (c) => {
    const { email, password } = c.body;
    if (typeof email !== "string" || typeof password !== "string") {
      throw errors.invalidBody("email and password must be strings");
    }
    const user = findUserByEmail(email.trim().toLowerCase());
    if (user === undefined || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, "invalid_credentials", "unknown email or wrong password");
    }
    const token = randomBytes(32).toString("base64url");
    const hash = sha256(token);
    state.tokens.set(hash, { hash, userId: user.id, issuedAt: c.nowMs });
    commit();
    return ok(200, { token, expiresAt: new Date(c.nowMs + tokenTtlMs).toISOString() });
  });

  route("POST", "/auth/logout", {}, (c) => {
    state.tokens.delete(c.tokenHash);
    commit();
    return ok(204);
  });

  route("GET", "/me", {}, (c) => ok(200, userView(c.user)));

  route("PATCH", "/me", { body: true }, (c) => {
    v.patchFields(c.body, ["name", "handle"]);
    const name = v.has(c.body, "name") ? v.trimmed(c.body.name, "name", 1, 100) : undefined;
    const handle = v.has(c.body, "handle") ? v.handle(c.body.handle) : undefined;
    if (handle !== undefined) {
      const other = findUserByHandle(handle);
      if (other !== undefined && other.id !== c.user.id) throw errors.conflict("handle_taken", "handle is already taken");
    }
    if (name !== undefined) c.user.name = name;
    if (handle !== undefined) c.user.handle = handle;
    commit();
    return ok(200, userView(c.user));
  });

  route("POST", "/me/password", { body: true }, async (c) => {
    const current = c.body.currentPassword;
    if (typeof current !== "string") throw errors.invalidBody("currentPassword must be a string");
    const next = v.password(c.body.newPassword, "newPassword");
    if (!(await verifyPassword(current, c.user.passwordHash))) {
      throw new HttpError(400, "wrong_password", "currentPassword is wrong");
    }
    c.user.passwordHash = await hashPassword(next);
    for (const [hash, t] of [...state.tokens]) if (t.userId === c.user.id) state.tokens.delete(hash);
    commit();
    return ok(204);
  });

  // ---- 2. teams and roles

  route("POST", "/teams", { body: true }, (c) => {
    const name = v.trimmed(c.body.name, "name", 1, 100);
    const team: TeamRec = { id: newId("team", state.teams), name, ownerId: c.user.id, createdAt: c.nowIso, seq: nextSeq() };
    state.teams.set(team.id, team);
    state.members.set(memberKey(team.id, c.user.id), {
      teamId: team.id,
      userId: c.user.id,
      role: "owner",
      joinedAt: c.nowIso,
      seq: nextSeq(),
    });
    audit(c, team.id, "team.created", "team", team.id);
    commit();
    return ok(201, teamView(team, "owner"));
  });

  route("GET", "/teams", {}, (c) => {
    const items = [...state.teams.values()]
      .filter((t) => state.members.has(memberKey(t.id, c.user.id)))
      .sort(byCreatedAt)
      .map((t) => teamView(t, state.members.get(memberKey(t.id, c.user.id))!.role));
    return ok(200, { items });
  });

  route("GET", "/teams/:teamId", {}, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    return ok(200, teamView(team, member.role));
  });

  route("PATCH", "/teams/:teamId", { body: true }, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    needRole(member, "admin");
    const fields = v.patchFields(c.body, ["name"]);
    team.name = v.trimmed(c.body.name, "name", 1, 100);
    audit(c, team.id, "team.updated", "team", team.id, { fields });
    commit();
    return ok(200, teamView(team, member.role));
  });

  route("DELETE", "/teams/:teamId", {}, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    needRole(member, "owner");
    deleteTeamRecords(team);
    commit();
    return ok(204);
  });

  route("GET", "/teams/:teamId/members", {}, (c) => {
    const { team } = visibleTeam(c, c.params.teamId!);
    const items = [...state.members.values()]
      .filter((m) => m.teamId === team.id)
      .sort(byJoinedAt)
      .map(memberView);
    return ok(200, { items });
  });

  route("POST", "/teams/:teamId/members", { body: true }, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    needRole(member, "admin");
    const email = v.email(c.body.email);
    const role = parseRole(c.body.role);
    const user = findUserByEmail(email);
    if (user === undefined) throw new HttpError(404, "user_not_found", "no user has this email");
    const key = memberKey(team.id, user.id);
    if (state.members.has(key)) throw errors.conflict("already_member", "the user is already a member");
    const added: MemberRec = { teamId: team.id, userId: user.id, role, joinedAt: c.nowIso, seq: nextSeq() };
    state.members.set(key, added);
    audit(c, team.id, "member.added", "member", user.id, { role });
    commit();
    const view = memberView(added);
    emit(c, team.id, "member.added", { member: view });
    return ok(201, view);
  });

  route("PATCH", "/teams/:teamId/members/:userId", { body: true }, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    const target = state.members.get(memberKey(team.id, c.params.userId!));
    if (target === undefined) throw errors.notFound("member not found");
    needRole(member, "admin");
    v.patchFields(c.body, ["role"]);
    const role = parseRole(c.body.role);
    if (target.role === "owner") throw errors.conflict("owner_required", "the owner's role cannot change; transfer ownership first");
    const from = target.role;
    target.role = role;
    audit(c, team.id, "member.role_changed", "member", target.userId, { from, to: role });
    commit();
    return ok(200, memberView(target));
  });

  route("DELETE", "/teams/:teamId/members/:userId", {}, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    const key = memberKey(team.id, c.params.userId!);
    const target = state.members.get(key);
    if (target === undefined) throw errors.notFound("member not found");
    if (target.userId !== c.user.id) needRole(member, "admin");
    if (target.role === "owner") throw errors.conflict("owner_required", "the owner cannot be removed; transfer ownership first");
    state.members.delete(key);
    for (const card of cardsOfTeam(team.id)) if (card.assigneeId === target.userId) card.assigneeId = null;
    audit(c, team.id, "member.removed", "member", target.userId);
    commit();
    emit(c, team.id, "member.removed", { userId: target.userId });
    return ok(204);
  });

  route("POST", "/teams/:teamId/transfer", { body: true }, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    needRole(member, "owner");
    const userId = c.body.userId;
    const target = typeof userId === "string" ? state.members.get(memberKey(team.id, userId)) : undefined;
    if (target === undefined || target.userId === c.user.id) {
      throw errors.invalidBody("userId must name another member of the team");
    }
    target.role = "owner";
    member.role = "admin";
    team.ownerId = target.userId;
    audit(c, team.id, "team.transferred", "team", team.id, { from: c.user.id, to: target.userId });
    commit();
    return ok(200, teamView(team, "admin"));
  });

  // ---- 3. projects

  route("POST", "/teams/:teamId/projects", { body: true }, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    needRole(member, "admin");
    const name = v.trimmed(c.body.name, "name", 1, 100);
    const key = c.body.key;
    if (typeof key !== "string" || !KEY_RE.test(key)) throw errors.invalidBody("key must match ^[A-Z][A-Z0-9]{1,5}$");
    const description = v.has(c.body, "description") ? v.plain(c.body.description, "description", 0, 2000) : "";
    for (const p of state.projects.values()) {
      if (p.teamId === team.id && p.key === key) throw errors.conflict("key_taken", "the team already has a project with this key");
    }
    const project: ProjectRec = {
      id: newId("prj", state.projects),
      teamId: team.id,
      name,
      key,
      description,
      archived: false,
      createdAt: c.nowIso,
      updatedAt: c.nowIso,
      nextNumber: 1,
      seq: nextSeq(),
    };
    state.projects.set(project.id, project);
    audit(c, team.id, "project.created", "project", project.id);
    commit();
    return ok(201, projectView(project));
  });

  route("GET", "/teams/:teamId/projects", {}, (c) => {
    const { team } = visibleTeam(c, c.params.teamId!);
    const archived = c.query.get("archived") ?? "false";
    if (archived !== "false" && archived !== "true" && archived !== "all") {
      throw errors.invalidQuery("archived must be false, true or all");
    }
    const items = [...state.projects.values()]
      .filter((p) => p.teamId === team.id && (archived === "all" || p.archived === (archived === "true")))
      .sort(byCreatedAt)
      .map(projectView);
    return ok(200, { items });
  });

  route("GET", "/projects/:projectId", {}, (c) => {
    const { project } = visibleProject(c, c.params.projectId!);
    return ok(200, projectView(project));
  });

  route("PATCH", "/projects/:projectId", { body: true }, (c) => {
    const { project, member } = visibleProject(c, c.params.projectId!);
    needRole(member, "admin");
    if (v.has(c.body, "key")) throw errors.invalidBody("a project key never changes");
    const fields = v.patchFields(c.body, ["name", "description", "archived"]);
    const name = v.has(c.body, "name") ? v.trimmed(c.body.name, "name", 1, 100) : undefined;
    const description = v.has(c.body, "description") ? v.plain(c.body.description, "description", 0, 2000) : undefined;
    const archived = v.has(c.body, "archived") ? v.boolean(c.body.archived, "archived") : undefined;
    if (name !== undefined) project.name = name;
    if (description !== undefined) project.description = description;
    if (archived !== undefined) project.archived = archived;
    project.updatedAt = c.nowIso;
    audit(c, project.teamId, "project.updated", "project", project.id, { fields });
    commit();
    return ok(200, projectView(project));
  });

  route("DELETE", "/projects/:projectId", {}, (c) => {
    const { project, member } = visibleProject(c, c.params.projectId!);
    needRole(member, "admin");
    deleteProjectRecords(project);
    audit(c, project.teamId, "project.deleted", "project", project.id);
    commit();
    return ok(204);
  });

  // ---- 4. boards and columns

  route("POST", "/projects/:projectId/boards", { body: true }, (c) => {
    const { project, member } = visibleProject(c, c.params.projectId!);
    needRole(member, "admin");
    const name = v.trimmed(c.body.name, "name", 1, 50);
    let names = ["To do", "In progress", "Done"];
    if (v.has(c.body, "columns")) {
      const cols = c.body.columns;
      if (!Array.isArray(cols) || cols.length < 1 || cols.length > 20) {
        throw errors.invalidBody("columns must be an array of 1 to 20 names");
      }
      names = cols.map((x, i) => v.trimmed(x, `columns[${i}]`, 1, 50));
    }
    notArchived(project);
    const board: BoardRec = { id: newId("brd", state.boards), projectId: project.id, name, createdAt: c.nowIso, seq: nextSeq() };
    state.boards.set(board.id, board);
    names.forEach((colName, position) => {
      const col: ColumnRec = { id: newId("col", state.columns), boardId: board.id, name: colName, position, wipLimit: null };
      state.columns.set(col.id, col);
    });
    audit(c, project.teamId, "board.created", "board", board.id);
    commit();
    return ok(201, boardView(board));
  });

  route("GET", "/projects/:projectId/boards", {}, (c) => {
    const { project } = visibleProject(c, c.params.projectId!);
    const items = [...state.boards.values()]
      .filter((b) => b.projectId === project.id)
      .sort(byCreatedAt)
      .map(boardView);
    return ok(200, { items });
  });

  route("GET", "/boards/:boardId", {}, (c) => {
    const { board } = visibleBoard(c, c.params.boardId!);
    return ok(200, boardView(board));
  });

  route("PATCH", "/boards/:boardId", { body: true }, (c) => {
    const { board, project, member } = visibleBoard(c, c.params.boardId!);
    needRole(member, "admin");
    const fields = v.patchFields(c.body, ["name"]);
    const name = v.trimmed(c.body.name, "name", 1, 50);
    notArchived(project);
    board.name = name;
    audit(c, project.teamId, "board.updated", "board", board.id, { fields });
    commit();
    return ok(200, boardView(board));
  });

  route("DELETE", "/boards/:boardId", {}, (c) => {
    const { board, project, member } = visibleBoard(c, c.params.boardId!);
    needRole(member, "admin");
    notArchived(project);
    deleteBoardRecords(board);
    audit(c, project.teamId, "board.deleted", "board", board.id);
    commit();
    return ok(204);
  });

  route("POST", "/boards/:boardId/columns", { body: true }, (c) => {
    const { board, project, member } = visibleBoard(c, c.params.boardId!);
    needRole(member, "admin");
    const name = v.trimmed(c.body.name, "name", 1, 50);
    const cols = columnsOfBoard(board.id);
    const position = v.has(c.body, "position") ? v.integer(c.body.position, "position", 0, cols.length) : cols.length;
    const wipLimit = v.has(c.body, "wipLimit") ? v.wipLimit(c.body.wipLimit) : null;
    notArchived(project);
    const col: ColumnRec = { id: newId("col", state.columns), boardId: board.id, name, position, wipLimit };
    state.columns.set(col.id, col);
    cols.splice(position, 0, col);
    renumber(cols);
    audit(c, project.teamId, "column.created", "column", col.id);
    commit();
    return ok(201, columnView(col));
  });

  route("PATCH", "/columns/:columnId", { body: true }, (c) => {
    const { column, board, project, member } = visibleColumn(c, c.params.columnId!);
    needRole(member, "admin");
    const fields = v.patchFields(c.body, ["name", "position", "wipLimit"]);
    const cols = columnsOfBoard(board.id);
    const name = v.has(c.body, "name") ? v.trimmed(c.body.name, "name", 1, 50) : undefined;
    const position = v.has(c.body, "position") ? v.integer(c.body.position, "position", 0, cols.length - 1) : undefined;
    const hasWip = v.has(c.body, "wipLimit");
    const wipLimit = hasWip ? v.wipLimit(c.body.wipLimit) : null;
    notArchived(project);
    if (name !== undefined) column.name = name;
    if (hasWip) column.wipLimit = wipLimit;
    if (position !== undefined) {
      const rest = cols.filter((x) => x !== column);
      rest.splice(position, 0, column);
      renumber(rest);
    }
    audit(c, project.teamId, "column.updated", "column", column.id, { fields });
    commit();
    return ok(200, columnView(column));
  });

  route("DELETE", "/columns/:columnId", {}, (c) => {
    const { column, board, project, member } = visibleColumn(c, c.params.columnId!);
    needRole(member, "admin");
    let target: ColumnRec | undefined;
    if (c.query.has("moveTo")) {
      const t = state.columns.get(c.query.get("moveTo")!);
      if (t === undefined || t.boardId !== board.id || t.id === column.id) {
        throw errors.invalidQuery("moveTo must name another column of the same board");
      }
      target = t;
    }
    notArchived(project);
    const cols = columnsOfBoard(board.id);
    if (cols.length <= 1) throw errors.conflict("last_column", "a board's last column cannot be deleted");
    const cards = cardsOfColumn(column.id);
    if (cards.length > 0 && target === undefined) {
      throw errors.conflict("column_not_empty", "the column still has cards; pass ?moveTo=");
    }
    if (target !== undefined) {
      const base = cardsOfColumn(target.id).length;
      const toId = target.id;
      cards.forEach((card, i) => {
        card.columnId = toId;
        card.position = base + i;
      });
    }
    state.columns.delete(column.id);
    renumber(cols.filter((x) => x !== column));
    audit(c, project.teamId, "column.deleted", "column", column.id);
    commit();
    return ok(204);
  });

  // ---- 5. cards

  route("POST", "/columns/:columnId/cards", { body: true }, (c) => {
    const { column, board, project, member } = visibleColumn(c, c.params.columnId!);
    needRole(member, "member");
    const b = c.body;
    const title = v.trimmed(b.title, "title", 1, 200);
    const description = v.has(b, "description") ? v.plain(b.description, "description", 0, 10000) : "";
    const assigneeId = v.has(b, "assigneeId") ? v.nullableString(b.assigneeId, "assigneeId") : null;
    const labels = v.has(b, "labels") ? v.labels(b.labels) : [];
    const dueDate = v.has(b, "dueDate") ? v.nullableDate(b.dueDate, "dueDate") : null;
    const cards = cardsOfColumn(column.id);
    const position = v.has(b, "position") ? v.integer(b.position, "position", 0, cards.length) : cards.length;
    checkAssignee(project.teamId, assigneeId);
    notArchived(project);
    if (column.wipLimit !== null && cards.length >= column.wipLimit) {
      throw errors.conflict("wip_limit_reached", "the column is at its WIP limit");
    }
    const card: CardRec = {
      id: newId("card", state.cards),
      number: project.nextNumber,
      boardId: board.id,
      columnId: column.id,
      position,
      title,
      description,
      assigneeId,
      labels,
      dueDate,
      createdBy: c.user.id,
      createdAt: c.nowIso,
      updatedAt: c.nowIso,
      seq: nextSeq(),
    };
    project.nextNumber++;
    state.cards.set(card.id, card);
    cards.splice(position, 0, card);
    renumber(cards);
    audit(c, project.teamId, "card.created", "card", card.id);
    commit();
    const view = cardView(card);
    emit(c, project.teamId, "card.created", { card: view });
    return ok(201, view);
  });

  route("GET", "/boards/:boardId/cards", {}, (c) => {
    const { board } = visibleBoard(c, c.params.boardId!);
    let cols = columnsOfBoard(board.id);
    if (c.query.has("columnId")) {
      const id = c.query.get("columnId");
      const col = cols.find((x) => x.id === id);
      if (col === undefined) throw errors.invalidQuery("columnId is not a column of this board");
      cols = [col];
    }
    return ok(200, { items: cols.flatMap((col) => cardsOfColumn(col.id)).map(cardView) });
  });

  route("GET", "/cards/:cardId", {}, (c) => {
    const { card } = visibleCard(c, c.params.cardId!);
    return ok(200, cardView(card));
  });

  route("PATCH", "/cards/:cardId", { body: true }, (c) => {
    const { card, project, member } = visibleCard(c, c.params.cardId!);
    needRole(member, "member");
    const b = c.body;
    const fields = v.patchFields(b, ["title", "description", "assigneeId", "labels", "dueDate"]);
    const title = v.has(b, "title") ? v.trimmed(b.title, "title", 1, 200) : undefined;
    const description = v.has(b, "description") ? v.plain(b.description, "description", 0, 10000) : undefined;
    const hasAssignee = v.has(b, "assigneeId");
    const assigneeId = hasAssignee ? v.nullableString(b.assigneeId, "assigneeId") : null;
    const labels = v.has(b, "labels") ? v.labels(b.labels) : undefined;
    const hasDue = v.has(b, "dueDate");
    const dueDate = hasDue ? v.nullableDate(b.dueDate, "dueDate") : null;
    if (hasAssignee) checkAssignee(project.teamId, assigneeId);
    notArchived(project);
    if (title !== undefined) card.title = title;
    if (description !== undefined) card.description = description;
    if (hasAssignee) card.assigneeId = assigneeId;
    if (labels !== undefined) card.labels = labels;
    if (hasDue) card.dueDate = dueDate;
    card.updatedAt = c.nowIso;
    audit(c, project.teamId, "card.updated", "card", card.id, { fields });
    commit();
    const view = cardView(card);
    emit(c, project.teamId, "card.updated", { card: view, fields });
    return ok(200, view);
  });

  route("POST", "/cards/:cardId/move", { body: true }, (c) => {
    const { card, board, project, member } = visibleCard(c, c.params.cardId!);
    needRole(member, "member");
    const columnId = c.body.columnId;
    if (typeof columnId !== "string") throw errors.invalidBody("columnId must be a string");
    const hasPosition = v.has(c.body, "position");
    if (hasPosition) v.integer(c.body.position, "position", 0, Number.MAX_SAFE_INTEGER);
    const target = state.columns.get(columnId);
    if (target === undefined || target.boardId !== board.id) {
      throw errors.invalidBody("columnId must be a column of the card's board");
    }
    const others = cardsOfColumn(target.id).filter((x) => x !== card);
    const position = hasPosition ? v.integer(c.body.position, "position", 0, others.length) : others.length;
    notArchived(project);
    const fromColumnId = card.columnId;
    const sameColumn = target.id === fromColumnId;
    if (!sameColumn && target.wipLimit !== null && others.length >= target.wipLimit) {
      throw errors.conflict("wip_limit_reached", "the target column is at its WIP limit");
    }
    if (!sameColumn) renumber(cardsOfColumn(fromColumnId).filter((x) => x !== card));
    others.splice(position, 0, card);
    card.columnId = target.id;
    renumber(others);
    card.updatedAt = c.nowIso;
    audit(c, project.teamId, "card.moved", "card", card.id, {
      fromColumnId,
      toColumnId: target.id,
      position: card.position,
    });
    commit();
    const view = cardView(card);
    emit(c, project.teamId, "card.moved", { card: view, fromColumnId, toColumnId: target.id });
    return ok(200, view);
  });

  route("DELETE", "/cards/:cardId", {}, (c) => {
    const { card, project, member } = visibleCard(c, c.params.cardId!);
    needRole(member, "member");
    notArchived(project);
    const view = cardView(card);
    deleteCardRecords(card);
    renumber(cardsOfColumn(card.columnId));
    audit(c, project.teamId, "card.deleted", "card", card.id);
    commit();
    emit(c, project.teamId, "card.deleted", { card: view });
    return ok(204);
  });

  // ---- 6. comments and mentions

  route("POST", "/cards/:cardId/comments", { body: true }, (c) => {
    const { card, project, member } = visibleCard(c, c.params.cardId!);
    needRole(member, "member");
    const body = v.trimmed(c.body.body, "body", 1, 5000);
    let parent: CommentRec | undefined;
    if (v.has(c.body, "parentId") && c.body.parentId !== null) {
      const parentId = c.body.parentId;
      if (typeof parentId !== "string") throw errors.invalidBody("parentId must be null or a string");
      parent = state.comments.get(parentId);
      if (parent === undefined || parent.cardId !== card.id) {
        throw errors.invalidBody("parentId must be a comment on the same card");
      }
    }
    notArchived(project);
    if (parent?.deleted) throw errors.conflict("comment_deleted", "cannot reply to a deleted comment");
    const comment: CommentRec = {
      id: newId("cmt", state.comments),
      cardId: card.id,
      parentId: parent?.id ?? null,
      authorId: c.user.id,
      body,
      mentions: computeMentions(state, body, c.user.id, project.teamId),
      deleted: false,
      createdAt: c.nowIso,
      updatedAt: c.nowIso,
      seq: nextSeq(),
    };
    state.comments.set(comment.id, comment);
    audit(c, project.teamId, "comment.created", "comment", comment.id);
    commit();
    const view = commentView(comment, new Map());
    emit(c, project.teamId, "comment.created", { comment: view });
    return ok(201, view);
  });

  route("GET", "/cards/:cardId/comments", {}, (c) => {
    const { card } = visibleCard(c, c.params.cardId!);
    const groups = commentGroups(card.id);
    return ok(200, { items: (groups.get(null) ?? []).map((x) => commentView(x, groups)) });
  });

  route("GET", "/comments/:commentId", {}, (c) => {
    const { comment } = visibleComment(c, c.params.commentId!);
    return ok(200, commentView(comment, commentGroups(comment.cardId)));
  });

  route("PATCH", "/comments/:commentId", { body: true }, (c) => {
    const { comment, project } = visibleComment(c, c.params.commentId!);
    if (comment.authorId !== c.user.id) throw errors.forbidden("only the author can edit a comment");
    v.patchFields(c.body, ["body"]);
    const body = v.trimmed(c.body.body, "body", 1, 5000);
    notArchived(project);
    if (comment.deleted) throw errors.conflict("comment_deleted", "the comment is deleted");
    comment.body = body;
    comment.mentions = computeMentions(state, body, comment.authorId, project.teamId);
    comment.updatedAt = c.nowIso;
    audit(c, project.teamId, "comment.updated", "comment", comment.id);
    commit();
    return ok(200, commentView(comment, commentGroups(comment.cardId)));
  });

  route("DELETE", "/comments/:commentId", {}, (c) => {
    const { comment, project, member } = visibleComment(c, c.params.commentId!);
    if (comment.authorId !== c.user.id) needRole(member, "admin");
    notArchived(project);
    if (comment.deleted) throw errors.conflict("comment_deleted", "the comment is already deleted");
    comment.deleted = true;
    comment.body = "";
    comment.mentions = [];
    comment.updatedAt = c.nowIso;
    audit(c, project.teamId, "comment.deleted", "comment", comment.id);
    commit();
    return ok(204);
  });

  route("GET", "/me/mentions", {}, (c) => {
    const pg = paging(c, `mentions:${c.user.id}`);
    const rows: { comment: CommentRec; teamId: string }[] = [];
    for (const comment of state.comments.values()) {
      if (comment.deleted || !comment.mentions.includes(c.user.id)) continue;
      const card = state.cards.get(comment.cardId);
      if (card === undefined) continue;
      const teamId = projectOfBoard(card.boardId).teamId;
      if (!state.members.has(memberKey(teamId, c.user.id))) continue;
      rows.push({ comment, teamId });
    }
    rows.sort((a, b) => byCreatedAt(b.comment, a.comment));
    return ok(
      200,
      pg.page(rows, ({ comment, teamId }) => ({
        commentId: comment.id,
        cardId: comment.cardId,
        teamId,
        authorId: comment.authorId,
        createdAt: comment.createdAt,
      })),
    );
  });

  // ---- 7. search

  route("GET", "/teams/:teamId/search", {}, (c) => {
    const { team } = visibleTeam(c, c.params.teamId!);
    const query = c.query;
    const q = query.get("q");
    let terms: string[] = [];
    if (q !== null) {
      if (q.length > 200) throw errors.invalidQuery("q is longer than 200 characters");
      terms = [...new Set(tokenize(q))];
      if (terms.length > 10) throw errors.invalidQuery("q has more than 10 distinct terms");
    }
    const projectId = query.get("projectId");
    const boardId = query.get("boardId");
    const columnId = query.get("columnId");
    const assigneeId = query.get("assigneeId");
    const labels = query.getAll("label").map((l) => l.trim().toLowerCase());
    const dueFrom = query.get("dueFrom");
    const dueTo = query.get("dueTo");
    if (dueFrom !== null && !v.isDate(dueFrom)) throw errors.invalidQuery("dueFrom must be a YYYY-MM-DD date");
    if (dueTo !== null && !v.isDate(dueTo)) throw errors.invalidQuery("dueTo must be a YYYY-MM-DD date");
    const includeArchivedRaw = query.get("includeArchived");
    if (includeArchivedRaw !== null && includeArchivedRaw !== "true" && includeArchivedRaw !== "false") {
      throw errors.invalidQuery("includeArchived must be true or false");
    }
    const includeArchived = includeArchivedRaw === "true";
    const pg = paging(c, `search:${team.id}`);

    // comment bodies per card, non-deleted only
    const commentTokens = new Map<string, string[]>();
    if (terms.length > 0) {
      for (const cm of state.comments.values()) {
        if (cm.deleted) continue;
        const list = commentTokens.get(cm.cardId);
        if (list === undefined) commentTokens.set(cm.cardId, tokenize(cm.body));
        else list.push(...tokenize(cm.body));
      }
    }
    const count = (tokens: string[], term: string) => tokens.reduce((n, t) => (t.startsWith(term) ? n + 1 : n), 0);

    const hits: { card: CardRec; score: number }[] = [];
    for (const card of state.cards.values()) {
      const project = projectOfBoard(card.boardId);
      if (project.teamId !== team.id) continue;
      if (project.archived && !includeArchived) continue;
      if (projectId !== null && project.id !== projectId) continue;
      if (boardId !== null && card.boardId !== boardId) continue;
      if (columnId !== null && card.columnId !== columnId) continue;
      if (assigneeId !== null && card.assigneeId !== (assigneeId === "none" ? null : assigneeId)) continue;
      if (!labels.every((l) => card.labels.includes(l))) continue;
      if ((dueFrom !== null || dueTo !== null) && card.dueDate === null) continue;
      if (dueFrom !== null && card.dueDate! < dueFrom) continue;
      if (dueTo !== null && card.dueDate! > dueTo) continue;
      let score = 0;
      if (terms.length > 0) {
        const title = tokenize(card.title);
        const description = tokenize(card.description);
        const comments = commentTokens.get(card.id) ?? [];
        let matched = true;
        for (const term of terms) {
          const t = count(title, term);
          const d = count(description, term);
          const cc = count(comments, term);
          if (t + d + cc === 0) {
            matched = false;
            break;
          }
          score += 3 * t + d + cc;
        }
        if (!matched) continue;
      }
      hits.push({ card, score });
    }
    hits.sort((a, b) => b.score - a.score || byCreatedAt(a.card, b.card));
    return ok(200, { ...pg.page(hits, (h) => cardView(h.card)), total: hits.length });
  });

  // ---- 8. webhooks

  route("POST", "/teams/:teamId/webhooks", { body: true }, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    needRole(member, "admin");
    const url = parseWebhookUrl(c.body.url);
    const events = parseEvents(c.body.events);
    const secret = v.has(c.body, "secret") ? v.plain(c.body.secret, "secret", 16, 200) : randomBytes(32).toString("hex");
    const active = v.has(c.body, "active") ? v.boolean(c.body.active, "active") : true;
    const webhook: WebhookRec = {
      id: newId("whk", state.webhooks),
      teamId: team.id,
      url,
      events,
      active,
      secret,
      createdAt: c.nowIso,
      updatedAt: c.nowIso,
      seq: nextSeq(),
    };
    state.webhooks.set(webhook.id, webhook);
    audit(c, team.id, "webhook.created", "webhook", webhook.id);
    commit();
    return ok(201, { ...webhookView(webhook), secret });
  });

  route("GET", "/teams/:teamId/webhooks", {}, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    needRole(member, "admin");
    const items = [...state.webhooks.values()]
      .filter((w) => w.teamId === team.id)
      .sort(byCreatedAt)
      .map(webhookView);
    return ok(200, { items });
  });

  route("GET", "/webhooks/:webhookId", {}, (c) => {
    const { webhook, member } = visibleWebhook(c, c.params.webhookId!);
    needRole(member, "admin");
    return ok(200, webhookView(webhook));
  });

  route("PATCH", "/webhooks/:webhookId", { body: true }, (c) => {
    const { webhook, member } = visibleWebhook(c, c.params.webhookId!);
    needRole(member, "admin");
    const fields = v.patchFields(c.body, ["url", "events", "active"]);
    const url = v.has(c.body, "url") ? parseWebhookUrl(c.body.url) : undefined;
    const events = v.has(c.body, "events") ? parseEvents(c.body.events) : undefined;
    const active = v.has(c.body, "active") ? v.boolean(c.body.active, "active") : undefined;
    if (url !== undefined) webhook.url = url;
    if (events !== undefined) webhook.events = events;
    if (active !== undefined) webhook.active = active;
    webhook.updatedAt = c.nowIso;
    audit(c, webhook.teamId, "webhook.updated", "webhook", webhook.id, { fields });
    commit();
    return ok(200, webhookView(webhook));
  });

  route("DELETE", "/webhooks/:webhookId", {}, (c) => {
    const { webhook, member } = visibleWebhook(c, c.params.webhookId!);
    needRole(member, "admin");
    state.webhooks.delete(webhook.id);
    engine.dropWebhook(webhook.id);
    audit(c, webhook.teamId, "webhook.deleted", "webhook", webhook.id);
    commit();
    return ok(204);
  });

  route("POST", "/webhooks/:webhookId/rotate-secret", {}, (c) => {
    const { webhook, member } = visibleWebhook(c, c.params.webhookId!);
    needRole(member, "admin");
    webhook.secret = randomBytes(32).toString("hex");
    webhook.updatedAt = c.nowIso;
    audit(c, webhook.teamId, "webhook.secret_rotated", "webhook", webhook.id);
    commit();
    return ok(200, { ...webhookView(webhook), secret: webhook.secret });
  });

  route("POST", "/webhooks/:webhookId/test", {}, (c) => {
    const { webhook, member } = visibleWebhook(c, c.params.webhookId!);
    needRole(member, "admin");
    const deliveryId = createDelivery(webhook, "ping", c, { webhookId: webhook.id });
    return ok(202, { deliveryId });
  });

  route("GET", "/webhooks/:webhookId/deliveries", {}, (c) => {
    const { webhook, member } = visibleWebhook(c, c.params.webhookId!);
    needRole(member, "admin");
    const pg = paging(c, `deliveries:${webhook.id}`);
    const list = [...engine.deliveries.values()]
      .filter((d) => d.webhookId === webhook.id)
      .sort((a, b) => byCreatedAt(b, a));
    return ok(200, pg.page(list, deliveryView));
  });

  // ---- 11. audit log

  route("GET", "/teams/:teamId/audit", {}, (c) => {
    const { team, member } = visibleTeam(c, c.params.teamId!);
    needRole(member, "admin");
    const action = c.query.get("action");
    const actorId = c.query.get("actorId");
    const pg = paging(c, `audit:${team.id}`);
    const list = [...state.audit.values()]
      .filter((a) => a.teamId === team.id && (action === null || a.action === action) && (actorId === null || a.actorId === actorId))
      .sort((a, b) => byAt(b, a));
    return ok(200, pg.page(list, auditView));
  });

  // ---- the request pipeline (section 0.3) ----------------------------------------------------

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readRaw(req);
    if (raw.aborted) {
      res.destroy();
      return;
    }
    const url = req.url ?? "/";
    const qi = url.indexOf("?");
    const pathname = qi === -1 ? url : url.slice(0, qi);
    const query = new URLSearchParams(qi === -1 ? "" : url.slice(qi + 1));
    // 1. the route exists
    const found = router.match(req.method ?? "", pathname);
    if (found === undefined) throw errors.notFound(`no route for ${req.method} ${pathname}`);
    const def = found.value;
    const nowMs = now();
    const ctx: Ctx = {
      params: found.params,
      query,
      body: {},
      user: undefined as unknown as UserRec,
      tokenHash: "",
      nowMs,
      nowIso: new Date(nowMs).toISOString(),
    };
    if (def.auth) {
      // 2. authentication
      const auth = authenticate(req, nowMs);
      if (auth === null) throw errors.unauthorized();
      // 3. rate limit
      if (!rateLimit(res, auth.tokenHash, nowMs)) throw new HttpError(429, "rate_limited", "too many requests");
      ctx.user = auth.user;
      ctx.tokenHash = auth.tokenHash;
    }
    if (def.body) {
      // 4. body
      if (raw.buf === null) throw new HttpError(413, "body_too_large", "body is larger than 64 KiB");
      if (raw.size === 0) throw errors.invalidBody("a JSON object body is required");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.buf.toString("utf8"));
      } catch {
        throw new HttpError(400, "invalid_json", "body is not valid JSON");
      }
      if (!v.isObject(parsed)) throw errors.invalidBody("body must be a JSON object");
      ctx.body = parsed;
    }
    // 5.-8. run inside the handler, in that order
    const result = await def.fn(ctx);
    if (result.body === undefined) sendEmpty(res, result.status);
    else sendJson(res, result.status, result.body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) sendError(res, err);
      else {
        console.error(err);
        sendError(res, new HttpError(500, "internal", "internal error"));
      }
    });
  });

  // Pending deliveries and their timers stop when the server closes.
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    engine.close();
    return originalClose(callback);
  }) as typeof server.close;
  server.on("close", () => engine.close());

  return server;
}
