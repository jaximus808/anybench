// Build and store the trace of every trial of one run from its out.tar.gz. Logic:
// apps/server/src/lib/trial-trace/backfill.ts.
//
//   pnpm exec tsx --env-file=.env scripts/ops/backfill-trial-traces.ts --run <run-id> --dry-run
//   pnpm exec tsx --env-file=.env scripts/ops/backfill-trial-traces.ts --run <run-id>
//
// Reads DATABASE_URL_DIRECT (else DATABASE_URL) and the S3_* artifact store settings. Read-only on
// the database (one SELECT of the run's trials): it never changes a trial's state, score or cost.
// Its only writes are the trace artifacts runs/<run>/server/traces/<trial>.json. Idempotent.
// Prints one JSON report; never prints env values.
import { parseArgs } from "node:util";
import { createDb } from "../../apps/server/src/db/client.js";
import { artifactStoreFromEnv } from "../../apps/server/src/lib/compute.js";
import { backfillRunTraces } from "../../apps/server/src/lib/trial-trace/backfill.js";
import {
  artifactBundleSource,
  artifactTraceStore,
} from "../../apps/server/src/lib/trial-trace/store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { run: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  });
  const runId = values.run;
  if (!runId || !UUID.test(runId)) {
    throw new Error("usage: backfill-trial-traces.ts --run <run-id> [--dry-run]");
  }
  const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_DIRECT or DATABASE_URL must be set");
  const store = artifactStoreFromEnv();
  if (!store) throw new Error("S3_BUCKET (the artifact store) must be set");
  const handle = createDb(url, { max: 2 });
  try {
    const report = await backfillRunTraces(handle.db, {
      runId,
      dryRun: values["dry-run"] === true,
      deps: { bundles: artifactBundleSource(store), traces: artifactTraceStore(store) },
      log: (msg) => process.stderr.write(`${msg}\n`),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.errors > 0) process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `backfill-trial-traces: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
