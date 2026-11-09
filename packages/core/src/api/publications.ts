// Publications (E12 minimal: 12.1 sign + verify, 12.3 public page, 12.4 badge, 12.5 embed,
// 12.6 OG image, 12.7 publish button). The owner publishes a delivered run; the server freezes
// the report plus how it was evaluated into an immutable, versioned snapshot under an unguessable
// slug (`/r/<slug>`), signs its canonical JSON with Ed25519, and can withdraw it. A withdrawn
// publication never silently disappears: its page and badge read "withdrawn".
//
// The fuller design (owner/slug URLs, pinned versions, release holds, gallery) is publish.ts;
// these are the routes that exist today.
//
// Honest by construction (plan.md 17.2): the snapshot carries the whole report (every setup,
// every requirement, every verdict, the per-task scope line), a run can only be published when
// it was delivered and its gate was proven (all six checks) or curated (oracle passes and the
// do-nothing contender fails, verified offline), and `badge` is derived from verdicts only.
import { z } from "zod";
import { ContenderIdSchema, RunIdSchema } from "../ids.js";
import { ContenderRoleSchema } from "../schemas/contender.js";
import { SubjectKindSchema } from "../schemas/kit-primitives.js";
import { IsoDateTimeSchema } from "./common.js";
import { ProofCheckResultSchema } from "./kits.js";
import { ReportSchema, VerdictSchema } from "./reports.js";
import { defineRoute, defineRoutes } from "./route.js";

export const PUBLICATION_SCHEMA = "anybench.publication/v1";

/** 20 chars of [a-z0-9] from a CSPRNG (~103 bits): unguessable, so the link is the permission. */
export const PublicationSlugSchema = z
  .string()
  .regex(/^[a-z0-9]{20}$/, { error: "publication slug: 20 of a-z, 0-9" });
export type PublicationSlug = z.infer<typeof PublicationSlugSchema>;

const Count = z.int().min(0);

export const PublicationSetupSchema = z.object({
  contender_id: ContenderIdSchema,
  name: z.string().min(1),
  role: ContenderRoleSchema,
  /** The pinned model id (agent setups), or null. */
  model: z.string().nullable(),
  /** The contender's own pinned version (e.g. `tandem@0.2.0`), or null. */
  version: z.string().nullable(),
  /** Pinned versions of what it installs (`CLAUDE_CODE_VERSION: 2.1.319`, `TANDEM_VERSION: …`). */
  versions: z.record(z.string(), z.string()),
  /** Trials of this setup that were graded (warm-ups, infra failures and cancels excluded). */
  graded_trials: Count,
});
export type PublicationSetup = z.infer<typeof PublicationSetupSchema>;

export const PublicationScoreCellSchema = z.object({
  contender_id: ContenderIdSchema,
  /** null: every task together. */
  workload_id: z.string().min(1).nullable(),
  graded: Count,
  /** Graded trials that passed every applicable gate. */
  passed: Count,
  /** Sum over the graded trials, integer micro-USD. */
  cost_micro_usd: Count,
  /** Mean wall clock over the gate-passing trials (no speed number without the gate). */
  wall_s_mean: z.number().nonnegative().nullable(),
  wall_n: Count,
  /**
   * TDM-210: mean share of hidden tests passed over EVERY graded trial (correctness itself, so
   * failed trials count), when the gate wrote `hidden_test_fraction`. Absent in older snapshots.
   */
  hidden_test_fraction_mean: z.number().min(0).max(1).optional(),
  hidden_test_fraction_n: Count.optional(),
});
export type PublicationScoreCell = z.infer<typeof PublicationScoreCellSchema>;

