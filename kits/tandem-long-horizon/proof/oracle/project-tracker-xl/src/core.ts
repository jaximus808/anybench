// The application core: state, ordering, views, the change pipeline (0.8), the scheduler (0.9),
// cascades and the mutations shared by routes, rule actions and scheduler jobs.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DeliveryEngine } from "./webhooks.ts";
import { migrateV1 } from "./migrate.ts";
import {
  E,
  HttpError,
  MENTION_RE,
  addDays,
  dateOf,
  daysBetween,
  daysInMonth,
  isDate,
  isHttpUrl,
  isObj,
  newId,
  startOf,
  weekday,
  DAY,
} from "./util.ts";

export const ROLE_RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export const PLAN_LIMITS: Record<string, Record<string, number | null>> = {
  free: { projects: 3, cards: 100, members: 5, webhooks: 2, rules: 3, recurrences: 2, storageBytes: 1048576 },
  team: { projects: 20, cards: 5000, members: 50, webhooks: 10, rules: 50, recurrences: 20, storageBytes: 104857600 },
  business: { projects: null, cards: null, members: null, webhooks: null, rules: null, recurrences: null, storageBytes: null },
};
export const LIMIT_KEYS = ["projects", "cards", "members", "webhooks", "rules", "recurrences", "storageBytes"];

export const mk = (a: string, b: string): string => `${a}\u0000${b}`;

/** Collections of the state and how each record is keyed. */
export const COLLECTIONS: Record<string, (r: any) => string> = {
  users: (r) => r.id,
  tokens: (r) => r.hash,
  apiKeys: (r) => r.id,
  teams: (r) => r.id,
  members: (r) => mk(r.teamId, r.userId),
  invites: (r) => r.id,
  projects: (r) => r.id,
  boards: (r) => r.id,
  columns: (r) => r.id,
  cards: (r) => r.id,
  comments: (r) => r.id,
  fields: (r) => r.id,
  labels: (r) => r.id,
  checklist: (r) => r.id,
  deps: (r) => mk(r.cardId, r.blockerId),
  sprints: (r) => r.id,
  templates: (r) => r.id,
  recurrences: (r) => r.id,
  rules: (r) => r.id,
  runs: (r) => r.id,
  notifications: (r) => r.id,
  settings: (r) => r.userId,
  watchers: (r) => mk(r.cardId, r.userId),
  attachments: (r) => r.id,
  activity: (r) => r.id,
  views: (r) => r.id,
  timeEntries: (r) => r.id,
  timers: (r) => r.userId,
  webhooks: (r) => r.id,
  audit: (r) => r.id,
};

export function emptyState(): any {
  const s: any = { seq: 0 };
  for (const k of Object.keys(COLLECTIONS)) s[k] = new Map();
  return s;
}

export function serialize(state: any): string {
  const out: any = { version: 2, seq: state.seq };
  for (const k of Object.keys(COLLECTIONS)) out[k] = [...state[k].values()];
  return JSON.stringify(out);
}

export function deserialize(file: any): any {
  const s = emptyState();
  s.seq = typeof file.seq === "number" ? file.seq : 0;
  for (const [k, key] of Object.entries(COLLECTIONS)) {
    const arr = Array.isArray(file[k]) ? file[k] : [];
    for (const r of arr) s[k].set(key(r), r);
  }
  return s;
}

function tsMs(iso: any): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Creation order (0.5): migrated first, then timestamp ascending, then creation sequence. */
export function creationOrder(ts: (x: any) => any = (x) => x.createdAt): (a: any, b: any) => number {
  return (a, b) => (a.mig ? 0 : 1) - (b.mig ? 0 : 1) || tsMs(ts(a)) - tsMs(ts(b)) || a.seq - b.seq;
}
export const byCreated = creationOrder();
export const byJoined = creationOrder((x) => x.joinedAt);
export const byAt = creationOrder((x) => x.at);
export const newestFirst = (cmp: (a: any, b: any) => number) => (a: any, b: any) => cmp(b, a);

