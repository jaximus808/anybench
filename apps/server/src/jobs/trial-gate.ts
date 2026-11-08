// trial.gate (TDM-51 [5.6], plan.md sections 5 and 17.2 rule 5): score one trial's frozen outputs
// on a fresh scoring computer and record the verdicts.
//
//   collecting → gating (this job) → runGates (packages/bench gate.ts) → trials.gate + trial.gate
//   events → reviewing (the kit has reviewed requirements) or done.
//
// Integrity: this job is the ONLY writer of trials.gate and of `trial.gate` events. The verdicts
// come from the worker reading the scoring computer through the provider. Nothing a runner token
// can reach writes them (the agent under test can read that token; the runner ingest refuses
// `trial.gate`). The scoring computer gets only gates/ and reference/ from the kit, never the
// contender, and it is never forked from a snapshot that held a subject.
//
// Idempotent: a trial not in collecting/gating, or on another attempt, is left alone. The verdict,
// the state change and the events commit in one transaction guarded by `state = 'gating'`, so a
// retried job never writes twice. Infra trouble (GateInfraError: computer, download, setup) throws,
// so graphile-worker retries; it is never recorded as a contender failure.
//
// Enqueue with `trialGateJobKey(trialId, attempt)` (the trial executor, [5.4], does this after
// `collecting`).
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
import { defineJob, type JobContext } from "./types.js";

export const TRIAL_GATE_JOB = "trial.gate";

export const TrialGatePayloadSchema = z.object({
  trialId: z.uuid(),
  attempt: z.int().positive(),
});
export type TrialGatePayload = z.infer<typeof TrialGatePayloadSchema>;

/** job_key for trial.gate. Distinct from trial.execute's `trials:<id>:<attempt>`. */
export function trialGateJobKey(trialId: string, attempt: number): string {
  return `trials:${trialId}:${attempt}:gate`;
}

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
}

export type GateTrialReport =
  | { outcome: "skipped"; reason: string }
  | { outcome: "scored"; to: TrialState; record: TrialGateRecord };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventDraft = DistributiveOmit<AnybenchEvent, "seq" | "run_id">;

function toEvents(runId: string, drafts: EventDraft[]): AnybenchEvent[] {
  const run = RunIdSchema.parse(runId);
  return drafts.map((d) => AnybenchEventSchema.parse({ ...d, run_id: run, seq: 0 }));
}

