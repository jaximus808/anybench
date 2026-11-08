// TDM-170 [2.9] spike helpers. Secrets come from process.env only (run with
// `node --env-file=<path to .env> <script>`); nothing here prints a secret value.
// Every call is appended to $SPIKE_LOG (JSON lines) with secret values redacted.
/* global process, console, setTimeout */
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
// pnpm does not hoist; resolve the SDK and pg through the packages that depend on them.
const serverRequire = createRequire(join(root, "apps/server/package.json"));
const sdkPath = join(
  root,
  "packages/naive/node_modules/@usenaive-sdk/managed-agents/dist/index.js",
);
export const { createClient, ApiError } = await import(sdkPath);
export const pg = serverRequire("pg");

const SECRET_KEYS = [
  "NAIVE_API_KEY",
  "DATABASE_URL_DIRECT",
  "DATABASE_URL",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "STRIPE_TEST_SECRET_KEY",
];

export function redact(text) {
  let out = typeof text === "string" ? text : JSON.stringify(text);
  for (const k of SECRET_KEYS) {
    const v = process.env[k];
    if (v && v.length >= 8) out = out.split(v).join(`<${k}>`);
  }
  // Belt and braces: anything that looks like a key or a postgres URL with a password.
  out = out.replace(/sk_(live|test)_[A-Za-z0-9]+/g, "sk_<redacted>");
  out = out.replace(/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/g, "postgres://<user>:<redacted>@");
  return out;
}

export function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function naive() {
  if (process.env.NAIVE_LIVE !== "1") throw new Error("set NAIVE_LIVE=1 for live Naïve calls");
  return createClient({
    apiKey: need("NAIVE_API_KEY"),
    ...(process.env.NAIVE_BASE_URL ? { baseUrl: process.env.NAIVE_BASE_URL } : {}),
  });
}

const LOG = process.env.SPIKE_LOG;

export function log(step, data) {
  const line = redact({ at: new Date().toISOString(), step, data });
  console.log(line.length > 4000 ? line.slice(0, 4000) + "…" : line);
  if (LOG) appendFileSync(LOG, line + "\n");
}

/** Runs an SDK call, logs request label + trimmed result or error, rethrows nothing unless asked. */
export async function step(label, fn, { rethrow = false } = {}) {
  const t0 = Date.now();
  try {
    const result = await fn();
    log(label, { ok: true, ms: Date.now() - t0, result });
    return result;
  } catch (error) {
    const e =
      error instanceof ApiError
        ? {
            status: error.status,
            code: error.code,
            message: error.message,
            requestId: error.requestId,
          }
        : { message: String(error?.message ?? error) };
    log(label, { ok: false, ms: Date.now() - t0, error: e });
    if (rethrow) throw error;
    return undefined;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