export function makeCore(options: any): any {
  const now: () => number = options.now ?? Date.now;
  const opts = {
    tokenTtlMs: options.tokenTtlMs ?? 86_400_000,
    rateLimit: options.rateLimit?.limit ?? 1000,
    rateWindowMs: options.rateLimit?.windowMs ?? 60_000,
    retryDelaysMs: options.webhooks?.retryDelaysMs ?? [1000, 5000, 30000],
    timeoutMs: options.webhooks?.timeoutMs ?? 5000,
    defaultPlan: options.defaultPlan ?? "free",
    idemTtlMs: options.idempotencyTtlMs ?? 86_400_000,
    maxDepth: options.automation?.maxDepth ?? 3,
    retentionMs: options.trash?.retentionMs ?? 2_592_000_000,
    inviteTtlMs: options.invites?.ttlMs ?? 604_800_000,
    dataFile: options.dataFile as string | undefined,
  };

  // ---- load ----------------------------------------------------------------------------------
  let state: any;
  let lastWritten: string | null = null;
  const writeFile = (text: string): void => {
    const file = opts.dataFile!;
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    lastWritten = text;
  };
  if (opts.dataFile === undefined || !existsSync(opts.dataFile)) {
    state = emptyState();
  } else {
    const text = readFileSync(opts.dataFile, "utf8");
    const parsed: any = JSON.parse(text);
    const version = isObj(parsed) ? parsed.version : undefined;
    if (version === 2) {
      state = deserialize(parsed);
      lastWritten = null;
    } else if (version === 1) {
      copyFileSync(opts.dataFile, `${opts.dataFile}.v1.bak`);
      state = migrateV1(parsed, { defaultPlan: opts.defaultPlan, nowMs: now() });
      writeFile(serialize(state));
    } else {
      throw new Error(`unsupported data version: ${JSON.stringify(version)}`);
    }
  }
  if (opts.dataFile !== undefined && lastWritten === null && existsSync(opts.dataFile)) {
    lastWritten = serialize(state);
  }
  const persist = (): void => {
    if (opts.dataFile === undefined) return;
    const text = serialize(state);
    if (text === lastWritten) return;
    if (lastWritten === null && !existsSync(opts.dataFile)) {
      // first write: only when something actually exists
      const empty = serialize(emptyState());
      if (text === empty) return;
    }
    writeFile(text);
  };

  const S = state;
  const seq = (): number => ++S.seq;

  const engine = new DeliveryEngine({
    retryDelaysMs: opts.retryDelaysMs,
    timeoutMs: opts.timeoutMs,
    lookup: (id: string) => S.webhooks.get(id),
  });
  let deliverySeq = 0;
  const cursorKey = randomBytes(32);

  const A: any = { state: S, opts, now, engine, persist, seq };

  // ---- lookups -------------------------------------------------------------------------------
  const values = (k: string): any[] => [...S[k].values()];
  A.values = values;
  const userByEmail = (email: string) => values("users").find((u) => u.email === email);
  const userByHandle = (h: string) => values("users").find((u) => u.handle === h);
  A.userByEmail = userByEmail;
  A.userByHandle = userByHandle;
  const memberRec = (teamId: string, userId: string | null) => (userId === null ? undefined : S.members.get(mk(teamId, userId)));
  A.memberRec = memberRec;
  const isMemberPlus = (teamId: string, userId: string | null) => {
    const m = memberRec(teamId, userId);
    return m !== undefined && m.role !== "viewer";
  };
  A.isMemberPlus = isMemberPlus;
  const boardOf = (id: string) => S.boards.get(id);
  const projectOfBoard = (boardId: string) => S.projects.get(S.boards.get(boardId)?.projectId);
  const projectOfCard = (card: any) => projectOfBoard(card.boardId);
  const teamIdOfCard = (card: any) => projectOfCard(card)?.teamId;
  A.boardOf = boardOf;
  A.projectOfBoard = projectOfBoard;
  A.projectOfCard = projectOfCard;
  A.teamIdOfCard = teamIdOfCard;
  const columnsOfBoard = (boardId: string) =>
    values("columns").filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  A.columnsOfBoard = columnsOfBoard;
  const cardsInColumn = (columnId: string) =>
    values("cards").filter((c) => c.columnId === columnId && !c.archived).sort((a, b) => a.position - b.position);
  A.cardsInColumn = cardsInColumn;
  const renumber = (items: any[]) => items.forEach((x, i) => (x.position = i));
  A.renumber = renumber;
  const cardsOfProject = (projectId: string) =>
    values("cards").filter((c) => S.boards.get(c.boardId)?.projectId === projectId);
  A.cardsOfProject = cardsOfProject;
  const cardsOfTeam = (teamId: string) => values("cards").filter((c) => teamIdOfCard(c) === teamId);
  A.cardsOfTeam = cardsOfTeam;
  const projectsOfTeam = (teamId: string) => values("projects").filter((p) => p.teamId === teamId);
  A.projectsOfTeam = projectsOfTeam;
  const isDoneColumn = (columnId: string) => S.columns.get(columnId)?.category === "done";
  A.isDoneColumn = isDoneColumn;
  const fieldsOfProject = (projectId: string) => values("fields").filter((f) => f.projectId === projectId).sort(byCreated);
  A.fieldsOfProject = fieldsOfProject;
  const teamIdOfField = (f: any) => S.projects.get(f.projectId)?.teamId;
  A.teamIdOfField = teamIdOfField;
  const membersOfTeam = (teamId: string) => values("members").filter((m) => m.teamId === teamId).sort(byJoined);
  A.membersOfTeam = membersOfTeam;
  const watchersOf = (cardId: string) => values("watchers").filter((w) => w.cardId === cardId).sort((a, b) => a.seq - b.seq);
  A.watchersOf = watchersOf;

  // ---- views ---------------------------------------------------------------------------------
  A.userView = (u: any) => ({ id: u.id, email: u.email, name: u.name, handle: u.handle, createdAt: u.createdAt });
  A.teamView = (t: any, myRole: string) => ({ id: t.id, name: t.name, ownerId: t.ownerId, plan: t.plan, createdAt: t.createdAt, myRole });
  A.memberView = (m: any) => {
    const u = S.users.get(m.userId);
    return { userId: m.userId, email: u?.email ?? "", name: u?.name ?? "", handle: u?.handle ?? "", role: m.role, joinedAt: m.joinedAt };
  };
  A.projectView = (p: any) => ({
    id: p.id, teamId: p.teamId, name: p.name, key: p.key, description: p.description, archived: p.archived,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  });
  A.columnView = (c: any) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit, category: c.category });
  A.boardView = (b: any) => ({ id: b.id, projectId: b.projectId, name: b.name, columns: columnsOfBoard(b.id).map(A.columnView), createdAt: b.createdAt });
  const isOpen = (card: any) => card.completedAt === null && !card.archived;
  A.isOpen = isOpen;
  const isBlocked = (card: any): boolean => {
    for (const d of S.deps.values()) {
      if (d.cardId !== card.id) continue;
      const b = S.cards.get(d.blockerId);
      if (b !== undefined && isOpen(b)) return true;
    }
    return false;
  };
  A.isBlocked = isBlocked;
  const checklistOf = (cardId: string) => values("checklist").filter((i) => i.cardId === cardId).sort((a, b) => a.position - b.position);
  A.checklistOf = checklistOf;
  const minutesOf = (cardId: string) => values("timeEntries").filter((e) => e.cardId === cardId).reduce((n, e) => n + e.minutes, 0);
  A.cardView = (c: any) => {
    const items = checklistOf(c.id);
    return {
      id: c.id, number: c.number, key: `${projectOfCard(c)?.key ?? ""}-${c.number}`, boardId: c.boardId, columnId: c.columnId,
      position: c.position, title: c.title, description: c.description, assigneeId: c.assigneeId, labels: [...c.labels],
      dueDate: c.dueDate, priority: c.priority, points: c.points, sprintId: c.sprintId, customFields: structuredClone(c.customFields),
      checklist: { total: items.length, done: items.filter((i) => i.done).length }, blocked: isBlocked(c),
      completedAt: c.completedAt, minutesLogged: minutesOf(c.id), archived: c.archived, archivedAt: c.archivedAt,
      createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
    };
  };
  const commentGroups = (cardId: string) => {
    const groups = new Map<string | null, any[]>();
    for (const c of values("comments").filter((x) => x.cardId === cardId).sort(byCreated)) {
      const g = groups.get(c.parentId);
      if (g === undefined) groups.set(c.parentId, [c]);
      else g.push(c);
    }
    return groups;
  };
  A.commentGroups = commentGroups;
  const commentView = (c: any, groups: Map<string | null, any[]> = new Map()): any => ({
    id: c.id, cardId: c.cardId, parentId: c.parentId, authorId: c.authorId, body: c.body, mentions: [...c.mentions],
    deleted: c.deleted, createdAt: c.createdAt, updatedAt: c.updatedAt,
    replies: (groups.get(c.id) ?? []).map((r) => commentView(r, groups)),
  });
  A.commentView = commentView;
  A.commentTree = (c: any) => commentView(c, commentGroups(c.cardId));
  A.sprintView = (s: any) => ({
    id: s.id, projectId: s.projectId, name: s.name, goal: s.goal, startDate: s.startDate, endDate: s.endDate, state: s.state,
    startedAt: s.startedAt, completedAt: s.completedAt, committedPoints: s.committedPoints, completedPoints: s.completedPoints,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
  });
  A.attachmentView = (a: any) => ({
    id: a.id, cardId: a.cardId, filename: a.filename, contentType: a.contentType, size: a.size, sha256: a.sha256,
    uploadedBy: a.uploadedBy, createdAt: a.createdAt, updatedAt: a.updatedAt,
  });

  // ---- cursors -------------------------------------------------------------------------------
  const sign = (p: string) => createHmac("sha256", cursorKey).update(p).digest("base64url");
  const makeCursor = (scope: string, offset: number) => {
    const p = Buffer.from(JSON.stringify({ s: scope, o: offset })).toString("base64url");
    return `${p}.${sign(p)}`;
  };
  const readCursor = (scope: string, cursor: string): number => {
    const bad = E.query("cursor is not valid");
    const dot = cursor.indexOf(".");
    if (dot <= 0) throw bad;
    const p = cursor.slice(0, dot);
    if (cursor.slice(dot + 1) !== sign(p)) throw bad;
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    } catch {
      throw bad;
    }
    if (!isObj(parsed) || parsed.s !== scope || !Number.isInteger(parsed.o) || parsed.o < 0) throw bad;
    return parsed.o;
  };
  A.paging = (query: URLSearchParams, scope: string) => {
    let limit = 20;
    const rawLimit = query.get("limit");
    if (rawLimit !== null) {
      if (!/^[0-9]+$/.test(rawLimit)) throw E.query("limit must be an integer from 1 to 100");
      limit = Number(rawLimit);
      if (limit < 1 || limit > 100) throw E.query("limit must be an integer from 1 to 100");
    }
    const rawCursor = query.get("cursor");
    const offset = rawCursor === null ? 0 : readCursor(scope, rawCursor);
    return {
      page(all: any[], view: (x: any) => any = (x) => x) {
        const slice = all.slice(offset, offset + limit);
        const end = offset + slice.length;
        return { items: slice.map(view), nextCursor: end < all.length ? makeCursor(scope, end) : null };
      },
    };
  };

  // ---- plans and usage -----------------------------------------------------------------------
  A.usage = (teamId: string) => {
    const projects = projectsOfTeam(teamId);
    const pids = new Set(projects.map((p) => p.id));
    const cards = values("cards").filter((c) => pids.has(S.boards.get(c.boardId)?.projectId)).length;
    const sizes = new Map<string, number>();
    for (const a of values("attachments")) if (a.teamId === teamId) sizes.set(a.sha256, a.size);
    return {
      projects: projects.length,
      cards,
      members: values("members").filter((m) => m.teamId === teamId).length,
      webhooks: values("webhooks").filter((w) => w.teamId === teamId).length,
      rules: values("rules").filter((r) => r.teamId === teamId).length,
      recurrences: values("recurrences").filter((r) => S.projects.get(S.boards.get(r.boardId)?.projectId)?.teamId === teamId).length,
      storageBytes: [...sizes.values()].reduce((a, b) => a + b, 0),
    };
  };
  /** Throws quota_exceeded when adding `add` records of `resource` would pass the team's limit. */
  A.checkQuota = (teamId: string, resource: string, add = 1) => {
    const team = S.teams.get(teamId);
    const limit = PLAN_LIMITS[team.plan]![resource];
    if (limit === null || limit === undefined) return;
    const used = A.usage(teamId)[resource];
    if (used + add > limit) throw E.quota(resource, limit, used);
  };

  // ---- custom field values (15.2) ------------------------------------------------------------
  /** Returns the normalised value, or undefined when invalid. */
  A.fieldValue = (field: any, v: any, teamId: string): any => {
    switch (field.type) {
      case "text": {
        if (typeof v !== "string") return undefined;
        const t = v.trim();
        return t.length >= 1 && t.length <= 500 ? t : undefined;
      }
      case "number":
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
      case "date":
        return isDate(v) ? v : undefined;
      case "select":
        return typeof v === "string" && field.options.includes(v) ? v : undefined;
      case "multiselect": {
        if (!Array.isArray(v) || v.length === 0) return undefined;
        if (!v.every((x) => typeof x === "string" && field.options.includes(x))) return undefined;
        return field.options.filter((o: string) => v.includes(o));
      }
      case "checkbox":
        return typeof v === "boolean" ? v : undefined;
      case "user":
        return typeof v === "string" && memberRec(teamId, v) !== undefined ? v : undefined;
      case "url":
        return isHttpUrl(v, 2000) ? v : undefined;
    }
    return undefined;
  };

  // ---- the change pipeline (0.8) -------------------------------------------------------------
  A.newPipe = () => ({ queue: [] as any[] });
  A.chgFor = (pipe: any, actorId: string | null, via: any, nowMs: number, depth = 0) => ({
    pipe, actorId, via, depth, nowMs, nowIso: new Date(nowMs).toISOString(),
  });
  A.audit = (chg: any, teamId: string, action: string, targetType: string, targetId: string, details: any = {}) => {
    const rec = {
      id: newId("aud"), teamId, actorId: chg.actorId, via: chg.via, action, targetType, targetId, details, at: chg.nowIso, seq: seq(),
    };
    S.audit.set(rec.id, rec);
  };
  A.emit = (chg: any, teamId: string, event: string, data: any, meta: any = {}) => {
    chg.pipe.queue.push({
      event, teamId, actorId: chg.actorId, via: chg.via, occurredAt: chg.nowIso, data, depth: chg.depth,
      cardId: meta.cardId ?? null, projectId: meta.projectId ?? null, prevAssigneeId: meta.prevAssigneeId, nowMs: chg.nowMs,
    });
  };
  A.runPipeline = (pipe: any) => {
    for (let i = 0; i < pipe.queue.length; i++) {
      const ev = pipe.queue[i];
      if (ev.depth < opts.maxDepth) A.runRules(ev, pipe);
    }
    for (const ev of pipe.queue) {
      addActivity(ev);
      notifyForEvent(ev);
      deliverEvent(ev);
    }
  };

  const addActivity = (ev: any) => {
    const rec = {
      id: newId("act"), teamId: ev.teamId, projectId: ev.projectId, cardId: ev.cardId, event: ev.event, actorId: ev.actorId,
      via: ev.via, data: ev.data, at: ev.occurredAt, seq: seq(),
    };
    S.activity.set(rec.id, rec);
  };
  A.activityView = (a: any) => ({
    id: a.id, teamId: a.teamId, projectId: a.projectId, cardId: a.cardId, event: a.event, actorId: a.actorId, via: a.via, data: a.data, at: a.at,
  });

  const createDelivery = (w: any, event: string, body: any, nowIso: string): string => {
    const id = newId("dlv");
    const payload = Buffer.from(JSON.stringify({ id, ...body }));
    engine.add({
      id, webhookId: w.id, teamId: w.teamId, event, status: "pending", attempts: 0, lastStatusCode: null, lastError: null,
      createdAt: nowIso, seq: ++deliverySeq, payload,
    });
    return id;
  };
  A.createDelivery = createDelivery;
  const deliverEvent = (ev: any) => {
    const hooks = values("webhooks").filter((w) => w.teamId === ev.teamId).sort(byCreated);
    for (const w of hooks) {
      if (!w.active || !(w.events.includes("*") || w.events.includes(ev.event))) continue;
      createDelivery(w, ev.event, {
        event: ev.event, teamId: ev.teamId, actorId: ev.actorId, via: ev.via, occurredAt: ev.occurredAt, data: ev.data,
      }, ev.occurredAt);
    }
  };

  // ---- notifications (23) --------------------------------------------------------------------
  const defaultSettings = () => ({
    types: { mention: true, comment: true, assigned: true, moved: true, due: true, rule: true, invite: true },
    mutedProjectIds: [] as string[],
  });
  A.settingsOf = (userId: string) => S.settings.get(userId)?.settings ?? defaultSettings();
  const allowed = (userId: string, type: string, projectId: string | null) => {
    const s = A.settingsOf(userId);
    if (s.types[type] === false) return false;
    if (type !== "invite" && projectId !== null && s.mutedProjectIds.includes(projectId)) return false;
    return true;
  };
  A.notificationAllowed = allowed;
  const addNotification = (n: any) => {
    const rec = {
      id: newId("ntf"), userId: n.userId, type: n.type, teamId: n.teamId, cardId: n.cardId ?? null, commentId: n.commentId ?? null,
      actorId: n.actorId ?? null, via: n.via ?? null, message: n.message ?? null, read: false, readAt: null, createdAt: n.nowIso, seq: seq(),
    };
    S.notifications.set(rec.id, rec);
    return rec;
  };
  A.addNotification = addNotification;
  const notifyForEvent = (ev: any) => {
    const cands: [string, string][] = [];
    const card = ev.cardId === null ? undefined : S.cards.get(ev.cardId);
    const watchers = () => (ev.cardId === null ? [] : watchersOf(ev.cardId).map((w) => w.userId));
    if (ev.event === "comment.created") {
      const mentions: string[] = ev.data.comment.mentions;
      for (const u of mentions) cands.push(["mention", u]);
      for (const u of watchers()) if (!mentions.includes(u)) cands.push(["comment", u]);
    } else if (ev.event === "card.created") {
      if (ev.data.card.assigneeId !== null) cands.push(["assigned", ev.data.card.assigneeId]);
    } else if (ev.event === "card.updated") {
      const a = ev.data.card.assigneeId;
      if (a !== null && a !== ev.prevAssigneeId && ev.prevAssigneeId !== undefined) cands.push(["assigned", a]);
    } else if (ev.event === "card.moved") {
      if (ev.data.fromColumnId !== ev.data.toColumnId) for (const u of watchers()) cands.push(["moved", u]);
    } else if (ev.event === "card.due") {
      if (ev.data.card.assigneeId !== null) cands.push(["due", ev.data.card.assigneeId]);
      for (const u of watchers()) cands.push(["due", u]);
    }
    void card;
    const seen = new Set<string>();
    for (const [type, userId] of cands) {
      if (userId === ev.actorId) continue;
      if (memberRec(ev.teamId, userId) === undefined) continue;
      if (seen.has(userId)) continue;
      seen.add(userId);
      if (!allowed(userId, type, ev.projectId)) continue;
      addNotification({
        userId, type, teamId: ev.teamId, cardId: ev.cardId,
        commentId: type === "mention" || type === "comment" ? ev.data.comment.id : null,
        actorId: ev.actorId, via: ev.via, nowIso: ev.occurredAt,
      });
    }
  };
  A.notificationView = (n: any) => ({
    id: n.id, type: n.type, teamId: n.teamId, cardId: n.cardId, commentId: n.commentId, actorId: n.actorId, via: n.via,
    message: n.message, read: n.read, readAt: n.readAt, createdAt: n.createdAt,
  });

  // ---- watchers ------------------------------------------------------------------------------
  A.watch = (cardId: string, userId: string | null) => {
    if (userId === null) return;
    const k = mk(cardId, userId);
    if (!S.watchers.has(k)) S.watchers.set(k, { cardId, userId, seq: seq() });
  };

  // ---- mentions ------------------------------------------------------------------------------
  A.computeMentions = (body: string, authorId: string, teamId: string): string[] => {
    const out: string[] = [];
    for (const m of body.matchAll(MENTION_RE)) {
      const u = userByHandle(m[1]!.toLowerCase());
      if (u === undefined || u.id === authorId) continue;
      if (memberRec(teamId, u.id) === undefined) continue;
      if (!out.includes(u.id)) out.push(u.id);
    }
    return out;
  };

  // ---- due job (5) ---------------------------------------------------------------------------
  A.scheduleDue = (card: any, nowMs: number) => {
    if (card.dueDate !== null && startOf(card.dueDate) > nowMs) card.dueJobAt = startOf(card.dueDate);
    else card.dueJobAt = null;
  };

  // ---- placeholders (20) ---------------------------------------------------------------------
  A.placeholders = (s: string, vars: Record<string, string>) => {
    let out = s;
    for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
    return out;
  };

  // ---- shared card mutations -----------------------------------------------------------------
  const cardMeta = (card: any, extra: any = {}) => ({ cardId: card.id, projectId: projectOfCard(card)?.id ?? null, ...extra });
  A.cardMeta = cardMeta;
  const completionOnEnter = (card: any, fromColumnId: string | null, toColumnId: string, nowIso: string) => {
    const fromDone = fromColumnId !== null && isDoneColumn(fromColumnId);
    const toDone = isDoneColumn(toColumnId);
    if (toDone && !fromDone) card.completedAt = nowIso;
    else if (!toDone) card.completedAt = null;
  };
  A.completionOnEnter = completionOnEnter;

  /** Creates a card (route, template, recurrence). `p` holds normalised values. */
  A.createCard = (chg: any, p: any) => {
    const { column, project } = p;
    const cards = cardsInColumn(column.id);
    const position = p.position ?? cards.length;
    const number = project.nextNumber;
    project.nextNumber++;
    const vars = { date: dateOf(chg.nowMs), user: p.handle ?? "", number: String(number), project: project.key };
    let title = p.title;
    let description = p.description ?? "";
    if (p.placeholders) {
      title = A.placeholders(title, vars).trim().slice(0, 200);
      description = A.placeholders(description, vars).slice(0, 10000);
    }
    const card: any = {
      id: newId("card"), number, boardId: column.boardId, columnId: column.id, position, title, description,
      assigneeId: p.assigneeId ?? null, labels: p.labels ?? [], dueDate: p.dueDate ?? null, priority: p.priority ?? "none",
      points: p.points ?? null, sprintId: p.sprintId ?? null, customFields: p.customFields ?? {},
      completedAt: isDoneColumn(column.id) ? chg.nowIso : null, archived: false, archivedAt: null,
      createdBy: p.createdBy, createdAt: chg.nowIso, updatedAt: chg.nowIso, seq: seq(), dueJobAt: null,
      history: [{ fromColumnId: null, toColumnId: column.id, at: chg.nowIso }],
    };
    S.cards.set(card.id, card);
    cards.splice(position, 0, card);
    renumber(cards);
    A.scheduleDue(card, chg.nowMs);
    (p.checklist ?? []).forEach((text: string, i: number) => {
      const item = {
        id: newId("chk"), cardId: card.id, text, done: false, position: i, doneAt: null, doneBy: null,
        createdAt: chg.nowIso, updatedAt: chg.nowIso, seq: seq(),
      };
      S.checklist.set(item.id, item);
    });
    if (p.watcher) A.watch(card.id, p.watcher);
    if (card.assigneeId !== null) A.watch(card.id, card.assigneeId);
    A.audit(chg, project.teamId, "card.created", "card", card.id);
    A.emit(chg, project.teamId, "card.created", { card: A.cardView(card) }, cardMeta(card));
    return card;
  };

  /** Applies already-validated attribute changes to a card as one change (PATCH or an action). */
  A.updateCard = (chg: any, card: any, changes: Record<string, any>, fields: string[]) => {
    const project = projectOfCard(card);
    const prevAssigneeId = card.assigneeId;
    for (const [k, v] of Object.entries(changes)) card[k] = v;
    card.updatedAt = chg.nowIso;
    if (Object.prototype.hasOwnProperty.call(changes, "dueDate")) A.scheduleDue(card, chg.nowMs);
    if (Object.prototype.hasOwnProperty.call(changes, "assigneeId") && card.assigneeId !== null && card.assigneeId !== prevAssigneeId) {
      A.watch(card.id, card.assigneeId);
    }
    A.audit(chg, project.teamId, "card.updated", "card", card.id, { fields });
    A.emit(chg, project.teamId, "card.updated", { card: A.cardView(card), fields }, cardMeta(card, { prevAssigneeId }));
  };

  A.moveCard = (chg: any, card: any, target: any, position: number) => {
    const project = projectOfCard(card);
    const fromColumnId = card.columnId;
    const same = target.id === fromColumnId;
    const others = cardsInColumn(target.id).filter((x) => x !== card);
    if (!same) renumber(cardsInColumn(fromColumnId).filter((x) => x !== card));
    others.splice(position, 0, card);
    card.columnId = target.id;
    renumber(others);
    if (!same) completionOnEnter(card, fromColumnId, target.id, chg.nowIso);
    card.history.push({ fromColumnId, toColumnId: target.id, at: chg.nowIso });
    card.updatedAt = chg.nowIso;
    A.audit(chg, project.teamId, "card.moved", "card", card.id, { fromColumnId, toColumnId: target.id, position: card.position });
    A.emit(chg, project.teamId, "card.moved", { card: A.cardView(card), fromColumnId, toColumnId: target.id }, cardMeta(card));
  };

  A.archiveCard = (chg: any, card: any) => {
    const project = projectOfCard(card);
    card.archived = true;
    card.archivedAt = chg.nowIso;
    card.position = null;
    renumber(cardsInColumn(card.columnId));
    card.updatedAt = chg.nowIso;
    A.audit(chg, project.teamId, "card.archived", "card", card.id);
    A.emit(chg, project.teamId, "card.archived", { card: A.cardView(card) }, cardMeta(card));
  };

  A.setFieldValue = (chg: any, card: any, field: any, value: any) => {
    const project = projectOfCard(card);
    if (value === undefined) delete card.customFields[field.id];
    else card.customFields[field.id] = value;
    card.updatedAt = chg.nowIso;
    const fields = ["customFields"];
    A.audit(chg, project.teamId, "card.updated", "card", card.id, { fields });
    A.emit(chg, project.teamId, "card.updated", { card: A.cardView(card), fields }, cardMeta(card, { prevAssigneeId: card.assigneeId }));
  };

  A.addComment = (chg: any, card: any, body: string, parentId: string | null, authorId: string) => {
    const project = projectOfCard(card);
    const comment = {
      id: newId("cmt"), cardId: card.id, parentId, authorId, body, mentions: A.computeMentions(body, authorId, project.teamId),
      deleted: false, createdAt: chg.nowIso, updatedAt: chg.nowIso, seq: seq(),
    };
    S.comments.set(comment.id, comment);
    A.watch(card.id, authorId);
    A.audit(chg, project.teamId, "comment.created", "comment", comment.id);
    A.emit(chg, project.teamId, "comment.created", { comment: commentView(comment) }, cardMeta(card));
    return comment;
  };

  /** Puts cards into a sprint (route or action). Only cards whose sprintId changes. */
  A.addCardsToSprint = (chg: any, sprint: any, cards: any[]) => {
    const changed = cards.filter((c) => c.sprintId !== sprint.id);
    if (changed.length === 0) return changed;
    const project = S.projects.get(sprint.projectId);
    for (const c of changed) {
      c.sprintId = sprint.id;
      c.updatedAt = chg.nowIso;
    }
    A.audit(chg, project.teamId, "sprint.cards_added", "sprint", sprint.id, { cardIds: changed.map((c) => c.id) });
    for (const c of changed) {
      A.emit(chg, project.teamId, "card.updated", { card: A.cardView(c), fields: ["sprintId"] }, cardMeta(c, { prevAssigneeId: c.assigneeId }));
    }
    return changed;
  };

  // ---- cascading deletes ---------------------------------------------------------------------
  /** Removes a card and everything that belongs to it (no event, no audit). */
  A.deleteCardRecords = (card: any) => {
    for (const x of values("comments")) if (x.cardId === card.id) S.comments.delete(x.id);
    for (const x of values("checklist")) if (x.cardId === card.id) S.checklist.delete(x.id);
    for (const x of values("attachments")) if (x.cardId === card.id) S.attachments.delete(x.id);
    for (const x of values("timeEntries")) if (x.cardId === card.id) S.timeEntries.delete(x.id);
    for (const [k, w] of [...S.watchers]) if (w.cardId === card.id) S.watchers.delete(k);
    for (const [k, d] of [...S.deps]) if (d.cardId === card.id || d.blockerId === card.id) S.deps.delete(k);
    for (const [k, t] of [...S.timers]) if (t.cardId === card.id) S.timers.delete(k);
    S.cards.delete(card.id);
  };
  /** DELETE /cards/:cardId and the trash purge. */
  A.deleteCard = (chg: any, card: any, purge: boolean) => {
    const project = projectOfCard(card);
    const snapshot = A.cardView(card);
    const meta = cardMeta(card);
    A.deleteCardRecords(card);
    if (!card.archived) renumber(cardsInColumn(card.columnId));
    A.audit(chg, project.teamId, purge ? "card.purged" : "card.deleted", "card", card.id);
    A.emit(chg, project.teamId, "card.deleted", { card: snapshot }, meta);
  };

  /** Disables every rule of the team matching `pred(rule)` (a cascade). */
  A.disableRules = (teamId: string | null, pred: (r: any) => boolean) => {
    for (const r of values("rules")) if ((teamId === null || r.teamId === teamId) && r.enabled && pred(r)) r.enabled = false;
  };
  A.ruleRefs = (r: any) => {
    const refs = { projects: new Set<string>(), columns: new Set<string>(), fields: new Set<string>(), sprints: new Set<string>(), labels: new Set<string>() };
    if (r.trigger.projectId) refs.projects.add(r.trigger.projectId);
    if (r.trigger.toColumnId) refs.columns.add(r.trigger.toColumnId);
    for (const c of r.conditions) {
      if (c.field === "columnId") refs.columns.add(c.value);
      if (c.field.startsWith("customFields.")) refs.fields.add(c.field.slice("customFields.".length));
      if (c.field === "labels") refs.labels.add(c.value);
    }
    for (const a of r.actions) {
      if (a.type === "move_to_column") refs.columns.add(a.columnId);
      if (a.type === "set_field") refs.fields.add(a.fieldId);
      if (a.type === "add_to_sprint" && a.sprintId !== "active") refs.sprints.add(a.sprintId);
      if (a.type === "add_label" || a.type === "remove_label") refs.labels.add(a.label);
    }
    return refs;
  };
  const disableReferencing = (kind: "projects" | "columns" | "fields" | "sprints", ids: Set<string>) => {
    if (ids.size === 0) return;
    A.disableRules(null, (r) => [...A.ruleRefs(r)[kind]].some((id) => ids.has(id)));
  };
  A.disableReferencing = disableReferencing;

  A.deleteBoardRecords = (board: any) => {
    for (const card of values("cards")) if (card.boardId === board.id) A.deleteCardRecords(card);
    const colIds = new Set<string>();
    for (const col of values("columns")) if (col.boardId === board.id) {
      colIds.add(col.id);
      S.columns.delete(col.id);
    }
    for (const r of values("recurrences")) if (r.boardId === board.id) S.recurrences.delete(r.id);
    S.boards.delete(board.id);
    disableReferencing("columns", colIds);
  };
  A.deleteProjectRecords = (project: any) => {
    for (const b of values("boards")) if (b.projectId === project.id) A.deleteBoardRecords(b);
    const fieldIds = new Set<string>();
    for (const f of values("fields")) if (f.projectId === project.id) {
      fieldIds.add(f.id);
      S.fields.delete(f.id);
    }
    const sprintIds = new Set<string>();
    for (const s of values("sprints")) if (s.projectId === project.id) {
      sprintIds.add(s.id);
      S.sprints.delete(s.id);
    }
    for (const t of values("templates")) if (t.projectId === project.id) S.templates.delete(t.id);
    S.projects.delete(project.id);
    disableReferencing("projects", new Set([project.id]));
    disableReferencing("fields", fieldIds);
    disableReferencing("sprints", sprintIds);
  };
  A.deleteTeamRecords = (team: any) => {
    for (const p of projectsOfTeam(team.id)) A.deleteProjectRecords(p);
    for (const [k, m] of [...S.members]) if (m.teamId === team.id) S.members.delete(k);
    for (const w of values("webhooks")) if (w.teamId === team.id) {
      S.webhooks.delete(w.id);
      engine.dropWebhook(w.id);
    }
    for (const k of ["labels", "invites", "views", "notifications", "activity", "audit"]) {
      for (const x of values(k)) if (x.teamId === team.id) S[k].delete(x.id);
    }
    for (const r of values("rules")) if (r.teamId === team.id) {
      S.rules.delete(r.id);
      for (const run of values("runs")) if (run.ruleId === r.id) S.runs.delete(run.id);
    }
    S.teams.delete(team.id);
  };

  /** Cascades when a user leaves or is removed from a team (2). */
  A.leaveTeamCascade = (teamId: string, userId: string) => {
    const cards = cardsOfTeam(teamId);
    const cardIds = new Set(cards.map((c) => c.id));
    for (const c of cards) if (c.assigneeId === userId) c.assigneeId = null;
    for (const [k, w] of [...S.watchers]) if (w.userId === userId && cardIds.has(w.cardId)) S.watchers.delete(k);
    for (const v of values("views")) if (v.teamId === teamId && v.ownerId === userId && !v.shared) S.views.delete(v.id);
    const t = S.timers.get(userId);
    if (t !== undefined && cardIds.has(t.cardId)) S.timers.delete(userId);
    const pids = new Set(projectsOfTeam(teamId).map((p) => p.id));
    const userFields = values("fields").filter((f) => f.type === "user" && pids.has(f.projectId));
    for (const f of userFields) {
      for (const c of cards) if (c.customFields[f.id] === userId) delete c.customFields[f.id];
      for (const tp of values("templates")) if (tp.projectId === f.projectId && tp.customFields[f.id] === userId) delete tp.customFields[f.id];
    }
  };

  // ---- recurrences (21) ----------------------------------------------------------------------
  /** Occurrence dates >= from, in order (generator). */
  A.occurrenceDates = function* (r: any, from: string): Generator<string> {
    const s = r.schedule;
    const start = r.startDate;
    const end = r.endDate;
    const lo = from > start ? from : start;
    if (s.frequency === "daily") {
      const diff = daysBetween(start, lo);
      let k = Math.max(0, Math.ceil(diff / s.interval));
      for (;;) {
        const d = addDays(start, k * s.interval);
        if (end !== null && d > end) return;
        if (d >= lo) yield d;
        k++;
      }
    } else if (s.frequency === "weekly") {
      const wd = weekday(start);
      const M = addDays(start, -((wd + 6) % 7));
      let d = lo;
      let guard = 0;
      for (;;) {
        if (end !== null && d > end) return;
        const weeks = Math.floor(daysBetween(M, d) / 7);
        if (weeks % s.interval !== 0) {
          // jump to the start of the next valid week
          const nextWeek = (Math.floor(weeks / s.interval) + 1) * s.interval;
          d = addDays(M, nextWeek * 7);
          continue;
        }
        if (s.weekdays.includes(weekday(d))) yield d;
        d = addDays(d, 1);
        if (++guard > 10_000_000) return;
      }
    } else {
      const y0 = Number(start.slice(0, 4));
      const m0 = Number(start.slice(5, 7)) - 1;
      const ly = Number(lo.slice(0, 4));
      const lm = Number(lo.slice(5, 7)) - 1;
      const monthsToLo = (ly - y0) * 12 + (lm - m0);
      let k = Math.max(0, Math.floor(monthsToLo / s.interval) - 1);
      for (;;) {
        const total = m0 + k * s.interval;
        const y = y0 + Math.floor(total / 12);
        const m = ((total % 12) + 12) % 12;
        const day = Math.min(s.dayOfMonth, daysInMonth(y, m));
        const d = `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        if (end !== null && d > end) return;
        if (d >= start && d >= lo) yield d;
        k++;
        if (y > 9999) return;
      }
    }
  };
  A.occurrenceInstant = (r: any, d: string) => {
    const [hh, mm] = r.schedule.time.split(":").map(Number);
    return startOf(d) + (hh * 60 + mm) * 60_000;
  };
  /** The first `count` occurrence instants later than nowMs. */
  A.nextOccurrences = (r: any, nowMs: number, count: number): number[] => {
    const out: number[] = [];
    const from = dateOf(nowMs - DAY);
    for (const d of A.occurrenceDates(r, from)) {
      const inst = A.occurrenceInstant(r, d);
      if (inst > nowMs) out.push(inst);
      if (out.length >= count) break;
    }
    return out;
  };
  A.computeNextRun = (r: any, nowMs: number) => {
    if (!r.active) {
      r.nextRunAt = null;
      return;
    }
    const [n] = A.nextOccurrences(r, nowMs, 1);
    r.nextRunAt = n === undefined ? null : new Date(n).toISOString();
  };

  const runRecurrence = (r: any, nowMs: number) => {
    const pipe = A.newPipe();
    const chg = A.chgFor(pipe, r.createdBy, { type: "recurrence", recurrenceId: r.id }, nowMs);
    const board = S.boards.get(r.boardId);
    const project = S.projects.get(board.projectId);
    const column = S.columns.get(r.columnId);
    const template = r.templateId === null ? null : S.templates.get(r.templateId);
    let error: string | null = null;
    const creator = memberRec(project.teamId, r.createdBy);
    const content = template
      ? { title: template.title, description: template.description, labels: [...template.labels], priority: template.priority, points: template.points, customFields: structuredClone(template.customFields), checklist: [...template.checklist] }
      : { title: r.title, description: r.description, labels: [...r.labels], priority: r.priority, points: r.points, customFields: {}, checklist: [] };
    if (creator === undefined || creator.role === "viewer") error = "forbidden";
    else if (project.archived) error = "project_archived";
    else {
      const limit = PLAN_LIMITS[S.teams.get(project.teamId).plan]!.cards;
      if (limit !== null && A.usage(project.teamId).cards + 1 > limit) error = "quota_exceeded";
      else if (column.wipLimit !== null && cardsInColumn(column.id).length >= column.wipLimit) error = "wip_limit_reached";
      else if (r.assigneeId !== null && !isMemberPlus(project.teamId, r.assigneeId)) error = "invalid_assignee";
      else {
        for (const f of fieldsOfProject(project.id)) {
          if (f.required && !Object.prototype.hasOwnProperty.call(content.customFields, f.id)) {
            error = "field_required";
            break;
          }
        }
      }
    }
    r.lastRunAt = chg.nowIso;
    r.lastError = error;
    if (error === null) {
      const card = A.createCard(chg, {
        column, project, ...content, assigneeId: r.assigneeId, dueDate: null, sprintId: null, createdBy: r.createdBy,
        watcher: r.createdBy, placeholders: true, handle: S.users.get(r.createdBy)?.handle ?? "",
      });
      r.lastCardId = card.id;
    }
    A.computeNextRun(r, nowMs);
    A.runPipeline(pipe);
  };

  // ---- the scheduler (0.9) -------------------------------------------------------------------
  A.runScheduler = (nowMs: number) => {
    for (let guard = 0; guard < 100_000; guard++) {
      let best: any = null;
      const consider = (at: number, kind: number, rec: any) => {
        if (at > nowMs) return;
        if (best === null || at < best.at || (at === best.at && (kind < best.kind || (kind === best.kind && byCreated(rec, best.rec) < 0)))) {
          best = { at, kind, rec };
        }
      };
      for (const c of S.cards.values()) {
        if (c.dueJobAt !== null && c.dueJobAt !== undefined) consider(c.dueJobAt, 0, c);
        if (c.archived) consider(tsMs(c.archivedAt) + opts.retentionMs, 2, c);
      }
      for (const r of S.recurrences.values()) if (r.nextRunAt !== null) consider(tsMs(r.nextRunAt), 1, r);
      if (best === null) return;
      const { kind, rec } = best;
      if (kind === 0) {
        rec.dueJobAt = null;
        const project = projectOfCard(rec);
        if (!rec.archived && rec.completedAt === null && project && !project.archived) {
          const pipe = A.newPipe();
          const chg = A.chgFor(pipe, null, { type: "schedule" }, nowMs);
          A.emit(chg, project.teamId, "card.due", { card: A.cardView(rec) }, cardMeta(rec));
          A.runPipeline(pipe);
        }
      } else if (kind === 1) {
        runRecurrence(rec, nowMs);
      } else {
        const pipe = A.newPipe();
        const chg = A.chgFor(pipe, null, { type: "schedule" }, nowMs);
        A.deleteCard(chg, rec, true);
        A.runPipeline(pipe);
      }
    }
  };

  A.HttpError = HttpError;
  return A;
}
