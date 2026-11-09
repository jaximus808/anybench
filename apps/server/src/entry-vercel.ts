// Vercel Functions entry (TDM-14) for our own Vercel project, the documented fallback host.
// Production runs as a Naïve fullstack app instead (entry-naive.ts, TDM-154), which reuses
// buildServerlessApp below. The app is built once per function instance, lazily, from the same
// createApp. Keep it free of in-process state: the only cached thing is the pooled-URL pg pool
// (DATABASE_URL, PgBouncer).
import { ArtifactStore } from "@anybench/envs";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { bootRuntime } from "./boot.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { artifactLogReader } from "./lib/trial-logs.js";
import { artifactTraceStore } from "./lib/trial-trace/store.js";
import type { AppEnv } from "./types.js";

let appPromise: Promise<Hono<AppEnv>> | undefined;

/**
 * The API for a serverless host (Vercel Functions here, the Naïve fullstack app in entry-naive.ts).
 * `source` is the env to validate; `poolMax` caps the pooled-URL pg pool of one instance.
 */
export async function buildServerlessApp(
  source: Record<string, string | undefined> = process.env,
  options: { poolMax?: number } = {},
): Promise<Hono<AppEnv>> {
  const config = loadConfig(source); // throws ConfigError listing every bad var: fails loudly
  const runtime = await bootRuntime(config, "api");
  const dbh = createDb(config.databaseUrl, { max: options.poolMax ?? 1 });
  // Neon and the pooler close idle connections; pg emits that on the pool, and an unhandled
  // 'error' event would crash the instance. The pool drops the dead client by itself.
  dbh.pool.on("error", (err) => runtime.logger.warn({ err }, "db: idle client error"));
  const artifacts = source.S3_BUCKET ? ArtifactStore.fromEnv(source) : undefined; // TDM-47 uploads
  const trialLogs = artifacts ? artifactLogReader(artifacts) : undefined; // TDM-74 log reads
  return createApp({
    config,
    db: dbh.db,
    artifacts,
    ...(artifacts ? { kitFiles: artifacts } : {}), // TDM-217 kit uploads
    ...(trialLogs ? { trialLogs } : {}),
    ...(artifacts ? { traces: artifactTraceStore(artifacts) } : {}),
    ...runtime,
  });
}

const buildApp = () => buildServerlessApp();

export function getVercelApp(): Promise<Hono<AppEnv>> {
  appPromise ??= buildApp().catch((err: unknown) => {
    appPromise = undefined;
    throw err;
  });
  return appPromise;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const app = await getVercelApp();
    return app.fetch(request);
  },
};
