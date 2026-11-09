// Run routes (plan.md sections 5, 6, 8). The API only enqueues commands; the worker owns state
// transitions. Ticket 7.3 implements them; the live run page (8.4) and MCP (8.7) read them.
import { z } from "zod";
import {
  AgentSessionIdSchema,
  ContenderIdSchema,
  KitIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "../ids.js";
import { MicroUsdSchema, NonNegativeMicroUsdSchema } from "../money.js";
import { ContenderRoleSchema, ContenderSchema, GithubSourceSchema } from "../schemas/contender.js";
import { RunStateSchema } from "../state/run.js";
import { TrialStateSchema } from "../state/trial.js";
import { AlertSchema } from "./alerts.js";
import {
  FreeRunRefusalSchema,
  IsoDateTimeSchema,
  PageQuerySchema,
  PaymentRequiredSchema,
  PositiveMicroUsdSchema,
  csvListSchema,
  pageOf,
} from "./common.js";
import { kitRoutes } from "./kits.js";
import { defineRoute, defineRoutes } from "./route.js";
import { UploadIdSchema } from "./uploads.js";

// ---------------------------------------------------------------------------------------------
// Entities

/**
 * Where a run's kit came from (TDM-218, E19): `generated` by our agents (understand, research,
 * kit design), or `uploaded` by the user's own coding agent. An uploaded kit skips kit generation
 * (and its run fee) but never skips the six proof checks on our computers.
 */
export const RunKitOriginSchema = z.enum(["generated", "uploaded"]);
export type RunKitOrigin = z.infer<typeof RunKitOriginSchema>;

export const RunSchema = z.object({
  id: RunIdSchema,
  project_id: ProjectIdSchema.nullable(),
  question: z.string(),
  state: RunStateSchema,
  budget_micro_usd: NonNegativeMicroUsdSchema,
  /**
   * TDM-242: spent against the budget limit so far: run fee + compute at billed price + managed
   * tokens (a free run: compute at our cost). Never includes BYOK tokens (`byok_token_micro_usd`).
   */
  spent_micro_usd: MicroUsdSchema,
  /** TDM-242: the worst case of the trials running now (each up to its cap, minus what it spent). */
  committed_micro_usd: NonNegativeMicroUsdSchema.default(0n),
  /** TDM-242: what the budget limits: `billed` = budget_micro_usd; `free_run` = the free-run cap. */
  budget_basis: z.enum(["billed", "free_run"]).default("billed"),
  /** TDM-242: the limit spent + committed is held to (budget_micro_usd unless a free run). */
  budget_limit_micro_usd: NonNegativeMicroUsdSchema.nullable().default(null),
  /** TDM-242: model tokens on the user's own key, paid to their provider; reported, not billed. */
  byok_token_micro_usd: NonNegativeMicroUsdSchema.default(0n),
  estimate_micro_usd: NonNegativeMicroUsdSchema.nullable(),
  kit_id: KitIdSchema.nullable(),
  /** `uploaded`: the run page says "kit: uploaded by you". Older servers omit it: `generated`. */
  kit_origin: RunKitOriginSchema.default("generated"),
  paused_reason: z.string().nullable(),
  cancel_requested_at: IsoDateTimeSchema.nullable(),
  /** Comped runs show "comped" on the report and on /company. */
  comped: z.boolean(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Run = z.infer<typeof RunSchema>;

/** The live run page's four counters. */
export const RunCountersSchema = z.object({
  trials_total: z.int().nonnegative(),
  trials_done: z.int().nonnegative(),
  trials_running: z.int().nonnegative(),
  trials_failed: z.int().nonnegative(),
  spent_micro_usd: MicroUsdSchema,
  projected_micro_usd: NonNegativeMicroUsdSchema.nullable(),
  elapsed_s: z.int().nonnegative(),
  eta_s: z.int().nonnegative().nullable(),
  /** The last event seq, so a page can open the stream right after it. */
  last_seq: z.int().nonnegative(),
});

/** A pending `confirmTool` or `answer` prompt from a Naïve session. */
export const PendingActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("confirm_tool"),
    tool_use_id: z.string().min(1),
    tool: z.string().min(1),
    input_preview: z.string(),
  }),
  z.object({ kind: z.literal("answer"), question: z.string() }),
]);

