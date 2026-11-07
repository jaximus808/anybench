// Runner ingest routes (plan.md P1 "In-VM runner", tickets 5.1 and 5.2): what the in-VM runner
// (`packages/runner`) posts with its per-trial bearer token. Versioned (`/v1`) because the runner
// binary is baked into VM snapshots and outlives a deploy.
//
// These are the wire schemas. They mirror, field for field, the runner's own schemas merged in
// TDM-46: `RunnerEventBatchSchema` and `RunnerStatusSchema` (packages/runner/src/events.ts,
// status.ts), and `UploadPlanRequestSchema` / `UploadCompleteRequestSchema` (upload.ts). Core
// cannot import the runner, so the contract owns them here; TODO(runner): re-export these from
// `@anybench/core` instead of defining them a second time.
//
// Runner behaviour the ingest must honour (packages/runner/src/events.ts):
// - A batch keeps its `batch_seq` and events across retries. The ingest dedupes on
//   (trial_id, attempt, batch_seq), also sent as `Idempotency-Key: <trial>:<attempt>:<batch_seq>`.
// - 2xx and 409 (a duplicate batch_seq) both count as accepted.
// - Any other 4xx except 408 and 429 is fatal: the runner stops pushing and goes file-only (the
//   worker then polls events.jsonl and status.json by byte offset). 5xx, 408, 429 and network
//   errors are retried with backoff, up to `max_failures` in a row.
// - The runner ignores the response body of every route here.
// - `seq` on each event is the runner's own per-attempt counter; the ingest assigns the run-wide
//   `events.seq` when it writes rows.
import { z } from "zod";
import { TrialIdSchema } from "../ids.js";
import { AnybenchEventSchema } from "../schemas/event.js";
import { defineRoute, defineRoutes } from "./route.js";

// ---------------------------------------------------------------------------------------------
// status.json

/** The runner's phases (status.json `phase`): prepare … done, or stopped at failed / cancelled. */
export const RUNNER_STATUS_PHASES = [
  "prepare",
  "healthcheck",
  "warmup",
  "run",
  "collect",
  "freeze",
  "upload",
  "done",
  "failed",
  "cancelled",
] as const;
export const RunnerStatusPhaseSchema = z.enum(RUNNER_STATUS_PHASES);
export type RunnerStatusPhase = z.infer<typeof RunnerStatusPhaseSchema>;

const datetime = z.iso.datetime({ offset: true });

export const RunnerUploadedArtifactSchema = z.object({
  name: z.string(),
  key: z.string(),
  sha256: z.string(),
  size_bytes: z.int().nonnegative(),
});

/** `~/eval/out/status.json`, as the runner writes it and sends it with every batch. */
export const RunnerStatusWireSchema = z.object({
  trial_id: z.string(),
  run_id: z.string(),
  attempt: z.int().positive(),
  runner_version: z.string(),
  pid: z.int(),
  hostname: z.string(),
  phase: RunnerStatusPhaseSchema,
  trial_state: z.string(),
  started_at: datetime,
  updated_at: datetime,
  heartbeat_at: datetime.nullable(),
  phases: z.array(
    z.object({
      phase: RunnerStatusPhaseSchema,
      started_at: datetime,
      ended_at: datetime.nullable(),
    }),
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
      artifacts: z.array(RunnerUploadedArtifactSchema),
      error: z.string().nullable(),
    })
    .nullable(),
  result: z
    .object({
      outcome: z.enum(["ok", "failed_subject", "failed_infra", "cancelled"]),
      reason: z.string().nullable(),
      failure_class: z.string().nullable(),
    })
    .nullable(),
});
export type RunnerStatusWire = z.infer<typeof RunnerStatusWireSchema>;

// ---------------------------------------------------------------------------------------------
// Event batches

/** Body of `POST /v1/trials/:id/events` (the runner's RunnerEventBatchSchema). */
export const RunnerEventBatchWireSchema = z.object({
  trial_id: z.string().min(1),
  attempt: z.int().positive(),
  /** 0-based, per (trial, attempt); the idempotency key. */
  batch_seq: z.int().nonnegative(),
  events: z.array(AnybenchEventSchema),
  /** The runner's status.json at send time (null only if not yet written). */
  status: RunnerStatusWireSchema.nullable(),
});
export type RunnerEventBatchWire = z.infer<typeof RunnerEventBatchWireSchema>;