export const PublicationEvaluationSchema = z.object({
  /** The preregistered whole-kit hash (frozen before the first contender trial). */
  kit_hash: z.string().min(1).max(200),
  kit_version: z.int().min(1),
  /** sha256 of the kit's whole file tree, when preregistration recorded it. */
  kit_files_sha256: z.string().nullable(),
  /** When the kit was frozen (preregistered) before the first contender trial, if recorded. */
  preregistered_at: IsoDateTimeSchema.nullable(),
  /** When the run was started and when it was delivered. */
  run_started_at: IsoDateTimeSchema,
  run_delivered_at: IsoDateTimeSchema.nullable(),
  /** "tokens: naive-proxy, effort: naive-min, thinking: off; simulated approvals", when stated. */
  disclosure: z.string().nullable(),
  setups: z.array(PublicationSetupSchema).min(1),
  tasks: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string(),
      /** Hidden tests behind the gate for this task, when the kit states it. */
      hidden_tests: Count.nullable(),
      shape: z.string().nullable(),
    }),
  ),
  /** The correctness gates; the agent under test never sees them. */
  gates: z.array(
    z.object({ id: z.string().min(1), kind: z.string(), description: z.string().nullable() }),
  ),
  proof: z.object({
    /** proven: all six checks passed. curated: oracle passes and do-nothing fails, offline. */
    basis: z.enum(["proven", "curated"]),
    label: z.string(),
    checks: z.array(ProofCheckResultSchema),
  }),
  trials: z.object({
    /** Graded trials: they count toward the result (a subject failure counts as a failure). */
    graded: Count,
    /** Of the graded trials, how many passed every applicable gate. */
    gate_passed: Count,
    /** Our own infrastructure failed: excluded from the result and not billed. */
    infra_excluded: Count,
    cancelled: Count,
    warmups: Count,
  }),
  stats: z.object({
    alpha: z.number().gt(0).lt(1).nullable(),
    /** Comparisons in the Holm family (per requirement × setup vs the baseline). */
    family: Count.nullable(),
    /** Per-task tests in their own Holm family, and the scope line that must sit next to them. */
    per_task_family: Count.nullable(),
    per_task_scope: z.string().nullable(),
  }),
  /** Which metrics the run reported (wall clock and cost can be missing on older runs). */
  metrics: z.object({ wall_clock: z.boolean(), cost: z.boolean() }),
  /**
   * Raw counts behind the scoreboard bars: per setup, overall (`workload_id` null) and per task.
   * No verdict; missing on publications made before it existed.
   */
  scoreboard: z.array(PublicationScoreCellSchema).optional(),
});
export type PublicationEvaluation = z.infer<typeof PublicationEvaluationSchema>;

/**
 * What the badge, the OG image and the embed say: one comparison, from its verdict only. A
 * `better`/`worse` word appears only when the decision rule called it; otherwise "no detectable
 * difference". `scope` is "on these N tasks" for agent results under 20 tasks.
 */
export const PublicationBadgeSchema = z.object({
  subject: z.string().min(1),
  baseline: z.string().nullable(),
  requirement: z.string().nullable(),
  verdict: VerdictSchema.nullable(),
  /** e.g. "Tandem vs Claude Code solo: no detectable difference". */
  message: z.string().min(1).max(160),
  scope: z.string().nullable(),
});
export type PublicationBadge = z.infer<typeof PublicationBadgeSchema>;

/** The frozen, signed snapshot. Immutable once written. */
export const PublicationSchema = z.object({
  schema: z.literal(PUBLICATION_SCHEMA),
  slug: PublicationSlugSchema,
  version: z.int().min(1),
  run_id: RunIdSchema,
  published_at: IsoDateTimeSchema,
  /** The run's question, e.g. "Does Tandem beat Claude Code?" */
  title: z.string().min(1),
  subject: z.object({ name: z.string().min(1), kind: SubjectKindSchema }),
  /** The one-line verdict (the report's headline, without the proof and disclosure tails). */
  verdict: z.string().min(1),
  badge: PublicationBadgeSchema,
  report: ReportSchema,
  evaluation: PublicationEvaluationSchema,
});
export type Publication = z.infer<typeof PublicationSchema>;