export const AgentSessionSchema = z.object({
  id: AgentSessionIdSchema,
  run_id: RunIdSchema,
  /** understander, researcher, intake, kit designer, reviewer, ... (plan.md section 11). */
  role: z.string().min(1),
  status: z.enum(["queued", "running", "waiting", "done", "failed", "cancelled"]),
  budget_micro_usd: NonNegativeMicroUsdSchema,
  cost_micro_usd: NonNegativeMicroUsdSchema,
  last_tool: z.string().nullable(),
  stop_reason: z.string().nullable(),
  pending_action: PendingActionSchema.nullable(),
  started_at: IsoDateTimeSchema.nullable(),
  ended_at: IsoDateTimeSchema.nullable(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const RunDetailSchema = z.object({
  run: RunSchema,
  counters: RunCountersSchema,
  open_alerts: z.array(AlertSchema),
  agents: z.array(AgentSessionSchema),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

/** A contender candidate on the test plan screen: kept, or unavailable with the reason. */
export const RunContenderSchema = z.object({
  id: ContenderIdSchema,
  kit_id: KitIdSchema.nullable(),
  name: z.string(),
  role: ContenderRoleSchema,
  status: z.enum(["candidate", "kept", "unavailable"]),
  reason: z.string().nullable(),
  found_by: z.string().nullable(),
  /** The kit contender (source, install, driver) once the intake agent wrote an adapter. */
  spec: ContenderSchema.nullable(),
});
export type RunContender = z.infer<typeof RunContenderSchema>;

// ---------------------------------------------------------------------------------------------
// Create

/** What to benchmark: a repo, a binary with docs, a Claude Code setup, or a saved kit (rerun). */
export const RunSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github"),
    github: GithubSourceSchema.shape.github,
    ref: z.string().min(1).optional(),
  }),
  z
    .object({
      kind: z.literal("binary"),
      binary_url: z.url({ protocol: /^https?$/ }).optional(),
      upload_id: UploadIdSchema.optional(),
      docs_url: z.url({ protocol: /^https?$/ }).optional(),
      docs_upload_id: UploadIdSchema.optional(),
    })
    .refine((s) => (s.binary_url === undefined) !== (s.upload_id === undefined), {
      message: "give exactly one of binary_url or upload_id",
    }),
  z.object({ kind: z.literal("claude_setup"), upload_id: UploadIdSchema }),
  z.object({ kind: z.literal("kit"), kit_id: KitIdSchema }),
]);
export type RunSource = z.infer<typeof RunSourceSchema>;

export const CreateRunBodySchema = z.object({
  question: z.string().trim().min(1).max(2000),
  source: RunSourceSchema,
  budget_micro_usd: PositiveMicroUsdSchema,
  /** Contenders the user adds up front; the researcher finds the rest. */
  contenders: z.array(ContenderSchema).max(20).default([]),
  /**
   * Leave `awaiting_go` on its own when the estimate fits and the billing gate passes. Omitted:
   * the user's `auto_start_runs` setting decides.
   */
  auto_go: z.boolean().optional(),
});

// ---------------------------------------------------------------------------------------------
// Suggest (New run screen): one bounded Naïve session reads a repo's README and file tree and
// proposes the rest of the form. The user reviews and edits every field; nothing is created.

export const SUGGESTED_QUESTIONS_MIN = 2;
export const SUGGESTED_QUESTIONS_MAX = 3;
export const SUGGESTED_ALTERNATIVES_MAX = 5;

/** The approvals preference the New run screen offers (runs per setup 1–20 likewise). */
export const ApprovalsPolicySchema = z.enum(["reviewer", "ask_me", "auto"]);

export const SuggestedAlternativeSchema = z.object({
  /** A product name or `owner/repo`, as the user would type it on the form. */
  name: z.string().trim().min(1).max(120),
  /** One line: why it is the obvious thing to compare against. */
  reason: z.string().trim().min(1).max(300),
});
export type SuggestedAlternative = z.infer<typeof SuggestedAlternativeSchema>;

/** What the suggester agent proposes. Also its Naïve output_schema. */
export const RunSuggestionSchema = z.object({
  /** One line: what this project is. */
  project_summary: z.string().trim().min(1).max(300),
  /** Questions worth benchmarking, best first. */
  questions: z
    .array(z.string().trim().min(1).max(400))
    .min(SUGGESTED_QUESTIONS_MIN)
    .max(SUGGESTED_QUESTIONS_MAX),
  alternatives: z.array(SuggestedAlternativeSchema).max(SUGGESTED_ALTERNATIVES_MAX),
  options: z.object({
    runs_per_setup: z.int().min(1).max(20),
    approvals: ApprovalsPolicySchema,
  }),
});
export type RunSuggestion = z.infer<typeof RunSuggestionSchema>;

export const SuggestRunBodySchema = z.object({
  source: z.object({
    kind: z.literal("github"),
    github: GithubSourceSchema.shape.github,
    ref: z.string().min(1).max(255).optional(),
  }),
});

// ---------------------------------------------------------------------------------------------
// Estimate (TDM-225, E20): what the run will cost before Go, line by line, and whether the free
// starter run covers it. Read-only: Go decides for real (apps/server lib/free-run.ts freeRunAtGo).

/**
 * GET /runs/:id/estimate. `price` is what the user pays: `free` when the account's free starter
 * run covers this run (it fits every starter limit and the pool can fund it), else `paid`.
 * `normal` is the normal price either way, so a free run shows what it would otherwise cost.
 * Model tokens are never part of our price: on the user's own key, their provider bills them.
 */
export const RunEstimateSchema = z.object({
  run_id: RunIdSchema,
  kit_origin: RunKitOriginSchema,
  price: z.enum(["free", "paid"]),
  /** What the user pays for this run: 0 when free, else `normal.total_micro_usd`. */
  total_micro_usd: NonNegativeMicroUsdSchema,
  /** The normal price, line by line (packages/billing estimateRunCost). */
  normal: z.object({
    /** RUN_FEE_MICRO_USD (generated kit) or UPLOADED_KIT_RUN_FEE_MICRO_USD (uploaded kit). */
    run_fee_micro_usd: NonNegativeMicroUsdSchema,
    compute: z.object({
      computers: z.int().nonnegative(),
      /** Trials, warm-ups included. */
      trials: z.int().nonnegative(),
      /** Billing blocks over all computers. */
      blocks: z.int().nonnegative(),
      block_seconds: z.int().positive(),
      /** Computer time at the billed price (cost + COMPUTE_MARKUP_BPS). */
      charge_micro_usd: NonNegativeMicroUsdSchema,
    }),
    /** run fee + computer time. Model tokens not included. */
    total_micro_usd: NonNegativeMicroUsdSchema,
    /**
     * TDM-244: model tokens on Anybench's key (the Naïve proxy), billed as used at our cost +
     * MANAGED_TOKEN_MARKUP_BPS ("Model tokens (ours): at cost + 20%"). Not in the total: the spend
     * is only known once the trials ran. Null when no contender uses our tokens.
     */
    managed_tokens: z
      .object({
        contenders: z.array(z.string()).min(1),
        markup_bps: z.int().nonnegative(),
      })
      .nullable(),
  }),
  tokens: z.object({
    /** Providers of the user's own keys the agent contenders use: that provider bills them. */
    byok_providers: z.array(z.enum(["anthropic", "openai"])),
    /**
     * Upper bound on spend on the user's own key: each BYOK trial at its contender's
     * token_cap_micro_usd. Null when a BYOK contender sets no spend cap (no honest bound) or
     * none uses the user's key.
     */
    byok_ceiling_micro_usd: NonNegativeMicroUsdSchema.nullable(),
    /** Contenders on Anybench's tokens: metered as used, not in this estimate. */
    managed_contenders: z.array(z.string()),
  }),
  /** The free starter run. Null when it is not in play (BILLING_MODE=off, a comped run). */
  free_run: z
    .object({
      /** The account's free run, as billing.summary `free_run.status` says it. */
      status: z.enum(["available", "in_use", "used", "not_eligible", "paused"]),
      /** The free run covers THIS run (`price` is `free`). */
      applies: z.boolean(),
      /** Why it does not: every starter limit the run passes, or the account or pool reason. */
      refusal: FreeRunRefusalSchema.nullable(),
      /** The starter limits, from config (FREE_RUN_MAX_TRIALS, FREE_RUN_CAP_MICRO_USD). */
      limits: z.object({
        max_setups: z.int().positive(),
        max_trials: z.int().nonnegative(),
        compute_cap_micro_usd: NonNegativeMicroUsdSchema,
      }),
      /** This run's setups (contenders x their `vary` combinations). */
      setups: z.int().nonnegative(),
    })
    .nullable(),
  /** Go will ask for a card: the run is paid and the account has no card on file. */
  card_needed: z.boolean(),
  /**
   * TDM-244: why Go will ask for a card, in plain words, when it is not only the price (a kit on
   * Anybench's model tokens needs a card or your own key). Null otherwise.
   */
  card_message: z.string().min(1).nullable(),
});
export type RunEstimate = z.infer<typeof RunEstimateSchema>;

const IdempotencyHeadersSchema = z.object({
  "idempotency-key": z.string().min(8).max(200).optional(),
});

const runParams = z.object({ id: RunIdSchema });
const runResponse = z.object({ run: RunSchema });

// ---------------------------------------------------------------------------------------------

export const runRoutes = defineRoutes({
  list: defineRoute({
    id: "runs.list",
    method: "GET",
    path: "/runs",
    auth: ["session", "apiKey:runs:read"],
    summary: "The caller's runs, newest first.",
    query: PageQuerySchema.extend({ state: csvListSchema(RunStateSchema).optional() }),
    response: pageOf(RunSchema),
  }),
  create: defineRoute({
    id: "runs.create",
    method: "POST",
    path: "/runs",
    auth: ["session", "apiKey:runs:write"],
    summary: "Start a run at `intake`. Nothing is billed until Go.",
    headers: IdempotencyHeadersSchema,
    body: CreateRunBodySchema,
    status: 201,
    response: runResponse,
  }),
  suggest: defineRoute({
    id: "runs.suggest",
    method: "POST",
    path: "/runs/suggest",
    auth: ["session"],
    summary:
      "Read a GitHub repo and propose questions, alternatives and options for a new run. Creates nothing.",
    body: SuggestRunBodySchema,
    response: z.object({
      suggestion: RunSuggestionSchema,
      /** What the suggester session cost Anybench (integer micro-USD); the user is not billed. */
      cost_micro_usd: NonNegativeMicroUsdSchema,
    }),
  }),
  get: defineRoute({
    id: "runs.get",
    method: "GET",
    path: "/runs/:id",
    auth: ["session", "apiKey:runs:read"],
    summary: "A run with its counters, open alerts and live agent sessions.",
    params: runParams,
    response: RunDetailSchema,
  }),
  editKit: defineRoute({
    id: "runs.editKit",
    method: "PATCH",
    path: "/runs/:id/kit",
    auth: ["session", "apiKey:runs:write"],
    summary:
      "Save an edited kit for the run (version 1 if it has none yet); allowed in kit_draft or " +
      "awaiting_go, and proof checks rerun before Go. Same body and response as kits.createVersion.",
    params: runParams,
    body: kitRoutes.createVersion.body,
    status: 201,
    response: kitRoutes.createVersion.response,
  }),
  estimate: defineRoute({
    id: "runs.estimate",
    method: "GET",
    path: "/runs/:id/estimate",
    auth: ["session", "apiKey:runs:read"],
    summary:
      "What the run costs before Go, line by line, and whether the free starter run covers it (409 until the run has a kit).",
    params: runParams,
    response: z.object({ estimate: RunEstimateSchema }),
  }),
  go: defineRoute({
    id: "runs.go",
    method: "POST",
    path: "/runs/:id/go",
    auth: ["session", "apiKey:runs:write"],
    summary: "Leave `awaiting_go`. 402 `{reason, link_card_url}` when the billing gate fails.",
    params: runParams,
    response: runResponse,
    errors: { 402: PaymentRequiredSchema },
  }),
  cancel: defineRoute({
    id: "runs.cancel",
    method: "POST",
    path: "/runs/:id/cancel",
    auth: ["session", "apiKey:runs:write"],
    summary:
      "Request cancellation (sets cancel_requested_at; the worker stops sessions and computers).",
    params: runParams,
    body: z.object({ reason: z.string().trim().min(1).max(2000).optional() }),
    response: runResponse,
  }),
  settle: defineRoute({
    id: "runs.settle",
    method: "POST",
    path: "/runs/:id/settle",
    auth: ["session", "apiKey:runs:write"],
    summary:
      "Operator settle (the run owner, or an admin for any run): every unfinished trial becomes `cancelled` (operator-stopped, never billed), its computer is destroyed, and the run scores with the trials it has.",
    params: runParams,
    body: z.object({ reason: z.string().trim().min(1).max(2000).optional() }),
    response: z.object({
      run: RunSchema,
      settled: z.array(z.object({ trial_id: z.string().min(1), from: TrialStateSchema })),
    }),
  }),
  resume: defineRoute({
    id: "runs.resume",
    method: "POST",
    path: "/runs/:id/resume",
    auth: ["session", "apiKey:runs:write"],
    summary: "Leave `needs_human` or `paused_budget`, optionally raising the budget.",
    params: runParams,
    body: z.object({
      to: RunStateSchema.optional(),
      budget_micro_usd: PositiveMicroUsdSchema.optional(),
    }),
    response: runResponse,
  }),
  contenders: defineRoute({
    id: "runs.contenders",
    method: "GET",
    path: "/runs/:id/contenders",
    auth: ["session", "apiKey:runs:read"],
    summary: "Every contender candidate and why it was kept or dropped (test plan screen).",
    params: runParams,
    response: z.object({ items: z.array(RunContenderSchema) }),
  }),
  addContender: defineRoute({
    id: "runs.addContender",
    method: "POST",
    path: "/runs/:id/contenders",
    auth: ["session", "apiKey:runs:write"],
    summary: "Add a contender before Go.",
    params: runParams,
    body: z.object({ contender: ContenderSchema }),
    status: 201,
    response: z.object({ contender: RunContenderSchema }),
  }),
  updateContender: defineRoute({
    id: "runs.updateContender",
    method: "PATCH",
    path: "/runs/:id/contenders/:contenderId",
    auth: ["session", "apiKey:runs:write"],
    summary: "Keep or drop a contender before Go.",
    params: z.object({ id: RunIdSchema, contenderId: ContenderIdSchema }),
    body: z.object({
      status: z.enum(["kept", "unavailable"]),
      reason: z.string().trim().min(1).max(2000).optional(),
    }),
    response: z.object({ contender: RunContenderSchema }),
  }),
  agents: defineRoute({
    id: "runs.agents",
    method: "GET",
    path: "/runs/:id/agents",
    auth: ["session", "apiKey:runs:read"],
    summary: "Every Naïve agent session of the run (the agents strip).",
    params: runParams,
    response: z.object({ items: z.array(AgentSessionSchema) }),
  }),
  agent: defineRoute({
    id: "runs.agent",
    method: "GET",
    path: "/agent-sessions/:id",
    auth: ["session", "apiKey:runs:read"],
    summary: "One agent session (drill-down 2).",
    params: z.object({ id: AgentSessionIdSchema }),
    response: z.object({ session: AgentSessionSchema }),
  }),
  agentTranscript: defineRoute({
    id: "runs.agentTranscript",
    method: "GET",
    path: "/agent-sessions/:id/transcript",
    auth: ["session", "apiKey:logs:read"],
    summary: "The mirrored Naïve transcript, paged by Naïve seq.",
    params: z.object({ id: AgentSessionIdSchema }),
    query: z.object({
      after_seq: z.coerce.number().int().nonnegative().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }),
    response: z.object({
      items: z.array(
        z.object({
          naive_seq: z.int().nonnegative(),
          type: z.string().min(1),
          payload: z.unknown(),
          at: IsoDateTimeSchema,
        }),
      ),
      next_after_seq: z.int().nonnegative().nullable(),
    }),
  }),
  answerAgent: defineRoute({
    id: "runs.answerAgent",
    method: "POST",
    path: "/agent-sessions/:id/answer",
    auth: ["session", "apiKey:runs:write"],
    summary: "Answer a pending confirmTool or answer prompt.",
    params: z.object({ id: AgentSessionIdSchema }),
    body: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("confirm_tool"),
        tool_use_id: z.string().min(1),
        allow: z.boolean(),
      }),
      z.object({ kind: z.literal("answer"), text: z.string().min(1).max(20_000) }),
    ]),
    response: z.object({ session: AgentSessionSchema }),
  }),
});
