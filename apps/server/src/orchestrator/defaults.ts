// Real port implementations that are small enough to own here (TDM-54), plus the graphile-worker
// JobsPort and the kit-backed TrialSource that trial.execute uses.
//
//   githubIngest        PipelinePort.ingest for `github` sources: packages/kit ingestGitHubRepo
//                       ([4.2]); the RepoIngest is cached for the agent stages (TDM-56). Binary and Claude Code setup sources need uploads ([7.4]) first.
//   naiveSessionCanceller  SessionCanceller over agent_sessions + Naïve `sessions.cancel`.
//   graphileJobsPort    JobsPort on the job's helpers.addJob + graphile_worker._private_jobs.
//   kitTrialSource      trial.execute's TrialSource: the run's kit → TrialJob (trialJobFromKit).
//   billingEstimate     PipelinePort.estimate: packages/billing estimateRunCost ([10.12]).
//   ledgerCharges       the run-terminal billing hook: packages/billing ledger.recordRunCharges.
import { createLedger, estimateRunCost, runFeeForKit } from "@anybench/billing";
import { IngestError, ingestGitHubRepo } from "@anybench/kit";
import type { NaiveClient } from "@anybench/naive";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import type { Database } from "../db/client.js";
import { agentSessions } from "../db/schema/agent_sessions.js";
import type { Config } from "../config.js";
import type { JobsPort, RunChargesHook } from "./advance.js";
import { writeRepoIngestCache } from "./repo-ingest-cache.js";
import {
  isUploadedKitRun,
  stageFail,
  stageHold,
  stageOk,
  type PipelinePort,
  type SessionCanceller,
} from "./ports.js";

// ---------- ingest ----------

function githubInput(github: string, ref: string | undefined): string {
  const path = github
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "");
  return `https://github.com/${path}${ref ? `#${ref}` : ""}`;
}

/**
 * PipelinePort.ingest: GitHub repos for real; other sources hold for their ticket. The whole
 * RepoIngest (digest + repo context) is also cached under the digest hash for the agent stages
 * (repo-ingest-cache.ts, TDM-56); a cache write that fails never fails the ingest.
 */
export function githubIngest(
  opts: { githubToken?: string; ingestCacheDir?: string } = {},
): PipelinePort["ingest"] {
  return async (ctx) => {
    const source = ctx.run.intake.source;
    if (source.kind !== "github") {
      // TODO([7.4] uploads, [4.3]/[4.4] binary and Claude setup ingest): read the upload, ingest it.
      return stageHold(`ingest of a ${source.kind} source is not built yet ([7.4] uploads)`);
    }
    try {
      const result = await ingestGitHubRepo(githubInput(source.github, source.ref), {
        ...(opts.githubToken ? { githubToken: opts.githubToken } : {}),
      });
      await writeRepoIngestCache(result, {
        ...(opts.ingestCacheDir ? { dir: opts.ingestCacheDir } : {}),
      }).catch(() => undefined);
      return stageOk(result.digest);
    } catch (err) {
      if (!(err instanceof IngestError)) throw err;
      // Bad input is the user's to fix; a git hiccup or timeout retries (throw).
      if (err.code === "bad_url" || err.code === "bad_ref" || err.code === "not_a_repo") {
        return stageFail(`ingest: ${err.message}`);
      }
      if (err.code === "too_large" || err.code === "invalid_digest") {
        return stageHold(`ingest: ${err.message}`);
      }
      throw err;
    }
  };
}

// ---------- Naïve sessions ----------

const LIVE_SESSION_STATUSES = ["pending", "queued", "running", "waiting"];

/** Cancel a run's live Naïve sessions and mark their agent_sessions rows cancelled. */
export function naiveSessionCanceller(db: Database, client: NaiveClient): SessionCanceller {
  return {
    async cancelRunSessions(runId) {
      const live = await db
        .select({ id: agentSessions.id, naiveSessionId: agentSessions.naiveSessionId })
        .from(agentSessions)
        .where(
          and(eq(agentSessions.runId, runId), inArray(agentSessions.status, LIVE_SESSION_STATUSES)),
        );
      for (const s of live) {
        // sessions.cancel is idempotent and returns a finished session as-is.
        if (s.naiveSessionId) await client.sessions.cancel(s.naiveSessionId);
        await db
          .update(agentSessions)
          .set({ status: "cancelled", stopReason: "run stopped", updatedAt: sql`now()` })
          .where(eq(agentSessions.id, s.id));
      }
      return live.length;
    },
  };
}

// ---------- graphile-worker ----------

