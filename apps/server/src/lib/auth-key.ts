// Scoped API keys and the request authenticator (TDM-66, plan.md sections 6 and 9).
//
// Keys:
// - `ab_live_<43 base64url chars>` when BILLING_MODE=live and the caller asked for a live key,
//   otherwise `ab_test_<…>` (32 random bytes). The full secret is returned once, at creation.
// - Only sha256(secret) is stored (api_keys.hash) plus a short display prefix (`ab_live_3f9aQk`),
//   so a database leak cannot be replayed as a key.
// - A key is live while revoked_at IS NULL and expires_at is NULL or in the future.
// - last_used_at is written at most once per API_KEY_TOUCH_INTERVAL_MS per key.
//
// Authenticator (the default AppDeps.authenticate):
// - `Authorization: Bearer ab_…` → the key's owner, carrying the key's scopes and run_ids. A bad
//   or revoked key is a 401: it never falls back to the cookie.
// - otherwise the `anybench_session` cookie (TDM-65) → the signed-in user, unrestricted.
// - `admin` is evaluated per request from ADMIN_GITHUB_LOGINS: a session's isAdmin, and a key's
//   `admin` scope is dropped while its owner is not an admin.
//
// requireScope(deps, scope, {runIdParam}) guards a route: 401 without credentials, 403 when an API
// key lacks the scope or is limited to other runs, 403 for `admin` unless the caller is an admin.
// Routes without a run id in the path (lists) must filter with runIdsOf(actor) themselves.
import { createHash, randomBytes } from "node:crypto";
import { apiError, ApiKeyScopeSchema, SESSION_COOKIE, type ApiKeyScope } from "@anybench/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { parse as parseCookieHeader } from "hono/utils/cookie";
import type { Config } from "../config.js";
import { apiKeys } from "../db/schema/api_keys.js";
import { users } from "../db/schema/users.js";
import { scopedDb } from "../db/scoped.js";
import type { AppDeps, AppEnv } from "../types.js";
import { isAdminLogin } from "./admin.js";
import { resolveSession } from "./session.js";

export const API_KEY_LIVE_PREFIX = "ab_live_";
export const API_KEY_TEST_PREFIX = "ab_test_";
/** How many random chars after `ab_live_` / `ab_test_` the display prefix keeps. */
export const API_KEY_DISPLAY_CHARS = 6;
/** last_used_at is written at most this often per key. */
export const API_KEY_TOUCH_INTERVAL_MS = 60 * 1000;

