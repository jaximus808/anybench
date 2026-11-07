// Uploads (plan.md P2 inputs): a binary, its docs, or a Claude Code setup goes straight to object
// storage by presigned PUT; the API only hands out the plan and records completion. Ticket 7.4.
import { z } from "zod";
import { IsoDateTimeSchema, uuidSchema } from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";

export const UploadIdSchema = uuidSchema<"UploadId">();
export type UploadId = z.output<typeof UploadIdSchema>;

export const UPLOAD_PURPOSES = ["binary", "docs", "claude_setup", "kit"] as const;
export const UploadPurposeSchema = z.enum(UPLOAD_PURPOSES);

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, { error: "sha256 must be 64 lowercase hex" });
const ByteCountSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const HeadersSchema = z.record(z.string(), z.string());

/** Same shape as `@anybench/envs` UploadPlan, in snake_case for the wire. */
export const UploadPlanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("single"),
    method: z.literal("PUT"),
    url: z.url(),
    headers: HeadersSchema,
  }),
  z.object({
    kind: z.literal("multipart"),
    part_size_bytes: ByteCountSchema,
    parts: z
      .array(
        z.object({
          part_number: z.int().min(1).max(10_000),
          offset: ByteCountSchema,
          size_bytes: ByteCountSchema,
          url: z.url(),
          headers: HeadersSchema,
        }),
      )
      .min(1),
  }),
]);

export const UploadSchema = z.object({
  id: UploadIdSchema,
  purpose: UploadPurposeSchema,
  filename: z.string().min(1),
  content_type: z.string().min(1),
  size_bytes: ByteCountSchema,
  sha256: Sha256Schema,
  status: z.enum(["pending", "complete", "expired"]),
  created_at: IsoDateTimeSchema,
  completed_at: IsoDateTimeSchema.nullable(),
});
export type Upload = z.infer<typeof UploadSchema>;

export const uploadRoutes = defineRoutes({
  create: defineRoute({
    id: "uploads.create",
    method: "POST",
    path: "/uploads",
    auth: ["session", "apiKey:runs:write"],
    summary: "Plan an upload: returns presigned PUT url(s). Size is capped per purpose.",
    body: z.object({
      purpose: UploadPurposeSchema,
      filename: z.string().min(1).max(255),
      content_type: z.string().min(1).max(255),
      size_bytes: ByteCountSchema,
      sha256: Sha256Schema,
    }),
    status: 201,
    response: z.object({
      upload: UploadSchema,
      plan: UploadPlanSchema,
      expires_at: IsoDateTimeSchema,
    }),
  }),
  complete: defineRoute({
    id: "uploads.complete",
    method: "POST",
    path: "/uploads/:id/complete",
    auth: ["session", "apiKey:runs:write"],
    summary:
      "Finish an upload (multipart: pass each part's ETag). The server checks size and sha256.",
    params: z.object({ id: UploadIdSchema }),
    body: z.object({
      parts: z
        .array(z.object({ part_number: z.int().min(1).max(10_000), etag: z.string().min(1) }))
        .optional(),
    }),
    response: z.object({ upload: UploadSchema }),
  }),
});
