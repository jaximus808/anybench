// TDM-65: auth config, cookie attributes, signed values and the GitHub client (stub fetch, no
// network). No database.
import { describe, expect, it } from "vitest";
import { ConfigError, configSecrets, loadConfig } from "../src/config.js";
import { isAdminLogin } from "../src/lib/admin.js";
import { createGitHubOAuth, GitHubOAuthError } from "../src/lib/github-oauth.js";
import {
  cookieDomain,
  cookieSecure,
  hashSessionToken,
  newSessionToken,
  sessionCookieOptions,
  signValue,
  verifySignedValue,
} from "../src/lib/session.js";
import { AUTH_ENV_TDM65 } from "./helpers/auth-tdm65.js";

function issues(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.map((i) => i.path);
    throw err;
  }
  return [];
}

describe("auth config (TDM-65)", () => {
  it("parses ALLOWED_ORIGINS into exact origins and ADMIN_GITHUB_LOGINS lowercased", () => {
    const c = loadConfig({
      ALLOWED_ORIGINS:
        " https://anybench.jaxonp.com/ , http://localhost:3000,https://anybench.jaxonp.com",
      ADMIN_GITHUB_LOGINS: "Jaximus808, ,Other",
    });
    expect(c.allowedOrigins).toEqual(["https://anybench.jaxonp.com", "http://localhost:3000"]);
    expect(c.adminGithubLogins).toEqual(["jaximus808", "other"]);
  });

  it("defaults to no origins and no admins", () => {
    const c = loadConfig({});
    expect(c.allowedOrigins).toEqual([]);
    expect(c.adminGithubLogins).toEqual([]);
    expect(isAdminLogin(c, "jaximus808")).toBe(false);
  });

  it("rejects origins with paths or other schemes, short secrets and bad cookie domains", () => {
    expect(issues({ ALLOWED_ORIGINS: "https://a.com/path" })).toEqual(["ALLOWED_ORIGINS"]);
    expect(issues({ ALLOWED_ORIGINS: "ftp://a.com" })).toEqual(["ALLOWED_ORIGINS"]);
    expect(issues({ ALLOWED_ORIGINS: "*" })).toEqual(["ALLOWED_ORIGINS"]);
    expect(issues({ SESSION_SECRET: "short" })).toEqual(["SESSION_SECRET"]);
    expect(issues({ SESSION_COOKIE_DOMAIN: "not a domain" })).toEqual(["SESSION_COOKIE_DOMAIN"]);
    expect(
      issues({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://a/b",
        DATABASE_URL_DIRECT: "postgres://a/b",
        GITHUB_OAUTH_CALLBACK_URL: "http://api.example.com/auth/github/callback",
      }),
    ).toEqual(["GITHUB_OAUTH_CALLBACK_URL"]);
  });

  it("treats SESSION_SECRET and GITHUB_CLIENT_SECRET as secrets for redaction", () => {
    const c = loadConfig(AUTH_ENV_TDM65);
    const s = configSecrets(c);
    expect(s.SESSION_SECRET).toBe(AUTH_ENV_TDM65.SESSION_SECRET);
    expect(s.GITHUB_CLIENT_SECRET).toBe(AUTH_ENV_TDM65.GITHUB_CLIENT_SECRET);
  });
});

