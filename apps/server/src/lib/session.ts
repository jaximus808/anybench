// Browser sessions (TDM-65, plan.md section 9).
//
// - The cookie carries an opaque 256-bit token (base64url). Only sha256(token) is stored, in
//   sessions.token_hash, so a database leak cannot be replayed as a cookie.
// - Cookie `anybench_session`: Domain from SESSION_COOKIE_DOMAIN, Path=/, HttpOnly, SameSite=Lax,
//   Secure. Secure is dropped only outside production when the OAuth callback is plain http
//   (local dev on http://localhost). 30-day sliding expiry: a request at most every
//   SESSION_TOUCH_INTERVAL_MS pushes expires_at out again and re-issues the cookie.
// - The principal carries `isAdmin`, computed from ADMIN_GITHUB_LOGINS on every request. It is
//   never written to the session.
// - Small HMAC helpers (signValue / verifySignedValue) sign short-lived cookies such as the OAuth
//   state, keyed by SESSION_SECRET with a purpose label for domain separation.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { apiError, newId, SESSION_COOKIE, SessionIdSchema } from "@anybench/core";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parse as parseCookieHeader, type CookieOptions } from "hono/utils/cookie";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { sessions } from "../db/schema/sessions.js";
import { users } from "../db/schema/users.js";
import { scopedDb, type DbActor } from "../db/scoped.js";
import type { AppDeps, AppEnv } from "../types.js";
import { isAdminLogin } from "./admin.js";

export { SESSION_COOKIE };

export const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
/** How stale last_seen_at may get before a request slides the expiry (bounds writes per session). */
export const SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A fresh opaque session token: 32 random bytes, base64url (43 chars). */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex of a token; what sessions.token_hash holds. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Cookie attributes

type CookieConfig = Pick<
  Config,
  "isProduction" | "SESSION_COOKIE_DOMAIN" | "GITHUB_OAUTH_CALLBACK_URL"
>;

/** Secure everywhere except local dev over plain http (never in production). */
export function cookieSecure(config: CookieConfig): boolean {
  if (config.isProduction) return true;
  return !config.GITHUB_OAUTH_CALLBACK_URL?.startsWith("http://");
}

/**
 * SESSION_COOKIE_DOMAIN, except outside production when the API host is not inside it (local dev
 * on localhost with the shared .env): a browser would reject that cookie, so send it host-only.
 */
export function cookieDomain(config: CookieConfig): string | undefined {
  const domain = config.SESSION_COOKIE_DOMAIN;
  if (!domain || config.isProduction || !config.GITHUB_OAUTH_CALLBACK_URL) return domain;
  const host = new URL(config.GITHUB_OAUTH_CALLBACK_URL).hostname.toLowerCase();
  const bare = domain.replace(/^\./, "").toLowerCase();
  return host === bare || host.endsWith(`.${bare}`) ? domain : undefined;
}

export function sessionCookieOptions(config: CookieConfig): CookieOptions {
  const domain = cookieDomain(config);
  return {
    path: "/",
    httpOnly: true,
    secure: cookieSecure(config),
    sameSite: "Lax",
    maxAge: SESSION_TTL_SEC,
    ...(domain ? { domain } : {}),
  };
}

export function setSessionCookie(c: Context, config: CookieConfig, token: string): void {
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(config));
}

export function clearSessionCookie(c: Context, config: CookieConfig): void {
  const { maxAge: _maxAge, ...opts } = sessionCookieOptions(config);
  deleteCookie(c, SESSION_COOKIE, opts);
}

// ---------------------------------------------------------------------------------------------
// HMAC-signed values

function mac(secret: string, purpose: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(`anybench:${purpose}\n${payload}`).digest();
}

/** `<payload>.<base64url hmac>`. The payload must not contain `.` (use base64url). */
export function signValue(secret: string, purpose: string, payload: string): string {
  if (payload.includes(".")) throw new TypeError("signed payload must not contain '.'");
  return `${payload}.${mac(secret, purpose, payload).toString("base64url")}`;
}

/** The payload when the signature is valid for this secret and purpose, else null. */
export function verifySignedValue(secret: string, purpose: string, signed: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1), "base64url");
  const want = mac(secret, purpose, payload);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return payload;
}

// ---------------------------------------------------------------------------------------------
// Session rows

export interface SessionUser {
  id: string;
  githubLogin: string;
  githubId: number;
  email: string | null;
  createdAt: Date;
}

