// Shared server types (TDM-14). Routes and jobs receive everything through deps; no module-level
// state, so the same app runs per-request on Vercel Functions and long-lived under node-server.
import type { RequestIdVariables } from "hono/request-id";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import type { DbActor } from "./db/scoped.js";
import type { EventFanout } from "./lib/events.js";
import type { GitHubOAuth } from "./lib/github-oauth.js";
import type { Logger } from "./lib/logger.js";
import type { SentryHandle } from "./lib/sentry.js";

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** Drizzle on the POOLED url (DATABASE_URL). Tenant queries go through scopedDb(actor, db). */
  db: Database;
  sentry: SentryHandle;
  /**
   * Who is calling a tenant route (session cookie or API key), or null when nobody is signed in.
   * Wired by the auth ticket; until then tenant routes (events, TDM-72) answer 401.
   */
  authenticate?: (req: Request) => Promise<DbActor | null>;
  /**
   * The shared LISTEN connection (TDM-72), only in long-lived processes with
   * EVENTS_STREAM_MODE=listen. Without it the event stream polls.
   */
  eventFanout?: EventFanout;
  /** GitHub OAuth client (TDM-65). Default: built from GITHUB_* config; tests pass a fake. */
  github?: GitHubOAuth;
}

/** Hono env for every router: `new Hono<AppEnv>()`. `c.get("log")` is a per-request child logger. */
export interface AppEnv {
  Variables: RequestIdVariables & { log: Logger };
}

/** Error body for every non-2xx JSON response. */
export interface ErrorBody {
  error: { code: string; message: string; requestId?: string };
}
