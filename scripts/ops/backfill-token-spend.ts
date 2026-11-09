// TDM-250: recompute one run's recorded BYOK token spend from Claude Code's own session totals in
// the trials' stored bundles (each session's latest `total_cost_usd`, summed over sessions), and
// runs.byok_token_micro_usd from the corrected trials. Logic:
// apps/server/src/orchestrator/token-spend-backfill.ts.
//
//   pnpm exec tsx --env-file=.env scripts/ops/backfill-token-spend.ts --run <run-id>           (dry run)
//   pnpm exec tsx --env-file=.env scripts/ops/backfill-token-spend.ts --run <run-id> --apply
//
// Database: DATABASE_URL_DIRECT (else DATABASE_URL), as the other ops scripts; the live app runs on
// that Neon branch (docs/findings/api-deploy.md). A dry run connects with
// default_transaction_read_only=on, so it cannot write. Bundles: the artifact store from S3_* (a presigned GET per trial, checked against its
// sha256). --apply also needs the server config (loadConfig) for the budget pricing.
// Idempotent: safe to run again. Prints a per-trial table and totals to stderr, one JSON report to
// stdout; never prints env values or URLs. After --apply, re-score with scripts/ops/rescore-run.ts.
import { parseArgs } from "node:util";
import { loadConfig } from "../../apps/server/src/config.js";
import { createDb } from "../../apps/server/src/db/client.js";
import { artifactStoreFromEnv } from "../../apps/server/src/lib/compute.js";
import { artifactBundleSource } from "../../apps/server/src/lib/trial-trace/store.js";
import { budgetPricingFromConfig } from "../../apps/server/src/orchestrator/budget.js";
import {
  backfillTokenSpend,
  type TokenSpendBackfillReport,
} from "../../apps/server/src/orchestrator/token-spend-backfill.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const usd = (micro: string | null): string =>
  micro === null ? "-" : `$${(Number(BigInt(micro)) / 1e6).toFixed(2)}`;

function readOnly(url: string): string {
  const u = new URL(url);
  u.searchParams.set("options", "-c default_transaction_read_only=on");
  return u.toString();
}

function table(r: TokenSpendBackfillReport): string {
  const out: string[] = [];
  out.push(
    `run ${r.runId} (${r.runState}) ${r.apply ? "APPLY" : "DRY RUN"}`,
    "contender            rep  state           att  source                    sessions  old (trial)  new (trial)  note",
  );
  for (const l of r.trials) {
    out.push(
      [
        l.contender.padEnd(20),
        String(l.repeat).padStart(3),
        l.state.padEnd(15),
        String(l.attempt).padStart(3),
        l.source.padEnd(25),
        `${l.sessions ?? "-"}/${l.open_sessions ?? "-"} open`.padEnd(9),
        usd(l.trial_old_micro_usd).padStart(11),
        usd(l.trial_new_micro_usd).padStart(12),
        ` ${l.trialId.slice(-8)}${l.note ? ` ${l.note}` : ""}${l.written ? " (written)" : ""}`,
      ].join(" "),
    );
  }
  out.push("by contender (BYOK trials):");
  let oldT = 0n;
  let newT = 0n;
  for (const [c, v] of Object.entries(r.byContender)) {
    oldT += BigInt(v.old_micro_usd);
    newT += BigInt(v.new_micro_usd);
    out.push(
      `  ${c.padEnd(20)} ${String(v.trials).padStart(2)} trials  ${usd(v.old_micro_usd).padStart(9)} -> ${usd(v.new_micro_usd).padStart(9)}`,
    );
  }
  out.push(
    `  ${"total".padEnd(20)}           ${usd(oldT.toString()).padStart(9)} -> ${usd(newT.toString()).padStart(9)}`,
    `runs.byok_token_micro_usd: stored ${r.run.stored_micro_usd} (${usd(r.run.stored_micro_usd)}) -> ${r.run.new_micro_usd} (${usd(r.run.new_micro_usd)})${r.run.written ? " (written)" : ""}`,
  );
  return out.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const runId = values.run;
  if (!runId || !UUID.test(runId)) {
    throw new Error("usage: backfill-token-spend.ts --run <run-id> [--apply]");
  }
  const apply = values.apply === true;
  const env = process.env;
  const url = env.DATABASE_URL_DIRECT || env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_DIRECT or DATABASE_URL must be set");
  const store = artifactStoreFromEnv();
  if (!store) throw new Error("S3_BUCKET (the artifact store) must be set");
  const pricing = apply ? budgetPricingFromConfig(loadConfig(env)) : undefined;
  const handle = createDb(apply ? url : readOnly(url), { max: 2 });
  try {
    if (!apply) {
      // Refuse a dry run whose connection could write (a pooler that drops startup options).
      const ro = await handle.pool.query<{ default_transaction_read_only: string }>(
        "show default_transaction_read_only",
      );
      if (ro.rows[0]?.default_transaction_read_only !== "on") {
        throw new Error("the dry run's connection is not read-only; refusing to run");
      }
      process.stderr.write("dry run: read-only connection (default_transaction_read_only=on)\n");
    }
    const report = await backfillTokenSpend(handle.db, {
      runId,
      apply,
      bundles: artifactBundleSource(store),
      ...(pricing ? { pricing } : {}),
      log: (msg) => process.stderr.write(`${msg}\n`),
    });
    process.stderr.write(`${table(report)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  // A failed query's own message names the SQL; its cause says why (never the URL).
  const cause = err instanceof Error ? (err.cause as { message?: string; code?: string }) : null;
  const why = cause?.message ? ` (${cause.code ? `${cause.code}: ` : ""}${cause.message})` : "";
  process.stderr.write(
    `backfill-token-spend: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}${why}\n`,
  );
  process.exit(1);
});
