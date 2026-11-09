// ~/eval/out/status.json: the runner's current phase and result. Rewritten atomically (tmp +
// rename) so a worker reading it with fs/read never sees half a document. When egress is blocked
// this file and events.jsonl are the only channel back to the worker.

import { rename, writeFile } from "node:fs/promises";
import type { TrialState } from "@anybench/core";
import { z } from "zod";

/** Runner phases, in order (plan.md P1 "In-VM runner"). */
export const RUNNER_PHASES = [
  "prepare",
  "healthcheck",
  "warmup",
  "run",
  "collect",
  "freeze",
  "upload",
  "done",
] as const;

/** Where a runner can stop instead of `done`. */
export const RUNNER_FAILURE_PHASES = ["failed", "cancelled"] as const;

export const RunnerPhaseSchema = z.enum([...RUNNER_PHASES, ...RUNNER_FAILURE_PHASES]);
export type RunnerPhase = z.infer<typeof RunnerPhaseSchema>;

export function isFinalRunnerPhase(phase: RunnerPhase): boolean {
  return phase === "done" || phase === "failed" || phase === "cancelled";
}

/**
 * Runner phase → `trials.state`. prepare and healthcheck happen while the worker still has the
 * trial in `installing`; collect, freeze and upload are `collecting`. `gating` belongs to the
 * scoring computer, so the runner never leaves `collecting` on the happy path.
 */
export const TRIAL_STATE_BY_RUNNER_PHASE = {
  prepare: "installing",
  healthcheck: "installing",
  warmup: "warming",
  run: "running",
  collect: "collecting",
  freeze: "collecting",
  upload: "collecting",
  done: "collecting",
} as const satisfies Record<(typeof RUNNER_PHASES)[number], TrialState>;

export const RunnerOutcomeSchema = z.enum(["ok", "failed_subject", "failed_infra", "cancelled"]);
export type RunnerOutcome = z.infer<typeof RunnerOutcomeSchema>;

const datetime = z.iso.datetime({ offset: true });

export const UploadedArtifactSchema = z.object({
  name: z.string(),
  key: z.string(),
  sha256: z.string(),
  size_bytes: z.int().nonnegative(),
  url: z.string().optional(),
});

export const RunnerStatusSchema = z.object({
  trial_id: z.string(),
  run_id: z.string(),
  attempt: z.int().positive(),
  runner_version: z.string(),
  pid: z.int(),
  hostname: z.string(),
  phase: RunnerPhaseSchema,
  /** The `trials.state` this phase corresponds to (the last one reported in a trial.phase event). */
  trial_state: z.string(),
  started_at: datetime,
  updated_at: datetime,
  heartbeat_at: datetime.nullable(),
  phases: z.array(
    z.object({ phase: RunnerPhaseSchema, started_at: datetime, ended_at: datetime.nullable() }),
  ),
  push: z.object({
    mode: z.enum(["push", "file_only"]),
    sent_batches: z.int().nonnegative(),
    failed_posts: z.int().nonnegative(),
    last_error: z.string().nullable(),
  }),
  events: z.object({ count: z.int().nonnegative(), bytes: z.int().nonnegative() }),
  run: z
    .object({
      exit_code: z.int().nullable(),
      signal: z.string().nullable(),
      duration_ms: z.int().nonnegative(),
      timed_out: z.boolean(),
    })
    .nullable(),
  upload: z
    .object({
      state: z.enum(["skipped", "uploaded", "failed"]),
      artifacts: z.array(UploadedArtifactSchema),
      error: z.string().nullable(),
    })
    .nullable(),
  result: z
    .object({
      outcome: RunnerOutcomeSchema,
      reason: z.string().nullable(),
      failure_class: z.string().nullable(),
    })
    .nullable(),
  /** Live log chunks per stream (present only when trial.json turns them on). */
  log_chunks: z
    .record(
      z.string(),
      z.object({
        segments: z.int().nonnegative(),
        bytes: z.int().nonnegative(),
        state: z.enum(["live", "off"]),
        error: z.string().nullable(),
      }),
    )
    .optional(),
  /** BYOK token cap (present only when trial.json sets one). Money as decimal micro-USD strings. */
  token_cap: z
    .object({
      cap_micro_usd: z.string(),
      spent_micro_usd: z.string(),
      /** TDM-231: the safety margin on the unreported estimate the cap check adds. */
      margin_micro_usd: z.string().optional(),
      source: z.string(),
      exceeded: z.boolean(),
    })
    .optional(),
});
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;

/** Atomic JSON write: tmp file in the same directory, then rename. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, path);
}