/** A job picked up this recently still counts as pending (it is about to take its lease). */
const JUST_LOCKED_MS = 120_000;

function rowsOf(result: unknown): { key: string }[] {
  return (result as { rows: { key: string }[] }).rows;
}

function isUndefinedTable(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "42P01") return true;
    e = typeof e === "object" && e !== null && "cause" in e ? e.cause : undefined;
  }
  return false;
}

/** JobsPort on graphile-worker: add through the job's helpers, look up pending keys in SQL. */
export function graphileJobsPort(db: Database, addJob: JobHelpers["addJob"]): JobsPort {
  const pendingWhere = sql`locked_at is null and attempts < max_attempts
    or locked_at > now() - (${JUST_LOCKED_MS} * interval '1 millisecond')`;
  async function query(where: ReturnType<typeof sql>): Promise<string[]> {
    try {
      const res = await db.execute(
        sql`select key from graphile_worker._private_jobs where ${where} and (${pendingWhere})`,
      );
      return rowsOf(res).map((r) => r.key);
    } catch (err) {
      if (isUndefinedTable(err)) return []; // graphile schema not installed yet
      throw err;
    }
  }
  return {
    async add(task, payload, spec) {
      await addJob(task, payload, {
        jobKey: spec.jobKey,
        ...(spec.runAt ? { runAt: spec.runAt } : {}),
        ...(spec.maxAttempts ? { maxAttempts: spec.maxAttempts } : {}),
      });
    },
    async pendingKeys(keys) {
      if (keys.length === 0) return new Set();
      const found = new Set<string>();
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        const list = sql.join(
          chunk.map((k) => sql`${k}`),
          sql`, `,
        );
        for (const k of await query(sql`key in (${list})`)) found.add(k);
      }
      return found;
    },
    async pendingKeysWithPrefix(prefix) {
      const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return query(sql`key like ${like}`);
    },
  };
}

// ---------- trial source ----------

// The kit-backed TrialSource lives in trial-source.ts (env image, workspace prep, proxy key).
export { kitTrialSource } from "./trial-source.js";

// ---------- billing ([10.12], TDM-171) ----------

type PricingConfig = Pick<
  Config,
  | "RUN_FEE_MICRO_USD"
  | "UPLOADED_KIT_RUN_FEE_MICRO_USD"
  | "COMPUTE_MARKUP_BPS"
  | "COMPUTER_BLOCK_PRICE_MICRO_USD"
>;

/**
 * PipelinePort.estimate: run fee + projected eval-computer charge for the kit, integer micro-USD.
 * An uploaded kit's run (TDM-218) pays UPLOADED_KIT_RUN_FEE_MICRO_USD instead of the run fee.
 * TODO([6.x] agent sessions on Naïve): our own agents' token spend is not in the estimate yet.
 */
export function billingEstimate(config: PricingConfig): PipelinePort["estimate"] {
  return async (ctx, input) =>
    stageOk(
      estimateRunCost(
        input.kit,
        {
          runFeeMicroUsd: config.RUN_FEE_MICRO_USD,
          uploadedKitRunFeeMicroUsd: config.UPLOADED_KIT_RUN_FEE_MICRO_USD,
          computeMarkupBps: config.COMPUTE_MARKUP_BPS,
          defaultBlockPriceMicroUsd: config.COMPUTER_BLOCK_PRICE_MICRO_USD,
        },
        { kitOrigin: isUploadedKitRun(ctx.run.intake) ? "uploaded" : "generated" },
      ).totalMicroUsd,
    );
}

/**
 * The run-terminal hook: ledger.recordRunCharges (run fee when owed, then every computer).
 * The ledger reads runs.state and runs.cancel_cause itself, so a cancel by us bills nothing.
 * Idempotent: a retried finalize never bills twice.
 */
export function ledgerCharges(db: Database, config: PricingConfig): RunChargesHook {
  const ledger = createLedger(db);
  return {
    recordRunCharges: (input) =>
      ledger.recordRunCharges({
        runId: input.runId,
        userId: input.userId,
        pricing: {
          // TDM-218: no kit-generation fee for an uploaded kit (a zero fee makes no entry).
          runFeeMicroUsd: runFeeForKit(input.kitOrigin, {
            runFeeMicroUsd: config.RUN_FEE_MICRO_USD,
            uploadedKitRunFeeMicroUsd: config.UPLOADED_KIT_RUN_FEE_MICRO_USD,
          }),
          computeMarkupBps: config.COMPUTE_MARKUP_BPS,
        },
      }),
  };
}
