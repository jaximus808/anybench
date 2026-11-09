// Kit routes (plan.md P2): saved kits are plain files plus a validated KitSpec; they rerun on the
// next release. Ticket 4.1 owns the loader; the server serves them here.
//
// Bring your own kit (E19, TDM-217 [19.1]): the user's agent builds and proves a kit locally, then
//   1. POST /kits/uploads {size_bytes, sha256}          → a presigned PUT for the kit tarball
//   2. PUT the .tar.gz to `plan.url` with `plan.headers` (R2 refuses another length or checksum)
//   3. POST /kits/uploads/:id/complete                   → the server downloads the tarball, unpacks
//      it safely (KIT_UPLOAD_LIMITS; no links, no absolute or `..` paths), runs validateKitDir, and
//      either answers `{ok: false, issues}` or stores a kit row with origin `uploaded`, no run, and
//      no proof. Anybench reruns the six proof checks itself before any billed run: an uploaded kit
//      is never trusted as is.
// The tarball's entries are kit-relative (`anybench.yaml` at the root), or all under one top-level
// directory that holds `anybench.yaml`. Regular files and directories only.
import { z } from "zod";
import { KitIdSchema, RunIdSchema } from "../ids.js";
import { KitSha256Schema } from "../schemas/kit-primitives.js";
import { KitSpecSchema } from "../schemas/kit.js";
import { IsoDateTimeSchema, PageQuerySchema, SignedUrlSchema, pageOf } from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";
import { UploadIdSchema } from "./uploads.js";

/** The six proof checks that must pass before any billed run (plan.md P2). */
export const PROOF_CHECKS = [
  "oracle_passes",
  "do_less_fails",
  "smoke_passes",
  "regression_scores_lower",
  "baselines_in_range",
  "no_secret_in_kit",
] as const;
export const ProofCheckNameSchema = z.enum(PROOF_CHECKS);

export const ProofCheckResultSchema = z.object({
  check: ProofCheckNameSchema,
  pass: z.boolean(),
  reason: z.string(),
  evidence: z.array(z.string()),
});
export type ProofCheckResult = z.infer<typeof ProofCheckResultSchema>;

/**
 * Where a kit came from: `generated` by the kit designer for a run, `curated` (a kit we maintain,
 * e.g. kits/tandem-vs-claude-code), or `uploaded` by the user (POST /kits/uploads). An uploaded kit
 * has no run until a run is created from it (RunSource `{kind: "kit", kit_id}`).
 */
export const KIT_ORIGINS = ["generated", "curated", "uploaded"] as const;
export const KitOriginSchema = z.enum(KIT_ORIGINS);
export type KitOrigin = z.infer<typeof KitOriginSchema>;

export const KitSummarySchema = z.object({
  id: KitIdSchema,
  /** The run this kit version belongs to; null for an uploaded kit no run uses yet. */
  run_id: RunIdSchema.nullable(),
  origin: KitOriginSchema,
  version: z.int().positive(),
  name: z.string(),
  hash: KitSha256Schema,
  /** True once all six proof checks passed. */
  proven: z.boolean(),
  created_at: IsoDateTimeSchema,
});
export type KitSummary = z.infer<typeof KitSummarySchema>;

export const KitDetailSchema = KitSummarySchema.extend({
  spec: KitSpecSchema,
  proof: z.array(ProofCheckResultSchema),
  /** Kit designer repairs used so far (max 2, then the run goes to needs_human). */
  repairs: z.int().nonnegative(),
});
export type KitDetail = z.infer<typeof KitDetailSchema>;

const kitParams = z.object({ id: KitIdSchema });

// ---------------------------------------------------------------------------------------------
// Kit uploads (TDM-217 [19.1])

const MiB = 1024 * 1024;

/** Limits on an uploaded kit tarball. The server refuses an archive over any of them. */
export const KIT_UPLOAD_LIMITS = {
  /** The .tar.gz as uploaded (the presigned PUT is signed for exactly the declared length). */
  maxBytes: 50 * MiB,
  /** Sum of the unpacked regular files (also caps the gunzipped stream: a gzip bomb stops here). */
  maxUnpackedBytes: 200 * MiB,
  /** Regular files plus directories. */
  maxEntries: 5000,
  /** One entry's path, in UTF-8 bytes. */
  maxPathBytes: 1024,
  /** Path segments in one entry. */
  maxDepth: 32,
} as const;

/** The only content type a kit tarball is uploaded with. */
export const KIT_UPLOAD_CONTENT_TYPE = "application/gzip";
/** How long the presigned PUT stays valid. */
export const KIT_UPLOAD_EXPIRES_SECONDS = 60 * 60;

const KitUploadSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, { error: "sha256 must be 64 lowercase hex" });

export const KitUploadSchema = z.object({
  id: UploadIdSchema,
  size_bytes: z.int().positive(),
  sha256: KitUploadSha256Schema,
  content_type: z.literal(KIT_UPLOAD_CONTENT_TYPE),
  /** The PUT must happen before this; complete it any time after the PUT. */
  expires_at: IsoDateTimeSchema,
});
export type KitUpload = z.infer<typeof KitUploadSchema>;

