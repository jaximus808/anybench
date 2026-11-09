// The CLI's API client (TDM-219): an Anybench API key from the env, the typed core client.
//
//   ANYBENCH_API_KEY   required: an `ab_live_…` / `ab_test_…` key (runs:write for push and run)
//   ANYBENCH_API_URL   the API base (default the deployed API)
//   ANYBENCH_WEB_URL   the web app, for the run URL the CLI prints (default the production site)
import { ApiClientError, createApiClient, type ApiClient, type FetchLike } from "@anybench/core";

export const DEFAULT_API_URL = "https://anybench-api-sj1arspaf10q.vercel.app";
export const DEFAULT_WEB_URL = "https://anybench.jaxonp.com";

export interface ApiDeps {
  env?: NodeJS.ProcessEnv;
  /** Tests pass a local server's fetch, or the global fetch against a local URL. */
  fetch?: FetchLike;
}

export interface CliApi {
  client: ApiClient;
  apiUrl: string;
  webUrl: string;
  fetch: FetchLike;
}

export function apiFromEnv(deps: ApiDeps = {}): CliApi | { error: string } {
  const env = deps.env ?? process.env;
  const key = env.ANYBENCH_API_KEY?.trim();
  if (!key) {
    return {
      error:
        "ANYBENCH_API_KEY is not set: create an API key (scope runs:write) and export ANYBENCH_API_KEY=ab_live_…",
    };
  }
  if (!/^ab_(live|test)_[A-Za-z0-9_-]{16,}$/.test(key)) {
    return {
      error: "ANYBENCH_API_KEY does not look like an Anybench key (ab_live_… or ab_test_…)",
    };
  }
  const apiUrl = (env.ANYBENCH_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  const webUrl = (env.ANYBENCH_WEB_URL?.trim() || DEFAULT_WEB_URL).replace(/\/+$/, "");
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return {
    client: createApiClient(apiUrl, { kind: "apiKey", key }, { fetch: fetchImpl }),
    apiUrl,
    webUrl,
    fetch: fetchImpl,
  };
}

/** One line for an API failure, plus its issues. */
export function describeApiError(e: unknown): string[] {
  if (e instanceof ApiClientError) {
    return [
      `${e.message} (HTTP ${e.status}${e.code ? `, ${e.code}` : ""})`,
      ...e.issues.map((i) => `  ${i}`),
    ];
  }
  return [e instanceof Error ? e.message : String(e)];
}
