// Run state machine (`runs.state`), plan.md section 5.
//
//   intake → understand → research → kit_draft → env_build → proof → awaiting_go
//          → running → scoring → analyzing → delivered
//   plus failed, needs_human, paused_budget, cancelled.
//
// The worker owns transitions; the API only enqueues commands (validated with RunCommandSchema).
// `needs_human` and `paused_budget` are holds, not ends: the caller records the state it held from
// (e.g. `runs.paused_reason`) and resumes with `{type: "resume", to}`. Terminal: delivered, failed,
// cancelled.

import { z } from "zod";
import { transitionFailure, type TransitionResult } from "./transition.js";

/** The happy path, in order. */
export const RUN_STAGES = [
  "intake",
  "understand",
  "research",
  "kit_draft",
  "env_build",
  "proof",
  "awaiting_go",
  "running",
  "scoring",
  "analyzing",
  "delivered",
] as const;

export const RUN_STATES = [
  ...RUN_STAGES,
  "failed",
  "needs_human",
  "paused_budget",
  "cancelled",
] as const;

export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;

export const RUN_TERMINAL_STATES = [
  "delivered",
  "failed",
  "cancelled",
] as const satisfies readonly RunState[];
export const RUN_HOLD_STATES = [
  "needs_human",
  "paused_budget",
] as const satisfies readonly RunState[];

/** The kit designer repairs a failing kit up to 2 times, then the run goes to `needs_human` (plan.md section 2). */
export const RUN_MAX_PROOF_REPAIRS = 2;

/** States an agent or a human can get stuck in. `awaiting_go` already waits on its own gate. */
export const RUN_NEEDS_HUMAN_FROM = [
  "intake",
  "understand",
  "research",
  "kit_draft",
  "env_build",
  "proof",
  "running",
  "scoring",
  "analyzing",
] as const satisfies readonly RunState[];

/** States that spend money, so the per-run cap can pause them. */
export const RUN_PAUSE_BUDGET_FROM = [
  "understand",
  "research",
  "kit_draft",
  "env_build",
  "proof",
  "running",
  "scoring",
  "analyzing",
] as const satisfies readonly RunState[];

const reason = z.string().min(1);

export const RunCommandSchema = z.discriminatedUnion("type", [
  /** Finish the current stage and move to the next one on the happy path. Not valid from `awaiting_go`. */
  z.object({ type: z.literal("advance") }),
  /** Leave `awaiting_go`. Passes only when the estimate fits the run budget and the billing gate passes. */
  z.object({
    type: z.literal("go"),
    estimate_fits_budget: z.boolean(),
    billing_gate_passed: z.boolean(),
  }),
  /** Proof failed: send the kit back to the kit designer. `repairs_so_far` counts earlier repairs of this run. */
  z.object({ type: z.literal("repair"), repairs_so_far: z.number().int().nonnegative() }),
  z.object({ type: z.literal("needs_human"), reason }),
  z.object({ type: z.literal("pause_budget"), reason: reason.optional() }),
  /** Leave a hold. `to` is the state the run held from (or an earlier stage a human chose). */
  z.object({ type: z.literal("resume"), to: RunStateSchema }),
  z.object({ type: z.literal("fail"), reason }),
  z.object({ type: z.literal("cancel"), reason: reason.optional() }),
]);
export type RunCommand = z.infer<typeof RunCommandSchema>;
export type RunCommandType = RunCommand["type"];
export const RUN_COMMAND_TYPES = RunCommandSchema.options.map(
  (o) => o.shape.type.value,
) as readonly RunCommandType[];

export type RunTransitionResult = TransitionResult<RunState, RunCommand>;

type RunTable = Record<RunState, Partial<Record<RunCommandType, readonly RunState[]>>>;

function buildRunTable(): RunTable {
  const table = Object.fromEntries(RUN_STATES.map((s) => [s, {}])) as RunTable;
  for (let i = 0; i < RUN_STAGES.length - 1; i++) {
    const from = RUN_STAGES[i]!;
    const to = RUN_STAGES[i + 1]!;
    if (from === "awaiting_go") table[from].go = [to];
    else table[from].advance = [to];
  }
  table.proof.repair = ["kit_draft"];
  for (const s of RUN_NEEDS_HUMAN_FROM) table[s].needs_human = ["needs_human"];
  for (const s of RUN_PAUSE_BUDGET_FROM) table[s].pause_budget = ["paused_budget"];
  table.needs_human.resume = RUN_NEEDS_HUMAN_FROM;
  table.paused_budget.resume = RUN_PAUSE_BUDGET_FROM;
  for (const s of RUN_STATES) {
    if (isTerminalRunState(s)) continue;
    table[s].fail = ["failed"];
    table[s].cancel = ["cancelled"];
  }
  return table;
}

export function isTerminalRunState(state: RunState): boolean {
  return (RUN_TERMINAL_STATES as readonly RunState[]).includes(state);
}

/**
 * The full transition table: for each state, each command it accepts and the states that command
 * may lead to (one, except `resume`). Read-only; use `transitionRun` to move.
 */
export const RUN_TRANSITIONS: Readonly<RunTable> = buildRunTable();

/** True when some command moves `from` to `to`. Used to validate `run.state_changed` events. */
export function isLegalRunEdge(from: RunState, to: RunState): boolean {
  return Object.values(RUN_TRANSITIONS[from]).some((targets) => targets.includes(to));
}

/** Apply one command to a run state. Pure; returns the next state or a typed error. */
export function transitionRun(state: RunState, command: RunCommand): RunTransitionResult {
  if (isTerminalRunState(state)) {
    return transitionFailure(
      "terminal_state",
      state,
      command,
      `run is ${state}, which is terminal`,
    );
  }
  const targets = RUN_TRANSITIONS[state][command.type];
  if (!targets) {
    return transitionFailure(
      "illegal_transition",
      state,
      command,
      `run cannot ${command.type} from ${state}`,
    );
  }
  switch (command.type) {
    case "go":
      if (!command.estimate_fits_budget || !command.billing_gate_passed) {
        const why = [
          command.estimate_fits_budget ? null : "estimate exceeds the run budget",
          command.billing_gate_passed ? null : "billing gate did not pass",
        ].filter(Boolean);
        return transitionFailure(
          "gate_blocked",
          state,
          command,
          `run stays in awaiting_go: ${why.join("; ")}`,
        );
      }
      break;
    case "repair":
      if (command.repairs_so_far >= RUN_MAX_PROOF_REPAIRS) {
        return transitionFailure(
          "repair_exhausted",
          state,
          command,
          `proof already repaired ${command.repairs_so_far} times (max ${RUN_MAX_PROOF_REPAIRS}); use needs_human`,
        );
      }
      break;
    case "resume":
      if (!targets.includes(command.to)) {
        return transitionFailure(
          "invalid_resume_target",
          state,
          command,
          `run cannot resume from ${state} into ${command.to}`,
        );
      }
      return { ok: true, from: state, to: command.to, command };
    default:
      break;
  }
  return { ok: true, from: state, to: targets[0]!, command };
}
