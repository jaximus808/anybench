// Run orchestrator ports (TDM-54, plan.md sections 5 and 11). The orchestrator (advance.ts) owns
// the run state machine and every database write; the work of each stage goes through these
// narrow interfaces so the agent roles (E6) and the pipeline pieces plug in without touching it.
//
//   AgentStagePort   our own Naïve agents, one method per role:
//                      understand → [6.2] understander     research  → [6.3] researcher
//                      designKit  → [6.6] kit designer     analyze   → [6.8] analyst
//                    E6 implements them on packages/naive (ensureAgent + runSession, agent role
//                    registry [6.1]), with `ctx.idempotencyKey` as the agent_sessions id and the
//                    Naïve idempotencyKey, so a crashed stage that runs again replays the session
//                    instead of paying twice.
//   PipelinePort     the code steps: ingest ([4.2], real for GitHub in defaults.ts), env build
//                    ([3.8]), the proof suite ([4.x]/[16.x]), the cost estimate ([10.12], real in
//                    defaults.ts) and
//                    scoring ([5.8]/[16.3]).
//   SessionCanceller cancels a run's live Naïve sessions (real in defaults.ts).
//
// A port returns `{ok: true, value}`, or `{ok: false, outcome, reason}` to hold the run in
// `needs_human` or fail it. Throwing means "transient": the job retries with backoff and the run
// fails only after the job's last attempt. Every value is validated with zod before it is stored.
// Ports must honour `ctx.signal` (cancel, kill switch, lost lease, worker shutdown).
import {
  ContenderRoleSchema,
  ProofCheckResultSchema,
  ReportSchema,
  RunSourceSchema,
  RunStateSchema,
  ContenderSchema,
  ProofCheckNameSchema,
  SubjectKindSchema,
  type AnybenchEvent,
  type KitSpec,
  type ProjectDigest,
  type ProofCheckResult,
  type TrialState,
} from "@anybench/core";
import { UnderstandingExtrasShape } from "@anybench/agents";
import { z } from "zod";

// ---------- what the orchestrator knows about a run ----------

/** runs.intake as POST /runs stored it (TDM-67). */
export const RunIntakeSchema = z.object({
  source: RunSourceSchema,
  contenders: z.array(ContenderSchema).default([]),
  auto_go: z.boolean().default(true),
  idempotency_key: z.string().optional(),
});
export type RunIntake = z.infer<typeof RunIntakeSchema>;

export interface StageRun {
  id: string;
  owner_id: string;
  project_id: string | null;
  question: string;
  intake: RunIntake;
  budget_micro_usd: bigint;
  spent_micro_usd: bigint;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the writer assigns run_id and seq (e.g. `agent.message` from a session). */
export type StageEventDraft = DistributiveOmit<AnybenchEvent, "seq" | "run_id">;

export interface StageContext {
  run: StageRun;
  /**
   * Stable for this run × stage × visit (`<run id>:<stage>:<n>`; n counts proof repairs). Use it
   * as the agent_sessions id seed and the Naïve idempotencyKey.
   */
  idempotencyKey: string;
  /** Aborted on cancel, kill switch, a lost lease or worker shutdown. */
  signal: AbortSignal;
  /** Append events to the run (live run page). The orchestrator writes run.state_changed itself. */
  emit(events: StageEventDraft[]): Promise<void>;
}

export type StageResult<T> =
  { ok: true; value: T } | { ok: false; outcome: "needs_human" | "fail"; reason: string };

export const stageOk = <T>(value: T): StageResult<T> => ({ ok: true, value });
export const stageHold = <T>(reason: string): StageResult<T> => ({
  ok: false,
  outcome: "needs_human",
  reason,
});
export const stageFail = <T>(reason: string): StageResult<T> => ({
  ok: false,
  outcome: "fail",
  reason,
});

// ---------- stage outputs (plan.md section 11 table) ----------

/**
 * understander: ProjectDigest → what the project is and what "better" means. TDM-56 adds the kit
 * designer's fields (driver_type, supported, claims, subject_command, history,
 * labelled_conversations: @anybench/agents UnderstandingExtrasShape), all optional or defaulted
 * so the curated pass-through and outputs stored before them still parse.
 */
export const UnderstandingSchema = z.object({
  kind: SubjectKindSchema,
  summary: z.string().min(1),
  better_means: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string()).default([]),
  benchable: z.enum(["ready", "needs_hardware", "skip"]),
  reason: z.string().default(""),
  ...UnderstandingExtrasShape,
});
export type Understanding = z.infer<typeof UnderstandingSchema>;

export const BaselineSchema = z.object({
  name: z.string().min(1),
  role: ContenderRoleSchema.default("baseline"),
  source: z.string().min(1),
  why: z.string().min(1),
  install_hint: z.string().optional(),
  published_numbers: z.array(z.unknown()).default([]),
});

