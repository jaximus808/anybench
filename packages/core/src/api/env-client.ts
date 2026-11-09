// The API client a local tool builds from its environment (TDM-219 CLI, TDM-220 MCP server): an
// Anybench API key from the env, the typed core client, and one shared way to word API failures
// and to read a dollar budget without floats. apps/cli and packages/mcp both import this, so the
// two never disagree on what a key looks like or what "$12.50" is in micro-USD.
//
//   ANYBENCH_API_KEY   required for API calls: an `ab_live_…` / `ab_test_…` key
//   ANYBENCH_API_URL   the API base (default the deployed API)
//   ANYBENCH_WEB_URL   the web app, for run URLs (default the production site)
//
// The key is only ever put in the Authorization header; nothing here formats it into a message.
import { MICRO_USD_PER_USD, type MicroUsd } from "../money.js";
import { ApiClientError, createApiClient, type ApiClient, type FetchLike } from "./client.js";

export const DEFAULT_API_URL = "https://anybench-api-sj1arspaf10q.vercel.app";
export const DEFAULT_WEB_URL = "https://anybench.jaxonp.com";

/** The shape of an Anybench API key. */
export const API_KEY_PATTERN = /^ab_(live|test)_[A-Za-z0-9_-]{16,}$/;

export interface EnvApiDeps {
  env?: Readonly<Record<string, string | undefined>>;
  /** Tests pass a local server's fetch, or the global fetch against a local URL. */
  fetch?: FetchLike;
}

export interface EnvApi {
  client: ApiClient;
  apiUrl: string;
  webUrl: string;
  /** The fetch the client uses, for the presigned PUT of a kit upload. */
  fetch: FetchLike;
}

/** Build the client from ANYBENCH_API_KEY / ANYBENCH_API_URL / ANYBENCH_WEB_URL, or say what is missing. */
export function apiFromEnv(deps: EnvApiDeps = {}): EnvApi | { error: string } {
  const env = deps.env ?? process.env;
  const key = env.ANYBENCH_API_KEY?.trim();
  if (!key) {
    return {
      error:
        "ANYBENCH_API_KEY is not set: create an API key (scope runs:write) and export ANYBENCH_API_KEY=ab_live_…",
    };
  }
  if (!API_KEY_PATTERN.test(key)) {
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

/** One line for an API failure, plus one indented line per issue. */
export function describeApiError(e: unknown): string[] {
  if (e instanceof ApiClientError) {
    return [
      `${e.message} (HTTP ${e.status}${e.code ? `, ${e.code}` : ""})`,
      ...e.issues.map((i) => `  ${i}`),
    ];
  }
  return [e instanceof Error ? e.message : String(e)];
}

/**
 * "25", "$12.50", "0.000001" → integer micro-USD. No floats: the decimal string is split at the
 * point and each side read as an integer. At most 6 decimals (one micro-USD), more than $0.
 */
export function parseUsdBudget(s: string, label = "budget"): MicroUsd | { error: string } {
  const m = /^\$?(\d{1,9})(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m)
    return {
      error: `${label} must be US dollars like 25 or 12.50 (at most 6 decimals), not '${s}'`,
    };
  const micro = BigInt(m[1]!) * MICRO_USD_PER_USD + BigInt((m[2] ?? "").padEnd(6, "0"));
  if (micro <= 0n) return { error: `${label} must be more than $0` };
  return micro;
}
