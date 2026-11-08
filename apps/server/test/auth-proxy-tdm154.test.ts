// TDM-154: sign-in behind the web app's same-origin proxy (anybench.vercel.app/api/* → the API).
// The browser sees /api/auth/github/..., so the OAuth state cookie must be scoped to that path or
// it never rides back to the callback.
import { describe, expect, it } from "vitest";
import { OAUTH_STATE_COOKIE, stateCookiePath } from "../src/routes/auth.js";
import { authAppTdm65, cookieTdm65, fakeGitHubTdm65 } from "./helpers/auth-tdm65.js";

const NO_DB = "postgres://anybench:anybench@127.0.0.1:1/none";

describe("stateCookiePath (TDM-154)", () => {
  it("is the parent path of the callback URL", () => {
    expect(stateCookiePath("https://api.anybench.jaxonp.com/auth/github/callback")).toBe(
      "/auth/github",
    );
    expect(stateCookiePath("https://anybench.vercel.app/api/auth/github/callback")).toBe(
      "/api/auth/github",
    );
    expect(stateCookiePath("https://anybench.vercel.app/api/auth/github/callback/")).toBe(
      "/api/auth/github",
    );
    expect(stateCookiePath("https://h.example/callback")).toBe("/");
  });

  it("falls back to /auth/github without a usable callback URL", () => {
    expect(stateCookiePath(undefined)).toBe("/auth/github");
    expect(stateCookiePath("not a url")).toBe("/auth/github");
  });
});

describe("OAuth state cookie behind the proxy (TDM-154)", () => {
  const extra = {
    GITHUB_OAUTH_CALLBACK_URL: "https://anybench.vercel.app/api/auth/github/callback",
    ALLOWED_ORIGINS: "https://anybench.vercel.app",
    PUBLIC_WEB_URL: "https://anybench.vercel.app",
    SESSION_COOKIE_DOMAIN: "",
  };

  it("start sets it on /api/auth/github and the callback clears that same path", async () => {
    const { app, dbh } = authAppTdm65(NO_DB, fakeGitHubTdm65({}), extra);
    try {
      const start = await app.request("/auth/github?redirect_to=%2Fruns");
      expect(start.status).toBe(302);
      const set = cookieTdm65(start, OAUTH_STATE_COOKIE);
      expect(set?.attrs).toMatchObject({ path: "/api/auth/github", samesite: "Lax" });
      expect(set?.attrs.domain).toBeUndefined();

      // A bad state is refused, and the cookie is deleted on the path it was set on.
      const cb = await app.request("/auth/github/callback?code=x&state=nope", {
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${set!.value}` },
      });
      expect(cb.status).toBe(400);
      const cleared = cookieTdm65(cb, OAUTH_STATE_COOKIE);
      expect(cleared?.attrs.path).toBe("/api/auth/github");
      expect(cleared?.attrs["max-age"]).toBe("0");
    } finally {
      await dbh.close();
    }
  });
});
