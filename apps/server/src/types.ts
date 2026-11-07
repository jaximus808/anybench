// Shared server types (TDM-14). Routes and jobs receive everything through deps; no module-level
// state, so the same app runs per-request on Vercel Functions and long-lived under node-server.
import type { RequestIdVariables } from "hono/request-id";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import type { Logger } from "./lib/logger.js";
import type { SentryHandle } from "./lib/sentry.js";

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** Drizzle on the POOLED url (DATABASE_URL). Tenant queries go through scopedDb(actor, db). */
  db: Database;
  sentry: SentryHandle;
}

/** Hono env for every router: `new Hono<AppEnv>()`. `c.get("log")` is a per-request child logger. */
export interface AppEnv {
  Variables: RequestIdVariables & { log: Logger };
}

/** Error body for every non-2xx JSON response. */
export interface ErrorBody {
  error: { code: string; message: string; requestId?: string };
}
