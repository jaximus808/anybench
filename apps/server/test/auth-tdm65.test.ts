// TDM-65: GitHub OAuth (mocked), sessions, CORS, CSRF and the admin check, against a fresh local
// Postgres. GitHub is a fake: no network.
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema/sessions.js";
import { users } from "../src/db/schema/users.js";
import { adminOnly } from "../src/lib/admin.js";
import { requireSession, signValue } from "../src/lib/session.js";
import { OAUTH_STATE_COOKIE } from "../src/routes/auth.js";
import {
  authAppTdm65,
  AUTH_ENV_TDM65,
  cookieTdm65,
  fakeGitHubTdm65,
  FOREIGN_ORIGIN_TDM65,
  WEB_ORIGIN_TDM65,
} from "./helpers/auth-tdm65.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const hasDb = await pgAvailableTdm11();

const ADMIN = {
  id: 1001,
  login: "jaximus808", // allowlist has "Jaximus808": the check is case-insensitive
  createdAt: new Date("2015-03-04T05:06:07Z"),
  email: "admin@example.com",
};
const PLAIN = {
  id: 2002,
  login: "someone",
  createdAt: new Date("2024-01-02T03:04:05Z"),
  email: null,
};

describe.skipIf(!hasDb)("auth routes (TDM-65)", () => {
  let fresh: FreshDbTdm11;
  let h: ReturnType<typeof authAppTdm65>;
  const github = fakeGitHubTdm65({ "code-admin": ADMIN, "code-plain": PLAIN });

  beforeAll(async () => {
    fresh = await freshMigratedDbTdm11();
    h = authAppTdm65(fresh.url, github);
  }, 60_000);
  afterAll(async () => {
    await h?.dbh.close();
    await fresh?.drop();
  });

  /** Run the whole OAuth round trip; returns the callback response and the session token. */
  async function signIn(code: string, redirectTo = "/runs", app = h.app) {
    const start = await app.request(`/auth/github?redirect_to=${encodeURIComponent(redirectTo)}`);
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    const state = location.searchParams.get("state")!;
    const stateCookie = cookieTdm65(start, OAUTH_STATE_COOKIE)!;
    const cb = await app.request(
      `/auth/github/callback?code=${code}&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${OAUTH_STATE_COOKIE}=${stateCookie.value}` } },
    );
    return { start, stateCookie, state, cb, token: cookieTdm65(cb, "anybench_session")?.value };
  }

  const withSession = (token: string, extra: Record<string, string> = {}) => ({
    headers: { cookie: `anybench_session=${token}`, ...extra },
  });

  it("GET /auth/github sets an HMAC'd, HttpOnly state cookie and redirects to GitHub", async () => {
    const { stateCookie, state } = await signIn("code-plain");
    expect(stateCookie.attrs.httponly).toBe(true);
    expect(stateCookie.attrs.secure).toBe(true);
    expect(stateCookie.attrs.samesite).toBe("Lax");
    expect(stateCookie.attrs.path).toBe("/auth/github");
    // The cookie is `<payload>.<mac>` and is not the bare nonce sent to GitHub.
    expect(stateCookie.value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(stateCookie.value).not.toBe(state);
  });

  it("login via mocked GitHub sets anybench_session with Domain, Secure, HttpOnly, SameSite=Lax", async () => {
    const { cb, token } = await signIn("code-admin", "/runs/abc?tab=live");
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe(`${WEB_ORIGIN_TDM65}/runs/abc?tab=live`);
    const c = cookieTdm65(cb, "anybench_session")!;
    expect(c.attrs.domain).toBe(".anybench.jaxonp.com");
    expect(c.attrs.secure).toBe(true);
    expect(c.attrs.httponly).toBe(true);
    expect(c.attrs.samesite).toBe("Lax");
    expect(c.attrs.path).toBe("/");
    expect(c.attrs["max-age"]).toBe(String(30 * 24 * 60 * 60));
    // 256-bit opaque token.
    expect(Buffer.from(token!, "base64url")).toHaveLength(32);
    // The state cookie is cleared after use.
    expect(cookieTdm65(cb, OAUTH_STATE_COOKIE)?.attrs["max-age"]).toBe("0");

    const [u] = await fresh.db.select().from(users).where(eq(users.githubId, ADMIN.id));
    expect(u).toMatchObject({ githubLogin: "jaximus808", email: "admin@example.com" });
    expect(u!.githubCreatedAt?.toISOString()).toBe(ADMIN.createdAt.toISOString());

    // Stored hashed: sha256(token), never the token itself.
    const rows = await fresh.db.select().from(sessions).where(eq(sessions.userId, u!.id));
    const hash = createHash("sha256").update(token!).digest("hex");
    expect(rows.map((r) => r.tokenHash)).toContain(hash);
    expect(rows.map((r) => r.tokenHash)).not.toContain(token);
  });

  it("re-login updates the same users row (rename keeps github_id)", async () => {
    const gh = fakeGitHubTdm65({ c1: { ...PLAIN, id: 3003, login: "renamer" } });
    const a = authAppTdm65(fresh.url, gh);
    try {
      expect((await signIn("c1", "/", a.app)).cb.status).toBe(302);
      const gh2 = fakeGitHubTdm65({ c2: { ...PLAIN, id: 3003, login: "renamed" } });
      const b = authAppTdm65(fresh.url, gh2);
      try {
        expect((await signIn("c2", "/", b.app)).cb.status).toBe(302);
      } finally {
        await b.dbh.close();
      }
      const rows = await fresh.db.select().from(users).where(eq(users.githubId, 3003));
      expect(rows.map((r) => r.githubLogin)).toEqual(["renamed"]);
    } finally {
      await a.dbh.close();
    }
  });

  it("callback refuses a missing, forged, mismatched or expired state", async () => {
    const start = await h.app.request("/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const good = cookieTdm65(start, OAUTH_STATE_COOKIE)!.value;
    const cb = (q: string, cookie?: string) =>
      h.app.request(`/auth/github/callback?${q}`, cookie ? { headers: { cookie } } : {});

    expect((await cb(`code=code-plain&state=${state}`)).status).toBe(400); // no cookie
    expect(
      (await cb(`code=code-plain&state=wrong-state-value-xx`, `${OAUTH_STATE_COOKIE}=${good}`))
        .status,
    ).toBe(400);
    const forged = `${good.split(".")[0]}.${"A".repeat(43)}`;
    expect(
      (await cb(`code=code-plain&state=${state}`, `${OAUTH_STATE_COOKIE}=${forged}`)).status,
    ).toBe(400);
    const expiredPayload = Buffer.from(
      JSON.stringify({ s: state, r: "/", e: Date.now() - 1000 }),
    ).toString("base64url");
    const expired = signValue(AUTH_ENV_TDM65.SESSION_SECRET!, "oauth-state", expiredPayload);
    const res = await cb(`code=code-plain&state=${state}`, `${OAUTH_STATE_COOKIE}=${expired}`);
    expect(res.status).toBe(400);
    expect(cookieTdm65(res, "anybench_session")).toBeUndefined();
    expect((await cb(`state=${state}`, `${OAUTH_STATE_COOKIE}=${good}`)).status).toBe(400); // no code
  });

  it("a code GitHub rejects is a 400 and sets no session", async () => {
    const { cb } = await signIn("code-unknown");
    expect(cb.status).toBe(400);
    expect(cookieTdm65(cb, "anybench_session")).toBeUndefined();
  });

  it("GitHub's error=access_denied goes back to the web app", async () => {
    const res = await h.app.request("/auth/github/callback?error=access_denied&state=x");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${WEB_ORIGIN_TDM65}/?auth_error=access_denied`);
  });

  it("redirect_to cannot leave the web origin", async () => {
    expect((await h.app.request("/auth/github?redirect_to=https://evil.example/")).status).toBe(
      400,
    );
    expect((await h.app.request("/auth/github?redirect_to=//evil.example/")).status).toBe(400);
    const { cb } = await signIn("code-plain", "/\\evil.example/x");
    expect(cb.headers.get("location")).toBe(`${WEB_ORIGIN_TDM65}/`);
  });

  it("isAdmin is true only for ADMIN_GITHUB_LOGINS, and is evaluated per request", async () => {
    const admin = (await signIn("code-admin")).token!;
    const plain = (await signIn("code-plain")).token!;

    const me = await h.app.request("/auth/me", withSession(admin));
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: Record<string, unknown>; via: unknown };
    expect(body.user).toMatchObject({ github_login: "jaximus808", is_admin: true });
    expect(body.user.avatar_url).toBe("https://avatars.githubusercontent.com/u/1001?v=4");
    expect(body.via).toEqual({ kind: "session" });

    const mePlain = (await (await h.app.request("/auth/me", withSession(plain))).json()) as {
      user: { is_admin: boolean; email: string | null };
    };
    expect(mePlain.user.is_admin).toBe(false);
    expect(mePlain.user.email).toBeNull();

    // Same session, allowlist changed: admin is gone on the next request (nothing was stored).
    const other = authAppTdm65(fresh.url, github, { ADMIN_GITHUB_LOGINS: "someone" });
    try {
      const a = (await (await other.app.request("/auth/me", withSession(admin))).json()) as {
        user: { is_admin: boolean };
      };
      expect(a.user.is_admin).toBe(false);
      const p = (await (await other.app.request("/auth/me", withSession(plain))).json()) as {
        user: { is_admin: boolean };
      };
      expect(p.user.is_admin).toBe(true);
    } finally {
      await other.dbh.close();
    }

    // adminOnly middleware gates admin routes the same way.
    const probe = new Hono().get(
      "/admin-probe-tdm65",
      requireSession({ config: h.config, db: h.dbh.db }),
      adminOnly,
      (c) => c.json({ ok: true }),
    );
    expect((await probe.request("/admin-probe-tdm65")).status).toBe(401);
    expect((await probe.request("/admin-probe-tdm65", withSession(plain))).status).toBe(403);
    expect((await probe.request("/admin-probe-tdm65", withSession(admin))).status).toBe(200);
  });

  it("/auth/me is 401 without a session, with a garbage cookie, or an unknown token", async () => {
    expect((await h.app.request("/auth/me")).status).toBe(401);
    expect((await h.app.request("/auth/me", withSession("garbage"))).status).toBe(401);
    expect((await h.app.request("/auth/me", withSession("A".repeat(43)))).status).toBe(401);
  });

  it("a mutating request with a foreign Origin gets 403; the session survives", async () => {
    const token = (await signIn("code-plain")).token!;
    const foreign = await h.app.request("/auth/logout", {
      method: "POST",
      ...withSession(token, { origin: FOREIGN_ORIGIN_TDM65 }),
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();

    const nullOrigin = await h.app.request("/auth/logout", {
      method: "POST",
      ...withSession(token, { origin: "null" }),
    });
    expect(nullOrigin.status).toBe(403);

    // A session cookie without any Origin is not our web app either.
    const noOrigin = await h.app.request("/auth/logout", { method: "POST", ...withSession(token) });
    expect(noOrigin.status).toBe(403);

    expect((await h.app.request("/auth/me", withSession(token))).status).toBe(200);

    // Cookie-less callers (CLI/runner/webhooks: Bearer or signature) are not blocked by CSRF.
    const bearer = await h.app.request("/no-such-route-tdm65", {
      method: "POST",
      headers: { authorization: "Bearer ab_test_x" },
    });
    expect(bearer.status).toBe(404);
  });

  it("logout with an allowed Origin revokes the session and clears the cookie", async () => {
    const token = (await signIn("code-plain")).token!;
    const res = await h.app.request("/auth/logout", {
      method: "POST",
      ...withSession(token, { origin: WEB_ORIGIN_TDM65 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cleared = cookieTdm65(res, "anybench_session")!;
    expect(cleared.value).toBe("");
    expect(cleared.attrs["max-age"]).toBe("0");
    expect(cleared.attrs.domain).toBe(".anybench.jaxonp.com");
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN_TDM65);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");

    expect((await h.app.request("/auth/me", withSession(token))).status).toBe(401);
    const hash = createHash("sha256").update(token).digest("hex");
    const [row] = await fresh.db.select().from(sessions).where(eq(sessions.tokenHash, hash));
    expect(row!.revokedAt).toBeInstanceOf(Date);

    // A second logout has nothing to revoke.
    const again = await h.app.request("/auth/logout", {
      method: "POST",
      ...withSession(token, { origin: WEB_ORIGIN_TDM65 }),
    });
    expect(again.status).toBe(401);
  });

  it("the 30-day expiry slides on use and expired sessions are refused", async () => {
    const token = (await signIn("code-plain")).token!;
    const hash = createHash("sha256").update(token).digest("hex");

    // Fresh session: no write, no cookie re-issue.
    const quiet = await h.app.request("/auth/me", withSession(token));
    expect(cookieTdm65(quiet, "anybench_session")).toBeUndefined();

    await fresh.db
      .update(sessions)
      .set({ lastSeenAt: sql`now() - interval '1 hour'`, expiresAt: sql`now() + interval '1 day'` })
      .where(eq(sessions.tokenHash, hash));
    const slid = await h.app.request("/auth/me", withSession(token));
    expect(slid.status).toBe(200);
    expect(cookieTdm65(slid, "anybench_session")?.value).toBe(token);
    const [row] = await fresh.db.select().from(sessions).where(eq(sessions.tokenHash, hash));
    const days = (row!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);

    await fresh.db
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.tokenHash, hash));
    expect((await h.app.request("/auth/me", withSession(token))).status).toBe(401);
  });

  it("CORS answers only ALLOWED_ORIGINS, with credentials", async () => {
    const ok = await h.app.request("/auth/me", { headers: { origin: "http://localhost:3000" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    expect(ok.headers.get("vary")).toContain("Origin");

    const bad = await h.app.request("/auth/me", { headers: { origin: FOREIGN_ORIGIN_TDM65 } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    expect(bad.headers.get("access-control-allow-credentials")).toBeNull();

    // A look-alike is not an exact match.
    const lookalike = await h.app.request("/auth/me", {
      headers: { origin: "https://anybench.jaxonp.com.evil.example" },
    });
    expect(lookalike.headers.get("access-control-allow-origin")).toBeNull();

    const pre = await h.app.request("/auth/logout", {
      method: "OPTIONS",
      headers: {
        origin: WEB_ORIGIN_TDM65,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN_TDM65);
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");

    const preBad = await h.app.request("/auth/logout", {
      method: "OPTIONS",
      headers: { origin: FOREIGN_ORIGIN_TDM65, "access-control-request-method": "POST" },
    });
    expect(preBad.status).toBe(403);
    expect(preBad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("auth routes without GitHub config (TDM-65)", () => {
  it("answers 503 instead of starting a broken OAuth flow", async () => {
    const { createApp } = await import("../src/app.js");
    const { loadConfig } = await import("../src/config.js");
    const { createDb } = await import("../src/db/client.js");
    const { silentLoggerTdm14, recordingSentryTdm14 } = await import("./helpers/server-tdm14.js");
    const url = "postgres://anybench:anybench@127.0.0.1:1/none";
    const dbh = createDb(url, { max: 1 });
    try {
      const app = createApp({
        config: loadConfig({ DATABASE_URL: url, LOG_LEVEL: "silent" }),
        logger: silentLoggerTdm14(),
        db: dbh.db,
        sentry: recordingSentryTdm14(),
      });
      expect((await app.request("/auth/github")).status).toBe(503);
      expect((await app.request("/auth/github/callback?code=a&state=b")).status).toBe(503);
      expect((await app.request("/auth/me")).status).toBe(401);
    } finally {
      await dbh.close();
    }
  });
});
