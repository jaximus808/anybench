import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { migrateV1 } from "./migrate.ts";

export type Role = "owner" | "admin" | "member" | "viewer";

export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * Every record carries `seq` (a global creation counter: the tie-breaker of creation order) and,
 * when it came from a 1.x file, `mig: true` (migrated records sort before everything else).
 */
interface Ordered {
  seq: number;
  mig?: boolean;
}

export interface UserRec extends Ordered {
  id: string;
  email: string;
  name: string;
  handle: string;
  passwordHash: string;
  createdAt: string;
}

export interface TokenRec {
  /** sha256 of the token; the token itself is never stored. */
  hash: string;
  userId: string;
  issuedAt: number;
}

export interface TeamRec extends Ordered {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

export interface MemberRec extends Ordered {
  teamId: string;
  userId: string;
  role: Role;
  joinedAt: string;
}

export interface ProjectRec extends Ordered {
  id: string;
  teamId: string;
  name: string;
  key: string;
  description: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  nextNumber: number;
}

export interface BoardRec extends Ordered {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
}

export interface ColumnRec {
  id: string;
  boardId: string;
  name: string;
  position: number;
  wipLimit: number | null;
}

export interface CardRec extends Ordered {
  id: string;
  number: number;
  boardId: string;
  columnId: string;
  position: number;
  title: string;
  description: string;
  assigneeId: string | null;
  labels: string[];
  dueDate: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommentRec extends Ordered {
  id: string;
  cardId: string;
  parentId: string | null;
  authorId: string;
  body: string;
  mentions: string[];
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookRec extends Ordered {
  id: string;
  teamId: string;
  url: string;
  events: string[];
  active: boolean;
  secret: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRec extends Ordered {
  id: string;
  teamId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  at: string;
}

export interface State {
  seq: number;
  users: Map<string, UserRec>;
  tokens: Map<string, TokenRec>;
  teams: Map<string, TeamRec>;
  /** Keyed by memberKey(teamId, userId). */
  members: Map<string, MemberRec>;
  projects: Map<string, ProjectRec>;
  boards: Map<string, BoardRec>;
  columns: Map<string, ColumnRec>;
  cards: Map<string, CardRec>;
  comments: Map<string, CommentRec>;
  webhooks: Map<string, WebhookRec>;
  audit: Map<string, AuditRec>;
}

export function memberKey(teamId: string, userId: string): string {
  return `${teamId}\u0000${userId}`;
}

export function emptyState(): State {
  return {
    seq: 0,
    users: new Map(),
    tokens: new Map(),
    teams: new Map(),
    members: new Map(),
    projects: new Map(),
    boards: new Map(),
    columns: new Map(),
    cards: new Map(),
    comments: new Map(),
    webhooks: new Map(),
    audit: new Map(),
  };
}

/** A new id that is not in `taken`. */
export function newId(prefix: string, taken: { has(id: string): boolean }): string {
  for (;;) {
    const id = `${prefix}_${randomBytes(9).toString("base64url")}`;
    if (!taken.has(id)) return id;
  }
}

function tsMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Creation order (section 0.5): migrated first, then by timestamp, then by creation sequence. */
export function creationOrder<T extends Ordered>(ts: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => (a.mig ? 0 : 1) - (b.mig ? 0 : 1) || tsMs(ts(a)) - tsMs(ts(b)) || a.seq - b.seq;
}

export const MENTION_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])/g;

/** Section 6: ids of current members of `teamId` mentioned in `body`, first appearance, no author. */
export function computeMentions(state: State, body: string, authorId: string, teamId: string): string[] {
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

// ---------------------------------------------------------------------------------------------
// The data file

interface FileV2 {
  version: 2;
  seq: number;
  users: UserRec[];
  tokens: TokenRec[];
  teams: TeamRec[];
  members: MemberRec[];
  projects: ProjectRec[];
  boards: BoardRec[];
  columns: ColumnRec[];
  cards: CardRec[];
  comments: CommentRec[];
  webhooks: WebhookRec[];
  audit: AuditRec[];
}

export function serialize(state: State): FileV2 {
  return {
    version: 2,
    seq: state.seq,
    users: [...state.users.values()],
    tokens: [...state.tokens.values()],
    teams: [...state.teams.values()],
    members: [...state.members.values()],
    projects: [...state.projects.values()],
    boards: [...state.boards.values()],
    columns: [...state.columns.values()],
    cards: [...state.cards.values()],
    comments: [...state.comments.values()],
    webhooks: [...state.webhooks.values()],
    audit: [...state.audit.values()],
  };
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((x) => [x.id, x]));
}

export function deserialize(file: Record<string, unknown>): State {
  const state = emptyState();
  state.seq = typeof file.seq === "number" ? file.seq : 0;
  state.users = byId(arr<UserRec>(file.users));
  state.tokens = new Map(arr<TokenRec>(file.tokens).map((t) => [t.hash, t]));
  state.teams = byId(arr<TeamRec>(file.teams));
  state.members = new Map(arr<MemberRec>(file.members).map((m) => [memberKey(m.teamId, m.userId), m]));
  state.projects = byId(arr<ProjectRec>(file.projects));
  state.boards = byId(arr<BoardRec>(file.boards));
  state.columns = byId(arr<ColumnRec>(file.columns));
  state.cards = byId(arr<CardRec>(file.cards));
  state.comments = byId(arr<CommentRec>(file.comments));
  state.webhooks = byId(arr<WebhookRec>(file.webhooks));
  state.audit = byId(arr<AuditRec>(file.audit));
  return state;
}

/** Writes the state atomically: a temporary file in the same directory, renamed over the target. */
export function saveState(file: string, state: State): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(serialize(state)));
  renameSync(tmp, file);
}

/** Loads (and for a 1.x file, migrates and rewrites) the data file. Throws on bad files. */
export function loadState(file: string): State {
  if (!existsSync(file)) return emptyState();
  const text = readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(text);
  const version =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).version
      : undefined;
  if (version === 2) return deserialize(parsed as Record<string, unknown>);
  if (version === 1) {
    copyFileSync(file, `${file}.v1.bak`);
    const state = migrateV1(parsed as Record<string, unknown>);
    saveState(file, state);
    return state;
  }
  throw new Error(`unsupported data version: ${JSON.stringify(version)}`);
}
