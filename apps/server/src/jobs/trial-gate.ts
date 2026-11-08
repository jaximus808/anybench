// trial.gate (TDM-51 [5.6], plan.md sections 5 and 17.2 rule 5): score one trial's frozen outputs
// on a fresh scoring computer and record the verdicts.
//
//   collecting → gating (this job) → runGates (packages/bench gate.ts) → trials.gate + trial.gate
//   events → reviewing (the kit has reviewed requirements) or done.
//
// Integrity: this job is the ONLY writer of trials.gate and of `trial.gate` events. The verdicts
// come from the worker reading the scoring computer through the provider. Nothing a runner token
// can reach writes them (the agent under test can read that token; the runner ingest refuses
// `trial.gate`). The scoring computer gets gates/, reference/ and workloads/ from the kit, never
// the contender, and it is never forked from a snapshot that held a subject.
//
// Metrics: the verdict's update also writes trials.metrics and trials.cost_micro_usd
// (orchestrator/trial-metrics.ts): the worker's wall clock (running → collecting), the passing
// gates' metric rows (api_p95_ms) and the attempt's Naïve proxy spend on top of the compute share.
// Same transaction as `done`, so the run never scores a trial without them.
//
// Idempotent: a trial not in collecting/gating, or on another attempt, is left alone. The verdict,
// the state change and the events commit in one transaction guarded by `state = 'gating'`, so a
// retried job never writes twice.
//
// Our failures are never billed to the contender, and the contender never gets a free re-roll (see
// gateTrial): only what is provable without its outputs is ours (missing bundle, GateInfraError
// past GATE_INFRA_MAX_ATTEMPTS job runs, a kit that doesn't load) → failed_infra, failure_class
// infra | kit. A check that broke on the outputs is the contender's FAIL plus `trial.kit_suspect`.
//
// Enqueue with payload `{trial_id, attempt}` and job key `trialGateJobKey(trialId, attempt)` (the
// trial executor, [5.4] TDM-49, does this after `collecting`). TRIAL_GATE_JOB, trialGateJobKey and
// TrialGatePayloadSchema are defined once, in trial-execute.ts, and re-exported here.
import { fileURLToPath } from "node:url";
import {
  AnybenchEventSchema,
  RunIdSchema,
  safeParseKitSpec,
  transitionTrial,
  type AnybenchEvent,
  type Gate,
  type TrialState,
} from "@anybench/core";
import {
  collectScoringFiles,
  FROZEN_BUNDLE_NAME,
  classifyGateRecord,
  GateInfraError,
  GateKitError,
  runGates,
  type FrozenOutputs,
  type GateRunDeps,
  type GateSandbox,
  type ScoringFile,
  type ScoringProfileInput,
  type TrialGateRecord,
} from "@anybench/bench";
import {
  ArtifactTransferError,
  createComputerRegistry,
  type ComputerRegistry,
  type DownloadTicket,
} from "@anybench/envs";
import type { ProxySpendSource } from "@anybench/naive";
import type { ComputeProvider } from "@anybench/providers";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { computers } from "../db/schema/computers.js";
import { kits } from "../db/schema/kits.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import { drizzleComputerStore } from "../lib/computer-store.js";
import { appendEvents } from "../lib/events.js";
import type { Logger } from "../lib/logger.js";
import { TRIAL_GATE_JOB, TrialGatePayloadSchema, trialGateJobKey } from "./trial-execute.js";
import {
  artifactStoreFromEnv,
  computeProviderFromConfig,
  proxyDepsFromConfig,
} from "../lib/compute.js";
import { attemptProxySpend, trialMetrics, trialPhaseEdges } from "../orchestrator/trial-metrics.js";
import { defineJob, type JobContext } from "./types.js";

export { TRIAL_GATE_JOB, TrialGatePayloadSchema, trialGateJobKey };

/**
 * Job runs that may hit GateInfraError (our computer, download, setup) before the trial is
 * failed_infra (failure_class infra: retried by the executor, never billed). Bounds how many
 * scoring computers one trial can cost.
 */
export const GATE_INFRA_MAX_ATTEMPTS = 3;
export type TrialGatePayload = z.infer<typeof TrialGatePayloadSchema>;

// ---------------------------------------------------------------------------------------------
// Ports

/** Where the trial's frozen bundle comes from. */
export interface FrozenOutputsPort {
  frozen(runId: string, trialId: string): Promise<FrozenOutputs>;
}

