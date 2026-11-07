// Vercel Functions entry (STUB, finished by TDM-154 / plan 13.10). TDM-14.
// The app is built once per function instance, lazily, from the same createApp. Keep it free of
// in-process state: the only cached thing is the pooled-URL pg pool (DATABASE_URL, PgBouncer).
// TDM-154: confirm the export shape against Vercel's Node runtime, set pool size, max duration,
// SSE reconnect behaviour and Sentry flush-before-freeze.
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { bootRuntime } from "./boot.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import type { AppEnv } from "./types.js";

let appPromise: Promise<Hono<AppEnv>> | undefined;

async function buildApp(): Promise<Hono<AppEnv>> {
  const config = loadConfig(); // throws ConfigError listing every bad var: the function fails loudly
  const runtime = await bootRuntime(config, "api");
  const dbh = createDb(config.databaseUrl, { max: 1 });
  return createApp({ config, db: dbh.db, ...runtime });
}

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
