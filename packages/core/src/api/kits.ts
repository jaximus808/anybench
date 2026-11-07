// Kit routes (plan.md P2): saved kits are plain files plus a validated KitSpec; they rerun on the
// next release. Ticket 4.1 owns the loader; the server serves them here.
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

export const KitSummarySchema = z.object({
  id: KitIdSchema,
  run_id: RunIdSchema,
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
    summary: "A presigned link to the kit folder as a tarball.",
    params: kitParams,
    response: SignedUrlSchema,
  }),
});