const SECRET_RE = /^ab_(live|test)_[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer\s+(ab_\S*)\s*$/i;

export type ApiKeyMode = "live" | "test";

/**
 * The key mode a deployment issues: live keys only exist when BILLING_MODE=live, so a test or
 * billing-off deployment never hands out an `ab_live_` key.
 */
export function apiKeyModeFor(config: Pick<Config, "BILLING_MODE">, requested: ApiKeyMode) {
  return config.BILLING_MODE === "live" ? requested : "test";
}

/** A fresh secret: the mode prefix plus 32 random bytes, base64url (43 chars). */
export function newApiKeySecret(mode: ApiKeyMode): string {
  const prefix = mode === "live" ? API_KEY_LIVE_PREFIX : API_KEY_TEST_PREFIX;
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** sha256 hex of a secret; what api_keys.hash holds. */
export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** The visible part of a key, e.g. `ab_live_3f9aQk`. */
export function apiKeyDisplayPrefix(secret: string): string {
  return secret.slice(0, API_KEY_LIVE_PREFIX.length + API_KEY_DISPLAY_CHARS);
}

export function isApiKeySecret(value: string): boolean {
  return SECRET_RE.test(value);
}

/** The `ab_…` token of an `Authorization: Bearer ab_…` header, or undefined. */
export function bearerApiKey(authorization: string | null | undefined): string | undefined {
  if (!authorization) return undefined;
  return BEARER_RE.exec(authorization)?.[1];
}

// ---------------------------------------------------------------------------------------------
// Actors

/** What an API key grants on this request. */
export interface ApiKeyGrant {
  id: string;
  scopes: readonly ApiKeyScope[];
  /** null = every run the owner has. Lowercase uuids. */
  runIds: readonly string[] | null;
}

/**
 * The caller of a tenant route. It is a DbActor (pass it to scopedDb), plus how it signed in.
 * Without `apiKey` the caller is a session user (or a test authenticator) and is not restricted
 * by scopes; `admin` still needs `isAdmin`.
 */
export interface AuthActor {
  kind: "user";
  userId: string;
  via?: "session" | "apiKey";
  /** ADMIN_GITHUB_LOGINS, evaluated for this request. */
  isAdmin?: boolean;
  apiKey?: ApiKeyGrant;
}

/** Whether the actor may use `scope`. */
export function actorHasScope(actor: AuthActor, scope: ApiKeyScope): boolean {
  if (actor.apiKey) return actor.apiKey.scopes.includes(scope);
  return scope === "admin" ? actor.isAdmin === true : true;
}

/** Whether the actor may touch `runId` (RLS still decides whether the run is the owner's). */
export function actorCanAccessRun(actor: AuthActor, runId: string): boolean {
  const ids = actor.apiKey?.runIds;
  return !ids || ids.includes(runId.toLowerCase());
}

/** The run ids a list route must filter to, or null for no restriction beyond RLS. */
export function runIdsOf(actor: AuthActor): readonly string[] | null {
  return actor.apiKey?.runIds ?? null;
}

// ---------------------------------------------------------------------------------------------
// Key lookup

/**
 * Look a secret up: a live key plus its owner. Writes last_used_at when it is older than
 * API_KEY_TOUCH_INTERVAL_MS (the update re-checks the age, so concurrent requests write once).
 */
export async function resolveApiKey(
  deps: Pick<AppDeps, "db" | "config">,
  secret: string,
): Promise<AuthActor | null> {
  if (!isApiKeySecret(secret)) return null;
  const hash = hashApiKey(secret);
  return scopedDb({ kind: "system", reason: "auth: resolve api key" }, deps.db).transaction(
    async (tx) => {
      const [row] = await tx
        .select({
          id: apiKeys.id,
          ownerId: apiKeys.ownerId,
          scopes: apiKeys.scopes,
          runIds: apiKeys.runIds,
          lastUsedAt: apiKeys.lastUsedAt,
          githubLogin: users.githubLogin,
        })
        .from(apiKeys)
        .innerJoin(users, eq(users.id, apiKeys.ownerId))
        .where(
          and(
            eq(apiKeys.hash, hash),
            isNull(apiKeys.revokedAt),
            sql`(${apiKeys.expiresAt} is null or ${apiKeys.expiresAt} > now())`,
          ),
        )
        .limit(1);
      if (!row) return null;
      if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() >= API_KEY_TOUCH_INTERVAL_MS) {
        await tx
          .update(apiKeys)
          .set({ lastUsedAt: sql`now()` })
          .where(
            and(
              eq(apiKeys.id, row.id),
              sql`(${apiKeys.lastUsedAt} is null or ${apiKeys.lastUsedAt} <= now() - make_interval(secs => ${API_KEY_TOUCH_INTERVAL_MS / 1000}))`,
            ),
          );
      }
      const isAdmin = isAdminLogin(deps.config, row.githubLogin);
      const scopes = row.scopes
        .map((s) => ApiKeyScopeSchema.safeParse(s))
        .flatMap((r) => (r.success ? [r.data] : []))
        .filter((s) => s !== "admin" || isAdmin);
      return {
        kind: "user",
        userId: row.ownerId,
        via: "apiKey",
        isAdmin,
        apiKey: {
          id: row.id,
          scopes,
          runIds: row.runIds ? row.runIds.map((id) => id.toLowerCase()) : null,
        },
      } satisfies AuthActor;
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Authenticator

export type Authenticate = (req: Request) => Promise<AuthActor | null>;

/** The default AppDeps.authenticate: a Bearer API key, else the session cookie. */
export function apiKeyOrSessionAuthenticator(deps: Pick<AppDeps, "db" | "config">): Authenticate {
  return async (req) => {
    const secret = bearerApiKey(req.headers.get("authorization"));
    if (secret !== undefined) return resolveApiKey(deps, secret);
    const header = req.headers.get("cookie");
    if (!header) return null;
    const token = parseCookieHeader(header, SESSION_COOKIE)[SESSION_COOKIE];
    if (!token) return null;
    const found = await resolveSession(deps.db, token);
    if (!found) return null;
    return {
      kind: "user",
      userId: found.user.id,
      via: "session",
      isAdmin: isAdminLogin(deps.config, found.user.githubLogin),
    };
  };
}

/**
 * Resolve each Request once, however many middlewares and handlers ask (requireScope, then the
 * route). Keyed by the Request object, so nothing outlives the request.
 */
export function memoizeAuthenticate(authenticate: Authenticate): Authenticate {
  const seen = new WeakMap<Request, Promise<AuthActor | null>>();
  return (req) => {
    let p = seen.get(req);
    if (!p) {
      p = authenticate(req);
      seen.set(req, p);
    }
    return p;
  };
}

// ---------------------------------------------------------------------------------------------
// Middleware

/** Hono env for handlers behind requireScope / requireSessionActor: `c.get("actor")`. */
export interface ActorEnv {
  Variables: AppEnv["Variables"] & { actor: AuthActor };
}

function deny(c: Context, status: 401 | 403, message: string) {
  const code = status === 401 ? "unauthorized" : "forbidden";
  return c.json(apiError(code, message, { request_id: c.get("requestId") as string }), status);
}

export interface RequireScopeOptions {
  /** Path param holding a run id; a key limited to other runs gets 403. */
  runIdParam?: string;
}

/** Guard for `auth: ["session", "apiKey:<scope>"]` routes. Sets `c.get("actor")`. */
export function requireScope(
  deps: Pick<AppDeps, "authenticate">,
  scope: ApiKeyScope,
  options: RequireScopeOptions = {},
): MiddlewareHandler<ActorEnv> {
  return async (c, next) => {
    const actor = deps.authenticate ? await deps.authenticate(c.req.raw) : null;
    if (!actor) return deny(c, 401, "sign in or pass an API key");
    if (!actorHasScope(actor, scope)) {
      return deny(c, 403, actor.apiKey ? `API key lacks the ${scope} scope` : "admin only");
    }
    if (options.runIdParam !== undefined) {
      const runId = c.req.param(options.runIdParam);
      if (runId === undefined || !actorCanAccessRun(actor, runId)) {
        return deny(c, 403, "API key is not valid for this run");
      }
    }
    c.set("actor", actor);
    await next();
  };
}

/**
 * Guard for `auth: ["session"]` routes that must refuse API keys (key management): 401 without
 * credentials, 403 for an API key. Sets `c.get("actor")`.
 */
export function requireSessionActor(
  deps: Pick<AppDeps, "authenticate">,
): MiddlewareHandler<ActorEnv> {
  return async (c, next) => {
    const actor = deps.authenticate ? await deps.authenticate(c.req.raw) : null;
    if (!actor) return deny(c, 401, "sign in required");
    if (actor.apiKey) return deny(c, 403, "API keys cannot manage API keys; sign in");
    c.set("actor", actor);
    await next();
  };
}