describe("session cookie attributes (TDM-65)", () => {
  const prod = loadConfig({
    ...AUTH_ENV_TDM65,
    NODE_ENV: "production",
    DATABASE_URL: "postgres://a/b",
    DATABASE_URL_DIRECT: "postgres://a/b",
  });

  it("production: Secure, HttpOnly, SameSite=Lax, Domain=.anybench.jaxonp.com, 30 days", () => {
    expect(sessionCookieOptions(prod)).toEqual({
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 30 * 24 * 60 * 60,
      domain: ".anybench.jaxonp.com",
    });
  });

  it("Secure=false only for local dev over http, never in production", () => {
    const localHttp = {
      isProduction: false,
      SESSION_COOKIE_DOMAIN: ".anybench.jaxonp.com",
      GITHUB_OAUTH_CALLBACK_URL: "http://localhost:8787/auth/github/callback",
    };
    expect(cookieSecure(localHttp)).toBe(false);
    // The shared .env domain cannot apply to localhost: host-only cookie instead.
    expect(cookieDomain(localHttp)).toBeUndefined();
    expect(cookieSecure({ ...localHttp, isProduction: true })).toBe(true);
    expect(cookieDomain({ ...localHttp, isProduction: true })).toBe(".anybench.jaxonp.com");
    expect(cookieSecure({ ...localHttp, GITHUB_OAUTH_CALLBACK_URL: undefined })).toBe(true);
  });
});

describe("tokens and signed values (TDM-65)", () => {
  it("tokens are 256-bit and stored as sha256 hex", () => {
    const t = newSessionToken();
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(newSessionToken()).not.toBe(t);
    expect(hashSessionToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies only the same secret and purpose", () => {
    const s = signValue("k".repeat(32), "oauth-state", "payload");
    expect(verifySignedValue("k".repeat(32), "oauth-state", s)).toBe("payload");
    expect(verifySignedValue("j".repeat(32), "oauth-state", s)).toBeNull();
    expect(verifySignedValue("k".repeat(32), "other", s)).toBeNull();
    expect(
      verifySignedValue("k".repeat(32), "oauth-state", `payloaX.${s.split(".")[1]}`),
    ).toBeNull();
    expect(verifySignedValue("k".repeat(32), "oauth-state", "nodot")).toBeNull();
  });
});

describe("GitHub OAuth client with a stub fetch (TDM-65)", () => {
  type Call = { url: string; init: RequestInit };
  function stub(routes: Record<string, unknown>, status: Record<string, number> = {}) {
    const calls: Call[] = [];
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (!(url in routes)) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(routes[url]), { status: status[url] ?? 200 });
    }) as typeof fetch;
    const gh = createGitHubOAuth({
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "https://api.anybench.jaxonp.com/auth/github/callback",
      fetch: fetchStub,
    });
    return { gh, calls };
  }

  it("builds the authorize URL", () => {
    const u = new URL(stub({}).gh.authorizeUrl("nonce123"));
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: "cid",
      state: "nonce123",
      scope: "read:user user:email",
      redirect_uri: "https://api.anybench.jaxonp.com/auth/github/callback",
    });
  });

  it("exchanges the code, reads /user and falls back to the primary verified email", async () => {
    const { gh, calls } = stub({
      "https://github.com/login/oauth/access_token": {
        access_token: "gho_fake",
        token_type: "bearer",
      },
      "https://api.github.com/user": {
        id: 42,
        login: "octo",
        created_at: "2011-01-25T18:44:36Z",
        email: null,
      },
      "https://api.github.com/user/emails": [
        { email: "old@example.com", primary: false, verified: true },
        { email: "octo@example.com", primary: true, verified: true },
      ],
    });
    const id = await gh.exchangeCode("the-code");
    expect(id).toEqual({
      id: 42,
      login: "octo",
      createdAt: new Date("2011-01-25T18:44:36Z"),
      email: "octo@example.com",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      code: "the-code",
      client_secret: "csecret",
    });
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer gho_fake",
    );
  });

  it("maps a refused code to bad_code and an outage to upstream", async () => {
    const refused = stub({
      "https://github.com/login/oauth/access_token": { error: "bad_verification_code" },
    });
    await expect(refused.gh.exchangeCode("x")).rejects.toMatchObject({ reason: "bad_code" });

    const down = stub(
      { "https://github.com/login/oauth/access_token": { access_token: "t" } },
      { "https://github.com/login/oauth/access_token": 502 },
    );
    const err = await down.gh.exchangeCode("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubOAuthError);
    expect((err as GitHubOAuthError).reason).toBe("upstream");
  });
});
