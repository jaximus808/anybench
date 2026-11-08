// Operator settle from a shell (worker-hardening): finish a run with the trials it has.
//
//   pnpm tsx scripts/ops/settle-run.ts <run-id> [--reason "why"] [--dry-run]
//
// Reads DATABASE_URL_DIRECT (or DATABASE_URL) from the environment (.env in the cwd is loaded the
// same way the server does; nothing is printed from it). Every unfinished trial of the run becomes
// `cancelled` (failure_class operator_settled: operator-stopped, never billed), `run.settle`
// destroys their computers and revokes their proxy keys, and `run.advance` scores the run. The
// same code backs `POST /runs/:id/settle` (apps/server/src/orchestrator/settle.ts). A running
// worker must pick the jobs up; this script only writes the database.
import { loadDotEnv } from "../../apps/server/src/boot.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { createDb } from "../../apps/server/src/db/client.js";
import { graphileJobQueue } from "../../apps/server/src/lib/job-queue.js";
import { previewSettle, settleRun } from "../../apps/server/src/orchestrator/settle.js";

function usage(): never {
  console.error('usage: pnpm tsx scripts/ops/settle-run.ts <run-id> [--reason "why"] [--dry-run]');
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runId = args[0];
  if (!runId || runId.startsWith("-")) usage();
  const ri = args.indexOf("--reason");
  const reason = ri >= 0 ? args[ri + 1] : undefined;
  if (ri >= 0 && !reason) usage();
  const dryRun = args.includes("--dry-run");

  loadDotEnv();
  const config = loadConfig(process.env);
  const h = createDb(config.databaseUrlDirect, { max: 1 });
  try {
    if (dryRun) {
      const p = await previewSettle(h.db, runId);
      console.log(
        JSON.stringify(
          { run_id: runId, dry_run: true, would_settle: p.wouldSettle, trials_now: p.byState },
          null,
          2,
        ),
      );
      return;
    }
    const out = await settleRun(h.db, runId, {
      actor: { kind: "system" },
      ...(reason ? { reason } : {}),
      jobs: graphileJobQueue(),
    });
    if (!out.ok) {
      console.error(out.message);
      process.exitCode = 1;
      return;
    }
    const now = await previewSettle(h.db, runId);
    console.log(
      JSON.stringify(
        {
          run_id: runId,
          run_state: out.run.state,
          settled: out.settled,
          trials_now: now.byState,
          enqueued: ["run.settle", "run.advance"],
        },
        null,
        2,
      ),
    );
  } finally {
    await h.close();
  }
}

await main();
