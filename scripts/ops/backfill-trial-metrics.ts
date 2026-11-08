// Backfill trials.metrics / trials.cost_micro_usd for one run, re-score it, and (curated Tandem
// runs) rebuild its deterministic report. Logic: apps/server/src/orchestrator/metrics-backfill.ts.
//
//   pnpm exec tsx --env-file=.env scripts/ops/backfill-trial-metrics.ts --run <run-id>           (dry run)
//   pnpm exec tsx --env-file=.env scripts/ops/backfill-trial-metrics.ts --run <run-id> --apply
//
// Reads DATABASE_URL_DIRECT (else DATABASE_URL) and NAIVE_API_KEY (+ NAIVE_BASE_URL) for the
// credits ledger (read-only: GET /v1/credits/ledger; no computer, no model call, no spend).
// Idempotent: safe to run again. Prints one JSON report; never prints env values.
import { parseArgs } from "node:util";
import { createDb } from "../../apps/server/src/db/client.js";
import { proxyDepsFromConfig } from "../../apps/server/src/lib/compute.js";
import { backfillRunMetrics } from "../../apps/server/src/orchestrator/metrics-backfill.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { run: { type: "string" }, apply: { type: "boolean", default: false } },
  });
  const runId = values.run;
  if (!runId || !UUID.test(runId)) {
    throw new Error("usage: backfill-trial-metrics.ts --run <run-id> [--apply]");
  }
  const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_DIRECT or DATABASE_URL must be set");
  const naive = proxyDepsFromConfig({
    NAIVE_API_KEY: process.env.NAIVE_API_KEY || undefined,
    NAIVE_BASE_URL: process.env.NAIVE_BASE_URL || undefined,
  });
  const handle = createDb(url, { max: 2 });
  try {
    const report = await backfillRunMetrics(handle.db, {
      runId,
      apply: values.apply === true,
      proxySpend: naive?.spend ?? null,
      log: (msg) => process.stderr.write(`${msg}\n`),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `backfill-trial-metrics: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
