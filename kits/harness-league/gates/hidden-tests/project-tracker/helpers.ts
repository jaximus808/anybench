// Hidden-test helpers for project-tracker (kits/tandem-long-horizon, TDM-209 [18.2]). Every
// assertion in these tests traces to workloads/project-tracker/instruction.md and nothing else.
//
// The gate copies this folder to <workspace>/.hidden-tests/, so `../src/app.ts` is the
// contender's app and `./fixtures/tracker-v1.json` is the gate's own copy of the 1.x file (the
// contender can edit the workspace's). The app is imported lazily inside each test, so a missing
// or broken module fails every test on its own instead of crashing the whole file.
//
// Determinism: a fake clock (`now`) for every timestamp, expiry and rate-limit window; webhook
// receivers on 127.0.0.1 ephemeral ports; waits poll a condition with a deadline, never sleep.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export interface AppOptions {
  dataFile?: string;
  now?: () => number;
  tokenTtlMs?: number;
  rateLimit?: { limit: number; windowMs: number };
  webhooks?: { retryDelaysMs?: number[]; timeoutMs?: number };
}

export interface Res {
  status: number;
  body: any;
  headers: Headers;
  text: string;
}

export interface Api {
  base: string;
  server: Server;
  call(method: string, path: string, body?: unknown, token?: string, opts?: { raw?: string; headers?: Record<string, string> }): Promise<Res>;
  close(): Promise<void>;
}

type CreateApp = (options?: AppOptions) => Server;

export async function loadCreateApp(): Promise<CreateApp> {
  const mod = (await import("../src/app.ts")) as { createApp: CreateApp };
  assert.equal(typeof mod.createApp, "function", "src/app.ts must export createApp");
  return mod.createApp;
}

/** A fake clock in ms since the epoch. `clock.now` is the `now` option. */
export class Clock {
  t: number;
  constructor(t = Date.UTC(2026, 2, 1, 12, 0, 0)) {
    this.t = t;
  }
  now = (): number => this.t;
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
  iso(): string {
    return new Date(this.t).toISOString();
  }
}

/** Starts an app on 127.0.0.1:<ephemeral> and closes it when the test ends. */
export async function startApp(t: TestContext, options: AppOptions = {}): Promise<Api> {
  const createApp = await loadCreateApp();
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  };
  t.after(close);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    server,
    close,
    async call(method, path, body, token, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      let payload: string | undefined;
      if (opts.raw !== undefined) payload = opts.raw;
      else if (body !== undefined) payload = JSON.stringify(body);
      if (payload !== undefined) headers["content-type"] ??= "application/json";
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      const res = await fetch(base + path, { method, headers, body: payload });
      const text = await res.text();
      let parsed: any;
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      return { status: res.status, body: parsed, headers: res.headers, text };
    },
  };
}