export interface SessionPrincipal {
  sessionId: string;
  user: SessionUser;
  /** From ADMIN_GITHUB_LOGINS, evaluated for this request only. */
  isAdmin: boolean;
}

export interface SessionMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

/** Insert a session for `userId`; returns the raw token for the cookie (never stored). */
export async function createSession(
  db: Database,
  userId: string,
  meta: SessionMeta = {},
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = newSessionToken();
  const sessionId = newId(SessionIdSchema);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000);
  await scopedDb({ kind: "system", reason: "auth: create session" }, db).transaction((tx) =>
    tx.insert(sessions).values({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(token),
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
      expiresAt,
      lastSeenAt: new Date(),
    }),
  );
  return { token, sessionId, expiresAt };
}

/**
 * Look a token up: live (not revoked, not expired) session plus its user. Slides the expiry when
 * last_seen_at is older than SESSION_TOUCH_INTERVAL_MS (`refreshed: true` = re-issue the cookie).
 */
export async function resolveSession(
  db: Database,
  token: string,
): Promise<{ sessionId: string; user: SessionUser; refreshed: boolean } | null> {
  if (!TOKEN_RE.test(token)) return null;
  const tokenHash = hashSessionToken(token);
  return scopedDb({ kind: "system", reason: "auth: resolve session" }, db).transaction(
    async (tx) => {
      const rows = await tx
        .select({
          sessionId: sessions.id,
          lastSeenAt: sessions.lastSeenAt,
          id: users.id,
          githubLogin: users.githubLogin,
          githubId: users.githubId,
          email: users.email,
          createdAt: users.createdAt,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, sql`now()`),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const stale =
        !row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS;
      if (stale) {
        await tx
          .update(sessions)
          .set({
            lastSeenAt: sql`now()`,
            expiresAt: sql`now() + make_interval(secs => ${SESSION_TTL_SEC})`,
          })
          .where(eq(sessions.id, row.sessionId));
      }
      const { sessionId, lastSeenAt: _seen, ...user } = row;
      return { sessionId, user, refreshed: stale };
    },
  );
}

/** Revoke one session by its raw token. Returns true when a live session was revoked. */
export async function revokeSession(db: Database, token: string): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;
  const rows = await scopedDb({ kind: "system", reason: "auth: revoke session" }, db).transaction(
    (tx) =>
      tx
        .update(sessions)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id }),
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Request helpers

/** Hono env for handlers behind requireSession / requireAdmin: `c.get("session")`. */
export interface SessionEnv {
  Variables: AppEnv["Variables"] & { session: SessionPrincipal };
}

/** The caller's session from the cookie, or null. Re-issues the cookie when the expiry slid. */
export async function authenticateSession(
  c: Context,
  deps: Pick<AppDeps, "config" | "db">,
): Promise<SessionPrincipal | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const found = await resolveSession(deps.db, token);
  if (!found) return null;
  if (found.refreshed) setSessionCookie(c, deps.config, token);
  return {
    sessionId: found.sessionId,
    user: found.user,
    isAdmin: isAdminLogin(deps.config, found.user.githubLogin),
  };
}

function unauthorized(c: Context) {
  return c.json(
    apiError("unauthorized", "sign in required", { request_id: c.get("requestId") as string }),
    401,
  );
}

/** Middleware for `auth: ["session"]` routes: 401 without a live session cookie. */
export function requireSession(
  deps: Pick<AppDeps, "config" | "db">,
): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const principal = await authenticateSession(c, deps);
    if (!principal) return unauthorized(c);
    c.set("session", principal);
    await next();
  };
}

/**
 * `AppDeps.authenticate` backed by the session cookie: the signed-in user as a DbActor, so tenant
 * routes (events, TDM-72) read through RLS as that user. It sees only the raw Request, so a slid
 * expiry is written to the row but the cookie itself is re-issued by the next cookie-aware route.
 * API keys are not handled here (their ticket wraps this).
 */
export function sessionAuthenticator(
  deps: Pick<AppDeps, "db">,
): (req: Request) => Promise<DbActor | null> {
  return async (req) => {
    const header = req.headers.get("cookie");
    if (!header) return null;
    const token = parseCookieHeader(header, SESSION_COOKIE)[SESSION_COOKIE];
    if (!token) return null;
    const found = await resolveSession(deps.db, token);
    return found ? { kind: "user", userId: found.user.id } : null;
  };
}