/** The part of @anybench/envs ArtifactStore this job uses. */
export interface ArtifactDownloads {
  createDownload(input: {
    runId: string;
    trialId: string;
    name: string;
    expiresInSec?: number;
  }): Promise<DownloadTicket>;
}

/** Presigned GET of `runs/<run>/trials/<trial>/out.tar.gz`; a missing object fails closed. */
export function artifactFrozenOutputs(store: ArtifactDownloads): FrozenOutputsPort {
  return {
    async frozen(runId, trialId) {
      try {
        const t = await store.createDownload({
          runId,
          trialId,
          name: FROZEN_BUNDLE_NAME,
          expiresInSec: 3600,
        });
        return { kind: "url", url: t.url, sha256: t.sha256, sizeBytes: t.sizeBytes };
      } catch (err) {
        if (err instanceof ArtifactTransferError && err.code === "not_found") {
          return { kind: "missing", reason: `${FROZEN_BUNDLE_NAME} is not in the artifact store` };
        }
        throw err;
      }
    },
  };
}

/** The kit's scoring bundle (gates/ + reference/). */
export interface KitFilesPort {
  scoringFiles(
    kit: { id: string; filesUrl: string | null },
    gates: readonly Gate[],
  ): Promise<ScoringFile[]>;
}

/**
 * Local-first worker: `kits.files_url` is a `file://` directory on the worker host.
 * TODO([16.2] subject/scoring bundle split): read a stored scoring bundle instead.
 */
export const localKitFiles: KitFilesPort = {
  async scoringFiles(kit, gates) {
    if (!kit.filesUrl?.startsWith("file://")) {
      throw new Error(
        `kit ${kit.id}: files_url ${kit.filesUrl ?? "(none)"} is not a file:// directory; no scoring bundle source`,
      );
    }
    return collectScoringFiles(fileURLToPath(kit.filesUrl), gates);
  },
};

/**
 * The run's scoring image (env_build: the base recipes only, never a subject file), from
 * stage_outputs.env.detail.scoring_snapshot_id. Null: a fresh base computer.
 */
