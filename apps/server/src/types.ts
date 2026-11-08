// Shared server types (TDM-14). Routes and jobs receive everything through deps; no module-level
// state, so the same app runs per-request on Vercel Functions and long-lived under node-server.
import type { RequestIdVariables } from "hono/request-id";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import type { AuthActor } from "./lib/auth-key.js";
import type { BillingGate } from "./lib/billing-gate.js";
import type { EventFanout } from "./lib/events.js";
import type { GitHubOAuth } from "./lib/github-oauth.js";
import type { JobQueue } from "./lib/job-queue.js";
import type { Logger } from "./lib/logger.js";
import type { TrialLogReader } from "./lib/trial-logs.js";
import type { SentryHandle } from "./lib/sentry.js";
import type { EventsWriter, TrialArtifactStore } from "./routes/runner.js";

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** Drizzle on the POOLED url (DATABASE_URL). Tenant queries go through scopedDb(actor, db). */
  db: Database;
  sentry: SentryHandle;
  /**
   * Who is calling a tenant route (session cookie or API key), or null when nobody is signed in.
   * Default (TDM-66): apiKeyOrSessionAuthenticator, memoized per Request. The actor is a DbActor
   * for scopedDb, plus the API key's scopes and run_ids when it came from a key.
   */
  authenticate?: (req: Request) => Promise<AuthActor | null>;
  /**
   * The shared LISTEN connection (TDM-72), only in long-lived processes with
   * EVENTS_STREAM_MODE=listen. Without it the event stream polls.
   */
  eventFanout?: EventFanout;
  /** GitHub OAuth client (TDM-65). Default: built from GITHUB_* config; tests pass a fake. */
  github?: GitHubOAuth;
  /** Event writer override (tests). Default: lib/events.ts `appendEvents`. */
  events?: EventsWriter;
  /** Trial artifact storage (`@anybench/envs` ArtifactStore). Upload routes answer 503 without it. */
  artifacts?: TrialArtifactStore;
  /**
   * Server-side ranged reads of trial log segments (TDM-74). Default in the entries:
   * lib/trial-logs.ts artifactLogReader over the ArtifactStore. Log routes answer 503 without it.
   */
  trialLogs?: TrialLogReader;
  /** The run gate's billing check (TDM-67). Default: lib/billing-gate.ts defaultBillingGate. */
  billingGate?: BillingGate;
  /** Enqueues graphile-worker jobs (TDM-67). Default: graphile_worker.add_job on `db`. */
  jobs?: JobQueue;
}

/** Hono env for every router: `new Hono<AppEnv>()`. `c.get("log")` is a per-request child logger. */
export interface AppEnv {
  Variables: RequestIdVariables & { log: Logger };
}

/** Error body for every non-2xx JSON response. */
export interface ErrorBody {
  error: { code: string; message: string; requestId?: string };
}