export const SignedPublicationSchema = z.object({
  payload: PublicationSchema,
  alg: z.literal("Ed25519"),
  key_id: z.string().min(1),
  /** Ed25519 over the canonical JSON of `payload` (RFC 8785 style), standard base64. */
  signature: z.string().min(1),
});
export type SignedPublication = z.infer<typeof SignedPublicationSchema>;

/** The owner's view of a run's publication. */
export const PublicationSummarySchema = z.object({
  slug: PublicationSlugSchema,
  run_id: RunIdSchema,
  status: z.enum(["live", "withdrawn"]),
  latest_version: z.int().min(1),
  published_at: IsoDateTimeSchema,
  withdrawn_at: IsoDateTimeSchema.nullable(),
  /** Absolute URLs on the web app. */
  page_url: z.url(),
  badge_url: z.url(),
  embed_url: z.url(),
  badge: PublicationBadgeSchema,
  verdict: z.string(),
});
export type PublicationSummary = z.infer<typeof PublicationSummarySchema>;

export const PublicVerificationSchema = z.object({
  valid: z.boolean(),
  key_id: z.string().nullable(),
  reason: z.string(),
});

/** GET /public/r/:slug. */
export const PublicPublicationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("live"),
    signed: SignedPublicationSchema,
    /** Checked by the API against /.well-known/anybench-keys.json when it served this. */
    verification: PublicVerificationSchema,
    /** Every version of this publication, newest first. */
    versions: z.array(z.object({ version: z.int().min(1), published_at: IsoDateTimeSchema })),
  }),
  z.object({
    status: z.literal("withdrawn"),
    slug: PublicationSlugSchema,
    withdrawn_at: IsoDateTimeSchema,
  }),
]);
export type PublicPublication = z.infer<typeof PublicPublicationSchema>;

const runParams = z.object({ id: RunIdSchema });
const summaryResponse = z.object({ publication: PublicationSummarySchema });

export const publicationRoutes = defineRoutes({
  publish: defineRoute({
    id: "publications.publish",
    method: "POST",
    path: "/runs/:id/publication",
    auth: ["session", "apiKey:publish:write"],
    summary:
      "Freeze the delivered run's report into a signed public snapshot (version 1, or the next " +
      "version under the same slug). 409 unless delivered with a proven or curated gate.",
    params: runParams,
    status: 201,
    response: summaryResponse,
  }),
  get: defineRoute({
    id: "publications.get",
    method: "GET",
    path: "/runs/:id/publication",
    auth: ["session", "apiKey:runs:read"],
    summary: "The run's publication, or null if it was never published.",
    params: runParams,
    response: z.object({ publication: PublicationSummarySchema.nullable() }),
  }),
  unpublish: defineRoute({
    id: "publications.unpublish",
    method: "POST",
    path: "/runs/:id/publication/unpublish",
    auth: ["session", "apiKey:publish:write"],
    summary: "Withdraw: the page and badge then read 'withdrawn'. Publishing again restores it.",
    params: runParams,
    response: summaryResponse,
  }),
  public: defineRoute({
    id: "publications.public",
    method: "GET",
    path: "/public/r/:slug",
    auth: ["public"],
    summary: "A publication's latest (or ?version=) signed snapshot, verified, or its withdrawal.",
    params: z.object({ slug: PublicationSlugSchema }),
    query: z.object({ version: z.coerce.number().int().positive().optional() }),
    response: PublicPublicationSchema,
  }),
  attestation: defineRoute({
    id: "publications.attestation",
    method: "GET",
    path: "/public/r/:slug/attestation.json",
    auth: ["public"],
    summary:
      "The signed snapshot exactly as signed (canonical JSON). Verify it with the key in " +
      "/.well-known/anybench-keys.json.",
    params: z.object({ slug: PublicationSlugSchema }),
    query: z.object({ version: z.coerce.number().int().positive().optional() }),
    kind: "text",
    response: z.string(),
  }),
});