export function scoringSnapshotOf(stageOutputs: unknown): string | null {
  const id = (stageOutputs as { env?: { detail?: { scoring_snapshot_id?: unknown } } } | null)?.env
    ?.detail?.scoring_snapshot_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

// ---------------------------------------------------------------------------------------------
// The work

export interface GateTrialDeps {
  db: Database;
  registry: ComputerRegistry;
  frozen: FrozenOutputsPort;
  kitFiles: KitFilesPort;
  profile?: ScoringProfileInput;
  sandbox?: GateSandbox;
  /** Passed through to runGates (poll interval, timeouts). */
  gateOptions?: Pick<GateRunDeps, "pollIntervalMs" | "readyTimeoutMs" | "graceMs" | "sleep">;
  logger?: Pick<Logger, "info" | "warn">;
  workerId: string;
  now?: () => Date;
  /** Injectable for tests; defaults to @anybench/bench runGates. */
  runGates?: typeof runGates;
  /** This job run's attempt (graphile `job.attempts`, 1-based). Default 1. */
  infraAttempt?: number;
  /** Default GATE_INFRA_MAX_ATTEMPTS. */
  maxInfraAttempts?: number;
  /**
   * The Naïve credits ledger (liveLedgerSpend) for the attempt's proxy-key spend. Without it a
   * trial that had a proxy key records `proxy_cost_missing` and its cost stays unscored.
   */
  proxySpend?: ProxySpendSource | null;
}

export type GateTrialReport =
  | { outcome: "skipped"; reason: string }
  | { outcome: "scored"; to: TrialState; record: TrialGateRecord }
  | {
      outcome: "failed_infra";
      failureClass: "infra" | "kit";
      reason: string;
      record: TrialGateRecord | null;
    };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventDraft = DistributiveOmit<AnybenchEvent, "seq" | "run_id">;

function toEvents(runId: string, drafts: EventDraft[]): AnybenchEvent[] {
  const run = RunIdSchema.parse(runId);
  return drafts.map((d) => AnybenchEventSchema.parse({ ...d, run_id: run, seq: 0 }));
}

/**
 * Score one trial. See the file header.
 *
 * Who pays for a failure:
 *   - the contender: every gate outcome once its outputs were scored → done/reviewing with
 *     failure_class "gate" when an applicable gate failed (billable, never a pass). That includes
 *     a check that broke on the contender's outputs (GateOutcome.kit_suspect): those also get a
 *     `trial.kit_suspect` event for a refund by hand, never an unbilled re-run (a contender could
 *     provoke a fragile check on purpose);
 *   - us, only for what is provable without the contender's outputs: no out.tar.gz in the store,
 *     GateInfraError past GATE_INFRA_MAX_ATTEMPTS → failed_infra, failure_class "infra"; a kit that
 *     doesn't load or a GateKitError (raised before any output is touched) → failed_infra,
 *     failure_class "kit". failed_infra is retried by the executor and never billed.
 */
export async function gateTrial(
  deps: GateTrialDeps,
  payload: TrialGatePayload,
): Promise<GateTrialReport> {
  const now = deps.now ?? (() => new Date());
  const actor = { kind: "worker" as const, id: deps.workerId };
  const [trial] = await deps.db.select().from(trials).where(eq(trials.id, payload.trial_id));
  if (!trial) return { outcome: "skipped", reason: "no such trial" };
  if (trial.attempt !== payload.attempt) {
    return {
      outcome: "skipped",
      reason: `stale attempt ${payload.attempt} (trial is on ${trial.attempt})`,
    };
  }
  if (trial.state !== "collecting" && trial.state !== "gating") {
    return { outcome: "skipped", reason: `trial is ${trial.state}, not collecting or gating` };
  }
  const runId = RunIdSchema.parse(trial.runId);
  const phase = (from: TrialState, to: TrialState, at: Date, extra: object = {}): EventDraft => ({
    type: "trial.phase",
    source: "trial",
    source_id: trial.id,
    severity: to === "failed_infra" ? "warn" : "info",
    actor,
    cost_delta_micro_usd: 0n,
    at: at.toISOString(),
    payload: { from, to, attempt: trial.attempt, ...extra },
  });

  // collecting → gating (the executor may already have done it).
  if (trial.state === "collecting") {
    const t = transitionTrial("collecting", { type: "advance" });
    if (!t.ok) throw new Error(t.error.message);
    await deps.db.transaction(async (tx) => {
      const at = now();
      const moved = await tx
        .update(trials)
        .set({ state: "gating", updatedAt: at })
        .where(
          and(
            eq(trials.id, trial.id),
            eq(trials.state, "collecting"),
            eq(trials.attempt, payload.attempt),
          ),
        )
        .returning({ id: trials.id });
      if (moved.length === 0) return;
      await appendEvents(tx, runId, toEvents(trial.runId, [phase("collecting", "gating", at)]));
    });
  }

  /** gating → failed_infra (our fault: never billed, retried by the executor). */
  async function failInfra(
    failureClass: "infra" | "kit",
    reason: string,
    record: TrialGateRecord | null,
  ): Promise<GateTrialReport> {
    const t = transitionTrial("gating", {
      type: "fail_infra",
      reason,
      failure_class: failureClass,
    });
    if (!t.ok) throw new Error(t.error.message);
    const at = now();
    const wrote = await deps.db.transaction(async (tx) => {
      const updated = await tx
        .update(trials)
        .set({
          state: "failed_infra",
          failureClass,
          updatedAt: at,
          endedAt: at,
          ...(record ? { gate: record } : {}),
        })
        .where(
          and(
            eq(trials.id, trial!.id),
            eq(trials.state, "gating"),
            eq(trials.attempt, payload.attempt),
          ),
        )
        .returning({ id: trials.id });
      if (updated.length === 0) return false;
      await appendEvents(
        tx,
        runId,
        toEvents(trial!.runId, [
          phase("gating", "failed_infra", at, { reason, failure_class: failureClass }),
        ]),
      );
      return true;
    });
    if (!wrote) return { outcome: "skipped", reason: "trial left gating while it was scored" };
    deps.logger?.warn(
      { trialId: trial!.id, failureClass, reason },
      "trial.gate: failed_infra (not the contender's fault)",
    );
    return { outcome: "failed_infra", failureClass, reason, record };
  }

  // The kit: its gates, and whether a reviewer comes next.
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, trial.runId));
  const [kit] = run?.kitId
    ? await deps.db.select().from(kits).where(eq(kits.id, run.kitId))
    : [undefined];
  if (!kit) return failInfra("kit", `run ${trial.runId} has no kit`, null);
  const spec = safeParseKitSpec(kit.spec);
  if (!spec.success) {
    return failInfra("kit", `kit ${kit.id} does not validate: ${spec.errors.join("; ")}`, null);
  }
  const gates = spec.data.gates;
  const reviewed = spec.data.requirements.some((r) => r.type === "reviewed");

  // Every snapshot a subject trial of this run ran on: the scoring computer may not fork one.
  const subjectSnaps = await deps.db
    .selectDistinct({ snapshotId: computers.snapshotId })
    .from(trials)
    .innerJoin(computers, eq(trials.computerId, computers.id))
    .where(and(eq(trials.runId, trial.runId), isNotNull(computers.snapshotId)));

  let record: TrialGateRecord;
  try {
    const scoring = gates.length > 0 ? await deps.kitFiles.scoringFiles(kit, gates) : [];
    const frozen: FrozenOutputs =
      gates.length > 0
        ? await deps.frozen.frozen(trial.runId, trial.id)
        : { kind: "missing", reason: "kit has no gates" };
    // No bundle at gate time is our storage/upload failure, never the contender's FAIL.
    if (gates.length > 0 && frozen.kind === "missing") {
      return failInfra("infra", `no frozen outputs: ${frozen.reason}`, null);
    }
    record = await (deps.runGates ?? runGates)(
      {
        runId: trial.runId,
        trialId: trial.id,
        workloadId: trial.workloadId,
        gates,
        frozen,
        scoring,
        ...(deps.profile
          ? { profile: deps.profile }
          : scoringSnapshotOf(run?.stageOutputs)
            ? { profile: { snapshotId: scoringSnapshotOf(run?.stageOutputs)! } }
            : {}),
        subjectSnapshotIds: subjectSnaps.flatMap((r) => (r.snapshotId ? [r.snapshotId] : [])),
      },
      {
        registry: deps.registry,
        ...(deps.sandbox ? { sandbox: deps.sandbox } : {}),
        ...deps.gateOptions,
        ...(deps.logger ? { logger: deps.logger } : {}),
        now,
      },
    );
  } catch (err) {
    if (err instanceof GateKitError) return failInfra("kit", err.message, null);
    if (err instanceof GateInfraError) {
      const tries = deps.infraAttempt ?? 1;
      const max = deps.maxInfraAttempts ?? GATE_INFRA_MAX_ATTEMPTS;
      if (tries >= max) {
        return failInfra("infra", `scoring failed ${tries} times: ${err.message}`, null);
      }
    }
    throw err;
  }

  // No reviewer job exists yet ([6.x] reviewer): a trial parked in `reviewing` never leaves it and
  // the run never scores. Until it ships, every trial skips review; reviewed requirements stay
  // unscored and drop out of the verdict family (proof-score already treats them that way).
  void reviewed;
  const command = { type: "skip_review" } as const;
  const t = transitionTrial("gating", command);
  if (!t.ok) throw new Error(t.error.message);
  const { failureClass, kitSuspects } = classifyGateRecord(record);
  const failedApplicable = failureClass !== null;
  const scored = record;
  // Before the transaction: a ledger read (never throws) and the worker's own phase edges.
  const proxy = await attemptProxySpend(deps.proxySpend, trial);
  if (proxy.status === "missing") {
    deps.logger?.warn(
      { trialId: trial.id, reason: proxy.reason },
      "trial.gate: proxy spend unknown; cost stays unscored",
    );
  }
  const edges = (await trialPhaseEdges(deps.db, trial.runId, [trial.id])).get(trial.id) ?? [];
  const measured = trialMetrics({
    attempt: trial.attempt,
    existing: trial.metrics,
    costMicroUsd: trial.costMicroUsd,
    edges,
    gate: scored,
    proxy,
  });
  const at = now();

  const wrote = await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(trials)
      .set({
        gate: scored,
        metrics: measured.metrics,
        costMicroUsd: measured.costMicroUsd,
        state: t.to,
        updatedAt: at,
        ...(failedApplicable ? { failureClass: "gate" } : {}),
        ...(t.to === "done" ? { endedAt: at } : {}),
      })
      .where(
        and(
          eq(trials.id, trial.id),
          eq(trials.state, "gating"),
          eq(trials.attempt, payload.attempt),
        ),
      )
      .returning({ id: trials.id });
    if (updated.length === 0) return false;
    const drafts: EventDraft[] = Object.entries(scored.gates).map(([gateId, o]) => ({
      type: "trial.gate",
      source: "trial",
      source_id: trial.id,
      severity: o.result.pass || !o.result.applicable ? "info" : "warn",
      actor,
      cost_delta_micro_usd: 0n,
      at: at.toISOString(),
      payload: {
        gate: gateId,
        passed: o.result.pass,
        summary: o.result.reason,
        details: {
          applicable: o.result.applicable,
          status: o.status,
          exit_code: o.exit_code,
          timed_out: o.timed_out,
          duration_ms: o.duration_ms,
          evidence: o.result.evidence,
          kit_suspect: o.kit_suspect,
          sandbox: scored.sandbox,
          scoring_computer_id: scored.scoring_computer?.computer_id ?? null,
        },
      },
    }));
    for (const k of kitSuspects) {
      drafts.push({
        type: "trial.kit_suspect",
        source: "trial",
        source_id: trial.id,
        severity: "warn",
        actor,
        cost_delta_micro_usd: 0n,
        at: at.toISOString(),
        payload: { gate: k.gate, status: k.status, reason: k.reason },
      });
    }
    drafts.push(phase("gating", t.to, at));
    await appendEvents(tx, runId, toEvents(trial.runId, drafts));
    return true;
  });
  if (!wrote) return { outcome: "skipped", reason: "trial left gating while it was scored" };
  deps.logger?.info(
    { trialId: trial.id, to: t.to, gates: Object.keys(scored.gates).length, failedApplicable },
    "trial gated",
  );
  return { outcome: "scored", to: t.to, record: scored };
}

