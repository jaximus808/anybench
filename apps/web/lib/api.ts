// Browser/server API client for the web app (TDM-98). Wraps the typed client from
// @anybench/core with the cookie session: every request carries `credentials: "include"`
// so the `anybench_session` cookie rides along. In the browser the base is the same-origin
// `/api` proxy (TDM-100, see lib/api-upstream.ts); on the server it is the upstream API.
import {
  ApiClientError,
  apiRoutes,
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
} from "@anybench/core";

import { upstreamApiUrl, WEB_API_BASE } from "./api-upstream";

export { DEFAULT_UPSTREAM_API_URL, upstreamApiUrl, WEB_API_BASE } from "./api-upstream";

/** `/api` in the browser (same-origin proxy); the upstream API URL on the server. */
export function apiBaseUrl(): string {
  return typeof window === "undefined" ? upstreamApiUrl() : WEB_API_BASE;
}

export function createWebApiClient(
  baseUrl: string = apiBaseUrl(),
  options: ApiClientOptions = {},
): ApiClient {
  return createApiClient(baseUrl, { kind: "session" }, options);
}

let cached: ApiClient | undefined;

/** Shared client for the default base URL. */
export function api(): ApiClient {
  cached ??= createWebApiClient();
  return cached;
}

/** Where sign-in and sign-up land when no `redirect_to` is given (TDM-100). The run form is TDM-101. */
export const POST_SIGN_IN_PATH = "/runs/new";

/** Where sign-up lands without a `redirect_to`: the add-a-card onboarding step (stripe-onboarding). */
export const POST_SIGN_UP_PATH = "/billing?welcome=1";

/** Pages a post-sign-in redirect must not point back at (it would loop). */
const AUTH_PAGES = new Set(["/signin", "/signup"]);

/**
 * A `redirect_to` from the query string, if it is a same-origin relative path; else
 * POST_SIGN_IN_PATH. Refuses absolute and protocol-relative URLs (`//evil.com`, `/\evil.com`),
 * anything that resolves off `origin`, and the sign-in pages themselves. The API re-checks it.
 */
export function safeRedirectPath(raw: string | null | undefined, origin: string): string {
  if (!raw || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//")) {
    return POST_SIGN_IN_PATH;
  }
  // Backslashes and control characters: browsers fold them into `/` or drop them (`/\evil.com`).
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x5c || c < 0x20 || c === 0x7f) return POST_SIGN_IN_PATH;
  }
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return POST_SIGN_IN_PATH;
  }
  if (url.origin !== new URL(origin).origin || url.pathname.startsWith("//")) {
    return POST_SIGN_IN_PATH;
  }
  if (AUTH_PAGES.has(url.pathname.replace(/\/+$/, "") || "/")) return POST_SIGN_IN_PATH;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The GitHub OAuth start URL, through the same-origin proxy (`/api/auth/github?redirect_to=…`), so
 * it renders identically on the server and in the browser. A full-page navigation (not fetch):
 * the API sets its state cookie, sends the browser to GitHub, and the callback redirects back to
 * `redirectTo` with the session cookie set. First sign-in creates the account, so sign-up is the
 * same flow.
 */
export function githubSignInUrl(
  redirectTo: string = POST_SIGN_IN_PATH,
  baseUrl: string = WEB_API_BASE,
): string {
  return createWebApiClient(baseUrl).url(apiRoutes.auth.githubStart, {
    query: { redirect_to: redirectTo },
  });
}

/**
 * True when the API could not be reached: the fetch itself failed (offline, DNS), or the proxy
 * answered a non-API 5xx (upstream down or not deployed).
 */
export function isUnreachable(err: unknown): boolean {
  if (err instanceof ApiClientError) return err.code === "http_error" && err.status >= 500;
  return err instanceof TypeError;
}

/** One human sentence for any API failure, for inline error text. */
export function apiErrorMessage(err: unknown): string {
  if (isUnreachable(err))
    return "Can't reach the Anybench API right now. Check your connection and try again in a minute.";
  if (err instanceof ApiClientError) {
    if (err.status === 401) return "Your session has ended. Sign in again.";
    const prefix = `${err.routeId}: `;
    const msg = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
    if (err.status === 0) return msg;
    if (err.code === "contract_violation" || err.code === "http_error")
      return `The Anybench API returned an unexpected response (${err.status || "invalid"}). Try again.`;
    return msg.charAt(0).toUpperCase() + msg.slice(1);
  }
  return err instanceof Error ? err.message : "Something went wrong. Try again.";
}
