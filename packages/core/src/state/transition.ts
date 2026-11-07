// Shared result and error types for the run and trial state machines (plan.md section 5).
// Transitions are pure: they never throw on a bad command, they return a typed error.

export const TRANSITION_ERROR_CODES = [
  /** No edge for this command from this state. */
  "illegal_transition",
  /** The state is terminal; nothing moves out of it. */
  "terminal_state",
  /** A `resume` named a target that the held state may not resume into. */
  "invalid_resume_target",
  /** `go` was issued but the estimate or the billing gate does not pass. */
  "gate_blocked",
  /** The kit designer already used every proof repair. */
  "repair_exhausted",
  /** The trial already used every `failed_infra` retry. */
  "retry_exhausted",
] as const;

export type TransitionErrorCode = (typeof TRANSITION_ERROR_CODES)[number];

export interface TransitionError<S extends string, K extends string> {
  code: TransitionErrorCode;
  from: S;
  command: K;
  message: string;
}

export type TransitionResult<S extends string, C extends { type: string }> =
  { ok: true; from: S; to: S; command: C } | { ok: false; error: TransitionError<S, C["type"]> };

export function transitionFailure<S extends string, C extends { type: string }>(
  code: TransitionErrorCode,
  from: S,
  command: C,
  message: string,
): TransitionResult<S, C> {
  return { ok: false, error: { code, from, command: command.type, message } };
}
