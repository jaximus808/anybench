// Auth routes (TDM-65, plan.md section 9; contract apiRoutes.auth in @anybench/core):
//   GET  /auth/github            set the HMAC'd state cookie, 302 to GitHub
//   GET  /auth/github/callback   verify state, exchange the code, upsert users, set anybench_session
//   GET  /auth/me                the signed-in user (is_admin evaluated for this request)
//   PATCH /auth/me/settings      change the signed-in user's settings (auto_start_runs)
//   POST /auth/logout            revoke the session, clear the cookie (CSRF: allowed Origin only)
//
// Until GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_OAUTH_CALLBACK_URL, SESSION_SECRET and a web
// origin (PUBLIC_WEB_URL or ALLOWED_ORIGINS) are set, the OAuth routes answer 503 (the rest of the
// API keeps working). Every post-sign-in redirect is an absolute URL on that web origin.
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  API_ERROR_STATUS,
  apiError,
  apiRoutes,
  encodeRouteResponse,
  newId,
  parseRouteRequest,
  SESSION_COOKIE,
  UserIdSchema,
  type ApiErrorCode,
  type RouteResult,
} from "@anybench/core";
import { and, eq, ne, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { users } from "../db/schema/users.js";
import { scopedDb } from "../db/scoped.js";
import { isAdminLogin } from "../lib/admin.js";
import {
  createGitHubOAuth,
  GitHubOAuthError,
  type GitHubIdentity,
  type GitHubOAuth,
} from "../lib/github-oauth.js";
import {
  clearSessionCookie,
  cookieSecure,
  createSession,
  requireSession,
  revokeSession,
  setSessionCookie,
  signValue,
  verifySignedValue,
} from "../lib/session.js";
import type { AppDeps, AppEnv } from "../types.js";

/** Short-lived cookie binding the OAuth round trip to this browser. Host-only on the host serving it. */
export const OAUTH_STATE_COOKIE = "anybench_oauth_state";
export const OAUTH_STATE_TTL_SEC = 10 * 60;
const STATE_PURPOSE = "oauth-state";
const DEFAULT_STATE_COOKIE_PATH = "/auth/github";

/**
 * Path of the OAuth state cookie: the parent of GITHUB_OAUTH_CALLBACK_URL's path, i.e. the path
 * the browser sees. Behind the web app's same-origin proxy (`anybench.vercel.app/api/*` → the API)
 * that is `/api/auth/github`; a fixed `/auth/github` would never ride back to the callback there.
 * Without a callback URL (sign-in unconfigured, or tests with an injected GitHub) it is
 * `/auth/github`.
 */
export function stateCookiePath(callbackUrl: string | undefined): string {
  if (!callbackUrl) return DEFAULT_STATE_COOKIE_PATH;
  let pathname: string;
  try {
    pathname = new URL(callbackUrl).pathname;
  } catch {
    return DEFAULT_STATE_COOKIE_PATH;
  }
  const parent = pathname.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
  return parent === "" ? "/" : parent;
}

const StatePayloadSchema = z.object({
  /** Random nonce, also sent to GitHub as `state`. */
  s: z.string().min(16),
  /** Where to land on the web app afterwards (relative path). */
  r: z.string(),
  /** Expiry, unix ms. */
  e: z.number().int(),
});

const contract = apiRoutes.auth;

function fail<E extends AppEnv>(
  c: Context<E>,
  code: ApiErrorCode,
  message: string,
  issues?: string[],
) {
  return c.json(
    apiError(code, message, { request_id: c.get("requestId"), ...(issues ? { issues } : {}) }),
    API_ERROR_STATUS[code] as ContentfulStatusCode,
  );
}

/** Where sign-in lands: PUBLIC_WEB_URL, else the first allowed origin. None = not configured. */
function webBase(deps: AppDeps): string | undefined {
  const raw = deps.config.PUBLIC_WEB_URL ?? deps.config.allowedOrigins[0];
  return raw ? new URL(raw).origin : undefined;
}

/**
 * An absolute URL on the web origin `base` for a relative `redirect_to`. Always absolute, never a
 * bare path: `/.//evil.com`, `/a/..//evil.com` and `/%2e//evil.com` normalize to the pathname
 * `//evil.com`, which as a bare Location is protocol-relative. A leading run of slashes in the
 * normalized pathname collapses to one, and anything that still resolves off-origin (`/\evil.com`)
 * falls back to `/`.
 */
export function landingUrl(base: string, path: string, extra?: Record<string, string>): string {
  const origin = new URL(base).origin;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    url = new URL("/", origin);
  }
  if (url.origin !== origin) url = new URL("/", origin);
  url.pathname = url.pathname.replace(/^\/{2,}/, "/");
  const out = new URL(`${url.pathname}${url.search}${url.hash}`, origin);
  for (const [k, v] of Object.entries(extra ?? {})) out.searchParams.set(k, v);
  return out.origin === origin ? out.toString() : `${origin}/`;
}

