// Browser/server API client for the web app (TDM-98). Wraps the typed client from
// @anybench/core with the cookie session: every request carries `credentials: "include"`
// so the `anybench_session` cookie (domain .anybench.jaxonp.com) rides along.
import { createApiClient, type ApiClient, type ApiClientOptions } from "@anybench/core";

export const DEFAULT_API_URL = "http://localhost:8787";

/** NEXT_PUBLIC_ANYBENCH_API_URL is inlined at build time; falls back to the local API. */
export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_ANYBENCH_API_URL || DEFAULT_API_URL;
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
