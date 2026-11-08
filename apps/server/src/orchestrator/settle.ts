// Operator settle (worker-hardening): finish a run with the trials it has. Before this, finishing a
// run whose remaining trials an operator stopped meant editing the DB by hand (failed_infra
// attempts set to 3, jobs deleted).
//
//   settleRun(db, runId, ...)   one transaction: every unfinished trial (not done, failed_subject,
//                               cancelled, or failed_infra out of tries) → `cancelled`, failure_class
//                               `operator_settled`, cost 0, lease cleared (a live executor loses it
//                               and stops touching the trial), a trial.phase event each; then
//                               `run.settle` (destroy their computers, revoke their proxy keys) and
//                               `run.advance` are enqueued in the same transaction.
//   run.settle job              destroys the settled trials' computers and wakes run.advance, which
//                               scores the run with the trials that finished.
//
// Billing (plan.md section 8): an operator stop is ours, so those trials bill nothing. A settled
// trial is `cancelled` with cost 0, and packages/billing bills only done / failed_subject trials'
// computers in a delivered or subject-failed run (cancelled ones only in a run the USER cancelled,
// and settle never cancels the run), so none of their compute reaches the ledger.
import {
  AnybenchEventSchema,
  RunIdSchema,
  type AnybenchEvent,
  type EventActor,
  type TrialState,
} from "@anybench/core";
import { createComputerRegistry } from "@anybench/envs";
import type { NaiveProxyKeysApi } from "@anybench/naive";
import type { ComputeProvider } from "@anybench/providers";
import { and, eq, inArray, or } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { computers } from "../db/schema/computers.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import { drizzleComputerStore } from "../lib/computer-store.js";
import { appendEvents } from "../lib/events.js";
import type { JobQueue } from "../lib/job-queue.js";
import { TRIAL_MAX_ATTEMPTS } from "@anybench/bench";

// Not imported from ./advance.js: advance → routes/kits → jobs/run-advance → advance is a cycle
// that a standalone entry (scripts/ops/settle-run.ts) would trip over.
const RUN_ADVANCE_JOB = "run.advance";

/** advance.ts trialSettled: a trial that will not change any more on its own. */
function trialSettled(t: { state: TrialState; attempt: number }): boolean {
  if (t.state === "done" || t.state === "failed_subject" || t.state === "cancelled") return true;
  return t.state === "failed_infra" && t.attempt >= TRIAL_MAX_ATTEMPTS;
}

export const RUN_SETTLE_JOB = "run.settle";
/** failure_class of a trial an operator stopped (never billed). */
export const OPERATOR_SETTLED_FAILURE_CLASS = "operator_settled";

export interface SettledTrial {
  trial_id: string;
  from: TrialState;
}

export type SettleResult =
  | { ok: true; run: typeof runs.$inferSelect; settled: SettledTrial[] }
  | { ok: false; reason: "not_found"; message: string };

/**
 * Settle a run. `db` must be a system (non-tenant) handle: authorize the caller first. Idempotent:
 * a second call settles nothing new and enqueues nothing new (job keys collapse).
 */
export async function settleRun(
  db: Database,
  runId: string,
  opts: { actor: EventActor; reason?: string; jobs: JobQueue },
): Promise<SettleResult> {
  const reason = `operator settled the run${opts.reason ? `: ${opts.reason}` : ""}`;
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update").limit(1);
    if (!run) return { ok: false, reason: "not_found", message: "run not found" };
    const rows = await tx.select().from(trials).where(eq(trials.runId, runId)).for("update");
    const open = rows.filter((t) => !trialSettled(t));
    const at = new Date();
    const evs: AnybenchEvent[] = [];
    for (const t of open) {
      await tx
        .update(trials)
        .set({
          state: "cancelled",
          failureClass: OPERATOR_SETTLED_FAILURE_CLASS,
          endedAt: at,
          costMicroUsd: 0n,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: at,
        })
        .where(eq(trials.id, t.id));
      evs.push(
        AnybenchEventSchema.parse({
          run_id: runId,
          seq: 0,
          type: "trial.phase",
          source: "trial",
          source_id: t.id,
          severity: "warn",
          actor: opts.actor,
          cost_delta_micro_usd: 0n,
          at: at.toISOString(),
          payload: {
            from: t.state,
            to: "cancelled",
            attempt: t.attempt,
            reason,
            failure_class: OPERATOR_SETTLED_FAILURE_CLASS,
          },
        }),
      );
    }
    if (evs.length > 0) await appendEvents(tx, RunIdSchema.parse(runId), evs);
    const stamp = at.getTime();
    await opts.jobs.add(tx, RUN_SETTLE_JOB, { run_id: runId }, { jobKey: `runs:${runId}:settle` });
    await opts.jobs.add(
      tx,
      RUN_ADVANCE_JOB,
      { run_id: runId, reason: "settled" },
      { jobKey: `runs:${runId}:settled:${stamp}` },
    );
    return { ok: true, run, settled: open.map((t) => ({ trial_id: t.id, from: t.state })) };
  });
}

