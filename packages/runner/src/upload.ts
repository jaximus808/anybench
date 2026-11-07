// Upload of the frozen bundle to our object store through presigned URLs. The runner never holds
// storage keys: it reports the file's size and sha256 to the ingest API, gets an UploadPlan back
// (`ArtifactStore.createUpload` on the server), runs it with `uploadFileWithPlan`, and reports the
// part etags so the server can `completeUpload`.

import { sha256File, uploadFileWithPlan, uploadPlanSchema, type UploadPlan } from "@anybench/envs";
import { z } from "zod";
import { RUNNER_INGEST_ROUTES, ingestUrl, type FetchLike } from "./events.js";
import type { TrialJob } from "./job.js";

/** Body of `POST /v1/trials/:id/uploads`. */
export const UploadPlanRequestSchema = z.object({
  attempt: z.int().positive(),
  name: z.string().min(1),
  size_bytes: z.int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type UploadPlanRequest = z.infer<typeof UploadPlanRequestSchema>;

/** Response of `POST /v1/trials/:id/uploads`. */
export const UploadPlanResponseSchema = z.object({ plan: uploadPlanSchema });

/** Body of `POST /v1/trials/:id/uploads/complete`. */
export const UploadCompleteRequestSchema = z.object({
  attempt: z.int().positive(),
  name: z.string().min(1),
  key: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size_bytes: z.int().nonnegative(),
  upload_id: z.string().min(1).optional(),
  parts: z.array(z.object({ partNumber: z.int().positive(), etag: z.string().nullable() })),
});
export type UploadCompleteRequest = z.infer<typeof UploadCompleteRequestSchema>;

export interface UploadedArtifact {
  name: string;
  key: string;
  sha256: string;
  size_bytes: number;
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${new URL(url).pathname}: HTTP ${res.status}`);
  return text ? (JSON.parse(text) as unknown) : {};
}

/**
 * Upload one file. Uses a pre-made plan from trial.json when there is one for `name`, else asks
 * the ingest API. Returns null when there is no way to get a plan (file-only trial).
 */
export async function uploadArtifact(
  job: TrialJob,
  name: string,
  filePath: string,
  options: { fetch?: FetchLike; allowIngest: boolean },
): Promise<UploadedArtifact | null> {
  const fetchImpl = options.fetch ?? fetch;
  const { sha256, sizeBytes } = await sha256File(filePath);
  if (sizeBytes > job.upload.max_bytes) {
    throw new Error(`${name} is ${sizeBytes} bytes, over the ${job.upload.max_bytes} byte cap`);
  }
  const ingest = options.allowIngest ? job.ingest : null;
  let plan: UploadPlan | undefined = job.upload.plans[name];
  if (!plan) {
    if (!ingest) return null;
    const request: UploadPlanRequest = {
      attempt: job.attempt,
      name,
      size_bytes: sizeBytes,
      sha256,
    };
    const res = await postJson(
      fetchImpl,
      ingestUrl(ingest.url, RUNNER_INGEST_ROUTES.uploads(job.trial_id)),
      ingest.token,
      request,
      ingest.timeout_ms,
    );
    plan = UploadPlanResponseSchema.parse(res).plan;
  }
  const { parts } = await uploadFileWithPlan(plan, filePath, { fetch: fetchImpl });
  if (ingest) {
    const complete: UploadCompleteRequest = {
      attempt: job.attempt,
      name,
      key: plan.key,
      sha256,
      size_bytes: sizeBytes,
      ...(plan.kind === "multipart" ? { upload_id: plan.uploadId } : {}),
      parts,
    };
    await postJson(
      fetchImpl,
      ingestUrl(ingest.url, RUNNER_INGEST_ROUTES.uploadComplete(job.trial_id)),
      ingest.token,
      complete,
      ingest.timeout_ms,
    );
  }
  return { name, key: plan.key, sha256, size_bytes: sizeBytes };
}
