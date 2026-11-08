// Trial traces (observability into a trial): what each agent session did, when, and where the
// time went. Built server-side from the trial's frozen out.tar.gz (the agent transcripts and, for
// Tandem, the board dump) after the gate has scored it; stored as a server-owned artifact the
// runner cannot write. Served by GET /trials/:id/trace and summarised per setup by
// GET /runs/:id/trace-summary.
//
// Every time is milliseconds from the trial's `running` phase (t = 0), on the eval computer's own
// clock (transcripts and runner events share it). Everything that came from a transcript is
// agent-controlled text: it is redacted and clipped before it is stored, and rendered as text.
//
// Honesty: a field is null when the transcript doesn't carry it (e.g. per-turn token usage, which
// the model proxy streams as zeros), and `notes` says what could not be derived. Nothing here is a
// score; the run's report stays the only verdict.
import { z } from "zod";
import { ContenderIdSchema, RunIdSchema, TrialIdSchema } from "../ids.js";
import { NonNegativeMicroUsdSchema } from "../money.js";

export const TRACE_VERSION = 1;

/**
 * What a step is:
 * - `model`: one model turn (from the previous event to the turn's last block);
 * - `tool`: a tool call in the workspace (Bash, Write, Edit, Read, ...);
 * - `board`: a call to the coordination board (Tandem MCP), except waiting;
 * - `wait`: blocked on the board (Tandem `queue_wait`).
 */
export const TRACE_STEP_KINDS = ["model", "tool", "board", "wait"] as const;
export const TraceStepKindSchema = z.enum(TRACE_STEP_KINDS);
export type TraceStepKind = z.infer<typeof TraceStepKindSchema>;

const Ms = z.int().nonnegative();

export const TraceStepSchema = z.object({
  kind: TraceStepKindSchema,
  start_ms: Ms,
  end_ms: Ms,
  /** "model turn", or the tool name (board tools without their `mcp__tandem__` prefix). */
  name: z.string().max(120),
  /** Short, redacted input: the command, the file path, the board call's arguments. */
  input: z.string().max(400).optional(),
  /** Short, redacted output: the model's text, or the tool result. */
  output: z.string().max(400).optional(),
  /** Tool result: false when the tool reported an error. */
  ok: z.boolean().optional(),
  /** The step ran the project's tests. */
  test: z.boolean().optional(),
  /** e.g. "pass 6 · fail 0", when the test output says so. */
  test_summary: z.string().max(120).optional(),
  /** Workspace files the step wrote or edited (relative paths). */
  files: z.array(z.string().max(300)).max(50).optional(),
  /** Model turns only, when the transcript carries per-turn usage (often it does not). */
  tokens: z
    .object({
      input: z.int().nonnegative(),
      output: z.int().nonnegative(),
      cache_read: z.int().nonnegative(),
      cache_write: z.int().nonnegative(),
    })
    .optional(),
  /** Model turns only: the turn's only calls were to the board (it decided a board move). */
  board_turn: z.boolean().optional(),
  /** Still running when the transcript ended (no result came back). */
  open: z.boolean().optional(),
});
export type TraceStep = z.infer<typeof TraceStepSchema>;

/** Time an actor was not doing anything the transcript shows. */
export const TraceGapSchema = z.object({
  kind: z.enum(["not_started", "idle", "finished"]),
  start_ms: Ms,
  end_ms: Ms,
});
export type TraceGap = z.infer<typeof TraceGapSchema>;

export const TraceTokensSchema = z.object({
  input: Ms,
  output: Ms,
  cache_read: Ms,
  cache_write: Ms,
});
export type TraceTokens = z.infer<typeof TraceTokensSchema>;

export const TraceActorTotalsSchema = z.object({
  model_ms: Ms,
  tool_ms: Ms,
  board_ms: Ms,
  wait_ms: Ms,
  /** Part of model_ms spent in turns whose only calls were to the board. */
  model_board_ms: Ms,
  /** Inside the session, covered by no step. */
  idle_ms: Ms,
  /** Session length (start to end). */
  session_ms: Ms,
  turns: Ms,
  tool_calls: Ms,
  tool_errors: Ms,
  board_calls: Ms,
  test_runs: Ms,
  /** From the session's result line; null when the session never wrote one. */
  tokens: TraceTokensSchema.nullable(),
  /**
   * Claude Code's own list-price estimate for the session (`total_cost_usd`), in micro-USD. The
   * billed cost is the trial's proxy cost; this only splits it between sessions.
   */
  cost_micro_usd: NonNegativeMicroUsdSchema.nullable(),
});
export type TraceActorTotals = z.infer<typeof TraceActorTotalsSchema>;

export const TRACE_ACTOR_ROLES = ["solo", "planner", "worker", "subagent"] as const;

export const TraceActorSchema = z.object({
  /** "agent", "planner", "worker-1", ... */
  id: z.string().min(1).max(80),
  role: z.enum(TRACE_ACTOR_ROLES),
  start_ms: Ms,
  end_ms: Ms,
  steps: z.array(TraceStepSchema),
  gaps: z.array(TraceGapSchema),
  totals: TraceActorTotalsSchema,
  /** How the session ended: "success", "error_max_turns", ..., or null without a result line. */
  outcome: z.string().max(60).nullable(),
  /** Steps dropped past the per-actor cap (the totals still count them). */
  truncated_steps: Ms,
});
export type TraceActor = z.infer<typeof TraceActorSchema>;

