import { emptyState, mk as memberKey } from "./core.ts";
import { MENTION_RE, newId as rid, startOf } from "./util.ts";

type Role = string;
type CardRec = any;
type ColumnRec = any;
type State = any;
const newId = (prefix: string, _taken: unknown) => rid(prefix);

function computeMentions(state: State, body: string, authorId: string, teamId: string): string[] {
  const byHandle = new Map<string, string>();
  for (const u of state.users.values()) byHandle.set(u.handle, u.id);
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const userId = byHandle.get(m[1]!.toLowerCase());
    if (userId === undefined || userId === authorId) continue;
    if (!state.members.has(memberKey(teamId, userId))) continue;
    if (!out.includes(userId)) out.push(userId);
  }
  return out;
}

type V1 = Record<string, unknown>;

const ROLE_MAP: Record<string, Role> = { manager: "admin", editor: "member", reader: "viewer" };

function list(v: unknown): V1[] {
  return Array.isArray(v) ? v.filter((x): x is V1 => typeof x === "object" && x !== null) : [];
}

function iso(ms: unknown): string {
  return new Date(typeof ms === "number" ? ms : 0).toISOString();
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

/** Section 10.3: handle from the email's local part, with `_2`, `_3`, … on collisions. */
export function deriveHandle(email: string, taken: Set<string>): string {
  const at = email.indexOf("@");
  const local = at === -1 ? email : email.slice(0, at);
  let base = local.replace(/[^a-z0-9_]/g, "_").slice(0, 20);
  if (base.length < 3) base = base.padEnd(3, "_");
  let handle = base;
  for (let n = 2; taken.has(handle); n++) {
    const s = `_${n}`;
    handle = base.slice(0, 20 - s.length) + s;
  }
  return handle;
}

/** Converts a parsed 1.x file to the 2.0 state (section 10.3). */
export function migrateV1(file: V1, o: { defaultPlan: string; nowMs: number }): State {
  const state = emptyState();
  const nextSeq = () => ++state.seq;

  // users
  const handles = new Set<string>();
  for (const u of list(file.users)) {
    const id = str(u.id);
    if (state.users.has(id)) continue;
    const email = str(u.email).trim().toLowerCase();
    const handle = deriveHandle(email, handles);
    handles.add(handle);
    state.users.set(id, {
      id,
      email,
      name: str(u.name),
      handle,
      passwordHash: str(u.passwordHash),
      createdAt: iso(u.createdAt),
      seq: nextSeq(),
      mig: true,
    });
  }

  // teams and members
  for (const t of list(file.teams)) {
    const id = str(t.id);
    if (state.teams.has(id)) continue;
    const createdAt = iso(t.createdAt);
    const ownerId = str(t.owner);
    state.teams.set(id, { id, name: str(t.name), ownerId, plan: o.defaultPlan, createdAt, seq: nextSeq(), mig: true });
    state.members.set(memberKey(id, ownerId), {
      teamId: id,
      userId: ownerId,
      role: "owner",
      joinedAt: createdAt,
      seq: nextSeq(),
      mig: true,
    });
    for (const m of list(t.members)) {
      const userId = str(m.user);
      const key = memberKey(id, userId);
      if (state.members.has(key)) continue;
      state.members.set(key, {
        teamId: id,
        userId,
        role: ROLE_MAP[str(m.role)] ?? "viewer",
        joinedAt: iso(m.addedAt),
        seq: nextSeq(),
        mig: true,
      });
    }
  }

  // projects
  for (const p of list(file.projects)) {
    const id = str(p.id);
    if (state.projects.has(id)) continue;
    const createdAt = iso(p.createdAt);
    state.projects.set(id, {
      id,
      teamId: str(p.teamId),
      name: str(p.name),
      key: str(p.key),
      description: "",
      archived: p.archived === true,
      createdAt,
      updatedAt: createdAt,
      nextNumber: 1,
      seq: nextSeq(),
      mig: true,
    });
  }

  // boards and columns
  const boardColumns = new Map<string, ColumnRec[]>();
  for (const b of list(file.boards)) {
    const id = str(b.id);
    if (state.boards.has(id)) continue;
    state.boards.set(id, {
      id,
      projectId: str(b.projectId),
      name: str(b.name),
      createdAt: iso(b.createdAt),
      seq: nextSeq(),
      mig: true,
    });
    const limits = typeof b.limits === "object" && b.limits !== null ? (b.limits as Record<string, unknown>) : {};
    const cols: ColumnRec[] = [];
    const names = Array.isArray(b.columns) ? b.columns : [];
    names.forEach((rawName: unknown, position: number) => {
      const name = str(rawName);
      const category = names.length === 1 ? "todo" : position === 0 ? "todo" : position === names.length - 1 ? "done" : "in_progress";
      const limit = Object.prototype.hasOwnProperty.call(limits, name) ? limits[name] : undefined;
      const col: ColumnRec = {
        id: newId("col", state.columns),
        boardId: id,
        name,
        position,
        wipLimit: typeof limit === "number" ? limit : null,
        category,
      };
      state.columns.set(col.id, col);
      cols.push(col);
    });
    boardColumns.set(id, cols);
  }

  // cards
  const teamOfBoard = (boardId: string): string | undefined => {
    const board = state.boards.get(boardId);
    return board === undefined ? undefined : state.projects.get(board.projectId)?.teamId;
  };
  const migrated: { card: CardRec; order: number; index: number; projectId: string; createdMs: number }[] = [];
  list(file.cards).forEach((c, index) => {
    const id = str(c.id);
    if (state.cards.has(id)) return;
    const boardId = str(c.boardId);
    const board = state.boards.get(boardId);
    const cols = boardColumns.get(boardId) ?? [];
    if (board === undefined || cols.length === 0) return;
    const project = state.projects.get(board.projectId);
    if (project === undefined) return;
    const column = cols.find((col) => col.name === c.column) ?? cols[0]!;
    const assignee = typeof c.assignee === "string" ? c.assignee : null;
    let assigneeId: string | null = null;
    if (assignee !== null) {
      const m = state.members.get(memberKey(project.teamId, assignee));
      if (m !== undefined && m.role !== "viewer") assigneeId = assignee;
    }
    const tagSet = new Set<string>();
    for (const piece of str(c.tags ?? "").split(",")) {
      const t = piece.trim().toLowerCase();
      if (t.length >= 1 && t.length <= 30) tagSet.add(t);
    }
    const createdAt = iso(c.createdAt);
    const card: CardRec = {
      id,
      number: 0,
      boardId,
      columnId: column.id,
      position: 0,
      title: str(c.title),
      description: typeof c.notes === "string" ? c.notes : "",
      assigneeId,
      labels: [...tagSet].sort().slice(0, 10),
      dueDate: typeof c.due === "number" ? new Date(c.due).toISOString().slice(0, 10) : null,
      priority: "none",
      points: null,
      sprintId: null,
      customFields: {},
      completedAt: column.category === "done" ? createdAt : null,
      archived: false,
      archivedAt: null,
      createdBy: str(c.creator),
      createdAt,
      updatedAt: createdAt,
      seq: nextSeq(),
      mig: true,
      dueJobAt: null,
      history: [{ fromColumnId: null, toColumnId: column.id, at: createdAt }],
    };
    if (card.dueDate !== null && startOf(card.dueDate) > o.nowMs) card.dueJobAt = startOf(card.dueDate);
    state.cards.set(id, card);
    migrated.push({
      card,
      order: typeof c.order === "number" ? c.order : 0,
      index,
      projectId: project.id,
      createdMs: typeof c.createdAt === "number" ? c.createdAt : 0,
    });
  });

  // positions: per 2.0 column, by `order` ascending, ties in file order
  const byColumn = new Map<string, typeof migrated>();
  for (const m of migrated) {
    const group = byColumn.get(m.card.columnId) ?? [];
    group.push(m);
    byColumn.set(m.card.columnId, group);
  }
  for (const group of byColumn.values()) {
    group.sort((a, b) => a.order - b.order || a.index - b.index);
    group.forEach((m, i) => (m.card.position = i));
  }

  // numbers: per project, by createdAt ascending, ties in file order
  const byProject = new Map<string, typeof migrated>();
  for (const m of migrated) {
    const group = byProject.get(m.projectId) ?? [];
    group.push(m);
    byProject.set(m.projectId, group);
  }
  for (const [projectId, group] of byProject) {
    group.sort((a, b) => a.createdMs - b.createdMs || a.index - b.index);
    group.forEach((m, i) => (m.card.number = i + 1));
    state.projects.get(projectId)!.nextNumber = group.length + 1;
  }

  // comments
  const rawComments = list(file.comments);
  const cardOfComment = new Map<string, string>();
  for (const m of rawComments) {
    const id = str(m.id);
    if (!cardOfComment.has(id)) cardOfComment.set(id, str(m.cardId));
  }
  for (const m of rawComments) {
    const id = str(m.id);
    if (state.comments.has(id)) continue;
    const cardId = str(m.cardId);
    const card = state.cards.get(cardId);
    if (card === undefined) continue;
    const teamId = teamOfBoard(card.boardId)!;
    const replyTo = typeof m.replyTo === "string" ? m.replyTo : null;
    const parentId = replyTo !== null && replyTo !== id && cardOfComment.get(replyTo) === cardId ? replyTo : null;
    const createdAt = iso(m.createdAt);
    const body = str(m.text);
    const authorId = str(m.author);
    state.comments.set(id, {
      id,
      cardId,
      parentId,
      authorId,
      body,
      mentions: [],
      deleted: false,
      createdAt,
      updatedAt: createdAt,
      seq: nextSeq(),
      mig: true,
    });
    // mentions are computed once all users and memberships exist (they already do here)
    state.comments.get(id)!.mentions = computeMentions(state, body, authorId, teamId);
  }
  // a parent that was skipped (its card is missing) or a reply cycle would orphan a thread
  for (const c of state.comments.values()) {
    if (c.parentId !== null && !state.comments.has(c.parentId)) c.parentId = null;
  }
  for (const c of state.comments.values()) {
    const seen = new Set<string>([c.id]);
    let p = c.parentId;
    while (p !== null) {
      if (seen.has(p)) {
        c.parentId = null;
        break;
      }
      seen.add(p);
      p = state.comments.get(p)?.parentId ?? null;
    }
  }
  return state;
}
