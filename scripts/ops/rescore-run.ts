// Re-score one run from its stored trial rows and (curated Tandem runs) rebuild its deterministic
// report, after a scorer or summary fix. Trial rows are read, never written: only
// runs.stage_outputs.score (+ rescored_at) and the report's json/md change. No email is sent.
// Logic: rescoreRun in apps/server/src/orchestrator/metrics-backfill.ts.
//
//   pnpm exec tsx --env-file=.env scripts/ops/rescore-run.ts --run <run-id>           (dry run)
//   pnpm exec tsx --env-file=.env scripts/ops/rescore-run.ts --run <run-id> --apply
//
// Reads DATABASE_URL_DIRECT (else DATABASE_URL). Idempotent. Prints one JSON report; never
// prints env values.
import { parseArgs } from "node:util";
import { createDb } from "../../apps/server/src/db/client.js";
import { proxyDepsFromConfig } from "../../apps/server/src/lib/compute.js";
import { rescoreRun } from "../../apps/server/src/orchestrator/metrics-backfill.js";

// Loaded first for the module graph's init order (as backfill-trial-metrics.ts does); unused.
void proxyDepsFromConfig;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { run: { type: "string" }, apply: { type: "boolean", default: false } },
  });
  const runId = values.run;
  if (!runId || !UUID.test(runId))
    throw new Error("usage: rescore-run.ts --run <run-id> [--apply]");
  const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_DIRECT or DATABASE_URL must be set");
  const handle = createDb(url, { max: 2 });
  try {
    const report = await rescoreRun(handle.db, { runId, apply: values.apply === true });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`rescore-run: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
