// Trial routes (plan.md sections 5 and 6): the tile grid, the trial drawer, log tail and
// transcript. Tickets 7.3, 8.3 and 8.5. Runner ingest lives in runner.ts.
import { z } from "zod";
import { ComputerIdSchema, ContenderIdSchema, RunIdSchema, TrialIdSchema } from "../ids.js";
import { NonNegativeMicroUsdSchema } from "../money.js";
import { GateResultSchema } from "../schemas/requirement.js";
import { FrozenWorkspaceSchema } from "../schemas/frozen-workspace.js";
import { ComputeProviderNameSchema } from "../schemas/env.js";
import { TrialStateSchema } from "../state/trial.js";
import { IsoDateTimeSchema, PageQuerySchema, csvListSchema, pageOf } from "./common.js";
import { defineRoute, defineRoutes } from "./route.js";
import { RunTraceSummarySchema, TrialTraceSchema } from "./trace.js";

/** Failure taxonomy (plan.md P4). `infra` is ours: retried, never billed. */
export const FAILURE_CLASSES = ["infra", "subject", "gate", "kit", "budget", "timeout"] as const;
export const FailureClassSchema = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const TrialSchema = z.object({
  id: TrialIdSchema,
  run_id: RunIdSchema,
  contender_id: ContenderIdSchema,
  workload_id: z.string().min(1),
  repeat: z.int().nonnegative(),
  attempt: z.int().min(1),
  state: TrialStateSchema,
  failure_class: FailureClassSchema.nullable(),
  started_at: IsoDateTimeSchema.nullable(),
  ended_at: IsoDateTimeSchema.nullable(),
  cost_micro_usd: NonNegativeMicroUsdSchema,
});
export type Trial = z.infer<typeof TrialSchema>;

/**
 * TDM-252: one gate's verdict on the trial, as its `trial.gate` event has it: passed, the summary
 * (the gate's reason), and the hidden-test counts the gate vouched for (null when it gave none).
 */
export const TrialGateVerdictSchema = z.object({
  gate: z.string().min(1),
  passed: z.boolean(),
  /** false: the gate does not apply to this trial (it leaves the gate's tally). */
  applicable: z.boolean(),
  summary: z.string(),
  /** How the verdict was obtained (`verdict`, `timeout`, `no_outputs`, ...); null if unrecorded. */
  status: z.string().nullable(),
  evidence: z.array(z.string()),
  hidden_tests_passed: z.number().nullable(),
  hidden_tests_total: z.number().nullable(),
  hidden_test_fraction: z.number().nullable(),
});
export type TrialGateVerdict = z.infer<typeof TrialGateVerdictSchema>;

/**
 * The trial drawer. `metrics` are raw collector readings; they only count toward a score when
 * `gate.pass` is true (no speed or quality number without a correctness gate).
 */
export const TrialDetailSchema = TrialSchema.extend({
  computer_id: ComputerIdSchema.nullable(),
  provider: ComputeProviderNameSchema.nullable(),
  exit_code: z.int().nullable(),
  log_offset: z.int().nonnegative(),
  machine: z.record(z.string(), z.unknown()).nullable(),
  metrics: z.record(z.string(), z.number()).nullable(),
  /**
   * The trial's verdict over all its gates (TDM-252): pass when every applicable gate passed,
   * reason and evidence from each gate. Null until a gate has scored it.
   */
  gate: GateResultSchema.nullable(),
  /** TDM-252: each gate's own verdict (absent on servers before it; [] until gated). */
  gates: z.array(TrialGateVerdictSchema).optional(),
  versions: z.record(z.string(), z.string()),
  phases: z.array(z.object({ state: TrialStateSchema, at: IsoDateTimeSchema })),
  /**
   * TDM-232: whether the attempt froze a workspace and what grading did with it (absent on
   * servers before it, null for a trial that has not ended).
   */
  frozen_workspace: FrozenWorkspaceSchema.nullable().optional(),
  /**
   * TDM-232: what happened to a failed_subject trial, in words, e.g. "stopped at the token cap;
   * graded on its frozen workspace (87 of 120 hidden tests)". Null for any other state.
   */
  outcome_note: z.string().nullable().optional(),
});
export type TrialDetail = z.infer<typeof TrialDetailSchema>;