export function assertError(res: Res, status: number, code: string, what = ""): void {
  const where = what === "" ? "" : `${what}: `;
  assert.equal(res.status, status, `${where}expected ${status} ${code}, got ${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(res.body?.error?.code, code, `${where}expected error code '${code}', got ${res.text.slice(0, 200)}`);
  assert.equal(typeof res.body?.error?.message, "string", `${where}error.message should be a string`);
}

export function assertStatus(res: Res, status: number, what = ""): void {
  const where = what === "" ? "" : `${what}: `;
  assert.equal(res.status, status, `${where}expected ${status}, got ${res.status} ${res.text.slice(0, 300)}`);
}

/** Calls and asserts the status; returns the body. */
export async function ok(api: Api, status: number, method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const res = await api.call(method, path, body, token);
  assertStatus(res, status, `${method} ${path}`);
  return res.body;
}

export interface User {
  id: string;
  token: string;
  email: string;
  password: string;
  handle: string;
  name: string;
}

let seq = 0;
/** A fresh handle matching ^[a-z0-9_]{3,20}$ (unique within the process). */
export function freshHandle(prefix = "user"): string {
  seq += 1;
  return `${prefix}_${seq}`.slice(0, 20);
}

/** Registers and logs in a user; asserts both succeed. */
export async function signUp(api: Api, o: { email?: string; password?: string; name?: string; handle?: string } = {}): Promise<User> {
  const handle = o.handle ?? freshHandle();
  const email = o.email ?? `${handle}@example.test`;
  const password = o.password ?? `pw-${handle}-secret`;
  const name = o.name ?? `Name ${handle}`;
  const reg = await api.call("POST", "/auth/register", { email, password, name, handle });
  assertStatus(reg, 201, "POST /auth/register");
  const login = await api.call("POST", "/auth/login", { email, password });
  assertStatus(login, 200, "POST /auth/login");
  assert.equal(typeof login.body?.token, "string", "login should return { token }");
  return { id: reg.body.id, token: login.body.token, email: email.trim().toLowerCase(), password, handle, name };
}

export async function login(api: Api, email: string, password: string): Promise<string> {
  const res = await api.call("POST", "/auth/login", { email, password });
  assertStatus(res, 200, `login ${email}`);
  return res.body.token as string;
}

export interface World {
  owner: User;
  admin: User;
  member: User;
  viewer: User;
  outsider: User;
  team: any;
}

/** A team with one user per role, plus an outsider who belongs to no team. */
export async function setupTeam(api: Api, clock?: Clock): Promise<World> {
  const owner = await signUp(api, { handle: freshHandle("owner") });
  const admin = await signUp(api, { handle: freshHandle("admin") });
  const member = await signUp(api, { handle: freshHandle("member") });
  const viewer = await signUp(api, { handle: freshHandle("viewer") });
  const outsider = await signUp(api, { handle: freshHandle("outsider") });
  const team = await ok(api, 201, "POST", "/teams", { name: "Core" }, owner.token);
  for (const [u, role] of [
    [admin, "admin"],
    [member, "member"],
    [viewer, "viewer"],
  ] as const) {
    clock?.advance(1000);
    await ok(api, 201, "POST", `/teams/${team.id}/members`, { email: u.email, role }, owner.token);
  }
  return { owner, admin, member, viewer, outsider, team };
}

export async function addMember(api: Api, teamId: string, by: User, who: User, role: string): Promise<any> {
  return ok(api, 201, "POST", `/teams/${teamId}/members`, { email: who.email, role }, by.token);
}

export async function createProject(api: Api, teamId: string, by: User, key = "ENG", extra: Record<string, unknown> = {}): Promise<any> {
  return ok(api, 201, "POST", `/teams/${teamId}/projects`, { name: `Project ${key}`, key, ...extra }, by.token);
}

export async function createBoard(api: Api, projectId: string, by: User, extra: Record<string, unknown> = {}): Promise<any> {
  return ok(api, 201, "POST", `/projects/${projectId}/boards`, { name: "Board", ...extra }, by.token);
}

export async function createCard(api: Api, columnId: string, by: User, body: Record<string, unknown>): Promise<any> {
  return ok(api, 201, "POST", `/columns/${columnId}/cards`, body, by.token);
}

/** A team with roles, one project (key ENG) and one board with the default three columns. */
export async function setupBoard(api: Api, clock?: Clock): Promise<World & { project: any; board: any; cols: string[] }> {
  const w = await setupTeam(api, clock);
  const project = await createProject(api, w.team.id, w.owner);
  const board = await createBoard(api, project.id, w.owner);
  return { ...w, project, board, cols: board.columns.map((c: any) => c.id) };
}

/** The ids of the cards of a column (or a board), in the order the API lists them. */
export async function cardIds(api: Api, token: string, boardId: string, columnId?: string): Promise<string[]> {
  const q = columnId === undefined ? "" : `?columnId=${encodeURIComponent(columnId)}`;
  const body = await ok(api, 200, "GET", `/boards/${boardId}/cards${q}`, undefined, token);
  return body.items.map((c: any) => c.id);
}

/** Follows nextCursor from the first page; returns every item and the pages seen. */
export async function collectPages(api: Api, token: string, path: string, limit: number): Promise<{ items: any[]; pages: any[] }> {
  const sep = path.includes("?") ? "&" : "?";
  const pages: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i++) {
    const url: string = `${path}${sep}limit=${limit}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page = await ok(api, 200, "GET", url, undefined, token);
    pages.push(page);
    assert.ok(Array.isArray(page.items), `${url}: items should be an array`);
    assert.ok(page.items.length <= limit, `${url}: page longer than limit`);
    if (page.nextCursor === null) break;
    assert.equal(typeof page.nextCursor, "string", `${url}: nextCursor should be a string or null`);
    cursor = page.nextCursor;
  }
  assert.equal(pages.at(-1).nextCursor, null, "the last page should have nextCursor null");
  return { items: pages.flatMap((p) => p.items), pages };
}

export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "tracker-hidden-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const FIXTURE_V1 = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tracker-v1.json");

/** A private copy of the gate's 1.x fixture; returns its path. */
export function fixtureCopy(t: TestContext): string {
  const file = join(tempDir(t), "tracker.json");
  copyFileSync(FIXTURE_V1, file);
  return file;
}

/** Polls `fn` until it returns a non-undefined value, or fails after `ms`. */
export async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface Received {
  headers: IncomingHttpHeaders;
  raw: string;
  body: any;
  path: string;
}

export interface Receiver {
  url: string;
  received: Received[];
  waitForCount(n: number, ms?: number): Promise<Received[]>;
}

/**
 * A webhook receiver on 127.0.0.1. `respond(req, n)` decides each answer (n is 1-based);
 * return a status, or "hang" to never answer. Default: 200.
 */
export async function startReceiver(t: TestContext, respond: (r: Received, n: number) => number | "hang" = () => 200): Promise<Receiver> {
  const received: Received[] = [];
  const hanging: ServerResponse[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const r: Received = { headers: req.headers, raw, body, path: req.url ?? "/" };
      received.push(r);
      const answer = respond(r, received.length);
      if (answer === "hang") {
        hanging.push(res);
        return;
      }
      res.writeHead(answer, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const res of hanging) res.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    waitForCount: (n, ms = 10_000) => waitFor(`${n} webhook request(s)`, () => (received.length >= n ? received.slice(0, n) : undefined), ms),
  };
}

/** A URL on 127.0.0.1 where nothing listens (a port that was just freed). */
export async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}/gone`;
}

export function sign(secret: string, raw: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

/** Waits until the webhook's deliveries satisfy `pred`; returns them (newest first). */
export async function waitDeliveries(api: Api, token: string, webhookId: string, what: string, pred: (items: any[]) => boolean, ms = 10_000): Promise<any[]> {
  return waitFor(what, async () => {
    const res = await api.call("GET", `/webhooks/${webhookId}/deliveries?limit=100`, undefined, token);
    if (res.status !== 200) throw new Error(`GET deliveries answered ${res.status}`);
    return pred(res.body.items) ? (res.body.items as any[]) : undefined;
  }, ms);
}

export const sorted = (xs: string[]): string[] => [...xs].sort();
