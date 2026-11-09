import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { makeCore, ROLE_RANK, mk } from "./core.ts";
import { E, HttpError, isObj, sha256 } from "./util.ts";
import { registerBasics } from "./r_basics.ts";
import { registerCards } from "./r_cards.ts";
import { registerMore } from "./r_more.ts";
import { registerRules } from "./r_rules.ts";
import { registerExtra } from "./r_extra.ts";

export interface RateLimitOptions {
  /** Requests allowed per credential (session token or API key) in one window. */
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

export interface AutomationOptions {
  /** How deep rule actions may trigger further rules. Default: 3. */
  maxDepth?: number;
}

export interface TrashOptions {
  /** How long an archived card stays in the trash before it is purged. Default: 2_592_000_000 (30 days). */
  retentionMs?: number;
}

export interface InviteOptions {
  /** Invitation lifetime. Default: 604_800_000 (7 days). */
  ttlMs?: number;
}

export type PlanId = "free" | "team" | "business";

export interface AppOptions {
  /** Where to persist state as JSON. Omit to keep everything in memory. */
  dataFile?: string;
  /** The clock, in milliseconds since the epoch. Default: Date.now. Every time-based rule reads it. */
  now?: () => number;
  /** How long a login token is valid. Default: 86_400_000 (24 hours). */
  tokenTtlMs?: number;
  /** Per-credential (token or API key) rate limit. Default: { limit: 1000, windowMs: 60_000 }. */
  rateLimit?: RateLimitOptions;
  /** Outgoing webhook delivery. Default: { retryDelaysMs: [1000, 5000, 30000], timeoutMs: 5000 }. */
  webhooks?: WebhookOptions;
  /** The plan of every new and every migrated team. Default: "free". */
  defaultPlan?: PlanId;
  /** How long a stored idempotent response is kept. Default: 86_400_000 (24 hours). */
  idempotencyTtlMs?: number;
  /** The automation rule engine. Default: { maxDepth: 3 }. */
  automation?: AutomationOptions;
  /** The archive. Default: { retentionMs: 2_592_000_000 }. */
  trash?: TrashOptions;
  /** Team invitations. Default: { ttlMs: 604_800_000 }. */
  invites?: InviteOptions;
}

const SMALL = 64 * 1024;
const BIG = 1024 * 1024;
const IDEM_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

interface RouteDef {
  method: string;
  parts: string[];
  path: string;
  public: boolean;
  body: "none" | "json" | "raw";
  big: boolean;
  scope: "read" | "write" | "admin";
  keyDenied: boolean;
  teamKeyDenied: boolean;
  fn: (c: any) => any;
}

function readRaw(req: IncomingMessage): Promise<{ buf: Buffer; size: number; aborted: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (aborted: boolean) => {
      if (done) return;
      done = true;
      resolve({ buf: Buffer.concat(chunks), size, aborted });
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BIG + 1) chunks.push(chunk);
    });
    req.on("end", () => finish(false));
    req.on("error", () => finish(true));
    req.on("close", () => finish(!req.complete));
  });
}

