// Where the web app's same-origin `/api/*` proxy forwards (TDM-100). Imported by next.config.ts
// and lib/api.ts, so it must stay dependency-free.
//
// The browser only ever calls `/api/*` on the web origin. Next rewrites it to ANYBENCH_API_URL,
// so the `anybench_session` cookie is first-party (Safari and strict Firefox block the
// cross-site cookie a direct call to the API host would need).

/** The deployed API (TDM-154). Override with ANYBENCH_API_URL (server-side, read at build). */
export const DEFAULT_UPSTREAM_API_URL = "https://anybench-api-sj1arspaf10q.vercel.app";

/** The path prefix the browser calls; next.config.ts rewrites it to the upstream API. */
export const WEB_API_BASE = "/api";

export function upstreamApiUrl(env: Readonly<Record<string, string | undefined>> = process.env) {
  return (env.ANYBENCH_API_URL || DEFAULT_UPSTREAM_API_URL).replace(/\/+$/, "");
}
