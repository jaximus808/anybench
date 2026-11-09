import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/app.ts";

async function start(t: { after(fn: () => unknown): void }): Promise<string> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test("GET /health answers ok", async (t) => {
  const base = await start(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("unknown routes answer 404 with the error body", async (t) => {
  const base = await start(t);
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "not_found");
  assert.equal(typeof body.error.message, "string");
});