export function createApp(options: AppOptions = {}): Server {
  const A = makeCore(options);
  const S = A.state;
  const routes: RouteDef[] = [];
  const rateCounters = new Map<string, { start: number; count: number }>();
  const idem = new Map<string, any>();

  A.route = (method: string, path: string, o: any, fn: (c: any) => any) => {
    routes.push({
      method,
      path,
      parts: path.split("/").filter((p) => p.length > 0),
      public: o.public ?? false,
      body: o.body ?? "none",
      big: o.big ?? false,
      scope: o.admin ? "admin" : method === "GET" ? "read" : "write",
      keyDenied: o.keyDenied ?? false,
      teamKeyDenied: o.teamKeyDenied ?? false,
      fn,
    });
  };
  const match = (method: string, pathname: string) => {
    const parts = pathname.split("/").filter((p) => p.length > 0);
    for (const r of routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let good = true;
      for (let i = 0; i < parts.length; i++) {
        const want = r.parts[i]!;
        const got = parts[i]!;
        if (want.startsWith(":")) {
          try {
            params[want.slice(1)] = decodeURIComponent(got);
          } catch {
            good = false;
            break;
          }
        } else if (want !== got) {
          good = false;
          break;
        }
      }
      if (good) return { def: r, params };
    }
    return undefined;
  };

  // ---- visibility helpers bound to a request ------------------------------------------------
  /** The caller's membership of a team, honouring team-restricted API keys. */
  A.membership = (c: any, teamId: string) => {
    if (c.keyTeamId !== null && c.keyTeamId !== undefined && c.keyTeamId !== teamId) return undefined;
    return S.members.get(mk(teamId, c.user.id));
  };
  A.visibleTeamIds = (c: any): Set<string> => {
    const out = new Set<string>();
    for (const m of S.members.values()) if (m.userId === c.user.id && A.membership(c, m.teamId)) out.add(m.teamId);
    return out;
  };
  A.needRole = (member: any, min: string) => {
    if (ROLE_RANK[member.role]! < ROLE_RANK[min]!) throw E.forbidden(`requires the ${min} role or higher`);
  };
  A.vTeam = (c: any, teamId: string) => {
    const team = S.teams.get(teamId);
    const member = team === undefined ? undefined : A.membership(c, teamId);
    if (team === undefined || member === undefined) throw E.notFound("not found");
    return { team, member };
  };
  A.vProject = (c: any, id: string) => {
    const project = S.projects.get(id);
    if (project === undefined) throw E.notFound("project not found");
    return { project, ...A.vTeam(c, project.teamId) };
  };
  A.vBoard = (c: any, id: string) => {
    const board = S.boards.get(id);
    if (board === undefined) throw E.notFound("board not found");
    return { board, ...A.vProject(c, board.projectId) };
  };
  A.vColumn = (c: any, id: string) => {
    const column = S.columns.get(id);
    if (column === undefined) throw E.notFound("column not found");
    return { column, ...A.vBoard(c, column.boardId) };
  };
  A.vCard = (c: any, id: string) => {
    const card = S.cards.get(id);
    if (card === undefined) throw E.notFound("card not found");
    return { card, ...A.vBoard(c, card.boardId) };
  };
  A.notArchived = (project: any) => {
    if (project.archived) throw E.conflict("project_archived", "the project is archived");
  };
  A.cardNotArchived = (card: any) => {
    if (card.archived) throw E.conflict("card_archived", "the card is archived");
  };
  A.checkAssignee = (teamId: string, assigneeId: string | null) => {
    if (assigneeId === null) return;
    if (!A.isMemberPlus(teamId, assigneeId)) {
      throw new HttpError(400, "invalid_assignee", "assigneeId must be a team member with role owner, admin or member");
    }
  };

  registerBasics(A);
  registerCards(A);
  registerMore(A);
  registerRules(A);
  registerExtra(A);

  // ---- auth and rate limit -------------------------------------------------------------------
  const authenticate = (req: IncomingMessage, nowMs: number) => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice(7);
    if (token.length === 0 || /\s/.test(token)) return null;
    const hash = sha256(token);
    if (token.startsWith("trk_")) {
      const key = [...S.apiKeys.values()].find((k: any) => k.hash === hash);
      if (key === undefined) return null;
      if (key.expiresAt !== null && nowMs >= Date.parse(key.expiresAt)) return null;
      const user = S.users.get(key.userId);
      if (user === undefined) return null;
      return { user, credId: `key:${key.id}`, key };
    }
    const t = S.tokens.get(hash);
    if (t === undefined || nowMs >= t.issuedAt + A.opts.tokenTtlMs) return null;
    const user = S.users.get(t.userId);
    if (user === undefined) return null;
    return { user, credId: `tok:${hash}`, tokenHash: hash, key: null };
  };
  const rateLimit = (res: ServerResponse, credId: string, nowMs: number): boolean => {
    const win = A.opts.rateWindowMs;
    const max = A.opts.rateLimit;
    const start = Math.floor(nowMs / win) * win;
    const end = start + win;
    let entry = rateCounters.get(credId);
    if (entry === undefined || entry.start !== start) {
      entry = { start, count: 0 };
      rateCounters.set(credId, entry);
    }
    res.setHeader("x-ratelimit-limit", String(max));
    res.setHeader("x-ratelimit-reset", String(Math.ceil(end / 1000)));
    if (entry.count >= max) {
      res.setHeader("x-ratelimit-remaining", "0");
      res.setHeader("retry-after", String(Math.max(1, Math.ceil((end - nowMs) / 1000))));
      return false;
    }
    entry.count++;
    res.setHeader("x-ratelimit-remaining", String(max - entry.count));
    return true;
  };

  const sendBody = (res: ServerResponse, status: number, bytes: Buffer | null, contentType: string | null, extra: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    if (bytes === null || status === 204 || status === 304) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": contentType ?? "application/json; charset=utf-8", "content-length": bytes.length });
    res.end(bytes);
  };
  const sendError = (res: ServerResponse, err: HttpError) => {
    const body: any = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    sendBody(res, err.status, Buffer.from(JSON.stringify(body)), "application/json; charset=utf-8");
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readRaw(req);
    if (raw.aborted) {
      res.destroy();
      return;
    }
    const nowMs = A.now();
    try {
      A.runScheduler(nowMs);
    } catch (err) {
      console.error(err);
    }
    const url = req.url ?? "/";
    const qi = url.indexOf("?");
    const pathname = qi === -1 ? url : url.slice(0, qi);
    const query = new URLSearchParams(qi === -1 ? "" : url.slice(qi + 1));
    const method = req.method ?? "";
    try {
      const found = match(method, pathname);
      if (found === undefined) throw E.notFound(`no route for ${method} ${pathname}`);
      const def = found.def;
      const pipe = A.newPipe();
      const c: any = { req, res, params: found.params, query, body: {}, raw: raw.buf, rawSize: raw.size, nowMs, nowIso: new Date(nowMs).toISOString(), pipe, keyTeamId: null };
      let idemKey: string | null = null;
      if (!def.public) {
        const auth = authenticate(req, nowMs);
        if (auth === null) throw E.unauthorized();
        if (!rateLimit(res, auth.credId, nowMs)) throw new HttpError(429, "rate_limited", "too many requests");
        c.user = auth.user;
        c.cred = auth;
        c.tokenHash = auth.tokenHash;
        c.apiKey = auth.key;
        c.keyTeamId = auth.key?.teamId ?? null;
        // 3a
        if (auth.key) {
          if (def.keyDenied || (def.teamKeyDenied && auth.key.teamId !== null)) {
            throw new HttpError(403, "api_key_not_allowed", "API keys may not call this route");
          }
          const rank: Record<string, number> = { read: 0, write: 1, admin: 2 };
          if (rank[auth.key.scope]! < rank[def.scope]!) throw new HttpError(403, "insufficient_scope", `this route needs the ${def.scope} scope`);
        }
        // 3b
        if (method === "POST") {
          const h = req.headers["idempotency-key"];
          if (h !== undefined) {
            const v = Array.isArray(h) ? h.join(",") : h;
            if (!IDEM_RE.test(v)) throw new HttpError(400, "invalid_header", "Idempotency-Key must be 1 to 100 characters of [A-Za-z0-9_.:-]");
            idemKey = `${c.user.id}\u0000${method}\u0000${pathname}\u0000${v}`;
            const stored = idem.get(idemKey);
            if (stored !== undefined && nowMs >= stored.at + A.opts.idemTtlMs) idem.delete(idemKey);
            else if (stored !== undefined) {
              if (!stored.req.equals(raw.buf.subarray(0, raw.size))) throw E.conflict("idempotency_conflict", "the key was used with a different body");
              sendBody(res, stored.status, stored.bytes, stored.contentType, { ...stored.headers, "idempotency-replayed": "true" });
              A.persist();
              return;
            }
          }
        }
        c.chg = A.chgFor(pipe, c.user.id, null, nowMs);
      }
      // 4
      if (def.body !== "none") {
        const limit = def.big ? BIG : SMALL;
        if (raw.size > limit) throw new HttpError(413, "body_too_large", `body is larger than ${limit} bytes`);
        if (def.body === "json") {
          if (raw.size === 0) throw E.body("a JSON object body is required");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.buf.toString("utf8"));
          } catch {
            throw new HttpError(400, "invalid_json", "body is not valid JSON");
          }
          if (!isObj(parsed)) throw E.body("body must be a JSON object");
          c.body = parsed;
        }
      }
      if (c.chg === undefined) c.chg = A.chgFor(pipe, null, null, nowMs);
      const result = (await def.fn(c)) ?? { status: 204 };
      A.runPipeline(pipe);
      A.persist();
      let bytes: Buffer | null = null;
      let contentType: string | null = null;
      if (result.bytes !== undefined) {
        bytes = result.bytes;
        contentType = result.contentType ?? null;
      } else if (result.body !== undefined) {
        const b = typeof result.body === "function" ? result.body() : result.body;
        bytes = Buffer.from(JSON.stringify(b));
        contentType = "application/json; charset=utf-8";
      }
      const headers: Record<string, string> = result.headers ?? {};
      if (idemKey !== null && result.status >= 200 && result.status < 300) {
        idem.set(idemKey, { status: result.status, bytes, contentType, headers, req: Buffer.from(raw.buf.subarray(0, raw.size)), at: nowMs });
      }
      sendBody(res, result.status, bytes, contentType, headers);
    } catch (err) {
      try {
        A.persist();
      } catch (e) {
        console.error(e);
      }
      throw err;
    }
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
  const originalClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    A.engine.close();
    return originalClose(cb);
  }) as typeof server.close;
  server.on("close", () => A.engine.close());
  return server;
}