const trialParams = z.object({ id: TrialIdSchema });
export const LOG_TAIL_MAX_BYTES = 1024 * 1024;

export const trialRoutes = defineRoutes({
  list: defineRoute({
    id: "trials.list",
    method: "GET",
    path: "/runs/:id/trials",
    auth: ["session", "apiKey:runs:read"],
    summary: "A run's trials (contender × workload × repeat), for the tile grid.",
    params: z.object({ id: RunIdSchema }),
    query: PageQuerySchema.extend({
      state: csvListSchema(TrialStateSchema).optional(),
      contender_id: ContenderIdSchema.optional(),
    }),
    response: pageOf(TrialSchema),
  }),
  get: defineRoute({
    id: "trials.get",
    method: "GET",
    path: "/trials/:id",
    auth: ["session", "apiKey:runs:read"],
    summary: "One trial with its machine info, metrics and gate result (the trial drawer).",
    params: trialParams,
    response: z.object({ trial: TrialDetailSchema }),
  }),
  log: defineRoute({
    id: "trials.log",
    method: "GET",
    path: "/trials/:id/log",
    auth: ["session", "apiKey:logs:read"],
    summary: "Tail a trial log by byte offset (redacted). Poll with next_offset.",
    params: trialParams,
    query: z.object({
      stream: z.enum(["stdout", "stderr", "runner"]).default("stdout"),
      offset: z.coerce.number().int().nonnegative().default(0),
      bytes: z.coerce
        .number()
        .int()
        .min(1)
        .max(LOG_TAIL_MAX_BYTES)
        .default(64 * 1024),
    }),
    response: z.object({
      offset: z.int().nonnegative(),
      next_offset: z.int().nonnegative(),
      text: z.string(),
      /** True when the trial is final and next_offset is the end of the log. */
      eof: z.boolean(),
    }),
  }),
  trace: defineRoute({
    id: "trials.trace",
    method: "GET",
    path: "/trials/:id/trace",
    auth: ["session", "apiKey:runs:read"],
    summary:
      "What each agent session did and when (model turns, tool calls, board events), where the time went, and why the gate failed.",
    params: trialParams,
    response: z.object({ trace: TrialTraceSchema }),
  }),
  traceSummary: defineRoute({
    id: "trials.traceSummary",
    method: "GET",
    path: "/runs/:id/trace-summary",
    auth: ["session", "apiKey:runs:read"],
    summary:
      "Where the time went, per setup and task: model, tool and coordination time and tokens, averaged over the traced trials.",
    params: z.object({ id: RunIdSchema }),
    response: RunTraceSummarySchema,
  }),
  transcript: defineRoute({
    id: "trials.transcript",
    method: "GET",
    path: "/trials/:id/transcript",
    auth: ["session", "apiKey:logs:read"],
    summary: "The agent-under-test transcript (Claude Code stream-json), as turns or Markdown.",
    params: trialParams,
    query: z.object({ format: z.enum(["turns", "md", "raw"]).default("turns") }),
    response: z.object({
      format: z.enum(["turns", "md", "raw"]),
      turns: z
        .array(
          z.object({
            index: z.int().nonnegative(),
            role: z.enum(["assistant", "user", "system", "tool"]),
            text: z.string(),
            tool: z.string().optional(),
            input_tokens: z.int().nonnegative().optional(),
            output_tokens: z.int().nonnegative().optional(),
          }),
        )
        .optional(),
      text: z.string().optional(),
      /** `raw`: a presigned link to the full stream-json in object storage. */
      url: z.url().optional(),
      truncated: z.boolean(),
    }),
  }),
});
