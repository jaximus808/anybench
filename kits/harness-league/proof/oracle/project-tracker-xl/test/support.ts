// Test support for the reference solution's own tests: an HTTP client for a fresh app, a fake
// clock, a team with one user per role, and an event log built on a webhook receiver. Written for
// these tests only; nothing here is shared with any other suite.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { createApp, type AppOptions } from "../src/app.ts";

export const DAY = 86_400_000;

export function startOf(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

export function addDays(date: string, days: number): string {
  return new Date(startOf(date) + days * DAY).toISOString().slice(0, 10);
}

/** A hand-moved clock (AppOptions.now), starting 2026-03-01T12:00:00Z. */
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
  set(ms: number): number {
    this.t = ms;
    return this.t;
  }
  iso(): string {
    return new Date(this.t).toISOString();
  }
  today(): string {
    return this.iso().slice(0, 10);
  }
}

export interface Res {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

export interface CallOpts {
  headers?: Record<string, string>;
  /** A raw request body, sent instead of JSON. */
  raw?: string | Uint8Array;
}

export interface Api {
  base: string;
  call(method: string, path: string, body?: unknown, token?: string, opts?: CallOpts): Promise<Res>;
  close(): Promise<void>;
}

export async function startApp(t: TestContext, options: AppOptions = {}): Promise<Api> {
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close,
    async call(method, path, body, token, opts = {}) {
      const headers: Record<string, string> = { ...opts.headers };
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      let payload: string | Uint8Array | undefined = opts.raw;
      if (body !== undefined) {
        payload = JSON.stringify(body);
        headers["content-type"] ??= "application/json";
      }
      const res = await fetch(base + path, { method, headers, body: payload });
      const text = await res.text();
      let parsed: any;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      return { status: res.status, body: parsed, text, headers: res.headers };
    },
  };
}

export function assertStatus(res: Res, status: number, what = ""): void {
  assert.equal(res.status, status, `${what}: expected ${status}, got ${res.status} ${res.text.slice(0, 300)}`);
}

export function assertError(res: Res, status: number, code: string, what = ""): void {
  assertStatus(res, status, what);
  assert.equal(res.body?.error?.code, code, `${what}: ${res.text.slice(0, 300)}`);
}

export async function ok(api: Api, status: number, method: string, path: string, body?: unknown, token?: string, opts?: CallOpts): Promise<any> {
  const res = await api.call(method, path, body, token, opts);
  assertStatus(res, status, `${method} ${path}`);
  return res.body;
}

export interface User {
  id: string;
  token: string;
  email: string;
  password: string;
  handle: string;
}

let users = 0;
export async function signUp(api: Api, handle = `user${++users}`): Promise<User> {
  const email = `${handle}@example.test`;
  const password = `${handle}-password`;
  const reg = await ok(api, 201, "POST", "/auth/register", { email, password, name: handle, handle });
  const login = await ok(api, 200, "POST", "/auth/login", { email, password });
  return { id: reg.id, token: login.token, email, password, handle };
}

export async function createApiKey(api: Api, user: User, body: Record<string, unknown>): Promise<any> {
  return ok(api, 201, "POST", "/me/api-keys", { name: "key", ...body }, user.token);
}

export async function createProject(api: Api, teamId: string, by: User, key = "ENG"): Promise<any> {
  return ok(api, 201, "POST", `/teams/${teamId}/projects`, { name: `Project ${key}`, key }, by.token);
}

export async function createBoard(api: Api, projectId: string, by: User, extra: Record<string, unknown> = {}): Promise<any> {
  return ok(api, 201, "POST", `/projects/${projectId}/boards`, { name: "Board", ...extra }, by.token);
}

export interface World {
  owner: User;
  admin: User;
  member: User;
  viewer: User;
  outsider: User;
  team: any;
  project: any;
  board: any;
  /** The board's default columns: todo, in_progress, done. */
  cols: string[];
}

/** A team with one user per role (joined 1 s apart on the clock), project ENG and one default board. */
export async function setupBoard(api: Api, clock?: Clock): Promise<World> {
  const owner = await signUp(api);
  const admin = await signUp(api);
  const member = await signUp(api);
  const viewer = await signUp(api);
  const outsider = await signUp(api);
  const team = await ok(api, 201, "POST", "/teams", { name: "Core" }, owner.token);
  for (const [u, role] of [[admin, "admin"], [member, "member"], [viewer, "viewer"]] as const) {
    clock?.advance(1000);
    await ok(api, 201, "POST", `/teams/${team.id}/members`, { email: u.email, role }, owner.token);
  }
  const project = await createProject(api, team.id, owner);
  const board = await createBoard(api, project.id, owner);
  return { owner, admin, member, viewer, outsider, team, project, board, cols: board.columns.map((c: any) => c.id) };
}

export async function createCard(api: Api, columnId: string, by: User, body: Record<string, unknown>): Promise<any> {
  return ok(api, 201, "POST", `/columns/${columnId}/cards`, body, by.token);
}

export async function getCard(api: Api, cardId: string, token: string): Promise<any> {
  return ok(api, 200, "GET", `/cards/${cardId}`, undefined, token);
}

export async function createRule(api: Api, teamId: string, by: User, body: Record<string, unknown>): Promise<any> {
  return ok(api, 201, "POST", `/teams/${teamId}/rules`, { name: "rule", ...body }, by.token);
}

export async function upload(api: Api, cardId: string, token: string, bytes: string | Uint8Array, filename = "f.bin", contentType = "application/octet-stream"): Promise<Res> {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return api.call("POST", `/cards/${cardId}/attachments?filename=${encodeURIComponent(filename)}`, undefined, token, {
    raw,
    headers: { "content-type": contentType },
  });
}

/** Polls `fn` until it returns something other than undefined, or fails after `ms`. */
export async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface EventLog {
  /** Event names in queue order (the deliveries list, oldest first). */
  names(): Promise<string[]>;
  /** The first `n` delivered event bodies, in queue order. */
  events(n: number): Promise<any[]>;
}

/** A webhook on every event of the team, delivering to a local receiver that answers 200. */
export async function eventLog(t: TestContext, api: Api, teamId: string, admin: User): Promise<EventLog> {
  const bodies = new Map<string, any>();
  const rx = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.set(body.id, body);
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => rx.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => rx.close(() => resolve())));
  const url = `http://127.0.0.1:${(rx.address() as AddressInfo).port}/hook`;
  const hook = await ok(api, 201, "POST", `/teams/${teamId}/webhooks`, { url, events: ["*"] }, admin.token);
  const deliveries = async () => {
    const all: any[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const page: any = await ok(api, 200, "GET", `/webhooks/${hook.id}/deliveries?limit=100${q}`, undefined, admin.token);
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return all.reverse();
  };
  return {
    names: async () => (await deliveries()).map((d) => d.event),
    async events(n) {
      const ids = (await deliveries()).slice(0, n).map((d) => d.id);
      assert.equal(ids.length, n, `expected ${n} deliveries`);
      return waitFor(`${n} event bodies`, () => (ids.every((id) => bodies.has(id)) ? ids.map((id) => bodies.get(id)) : undefined));
    },
  };
}
