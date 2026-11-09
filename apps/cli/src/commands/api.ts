// The CLI's API client (TDM-219). The client itself is shared with the MCP server (TDM-220): it
// lives in @anybench/core env-client.ts, so both read ANYBENCH_API_KEY / ANYBENCH_API_URL /
// ANYBENCH_WEB_URL the same way.
//
//   ANYBENCH_API_KEY   required: an `ab_live_…` / `ab_test_…` key (runs:write for push and run)
//   ANYBENCH_API_URL   the API base (default the deployed API)
//   ANYBENCH_WEB_URL   the web app, for the run URL the CLI prints (default the production site)
import type { EnvApi, EnvApiDeps } from "@anybench/core";

export { DEFAULT_API_URL, DEFAULT_WEB_URL, apiFromEnv, describeApiError } from "@anybench/core";

export type ApiDeps = EnvApiDeps;
export type CliApi = EnvApi;