/** researcher: digest + understanding → baselines with cited sources. */
export const ResearchSchema = z.object({
  baselines: z.array(BaselineSchema),
  sources: z.array(z.string()).default([]),
});
export type Research = z.infer<typeof ResearchSchema>;

/** kit designer: everything so far → a KitSpec (validated with safeParseKitSpec on the way in). */
export interface KitDesign {
  spec: KitSpec;
  /** `upload:<id>` of the kit folder, once [7.4] uploads exist. */
  files_upload_id?: string;
  /**
   * Absolute path of the kit directory on the worker's disk (TDM-44 contract C1): the curated kit
   * dir, or `<ANYBENCH_GENERATED_KITS_DIR>/<run_id>/v<n>/` for a generated kit. Stored as a
   * file:// kits.files_url so env_build and proof read the kit's files. Wins over files_upload_id.
   */
  files_dir?: string;
}

export const EnvBuildSchema = z.object({
  /** envs.id or the provider snapshot the trials fork. Null until [3.8] builds real envs. */
  env_id: z.string().min(1).nullable(),
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type EnvBuild = z.infer<typeof EnvBuildSchema>;

export const ProofResultsSchema = z.array(ProofCheckResultSchema);

/**
 * A curated kit's proof: its committed, signed-off offline proof results (kits/<slug>/PROOF.md)
 * instead of the proof suite ([4.12]). `checks` holds all six checks: the ones the offline run
 * verified pass with their evidence, the rest are `pass: false` with reason "not run". The
 * orchestrator accepts it for this kit (stage_outputs.proof_basis), never isProven: the kit stays
 * "not proven" everywhere a proven kit is claimed.
 */
export const CuratedProofSchema = z.object({
  basis: z.literal("curated"),
  /** `proof: curated (verified offline at <short commit>)`. */
  label: z.string().min(1),
  /** Repo path of the signed-off proof output. */
  source: z.string().min(1),
  /** The commit that generated and signed it off. */
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** sha256 of `source` as signed off. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The checks the offline run verified (they must pass in `checks`). */
  verified: z.array(ProofCheckNameSchema).min(1),
  checks: ProofResultsSchema,
});
export type CuratedProof = z.infer<typeof CuratedProofSchema>;

/** stage_outputs.proof_basis: the curated sign-off accepted for one kit row. */
export const ProofBasisSchema = CuratedProofSchema.omit({ checks: true }).extend({
  kit_id: z.string().min(1),
});
export type ProofBasis = z.infer<typeof ProofBasisSchema>;

/** One settled trial as the scorer and the analyst see it. */
export interface StageTrial {
  id: string;
  /** The kit contender id (slug). */
  contender: string;
  /** contenders.id of that contender in this run. */
  contender_id: string;
  workload_id: string;
  /** Measured repeats are 0-based; warm-ups are stored as -1, -2, … and never scored. */
  repeat: number;
  state: TrialState;
  attempt: number;
  metrics: unknown;
  gate: unknown;
  cost_micro_usd: bigint;
  /** TDM-232: why a failed_subject trial stopped (runner failure class), for the report. */
  failure_class?: string | null;
  /** TDM-232: trials.frozen_workspace (core FrozenWorkspaceSchema), for the report. */
  frozen_workspace?: unknown;
}

/** analyst: computed stats → the report. Numbers come from code ([5.8] scoring, [7.5] report). */
export const AnalysisSchema = z.object({
  report: ReportSchema,
  md: z.string(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ---------- ports ----------

export interface AgentStagePort {
  /** [6.2] understander. */
  understand(ctx: StageContext, input: { digest: ProjectDigest }): Promise<StageResult<unknown>>;
  /** [6.3] researcher. */
  research(
    ctx: StageContext,
    input: { digest: ProjectDigest; understanding: Understanding },
  ): Promise<StageResult<unknown>>;
  /**
   * [6.6] kit designer. `previous` is set on a proof repair: the failing kit and its proof
   * results. Plan 17.2 rule 6: the repair loop never sees contender scores, and it gets none here.
   */
  designKit(
    ctx: StageContext,
    input: {
      digest: ProjectDigest | null;
      understanding: Understanding | null;
      research: Research | null;
      previous: { spec: unknown; proof: ProofCheckResult[] } | null;
    },
  ): Promise<StageResult<KitDesign>>;
  /** [6.8] analyst (with the [7.5] report builder for the numbers). */
  analyze(
    ctx: StageContext,
    input: {
      kit_id: string;
      kit: KitSpec;
      score: unknown;
      proof: ProofCheckResult[];
      /** Set when the proof stage accepted a curated sign-off for this kit. */
      proof_basis?: ProofBasis | null;
      trials: StageTrial[];
    },
  ): Promise<StageResult<unknown>>;
}

export interface PipelinePort {
  /** [4.2] ingest → ProjectDigest. */
  ingest(ctx: StageContext): Promise<StageResult<ProjectDigest>>;
  /** [3.8] env build: the image every trial forks. */
  buildEnv(
    ctx: StageContext,
    input: { kit_id: string; kit: KitSpec },
  ): Promise<StageResult<unknown>>;
  /**
   * The six proof checks (plan 17.2 rule 9) on the scoring computer, or a curated kit's
   * signed-off offline proof (CuratedProofSchema).
   */
  prove(
    ctx: StageContext,
    input: { kit_id: string; kit: KitSpec; env: EnvBuild | null },
  ): Promise<StageResult<ProofCheckResult[] | CuratedProof>>;
  /** [10.12] estimateRunCost: integer micro-USD for the whole run. */
  estimate(
    ctx: StageContext,
    input: { kit_id: string; kit: KitSpec },
  ): Promise<StageResult<bigint>>;
  /** [5.8]/[16.3] scoring over settled trials (scoreKit). The result is stored as JSON. */
  score(
    ctx: StageContext,
    input: { kit_id: string; kit: KitSpec; trials: StageTrial[] },
  ): Promise<StageResult<unknown>>;
}

export interface SessionCanceller {
  /** Cancel every live Naïve session of this run (sessions.cancel); returns how many. */
  cancelRunSessions(runId: string): Promise<number>;
}

// ---------- defaults for what is not built yet ----------

/** A port method that is not built yet: hold the run for a human, naming the ticket. */
function notBuilt<T>(what: string, ticket: string): Promise<StageResult<T>> {
  return Promise.resolve(stageHold<T>(`${what} is not built yet (${ticket})`));
}

/**
 * The agent roles until E6 lands. Each holds the run in `needs_human` instead of throwing, so an
 * unbuilt stage costs nothing and does not burn job retries; an admin resumes it once it exists.
 */
export const unbuiltAgentStages: AgentStagePort = {
  // TODO([6.1] registry + [6.2] understander): replace with the Naïve understander.
  understand: () => notBuilt("the understander agent", "[6.2]"),
  // TODO([6.3] researcher): replace with the Naïve researcher.
  research: () => notBuilt("the researcher agent", "[6.3]"),
  // TODO([6.6] kit designer): replace with the Naïve kit designer (and its repair mode).
  designKit: () => notBuilt("the kit designer agent", "[6.6]"),
  // TODO([6.8] analyst + [7.5] report builder): replace with the Naïve analyst.
  analyze: () => notBuilt("the analyst agent", "[6.8]"),
};

/** Pipeline steps until their tickets land (ingest is real for GitHub: see defaults.ts). */
export const unbuiltPipeline: PipelinePort = {
  ingest: () => notBuilt("ingest", "[4.2]"),
  // TODO([3.8] env build): build the env image and return its envs.id / snapshot.
  buildEnv: () => notBuilt("env build", "[3.8]"),
  // TODO([4.x] proof suite on the scoring computer, plan 17.2 rule 9).
  prove: () => notBuilt("the proof suite", "[4.x proof]"),
  // Real in defaults.ts (billingEstimate over packages/billing estimateRunCost).
  estimate: () => notBuilt("the run cost estimate", "[10.12]"),
  // TODO([5.8]/TDM-174 [16.3]): scoreKit over the gated trial results.
  score: () => notBuilt("scoring", "[5.8]"),
};

export const noSessionCanceller: SessionCanceller = {
  cancelRunSessions: async () => 0,
};

// ---------- runs.stage_outputs ----------

/**
 * runs.stage_outputs: what the orchestrator keeps between stages. Written only together with the
 * state change that consumes it (or, for proof/estimate, before it), so a crashed stage reruns.
 */
export const RunStageOutputsShape = z.looseObject({
  understand: UnderstandingSchema.optional(),
  research: ResearchSchema.optional(),
  env: EnvBuildSchema.optional(),
  score: z.unknown().optional(),
  /** Set when the proof stage accepted a curated kit's signed-off offline proof. */
  proof_basis: ProofBasisSchema.optional(),
  /** TDM-60: the kit frozen at Go (orchestrator/prereg.ts PreregSchema), checked before trials. */
  prereg: z.unknown().optional(),
  /** needs_human / paused_budget: the state to resume into. */
  held_from: RunStateSchema.optional(),
  hold_reason: z.string().optional(),
  /** failed: where our pipeline broke (the report's postmortem). */
  failure: z.object({ stage: RunStateSchema, reason: z.string() }).optional(),
  /** Terminal cleanup done (sessions, trials, billing hook). */
  finalized_at: z.string().optional(),
});
export type RunStageOutputs = z.infer<typeof RunStageOutputsShape>;
