// TDM-65 test helpers: an app with auth config (fake values, never the real .env) and a fake
// GitHub, plus a tiny cookie reader. No test reaches github.com.
import { createApp } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createDb, type DbHandle } from "../../src/db/client.js";
import {
  GitHubOAuthError,
  type GitHubIdentity,
  type GitHubOAuth,
} from "../../src/lib/github-oauth.js";
import { recordingSentryTdm14, silentLoggerTdm14 } from "./server-tdm14.js";

export const WEB_ORIGIN_TDM65 = "https://anybench.jaxonp.com";
export const FOREIGN_ORIGIN_TDM65 = "https://evil.example";

export const AUTH_ENV_TDM65: Record<string, string> = {
  LOG_LEVEL: "silent",
  SESSION_SECRET: "tdm65-test-secret-not-real-0123456789abcdef",
  GITHUB_CLIENT_ID: "Iv1.tdm65fakeclient",
  GITHUB_CLIENT_SECRET: "tdm65-fake-client-secret",
  GITHUB_OAUTH_CALLBACK_URL: "https://api.anybench.jaxonp.com/auth/github/callback",
  SESSION_COOKIE_DOMAIN: ".anybench.jaxonp.com",
  ALLOWED_ORIGINS: `${WEB_ORIGIN_TDM65},http://localhost:3000`,
  ADMIN_GITHUB_LOGINS: "Jaximus808, other-admin",
  PUBLIC_WEB_URL: WEB_ORIGIN_TDM65,
};

export function authConfigTdm65(url: string, extra: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: url, DATABASE_URL_DIRECT: url, ...AUTH_ENV_TDM65, ...extra });
}

/** GitHub stand-in: `code` → identity. Unknown codes fail like GitHub's bad_verification_code. */
export function fakeGitHubTdm65(identities: Record<string, GitHubIdentity>): GitHubOAuth & {
  exchanged: string[];
} {
  const exchanged: string[] = [];
  return {
    exchanged,
    authorizeUrl: (state) =>
      `https://github.com/login/oauth/authorize?client_id=fake&state=${encodeURIComponent(state)}`,
    async exchangeCode(code) {
      exchanged.push(code);
      const id = identities[code];
      if (!id) throw new GitHubOAuthError("bad_verification_code", "bad_code");
      return id;
    },
  };
}

export function authAppTdm65(
  url: string,
  github: GitHubOAuth,
  extra: Record<string, string> = {},
): { app: ReturnType<typeof createApp>; dbh: DbHandle; config: Config } {
  const config = authConfigTdm65(url, extra);
  const dbh = createDb(url, { max: 2 });
  const app = createApp({
    config,
    logger: silentLoggerTdm14(),
    db: dbh.db,
    sentry: recordingSentryTdm14(),
    github,
  });
  return { app, dbh, config };
}

export interface SetCookieTdm65 {
  name: string;
  value: string;
  attrs: Record<string, string | true>;
}

/** Parse every Set-Cookie header of a response (attribute names lowercased). */
export function setCookiesTdm65(res: Response): SetCookieTdm65[] {
  return res.headers.getSetCookie().map((line) => {
    const [pair, ...rest] = line.split(";").map((s) => s.trim());
    const eq = pair!.indexOf("=");
    const attrs: Record<string, string | true> = {};
    for (const a of rest) {
      const i = a.indexOf("=");
      if (i === -1) attrs[a.toLowerCase()] = true;
      else attrs[a.slice(0, i).toLowerCase()] = a.slice(i + 1);
    }
    return { name: pair!.slice(0, eq), value: decodeURIComponent(pair!.slice(eq + 1)), attrs };
  });
}

export function cookieTdm65(res: Response, name: string): SetCookieTdm65 | undefined {
  return setCookiesTdm65(res).find((c) => c.name === name);
}