/** `<trial_id>:<attempt>:<batch_seq>`; the server checks it matches the body. */
export const RunnerIdempotencyKeySchema = z
  .string()
  .regex(/^[^:\s]+:[1-9]\d*:\d+$/, { error: "expected <trial_id>:<attempt>:<batch_seq>" });

export function runnerIdempotencyKey(trialId: string, attempt: number, batchSeq: number): string {
  return `${trialId}:${attempt}:${batchSeq}`;
}

/** The runner ignores this body; it is for logs and other callers. */
export const RunnerIngestResponseSchema = z.object({
  accepted: z.int().nonnegative(),
  duplicate: z.boolean().optional(),
  cancel_requested: z.boolean().optional(),
});

// ---------------------------------------------------------------------------------------------
// Uploads (the frozen bundle, by presigned URL; the runner never holds storage keys)

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const httpHeaders = z.record(z.string(), z.string());

/** Mirrors `@anybench/envs` storage.ts constants (core cannot import envs). */
export const TRIAL_UPLOAD_MIN_PART_BYTES = 5 * 1024 * 1024;
export const TRIAL_UPLOAD_MAX_PARTS = 10_000;

const planBase = {
  key: z.string().min(1),
  sizeBytes: byteCount,
  sha256,
  maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.iso.datetime(),
};

/**
 * The upload plan, exactly `@anybench/envs` `uploadPlanSchema` (camelCase, as
 * `ArtifactStore.createUpload` returns it and `uploadFileWithPlan` consumes it).
 */
export const TrialUploadPlanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("single"),
    ...planBase,
    method: z.literal("PUT"),
    url: z.url(),
    headers: httpHeaders,
  }),
  z.object({
    kind: z.literal("multipart"),
    ...planBase,
    uploadId: z.string().min(1),
    partSizeBytes: z.number().int().min(TRIAL_UPLOAD_MIN_PART_BYTES),
    parts: z
      .array(
        z.object({
          partNumber: z.number().int().min(1).max(TRIAL_UPLOAD_MAX_PARTS),
          offset: byteCount,
          sizeBytes: byteCount,
          url: z.url(),
          headers: httpHeaders,
        }),
      )
      .min(1)
      .max(TRIAL_UPLOAD_MAX_PARTS),
  }),
]);
export type TrialUploadPlan = z.infer<typeof TrialUploadPlanSchema>;

/** Body of `POST /v1/trials/:id/uploads` (the runner's UploadPlanRequestSchema). */
export const TrialUploadPlanRequestSchema = z.object({
  attempt: z.int().positive(),
  name: z.string().min(1),
  size_bytes: z.int().nonnegative(),
  sha256,
});

/** Body of `POST /v1/trials/:id/uploads/complete` (the runner's UploadCompleteRequestSchema). */
export const TrialUploadCompleteRequestSchema = z.object({
  attempt: z.int().positive(),
  name: z.string().min(1),
  key: z.string().min(1),
  sha256,
  size_bytes: z.int().nonnegative(),
  upload_id: z.string().min(1).optional(),
  parts: z.array(z.object({ partNumber: z.int().positive(), etag: z.string().nullable() })),
});

// ---------------------------------------------------------------------------------------------

const trialParams = z.object({ id: TrialIdSchema });

export const runnerRoutes = defineRoutes({
  ingest: defineRoute({
    id: "runner.ingest",
    method: "POST",
    path: "/v1/trials/:id/events",
    auth: ["runner"],
    summary:
      "Runner ingest: one idempotent batch of AnybenchEvents plus status.json. 409 = duplicate (accepted).",
    params: trialParams,
    headers: z.object({ "idempotency-key": RunnerIdempotencyKeySchema }),
    body: RunnerEventBatchWireSchema,
    response: RunnerIngestResponseSchema,
  }),
  uploads: defineRoute({
    id: "runner.uploads",
    method: "POST",
    path: "/v1/trials/:id/uploads",
    auth: ["runner"],
    summary: "Plan an upload of one frozen artifact (ArtifactStore.createUpload).",
    params: trialParams,
    body: TrialUploadPlanRequestSchema,
    response: z.object({ plan: TrialUploadPlanSchema }),
  }),
  uploadComplete: defineRoute({
    id: "runner.uploadComplete",
    method: "POST",
    path: "/v1/trials/:id/uploads/complete",
    auth: ["runner"],
    summary: "Finish an upload with the part ETags (ArtifactStore.completeUpload).",
    params: trialParams,
    body: TrialUploadCompleteRequestSchema,
    response: z.object({ artifact: RunnerUploadedArtifactSchema }),
  }),
});