/** Score one trial. See the file header. */
export async function gateTrial(
  deps: GateTrialDeps,
  payload: TrialGatePayload,
): Promise<GateTrialReport> {
  const now = deps.now ?? (() => new Date());
  const actor = { kind: "worker" as const, id: deps.workerId };
  const [trial] = await deps.db.select().from(trials).where(eq(trials.id, payload.trialId));
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

  // The kit: its gates, and whether a reviewer comes next.
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, trial.runId));
  if (!run?.kitId) throw new Error(`trial ${trial.id}: run ${trial.runId} has no kit`);
  const [kit] = await deps.db.select().from(kits).where(eq(kits.id, run.kitId));
  if (!kit) throw new Error(`trial ${trial.id}: kit ${run.kitId} not found`);
  const spec = safeParseKitSpec(kit.spec);
  if (!spec.success) {
    throw new Error(`kit ${kit.id} does not validate: ${spec.errors.join("; ")}`);
  }
  const gates = spec.data.gates;
  const reviewed = spec.data.requirements.some((r) => r.type === "reviewed");

  // collecting → gating (the executor may already have done it).
  if (trial.state === "collecting") {
    const t = transitionTrial("collecting", { type: "advance" });
    if (!t.ok) throw new Error(t.error.message);
    await deps.db.transaction(async (tx) => {
      const moved = await tx
        .update(trials)
        .set({ state: "gating", updatedAt: now() })
        .where(and(eq(trials.id, trial.id), eq(trials.state, "collecting")))
        .returning({ id: trials.id });
      if (moved.length === 0) return;
      await appendEvents(
        tx,
        RunIdSchema.parse(trial.runId),
        toEvents(trial.runId, [
          {
            type: "trial.phase",
            source: "trial",
            source_id: trial.id,
            severity: "info",
            actor,
            cost_delta_micro_usd: 0n,
            at: now().toISOString(),
            payload: { from: "collecting", to: "gating", attempt: trial.attempt },
          },
        ]),
      );
    });
  }

  // Every snapshot a subject trial of this run ran on: the scoring computer may not fork one.
  const subjectSnaps = await deps.db
    .selectDistinct({ snapshotId: computers.snapshotId })
    .from(trials)
    .innerJoin(computers, eq(trials.computerId, computers.id))
    .where(and(eq(trials.runId, trial.runId), isNotNull(computers.snapshotId)));

  const scoring = gates.length > 0 ? await deps.kitFiles.scoringFiles(kit, gates) : [];
  const frozen: FrozenOutputs =
    gates.length > 0
      ? await deps.frozen.frozen(trial.runId, trial.id)
      : { kind: "missing", reason: "kit has no gates" };

  const record = await (deps.runGates ?? runGates)(
    {
      runId: trial.runId,
      trialId: trial.id,
      workloadId: trial.workloadId,
      gates,
      frozen,
      scoring,
      ...(deps.profile ? { profile: deps.profile } : {}),
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

  const command = reviewed ? ({ type: "advance" } as const) : ({ type: "skip_review" } as const);
  const t = transitionTrial("gating", command);
  if (!t.ok) throw new Error(t.error.message);
  const failedApplicable = Object.values(record.gates).some(
    (o) => o.result.applicable && !o.result.pass,
  );
  const at = now();

  const wrote = await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(trials)
      .set({
        gate: record,
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
    const drafts: EventDraft[] = Object.entries(record.gates).map(([gateId, o]) => ({
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
          sandbox: record.sandbox,
          scoring_computer_id: record.scoring_computer?.computer_id ?? null,
        },
      },
    }));
    drafts.push({
      type: "trial.phase",
      source: "trial",
      source_id: trial.id,
      severity: "info",
      actor,
      cost_delta_micro_usd: 0n,
      at: at.toISOString(),
      payload: { from: "gating", to: t.to, attempt: trial.attempt },
    });
    await appendEvents(tx, RunIdSchema.parse(trial.runId), toEvents(trial.runId, drafts));
    return true;
  });
  if (!wrote) return { outcome: "skipped", reason: "trial left gating while it was scored" };
  deps.logger?.info(
    { trialId: trial.id, to: t.to, gates: Object.keys(record.gates).length, failedApplicable },
    "trial gated",
  );
  return { outcome: "scored", to: t.to, record };
}

// ---------------------------------------------------------------------------------------------
// Job

export interface TrialGateJobOptions {
  /** The scoring provider. TODO([3.1]/[5.9]): a provider factory from config. */
  provider?: (ctx: JobContext) => ComputeProvider | null;
  /** Presigned downloads (ArtifactStore). */
  artifacts?: (ctx: JobContext) => ArtifactDownloads | null;
  kitFiles?: KitFilesPort;
  /** TODO([3.9] VM profiles): the scoring profile snapshot. Default: a fresh base computer. */
  profile?: (ctx: JobContext) => ScoringProfileInput | undefined;
  sandbox?: GateSandbox;
  gateOptions?: GateTrialDeps["gateOptions"];
  runGates?: typeof runGates;
}

export function createTrialGateJob(options: TrialGateJobOptions = {}) {
  return defineJob({
    name: TRIAL_GATE_JOB,
    payload: TrialGatePayloadSchema,
    async run(payload, ctx) {
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
          logger: ctx.logger,
          workerId: ctx.workerId,
        },
        payload,
      );
      if (report.outcome === "skipped") {
        ctx.logger.info({ job: TRIAL_GATE_JOB, ...payload, reason: report.reason }, "skipped");
      }
    },
  });
}

export const trialGateJob = createTrialGateJob();