/** One presigned PUT. Send every header as given; the body is the tarball's exact bytes. */
export const KitUploadPlanSchema = z.object({
  method: z.literal("PUT"),
  url: z.url(),
  headers: z.record(z.string(), z.string()),
});
export type KitUploadPlan = z.infer<typeof KitUploadPlanSchema>;

export const KitUploadCreateBodySchema = z.object({
  /** The tarball's exact length; 413 `payload_too_large` over KIT_UPLOAD_LIMITS.maxBytes. */
  size_bytes: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: KitUploadSha256Schema,
  content_type: z.literal(KIT_UPLOAD_CONTENT_TYPE).default(KIT_UPLOAD_CONTENT_TYPE),
});
export type KitUploadCreateBody = z.input<typeof KitUploadCreateBodySchema>;

/**
 * One problem with an uploaded kit, as `@anybench/kit` validateKitDir reports it (KitIssue): a
 * file, an optional line:col in it, the KitSpec field, and a message.
 */
export const KitIssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  /** A `@anybench/kit` KitIssueCode (e.g. `schema`, `missing_file`, `outside_kit`). */
  code: z.string().min(1),
  /** Relative to the kit root, usually `anybench.yaml`. */
  file: z.string(),
  line: z.int().nonnegative().optional(),
  col: z.int().nonnegative().optional(),
  path: z.string().optional(),
  message: z.string(),
});
export type KitIssueBody = z.infer<typeof KitIssueSchema>;

export const KitUploadCompleteResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    kit: KitDetailSchema,
    warnings: z.array(KitIssueSchema),
  }),
  z.object({
    ok: z.literal(false),
    /** The errors validateKitDir found; nothing was stored. Fix the kit and upload it again. */
    issues: z.array(KitIssueSchema).min(1),
    warnings: z.array(KitIssueSchema),
    /** One formatted line per error: `anybench.yaml:LINE:COL: path: message`. */
    lines: z.array(z.string()).min(1),
  }),
]);
export type KitUploadCompleteResponse = z.infer<typeof KitUploadCompleteResponseSchema>;

export const kitRoutes = defineRoutes({
  list: defineRoute({
    id: "kits.list",
    method: "GET",
    path: "/kits",
    auth: ["session", "apiKey:runs:read"],
    summary: "The caller's saved kits, newest first.",
    query: PageQuerySchema.extend({ run_id: RunIdSchema.optional() }),
    response: pageOf(KitSummarySchema),
  }),
  get: defineRoute({
    id: "kits.get",
    method: "GET",
    path: "/kits/:id",
    auth: ["session", "apiKey:runs:read"],
    summary: "A kit version: the validated spec and its proof results.",
    params: kitParams,
    response: z.object({ kit: KitDetailSchema }),
  }),
  validate: defineRoute({
    id: "kits.validate",
    method: "POST",
    path: "/kits/validate",
    auth: ["session", "apiKey:runs:read"],
    summary: "Validate an `anybench.yaml` document (already parsed to JSON). Never stores it.",
    body: z.object({ spec: z.unknown() }),
    response: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), spec: KitSpecSchema }),
      z.object({ ok: z.literal(false), issues: z.array(z.string()).min(1) }),
    ]),
  }),
  createVersion: defineRoute({
    id: "kits.createVersion",
    method: "POST",
    path: "/kits/:id/versions",
    auth: ["session", "apiKey:runs:write"],
    summary: "Save an edited kit as a new version; proof checks rerun before it can be billed.",
    params: kitParams,
    body: z.object({ spec: KitSpecSchema, files_upload_id: UploadIdSchema.optional() }),
    status: 201,
    response: z.object({ kit: KitDetailSchema }),
  }),
  download: defineRoute({
    id: "kits.download",
    method: "GET",
    path: "/kits/:id/download",
    auth: ["session", "apiKey:runs:read"],
    summary:
      "A presigned link to the kit folder as a tarball (409 when the kit's files are not in the artifact store).",
    params: kitParams,
    response: SignedUrlSchema,
  }),
  uploadsCreate: defineRoute({
    id: "kits.uploadsCreate",
    method: "POST",
    path: "/kits/uploads",
    auth: ["session", "apiKey:runs:write"],
    summary:
      "Plan a kit upload: a presigned PUT for the .tar.gz, signed for exactly `size_bytes` and `sha256`.",
    body: KitUploadCreateBodySchema,
    status: 201,
    response: z.object({ upload: KitUploadSchema, plan: KitUploadPlanSchema }),
  }),
  uploadsComplete: defineRoute({
    id: "kits.uploadsComplete",
    method: "POST",
    path: "/kits/uploads/:id/complete",
    auth: ["session", "apiKey:runs:write"],
    summary:
      "Validate the uploaded kit and store it (origin `uploaded`, unproven), or return its issues. " +
      "An unsafe archive (link, absolute or `..` path, bad tar) is a 400, one over KIT_UPLOAD_LIMITS a 413. " +
      "Completing the same upload again returns the same kit.",
    params: z.object({ id: UploadIdSchema }),
    response: KitUploadCompleteResponseSchema,
  }),
});