/** What settleRun would settle (dry run), and the run's trial counts by state. */
export async function previewSettle(
  db: Database,
  runId: string,
): Promise<{ wouldSettle: SettledTrial[]; byState: Record<string, number> }> {
  const rows = await db
    .select({ id: trials.id, state: trials.state, attempt: trials.attempt })
    .from(trials)
    .where(eq(trials.runId, runId));
  const byState: Record<string, number> = {};
  for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;
  return {
    wouldSettle: rows
      .filter((t) => !trialSettled(t))
      .map((t) => ({ trial_id: t.id, from: t.state })),
    byState,
  };
}

export interface SettleCleanupDeps {
  db: Database;
  provider: ComputeProvider | null;
  pricePerBlockMicroUsd: bigint;
  /** Naïve proxy keys, to revoke the settled trials' keys. */
  proxyKeys?: NaiveProxyKeysApi | null;
  actor: EventActor;
  logger?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

/** run.settle: destroy the computers of a run's operator-settled trials, revoke their keys. */
export async function cleanupSettledTrials(
  deps: SettleCleanupDeps,
  runId: string,
): Promise<{ destroyed: string[]; failed: string[]; revoked: string[] }> {
  const settled = await deps.db
    .select({
      id: trials.id,
      computerId: trials.computerId,
      proxyKeyId: trials.proxyKeyId,
    })
    .from(trials)
    .where(
      and(
        eq(trials.runId, runId),
        eq(trials.state, "cancelled"),
        eq(trials.failureClass, OPERATOR_SETTLED_FAILURE_CLASS),
      ),
    );
  const out = { destroyed: [] as string[], failed: [] as string[], revoked: [] as string[] };
  if (settled.length === 0) return out;
  const ids = settled.map((t) => t.id);
  const linked = settled.flatMap((t) => (t.computerId ? [t.computerId] : []));
  const live = await deps.db
    .select({ id: computers.id, trialId: computers.trialId })
    .from(computers)
    .where(
      and(
        inArray(computers.status, ["creating", "running", "destroying", "leaked"]),
        linked.length > 0
          ? or(inArray(computers.trialId, ids), inArray(computers.id, linked))
          : inArray(computers.trialId, ids),
      ),
    );
  if (live.length > 0 && !deps.provider) {
    throw new Error("run.settle: no compute provider configured to destroy the settled computers");
  }
  if (deps.provider && live.length > 0) {
    const registry = createComputerRegistry({
      provider: deps.provider,
      store: drizzleComputerStore(deps.db),
      pricing: { pricePerBlockMicroUsd: deps.pricePerBlockMicroUsd },
    });
    for (const c of live) {
      try {
        const d = await registry.destroy(c.id);
        out.destroyed.push(c.id);
        await appendEvents(deps.db, RunIdSchema.parse(runId), [
          AnybenchEventSchema.parse({
            run_id: runId,
            seq: 0,
            type: "computer.destroyed",
            source: "computer",
            source_id: c.id,
            severity: "info",
            actor: deps.actor,
            cost_delta_micro_usd: 0n,
            at: new Date().toISOString(),
            payload: {
              provider: deps.provider.name,
              reason: "operator settled the run",
              ...(c.trialId ? { trial_id: c.trialId } : {}),
              blocks_billed: d.blocksBilled,
            },
          }),
        ]);
      } catch (err) {
        out.failed.push(c.id);
        deps.logger?.warn(
          { err, computerId: c.id },
          "run.settle: destroy failed (the reaper retries)",
        );
        await registry.markLeaked(c.id).catch(() => undefined);
      }
    }
  }
  if (deps.proxyKeys) {
    for (const t of settled) {
      if (!t.proxyKeyId) continue;
      try {
        await deps.proxyKeys.revoke(t.proxyKeyId);
        out.revoked.push(t.proxyKeyId);
      } catch (err) {
        deps.logger?.warn({ err, trialId: t.id }, "run.settle: proxy key revoke failed");
      }
    }
  }
  return out;
}