/** Everything sign-in needs, or undefined when any piece is missing (the routes answer 503). */
function signInSetup(
  deps: AppDeps,
): { github: GitHubOAuth; secret: string; web: string } | undefined {
  const github = githubFor(deps);
  const secret = deps.config.SESSION_SECRET;
  const web = webBase(deps);
  return github && secret && web ? { github, secret, web } : undefined;
}

function githubFor(deps: AppDeps): GitHubOAuth | undefined {
  if (deps.github) return deps.github;
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_OAUTH_CALLBACK_URL } = deps.config;
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !GITHUB_OAUTH_CALLBACK_URL) return undefined;
  return createGitHubOAuth({
    clientId: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
    redirectUri: GITHUB_OAUTH_CALLBACK_URL,
  });
}

function clearStateCookie(c: Context<AppEnv>, deps: AppDeps): void {
  deleteCookie(c, OAUTH_STATE_COOKIE, {
    path: stateCookiePath(deps.config.GITHUB_OAUTH_CALLBACK_URL),
    httpOnly: true,
    secure: cookieSecure(deps.config),
    sameSite: "Lax",
  });
}

/** Insert or refresh the users row for a GitHub identity; returns the user id. */
async function upsertGitHubUser(deps: AppDeps, gh: GitHubIdentity): Promise<string> {
  const isAdminCache = isAdminLogin(deps.config, gh.login);
  return scopedDb({ kind: "system", reason: "auth: upsert github user" }, deps.db).transaction(
    async (tx) => {
      // GitHub logins are unique but can be renamed and re-registered: free a login still held
      // by a different GitHub account so the unique index does not block the real owner.
      await tx
        .update(users)
        .set({ githubLogin: sql`${users.githubLogin} || '~' || ${users.githubId}::text` })
        .where(
          and(sql`lower(${users.githubLogin}) = lower(${gh.login})`, ne(users.githubId, gh.id)),
        );
      const rows = await tx
        .insert(users)
        .values({
          id: newId(UserIdSchema),
          githubId: gh.id,
          githubLogin: gh.login,
          githubCreatedAt: gh.createdAt,
          email: gh.email,
          isAdminCache,
        })
        .onConflictDoUpdate({
          target: users.githubId,
          set: {
            githubLogin: gh.login,
            githubCreatedAt: sql`coalesce(excluded.github_created_at, ${users.githubCreatedAt})`,
            email: sql`coalesce(excluded.email, ${users.email})`,
            isAdminCache,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: users.id });
      return rows[0]!.id;
    },
  );
}

const EmailSchema = z.email();

export function authRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/github", (c) => {
    const setup = signInSetup(deps);
    if (!setup) return fail(c, "unavailable", "sign-in not configured");
    const { github, secret } = setup;
    const parsed = parseRouteRequest(contract.githubStart, { query: c.req.query() });
    if (!parsed.ok)
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);

    const nonce = randomBytes(24).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        s: nonce,
        r: parsed.request.query.redirect_to ?? "/",
        e: Date.now() + OAUTH_STATE_TTL_SEC * 1000,
      }),
    ).toString("base64url");
    setCookie(c, OAUTH_STATE_COOKIE, signValue(secret, STATE_PURPOSE, payload), {
      path: stateCookiePath(deps.config.GITHUB_OAUTH_CALLBACK_URL),
      httpOnly: true,
      secure: cookieSecure(deps.config),
      // Lax: GitHub's redirect back is a top-level GET navigation, which Lax cookies ride.
      sameSite: "Lax",
      maxAge: OAUTH_STATE_TTL_SEC,
    });
    return c.redirect(github.authorizeUrl(nonce), 302);
  });

  r.get("/github/callback", async (c) => {
    const setup = signInSetup(deps);
    if (!setup) return fail(c, "unavailable", "sign-in not configured");
    const { github, secret, web } = setup;

    const rawState = getCookie(c, OAUTH_STATE_COOKIE);
    clearStateCookie(c, deps);

    const denied = c.req.query("error");
    if (denied !== undefined) {
      // The user declined (access_denied) or the app is misconfigured: back to the web app.
      const code = /^[a-z_]{1,64}$/.test(denied) ? denied : "github_error";
      return c.redirect(landingUrl(web, "/", { auth_error: code }), 302);
    }

    const parsed = parseRouteRequest(contract.githubCallback, { query: c.req.query() });
    if (!parsed.ok)
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);
    const { code, state } = parsed.request.query;

    const verified = rawState ? verifySignedValue(secret, STATE_PURPOSE, rawState) : null;
    let payload: z.infer<typeof StatePayloadSchema> | undefined;
    if (verified) {
      try {
        const p = StatePayloadSchema.safeParse(
          JSON.parse(Buffer.from(verified, "base64url").toString("utf8")),
        );
        if (p.success) payload = p.data;
      } catch {
        payload = undefined;
      }
    }
    const stateMatches =
      payload !== undefined &&
      payload.s.length === state.length &&
      timingSafeEqual(Buffer.from(payload.s), Buffer.from(state));
    if (!payload || !stateMatches || payload.e < Date.now()) {
      return fail(
        c,
        "bad_request",
        "sign-in state is missing, expired or does not match; start again",
      );
    }

    let identity: GitHubIdentity;
    try {
      identity = await github.exchangeCode(code);
    } catch (err) {
      if (err instanceof GitHubOAuthError && err.reason === "bad_code") {
        return fail(c, "bad_request", "GitHub rejected the sign-in code; start again");
      }
      c.get("log").warn({ err }, "auth: GitHub code exchange failed");
      return fail(c, "unavailable", "GitHub is unavailable; try again");
    }

    const userId = await upsertGitHubUser(deps, identity);
    const { token } = await createSession(deps.db, userId, {
      userAgent: c.req.header("user-agent"),
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
    });
    setSessionCookie(c, deps.config, token);
    c.get("log").info({ userId, githubLogin: identity.login }, "auth: signed in");
    return c.redirect(landingUrl(web, payload.r), 302);
  });

  const readSettings = (userId: string) =>
    scopedDb({ kind: "system", reason: "auth: read user settings" }, deps.db).transaction(
      async (tx) => {
        const [row] = await tx
          .select({ autoStartRuns: users.autoStartRuns })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        return { auto_start_runs: row?.autoStartRuns ?? false };
      },
    );

  r.get("/me", requireSession(deps), async (c) => {
    const { user, isAdmin } = c.get("session");
    const settings = await readSettings(user.id);
    const result: RouteResult<typeof contract.me> = {
      user: {
        id: user.id,
        github_login: user.githubLogin,
        email: user.email && EmailSchema.safeParse(user.email).success ? user.email : null,
        avatar_url: `https://avatars.githubusercontent.com/u/${user.githubId}?v=4`,
        is_admin: isAdmin,
        created_at: user.createdAt.toISOString(),
      },
      via: { kind: "session" },
      settings,
    };
    return c.json(encodeRouteResponse(contract.me, result) as object, 200);
  });

  r.patch("/me/settings", requireSession(deps), async (c) => {
    const { user } = c.get("session");
    let body: unknown;
    try {
      const text = await c.req.text();
      body = text.trim() === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      return fail(c, "bad_request", "request body is not valid JSON");
    }
    const parsed = parseRouteRequest(contract.updateSettings, { body });
    if (!parsed.ok)
      return fail(c, "validation_failed", parsed.error.error.message, parsed.error.error.issues);
    const patch = parsed.request.body;
    if (patch.auto_start_runs !== undefined) {
      const value = patch.auto_start_runs;
      await scopedDb({ kind: "system", reason: "auth: update user settings" }, deps.db).transaction(
        (tx) =>
          tx
            .update(users)
            .set({ autoStartRuns: value, updatedAt: sql`now()` })
            .where(eq(users.id, user.id)),
      );
      c.get("log").info({ userId: user.id, autoStartRuns: value }, "auth: settings changed");
    }
    const result: RouteResult<typeof contract.updateSettings> = await readSettings(user.id);
    return c.json(encodeRouteResponse(contract.updateSettings, result) as object, 200);
  });

  r.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const revoked = token ? await revokeSession(deps.db, token) : false;
    clearSessionCookie(c, deps.config);
    if (!revoked) return fail(c, "unauthorized", "no active session");
    const result: RouteResult<typeof contract.logout> = { ok: true };
    return c.json(encodeRouteResponse(contract.logout, result) as object, 200);
  });

  return r;
}
