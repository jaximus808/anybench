// Naïve fullstack app entry (TDM-154). The API runs as a Naïve `fullstack` app, which is a Vercel
// project in Naïve's team: Node 22 functions with Fluid compute, requests capped at 300 s
// (docs/findings/naive-hosting.md, section 2). scripts/deploy/api.ts bundles this file into
// `api/app.js`, and its vercel.json rewrites every path to `/api/app?__path=/<path>`.
//
// The same createApp runs here, in entry-vercel.ts (our own Vercel project) and in main.ts
// (@hono/node-server, local dev). This file only adapts the host:
// - The rewrite moves the original path into `__path`; restore it before Hono routes the request.
// - The platform owns every `DATABASE_*` name on the app (they point at the app's managed
//   Postgres). Our Neon URLs arrive as ANYBENCH_DATABASE_URL / ANYBENCH_DATABASE_URL_DIRECT and
//   are mapped onto the names config.ts reads. Without them the function refuses to boot rather
//   than silently use the platform database.
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import { ConfigError } from "./config.js";
import { buildServerlessApp } from "./entry-vercel.js";
import type { AppEnv } from "./types.js";

/** The query parameter the vercel.json rewrite carries the original path in. */
export const REWRITE_PATH_PARAM = "__path";

/** The vercel.json the deploy ships next to `api/app.js`. */
export function naiveVercelJson(maxDurationSec = 300): Record<string, unknown> {
  return {
    functions: { "api/app.js": { maxDuration: maxDurationSec } },
    rewrites: [{ source: "/(.*)", destination: `/api/app?${REWRITE_PATH_PARAM}=/$1` }],
  };
}

/**
 * `/api/app?__path=/auth/github/callback&code=x` → `/auth/github/callback?code=x`. A URL without
 * the parameter (a direct hit on the function, or a host that keeps the original path) is
 * returned unchanged. The restored path must be absolute, else the URL is left alone.
 */
export function restoreRewrittenPath(rawUrl: string): string {
  const url = new URL(rawUrl, "http://naive.invalid");
  const original = url.searchParams.get(REWRITE_PATH_PARAM);
  if (original === null || !original.startsWith("/") || original.startsWith("//")) return rawUrl;
  url.searchParams.delete(REWRITE_PATH_PARAM);
  const qs = url.searchParams.toString();
  return original + (qs ? `?${qs}` : "");
}

/** Map the app's ANYBENCH_DATABASE_* secrets onto DATABASE_*; refuse to boot without them. */
export function naiveEnvSource(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const pooled = env.ANYBENCH_DATABASE_URL?.trim();
  const direct = env.ANYBENCH_DATABASE_URL_DIRECT?.trim();
  const issues = [];
  if (!pooled) {
    issues.push({
      path: "ANYBENCH_DATABASE_URL",
      message: "required on the Naïve app (DATABASE_URL is the platform's managed Postgres)",
    });
  }
  if (!direct) {
    issues.push({ path: "ANYBENCH_DATABASE_URL_DIRECT", message: "required on the Naïve app" });
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return { ...env, DATABASE_URL: pooled, DATABASE_URL_DIRECT: direct };
}

let appPromise: Promise<Hono<AppEnv>> | undefined;

/** One app per function instance, built on first request. A failed boot is retried next time. */
export function getNaiveApp(): Promise<Hono<AppEnv>> {
  // Fluid compute serves many requests per instance at once, so the pool gets a few connections
  // (Neon's PgBouncer pooler multiplexes them).
  appPromise ??= Promise.resolve()
    .then(() => {
      const source = naiveEnvSource(process.env);
      // Code that reads process.env directly (getDb(), scopedDb's default db) must never reach the
      // platform's managed, no-RLS Postgres: point the process-wide names at Neon too.
      process.env.DATABASE_URL = source.DATABASE_URL;
      process.env.DATABASE_URL_DIRECT = source.DATABASE_URL_DIRECT;
      return buildServerlessApp(source, { poolMax: 5 });
    })
    .catch((err: unknown) => {
      appPromise = undefined;
      throw err;
    });
  return appPromise;
}

const listener = getRequestListener(async (request) => (await getNaiveApp()).fetch(request), {
  errorHandler: (err) => {
    // Boot failures land here. Log the config problems (never values) and answer a bare 503.
    const msg = err instanceof ConfigError ? err.message : "api failed to boot";
    process.stderr.write(`anybench api (naive): ${msg}\n`);
    return new Response(
      JSON.stringify({ error: { code: "unavailable", message: "booting failed" } }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    );
  },
});

/** Node-style function entry (Vercel zero-config `api/app.js`). */
export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url) req.url = restoreRewrittenPath(req.url);
  return listener(req, res);
}
