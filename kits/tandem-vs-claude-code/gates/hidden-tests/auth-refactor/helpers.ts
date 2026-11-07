// Hidden-test helpers for auth-refactor. Copied to <workspace>/.hidden-tests/ by the gate.
// The app is imported lazily inside each test so a broken module fails each test on its own.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export const SECRET = "hidden-test-secret-0123456789abcdef";

type CreateApp = (options?: { env?: Record<string, string | undefined> }) => Server;

export interface Api {
  call(method: string, path: string, opts?: { body?: unknown; token?: string; cookie?: string }): Promise<{
    status: number;
    body: any;
    headers: Headers;
  }>;
}

export async function startApp(t: TestContext, env: Record<string, string> = {}): Promise<Api> {
  const mod = (await import("../src/app.ts")) as { createApp: CreateApp };
  const server = mod.createApp({ env: { JWT_SECRET: SECRET, ...env } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
      if (opts.cookie !== undefined) headers.cookie = opts.cookie;
      const res = await fetch(base + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      return { status: res.status, body: text === "" ? undefined : JSON.parse(text), headers: res.headers };
    },
  };
}

/** Logs in and asserts the JWT contract: 200 { token, expiresIn }. */
export async function login(api: Api, username: string, password: string): Promise<{ token: string; expiresIn: number; res: Awaited<ReturnType<Api["call"]>> }> {
  const res = await api.call("POST", "/auth/login", { body: { username, password } });
  assert.equal(res.status, 200, `login should answer 200, got ${res.status}`);
  assert.equal(typeof res.body?.token, "string", "login should return { token }");
  return { token: res.body.token, expiresIn: res.body.expiresIn, res };
}

export const alice = (api: Api) => login(api, "alice", "wonderland");
export const bob = (api: Api) => login(api, "bob", "builder123");

export function b64url(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

export function decodePart(part: string): any {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** Builds an HS256 JWT by hand, independent of the contender's code. */
export function forge(payload: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): string {
  const head = `${b64url(header)}.${b64url(payload)}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

export function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

export function assertError(res: { status: number; body: any }, status: number, code: string): void {
  assert.equal(res.status, status, `expected ${status} ${code}, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error?.code, code);
}