// ---------------------------------------------------------------------------------------------
// Job

export interface TrialGateJobOptions {
  /** The scoring provider (production: the trials' provider, lib/compute.ts). */
  provider?: (ctx: JobContext) => ComputeProvider | null;
  /** Presigned downloads (ArtifactStore). */
  artifacts?: (ctx: JobContext) => ArtifactDownloads | null;
  kitFiles?: KitFilesPort;
  /** TODO([3.9] VM profiles): the scoring profile snapshot. Default: a fresh base computer. */
  profile?: (ctx: JobContext) => ScoringProfileInput | undefined;
  sandbox?: GateSandbox;
  gateOptions?: GateTrialDeps["gateOptions"];
  runGates?: typeof runGates;
  /** The attempt's proxy-key spend (production: the Naïve credits ledger). */
  proxySpend?: (ctx: JobContext) => ProxySpendSource | null;
}

export function createTrialGateJob(options: TrialGateJobOptions = {}) {
  return defineJob({
    name: TRIAL_GATE_JOB,
    payload: TrialGatePayloadSchema,
    async run(payload, ctx, helpers) {
      const provider = options.provider?.(ctx) ?? null;
      const artifacts = options.artifacts?.(ctx) ?? null;
      if (!provider || !artifacts) {
        // Throw, never pass: an unscored trial must stay visibly stuck in gating.
        throw new Error(
          `trial.gate: no scoring ${provider ? "artifact store" : "provider"} configured`,
        );
      }
      const registry = createComputerRegistry({
        provider,
        store: drizzleComputerStore(ctx.db),
        pricing: { pricePerBlockMicroUsd: ctx.config.COMPUTER_BLOCK_PRICE_MICRO_USD },
      });
      const profile = options.profile?.(ctx);
      const report = await gateTrial(
        {
          db: ctx.db,
          registry,
          frozen: artifactFrozenOutputs(artifacts),
          kitFiles: options.kitFiles ?? localKitFiles,
          ...(profile ? { profile } : {}),
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
          ...(options.gateOptions ? { gateOptions: options.gateOptions } : {}),
          ...(options.runGates ? { runGates: options.runGates } : {}),
          proxySpend: options.proxySpend?.(ctx) ?? null,
          logger: ctx.logger,
          workerId: ctx.workerId,
          infraAttempt: helpers.job.attempts,
        },
        payload,
      );
      if (report.outcome === "skipped") {
        ctx.logger.info({ job: TRIAL_GATE_JOB, ...payload, reason: report.reason }, "skipped");
      }
    },
  });
}

/** Production wiring: the scoring computer on the same provider as the trials, bundles from S3. */
export const trialGateJob = createTrialGateJob({
  provider: (ctx) => computeProviderFromConfig(ctx.config),
  artifacts: () => artifactStoreFromEnv(),
  proxySpend: (ctx) => proxyDepsFromConfig(ctx.config)?.spend ?? null,
});