export const TRACE_COORD_KINDS = [
  "epic_proposed",
  "approved",
  "task_created",
  "claimed",
  "lost_claim",
  "task_done",
] as const;

/** A board event (Tandem), from the board dump. */
export const TraceCoordEventSchema = z.object({
  at_ms: Ms,
  kind: z.enum(TRACE_COORD_KINDS),
  actor: z.string().max(80).nullable(),
  ticket: z.string().max(40).nullable(),
  title: z.string().max(200).nullable(),
});
export type TraceCoordEvent = z.infer<typeof TraceCoordEventSchema>;

/**
 * Wall time split by what was happening across ALL actors at each moment, in priority order:
 * any model turn in flight → model; else any workspace tool → tool; else any board call or wait →
 * coordination; else nothing the transcripts show (startup, teardown, between sessions) → idle.
 * The four add up to `duration_ms` (to the 10 ms resolution it is computed at).
 */
export const TraceWallSchema = z.object({
  model_ms: Ms,
  tool_ms: Ms,
  coordination_ms: Ms,
  idle_ms: Ms,
});
export type TraceWall = z.infer<typeof TraceWallSchema>;

/** Contiguous stretches of the trial: setup, planning, work, teardown. */
export const TracePhaseSchema = z.object({
  name: z.enum(["setup", "planning", "work", "teardown"]),
  start_ms: Ms,
  end_ms: Ms,
});
export type TracePhase = z.infer<typeof TracePhaseSchema>;

export const TraceFailingTestSchema = z.object({
  gate: z.string().max(80),
  file: z.string().max(200).nullable(),
  name: z.string().max(300),
  message: z.string().max(600),
});

export const TraceRelatedStepSchema = z.object({
  actor: z.string().max(80),
  step: Ms,
  /** Why it was picked: the failing test's terms it mentions, or the file it wrote. */
  why: z.string().max(200),
});

export const TraceFailureSchema = z.object({
  gates: z.array(
    z.object({ gate: z.string().max(80), reason: z.string().max(1000), applicable: z.boolean() }),
  ),
  /** From the gate's reason: only the first failing test is recorded. */
  passed: Ms.nullable(),
  total: Ms.nullable(),
  tests: z.array(TraceFailingTestSchema),
  /** Workspace files the agents wrote that match the failing test's terms. */
  files: z.array(z.string().max(300)),
  /** Steps that wrote those files or mention the test's terms (a lead, not a proven cause). */
  related: z.array(TraceRelatedStepSchema),
  /** The terms matched. */
  terms: z.array(z.string().max(40)),
});
export type TraceFailure = z.infer<typeof TraceFailureSchema>;

export const TrialTraceSchema = z.object({
  version: z.literal(TRACE_VERSION),
  trial_id: TrialIdSchema,
  /** e.g. "claude-code-solo", "tandem" (versions.json). */
  setup: z.string().max(80).nullable(),
  /** The trial's `running` phase, ISO (t = 0). */
  started_at: z.string().max(40).nullable(),
  duration_ms: Ms,
  actors: z.array(TraceActorSchema),
  coordination: z.array(TraceCoordEventSchema),
  phases: z.array(TracePhaseSchema),
  wall: TraceWallSchema,
  /** Null when every applicable gate passed (or the trial has no gate record). */
  failure: TraceFailureSchema.nullable(),
  /** Files in the bundle the trace was built from. */
  sources: z.array(z.string().max(200)),
  /** What could not be derived, in plain words. */
  notes: z.array(z.string().max(300)),
  built_at: z.string().max(40),
});
export type TrialTrace = z.infer<typeof TrialTraceSchema>;

// ---------------------------------------------------------------------------------------------
// Run summary: where the time went, per setup and task, averaged over the traced trials.

const Avg = z.number().nonnegative();

export const TraceAverageSchema = z.object({
  /** Trials with a trace in this cell. */
  n: Ms,
  /** Gate-passing trials among them. */
  passed: Ms,
  duration_ms: Avg,
  wall: z.object({
    model_ms: Avg,
    tool_ms: Avg,
    coordination_ms: Avg,
    idle_ms: Avg,
  }),
  /** Summed over every session of the trial (3 workers in parallel count 3×). */
  agent_ms: z.object({
    model_ms: Avg,
    /** Part of model_ms in turns whose only calls were to the board. */
    model_board_ms: Avg,
    tool_ms: Avg,
    board_ms: Avg,
    wait_ms: Avg,
  }),
  sessions: Avg,
  turns: Avg,
  tool_calls: Avg,
  board_calls: Avg,
  lost_claims: Avg,
  /** Trials whose every session reported tokens; null when none did. */
  tokens: z
    .object({ n: Ms, input: Avg, output: Avg, cache_read: Avg, cache_write: Avg })
    .nullable(),
});
export type TraceAverage = z.infer<typeof TraceAverageSchema>;

export const RunTraceSummarySchema = z.object({
  run_id: RunIdSchema,
  setups: z.array(
    z.object({
      contender_id: ContenderIdSchema,
      setup: z.string().max(80).nullable(),
      /** Trials of this setup without a trace (not finished, or no bundle). */
      missing: Ms,
      all: TraceAverageSchema,
      by_task: z.array(TraceAverageSchema.extend({ workload_id: z.string().min(1) })),
    }),
  ),
});
export type RunTraceSummary = z.infer<typeof RunTraceSummarySchema>;
