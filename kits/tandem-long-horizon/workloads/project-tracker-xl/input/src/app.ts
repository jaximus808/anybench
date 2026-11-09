import { createServer, type Server } from "node:http";
import { HttpError, sendError, sendJson } from "./http.ts";
import { Router } from "./router.ts";

export interface RateLimitOptions {
  /** Requests allowed per credential (session token or API key) in one window. */
  limit: number;
  /** Window length in milliseconds. Windows are fixed: floor(now() / windowMs). */
  windowMs: number;
}

export interface WebhookOptions {
  /** Wait before each retry, in milliseconds. Attempts = 1 + retryDelaysMs.length. */
  retryDelaysMs?: number[];
  /** How long one delivery attempt may take before it counts as failed. */
  timeoutMs?: number;
}

export interface AutomationOptions {
  /** How deep rule actions may trigger further rules. Default: 3. */
  maxDepth?: number;
}

export interface TrashOptions {
  /** How long an archived card stays in the trash before it is purged. Default: 2_592_000_000 (30 days). */
  retentionMs?: number;
}

export interface InviteOptions {
  /** Invitation lifetime. Default: 604_800_000 (7 days). */
  ttlMs?: number;
}

export type PlanId = "free" | "team" | "business";

export interface AppOptions {
  /** Where to persist state as JSON. Omit to keep everything in memory. */
  dataFile?: string;
  /** The clock, in milliseconds since the epoch. Default: Date.now. Every time-based rule reads it. */
  now?: () => number;
  /** How long a login token is valid. Default: 86_400_000 (24 hours). */
  tokenTtlMs?: number;
  /** Per-credential (token or API key) rate limit. Default: { limit: 1000, windowMs: 60_000 }. */
  rateLimit?: RateLimitOptions;
  /** Outgoing webhook delivery. Default: { retryDelaysMs: [1000, 5000, 30000], timeoutMs: 5000 }. */
  webhooks?: WebhookOptions;
  /** The plan of every new and every migrated team. Default: "free". */
  defaultPlan?: PlanId;
  /** How long a stored idempotent response is kept. Default: 86_400_000 (24 hours). */
  idempotencyTtlMs?: number;
  /** The automation rule engine. Default: { maxDepth: 3 }. */
  automation?: AutomationOptions;
  /** The archive. Default: { retentionMs: 2_592_000_000 }. */
  trash?: TrashOptions;
  /** Team invitations. Default: { ttlMs: 604_800_000 }. */
  invites?: InviteOptions;
}

export function createApp(_options: AppOptions = {}): Server {
  const router = new Router();

  router.add("GET", "/health", ({ res }) => sendJson(res, 200, { ok: true }));

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const found = router.match(req.method ?? "GET", url.pathname);
    if (found === undefined) {
      sendError(res, new HttpError(404, "not_found", `no route for ${req.method} ${url.pathname}`));
      return;
    }
    // Run sync and async handlers alike, so a thrown HttpError always becomes a response.
    const ctx = { req, res, params: found.params, query: url.searchParams };
    Promise.resolve()
      .then(() => found.handler(ctx))
      .catch((err: unknown) => {
        if (err instanceof HttpError) sendError(res, err);
        else {
          console.error(err);
          sendError(res, new HttpError(500, "internal", "internal error"));
        }
      });
  });
}
