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

/** Where every sign-in and sign-up lands (TDM-100). The run form is TDM-101. */
export const POST_SIGN_IN_PATH = "/runs/new";

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
