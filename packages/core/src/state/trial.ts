// Trial state machine (`trials.state`), plan.md section 5.
//
//   queued → forking → installing → warming → running → collecting → gating → reviewing
//          → done | failed_infra | failed_subject | cancelled
//
// Only `failed_infra` retries: `{type: "retry", attempt}` moves it back to `queued`, and the caller
// then writes `trials.attempt = attempt + 1`. `attempt` is 1-based (the first try is attempt 1), so
// with TRIAL_MAX_INFRA_RETRIES = 3 a trial gets at most 4 tries. Backoff is exponential, see
// `trialRetryDelayMs`.

import { z } from "zod";
import { transitionFailure, type TransitionResult } from "./transition.js";

/** The happy path, in order. */
export const TRIAL_PHASES = [
  "queued",
  "forking",
  "installing",
  "warming",
  "running",
  "collecting",
  "gating",
  "reviewing",
  "done",
] as const;

export const TRIAL_STATES = [
  ...TRIAL_PHASES,
  "failed_infra",
  "failed_subject",
  "cancelled",
] as const;

export const TrialStateSchema = z.enum(TRIAL_STATES);
export type TrialState = z.infer<typeof TrialStateSchema>;

/** Where a trial ends up. `failed_infra` is final unless it is retried. */
export const TRIAL_FINAL_STATES = [
  "done",
  "failed_infra",
  "failed_subject",
  "cancelled",
] as const satisfies readonly TrialState[];

/** Final states nothing can move out of. */
export const TRIAL_TERMINAL_STATES = [
  "done",
  "failed_subject",
  "cancelled",
] as const satisfies readonly TrialState[];

/** Billed per trial that ended from the subject's side (plan.md section 8). `failed_infra` is never billed. */
export const TRIAL_BILLABLE_STATES = [
  "done",
  "failed_subject",
] as const satisfies readonly TrialState[];

export const TRIAL_MAX_INFRA_RETRIES = 3;
export const TRIAL_RETRY_BASE_DELAY_MS = 30_000;

/** Phases where the subject is on the machine, so a failure can be the subject's fault. */
export const TRIAL_FAIL_SUBJECT_FROM = [
  "installing",
  "warming",
  "running",
  "collecting",
  "gating",
  "reviewing",
] as const satisfies readonly TrialState[];

const reason = z.string().min(1);

export const TrialCommandSchema = z.discriminatedUnion("type", [
  /** Finish the current phase and move to the next one on the happy path. */
  z.object({ type: z.literal("advance") }),
  /** gating → done, for kits with no review rubric. */
  z.object({ type: z.literal("skip_review") }),
  z.object({ type: z.literal("fail_infra"), reason, failure_class: z.string().min(1).optional() }),
  z.object({
    type: z.literal("fail_subject"),
    reason,
    failure_class: z.string().min(1).optional(),
  }),
  /** failed_infra → queued. `attempt` is the trial's current 1-based `trials.attempt`. */
  z.object({ type: z.literal("retry"), attempt: z.number().int().positive() }),
  z.object({ type: z.literal("cancel"), reason: reason.optional() }),
]);
export type TrialCommand = z.infer<typeof TrialCommandSchema>;
export type TrialCommandType = TrialCommand["type"];

export type TrialTransitionResult = TransitionResult<TrialState, TrialCommand>;

type TrialTable = Record<TrialState, Partial<Record<TrialCommandType, TrialState>>>;

function buildTrialTable(): TrialTable {
  const table = Object.fromEntries(TRIAL_STATES.map((s) => [s, {}])) as TrialTable;
  for (let i = 0; i < TRIAL_PHASES.length - 1; i++) {
    table[TRIAL_PHASES[i]!].advance = TRIAL_PHASES[i + 1]!;
  }
  table.gating.skip_review = "done";
  for (const s of TRIAL_FAIL_SUBJECT_FROM) table[s].fail_subject = "failed_subject";
  for (const s of TRIAL_STATES) {
    if (isFinalTrialState(s)) continue;
    table[s].fail_infra = "failed_infra";
    table[s].cancel = "cancelled";
  }
  table.failed_infra.retry = "queued";
  // A trial waiting out its retry backoff is cancelled with its run instead of retrying.
  table.failed_infra.cancel = "cancelled";
  return table;
}

export function isFinalTrialState(state: TrialState): boolean {
  return (TRIAL_FINAL_STATES as readonly TrialState[]).includes(state);
}

export function isTerminalTrialState(state: TrialState): boolean {
  return (TRIAL_TERMINAL_STATES as readonly TrialState[]).includes(state);
}

export function isBillableTrialState(state: TrialState): boolean {
  return (TRIAL_BILLABLE_STATES as readonly TrialState[]).includes(state);
}

/** The full transition table: for each state, each command it accepts and where it leads. */
export const TRIAL_TRANSITIONS: Readonly<TrialTable> = buildTrialTable();

/** True when some command moves `from` to `to`. Used to validate `trial.phase` events. */
export function isLegalTrialEdge(from: TrialState, to: TrialState): boolean {
  return Object.values(TRIAL_TRANSITIONS[from]).includes(to);
}

/** Delay before retry number `attempt` (1-based attempt that just failed): 30 s, 60 s, 120 s. */
export function trialRetryDelayMs(attempt: number): number {
  return TRIAL_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
}

/** Apply one command to a trial state. Pure; returns the next state or a typed error. */
export function transitionTrial(state: TrialState, command: TrialCommand): TrialTransitionResult {
  if (isTerminalTrialState(state)) {
    return transitionFailure(
      "terminal_state",
      state,
      command,
      `trial is ${state}, which is terminal`,
    );
  }
  const to = TRIAL_TRANSITIONS[state][command.type];
  if (!to) {
    return transitionFailure(
      "illegal_transition",
      state,
      command,
      `trial cannot ${command.type} from ${state}`,
    );
  }
  if (command.type === "retry" && command.attempt > TRIAL_MAX_INFRA_RETRIES) {
    return transitionFailure(
      "retry_exhausted",
      state,
      command,
      `trial already retried ${command.attempt - 1} times (max ${TRIAL_MAX_INFRA_RETRIES})`,
    );
  }
  return { ok: true, from: state, to, command };
}
