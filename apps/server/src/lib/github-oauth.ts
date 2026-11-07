// GitHub OAuth web flow client (TDM-65). The only network code in sign-in; tests replace it through
// `deps.github` (or pass a stub `fetch`), so no test ever reaches github.com.
//
// Scope is `read:user user:email`: sign-in needs the id, login, account age (abuse rule: grants
// only for accounts older than 90 days) and an email. The GitHub access token is used for these
// reads only and is never stored.
import { z } from "zod";

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_OAUTH_SCOPE = "read:user user:email";

/** Who signed in, as read from the GitHub API. */
export interface GitHubIdentity {
  id: number;
  login: string;
  /** Account creation time; null only if GitHub omits it. */
  createdAt: Date | null;
  email: string | null;
}

export interface GitHubOAuth {
  /** The github.com URL to send the browser to. */
  authorizeUrl(state: string): string;
  /** Exchange the callback `code` and read the user. Throws GitHubOAuthError on any failure. */
  exchangeCode(code: string): Promise<GitHubIdentity>;
}

export class GitHubOAuthError extends Error {
  constructor(
    message: string,
    readonly reason: "bad_code" | "upstream",
  ) {
    super(message);
    this.name = "GitHubOAuthError";
  }
}

const TokenResponseSchema = z.union([
  z.object({ access_token: z.string().min(1), token_type: z.string().optional() }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);

const GitHubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  created_at: z.string().nullish(),
  email: z.string().nullish(),
});

const GitHubEmailsSchema = z.array(
  z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }),
);

export interface GitHubOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createGitHubOAuth(opts: GitHubOAuthOptions): GitHubOAuth {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function getJson(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new GitHubOAuthError(`GitHub request failed: ${String(err)}`, "upstream");
    }
    if (!res.ok) throw new GitHubOAuthError(`GitHub ${url} answered ${res.status}`, "upstream");
    try {
      return await res.json();
    } catch {
      throw new GitHubOAuthError(`GitHub ${url} returned invalid JSON`, "upstream");
    }
  }

  return {
    authorizeUrl(state) {
      const u = new URL(GITHUB_AUTHORIZE_URL);
      u.searchParams.set("client_id", opts.clientId);
      u.searchParams.set("redirect_uri", opts.redirectUri);
      u.searchParams.set("scope", GITHUB_OAUTH_SCOPE);
      u.searchParams.set("state", state);
      u.searchParams.set("allow_signup", "true");
      return u.toString();
    },

    async exchangeCode(code) {
      const tokenBody = TokenResponseSchema.safeParse(
        await getJson(GITHUB_TOKEN_URL, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: opts.clientId,
            client_secret: opts.clientSecret,
            code,
            redirect_uri: opts.redirectUri,
          }),
        }),
      );
      if (!tokenBody.success) {
        throw new GitHubOAuthError("unexpected token response from GitHub", "upstream");
      }
      if ("error" in tokenBody.data) {
        // bad_verification_code, redirect_uri_mismatch, ...: the code is unusable, not an outage.
        throw new GitHubOAuthError(`GitHub refused the code: ${tokenBody.data.error}`, "bad_code");
      }
      const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenBody.data.access_token}`,
        "User-Agent": "anybench",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      const user = GitHubUserSchema.safeParse(await getJson(`${GITHUB_API_URL}/user`, { headers }));
      if (!user.success) throw new GitHubOAuthError("unexpected /user response", "upstream");

      let email = user.data.email ?? null;
      if (!email) {
        // The public email is often hidden; the primary verified one needs user:email.
        try {
          const emails = GitHubEmailsSchema.safeParse(
            await getJson(`${GITHUB_API_URL}/user/emails`, { headers }),
          );
          if (emails.success) {
            email = emails.data.find((e) => e.primary && e.verified)?.email ?? null;
          }
        } catch {
          email = null; // optional: sign-in works without an email
        }
      }
      const created = user.data.created_at ? new Date(user.data.created_at) : null;
      return {
        id: user.data.id,
        login: user.data.login,
        createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
        email,
      };
    },
  };
}
