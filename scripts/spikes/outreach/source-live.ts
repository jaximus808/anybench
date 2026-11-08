// TDM-163 [15.2a] live check: one sourcing pass through the real CLI command, writing to the LOCAL
// dev DB only. Keys come from .env via lib.ts (quotes/whitespace stripped); only the keys the
// command needs are passed, and DATABASE_URL is forced to the local Docker Postgres.
//
//   npx tsx scripts/spikes/outreach/source-live.ts <saved-query-id> <limit> [extra CLI flags...]
//
// Default caps for the live check: 10 Context.dev credits, $1 Monid, 20 GitHub calls.
import { runOutreach } from "../../../apps/cli/src/commands/outreach.js";
import { key, redact } from "./lib.js";

const LOCAL_DB = "postgres://anybench:anybench@localhost:55432/anybench";
const [queryId = "harness-perf", limit = "5", ...extra] = process.argv.slice(2);

const env = {
  CONTEXT_DEV_API_KEY: key("CONTEXT_DEV_API_KEY"),
  MONID_API_KEY: key("MONID_API_KEY"),
  GITHUB_TOKEN: key("GITHUB_TOKEN", false),
  DATABASE_URL: LOCAL_DB,
};

const code = await runOutreach(
  [
    "source",
    "--query",
    queryId,
    "--limit",
    limit,
    "--credit-cap",
    "10",
    "--monid-cap-micro-usd",
    "1000000",
    "--github-budget",
    "20",
    "--database-url",
    LOCAL_DB,
    ...extra,
  ],
  {
    env,
    stdout: (l) => console.log(redact(l)),
    stderr: (l) => console.error(redact(l)),
  },
);
process.exitCode = code;
