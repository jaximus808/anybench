// Hidden-test helpers for todo-api. The gate copies this folder to <workspace>/.hidden-tests/,
// so `../src/app.ts` is the contender's app. The app is imported lazily inside each test, so a
// missing or broken module fails every test on its own instead of crashing the whole file.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export interface Api {
  base: string;
  call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>;
}

type CreateApp = (options?: { dataFile?: string }) => Server;

export async function startApp(t: TestContext, options: { dataFile?: string } = {}): Promise<Api> {
  const mod = (await import("../src/app.ts")) as { createApp: CreateApp };
  const server = mod.createApp(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async call(method, path, body, token) {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
    },
  };
}

let n = 0;
export function uniqueEmail(): string {
  n += 1;
  return `user${n}.${process.pid}@example.test`;
}

/** Registers and logs in a fresh user; asserts both succeed. Returns the bearer token. */
export async function signUp(api: Api, email = uniqueEmail(), password = "correct horse"): Promise<string> {
  const reg = await api.call("POST", "/auth/register", { email, password });
  assert.equal(reg.status, 201, `register should answer 201, got ${reg.status}`);
  const login = await api.call("POST", "/auth/login", { email, password });
  assert.equal(login.status, 200, `login should answer 200, got ${login.status}`);
  assert.equal(typeof login.body?.token, "string", "login should return { token }");
  return login.body.token as string;
}

export async function createTodo(api: Api, token: string, title: string): Promise<any> {
  const res = await api.call("POST", "/todos", { title }, token);
  assert.equal(res.status, 201, `POST /todos should answer 201, got ${res.status}`);
  return res.body;
}

export function assertError(res: { status: number; body: any }, status: number, code: string): void {
  assert.equal(res.status, status);
  assert.equal(res.body?.error?.code, code, `expected error code '${code}'`);
  assert.equal(typeof res.body?.error?.message, "string", "error.message should be a string");
}

export function tempDataFile(): string {
  return join(mkdtempSync(join(tmpdir(), "todo-api-hidden-")), "data.json");
}
