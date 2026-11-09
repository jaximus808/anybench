// TDM-232 [18.11]: whether a trial left a frozen workspace, recorded on the trial
// (`trials.frozen_workspace`), and what grading did with it.
//
// The runner always collects, freezes and uploads after a subject failure (packages/runner
// runner.ts). A trial that ends `failed_subject` because it hit the wall-clock or token cap, or
// because its driver exited non-zero after working, has real outputs: its frozen workspace is
// graded like any other (trial.gate), and its outcome stays `failed_subject`. The fact that
// decides it is read from the runner's manifest.json by the worker when the trial ends, never
// inferred from the state or the failure class:
//
//   present   manifest.json exists for this attempt and lists at least one file besides the
//             runner's own logs and probes (FROZEN_RUNNER_OWN_FILES).
//   grading   pending      present, the gate has not written its verdict yet (the run waits);
//             graded       the gate scored the frozen outputs (trials.gate holds the verdict);
//             unavailable  present, but our scoring could not grade it (no bundle in the store,
//                          the scoring computer failed past its retries, the kit did not load):
//                          the trial counts as failed with no partial credit;
//             none         nothing to grade (no manifest, or only the runner's own files).
//
// An infra failure (failed_infra: the computer died, no frozen workspace) is unchanged: excluded
// from scoring, retried, never billed.
import { z } from "zod";

/** Files the runner writes into ~/eval/out itself: their presence is not the subject's work. */
export const FROZEN_RUNNER_OWN_FILES = [
  "stdout.log",
  "stderr.log",
  "machine.json",
  "network.json",
  "manifest.json",
  "events.jsonl",
  "status.json",
] as const;

export const FROZEN_GRADINGS = ["pending", "graded", "unavailable", "none"] as const;
export const FrozenGradingSchema = z.enum(FROZEN_GRADINGS);
export type FrozenGrading = z.infer<typeof FrozenGradingSchema>;

export const FrozenWorkspaceSchema = z.strictObject({
  /** manifest.json present for this attempt with at least one workspace file. */
  present: z.boolean(),
  /** manifest.json was found and parsed (for this attempt). */
  manifest: z.boolean(),
  /** Files the manifest lists. */
  files: z.int().nonnegative(),
  /** Of which are not the runner's own (FROZEN_RUNNER_OWN_FILES). */
  workspace_files: z.int().nonnegative(),
  /** The manifest's `frozen_at`, when it had one. */
  frozen_at: z.string().nullable(),
  grading: FrozenGradingSchema,
  /** Why grading is `unavailable` or `none`. */
  reason: z.string().optional(),
});
export type FrozenWorkspace = z.infer<typeof FrozenWorkspaceSchema>;

/** The stored column, or null when it is absent or not a FrozenWorkspace (older trials). */
export function frozenWorkspaceOf(raw: unknown): FrozenWorkspace | null {
  const r = FrozenWorkspaceSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** A failed_subject trial whose frozen workspace is still waiting for its gate. */
export function frozenGradingPending(state: string, raw: unknown): boolean {
  return state === "failed_subject" && frozenWorkspaceOf(raw)?.grading === "pending";
}

/** Why a failed_subject trial stopped, in words, from its failure_class (runner or executor). */
export function subjectStopWords(failureClass: string | null | undefined): string {
  switch (failureClass) {
    case "budget":
      return "stopped at the token cap";
    case "wall_clock_exceeded":
    case "wall_clock":
      return "stopped at the wall-clock cap";
    case "run_failed":
      return "its driver exited non-zero";
    case "warmup_failed":
      return "a warm-up failed";
    case "start_failed":
      return "its driver did not start";
    case "healthcheck_failed":
      return "its healthcheck failed";
    case "not_ready":
      return "its driver never became ready";
    case "unrequested_cancel":
      return "it cancelled itself";
    case null:
    case undefined:
    case "":
      return "failed";
    default:
      return `failed (${failureClass})`;
  }
}

/**
 * The one-line account of a failed_subject trial for the report and the trial view, e.g.
 * "stopped at the token cap; graded on its frozen workspace (87 of 120 hidden tests)".
 */
export function subjectFailureNote(input: {
  failureClass: string | null | undefined;
  frozen: unknown;
  /** The graded trial's hidden-test fraction, when its gate wrote one. */
  hiddenTestFraction?: number | undefined;
  hiddenTestsPassed?: number | undefined;
  hiddenTestsTotal?: number | undefined;
}): string {
  const stop = subjectStopWords(input.failureClass);
  const frozen = frozenWorkspaceOf(input.frozen);
  switch (frozen?.grading) {
    case "graded": {
      const { hiddenTestsPassed: k, hiddenTestsTotal: n, hiddenTestFraction: f } = input;
      const detail =
        k !== undefined && n !== undefined
          ? ` (${k} of ${n} hidden tests)`
          : f !== undefined
            ? ` (hidden tests ${Math.round(f * 1000) / 10}%)`
            : "";
      return `${stop}; graded on its frozen workspace${detail}`;
    }
    case "pending":
      return `${stop}; grading its frozen workspace`;
    case "unavailable":
      return `${stop}; its frozen workspace could not be graded (our scoring failed${frozen.reason ? `: ${frozen.reason}` : ""}), counted as a fail with no partial credit`;
    default:
      return `${stop}; no frozen workspace to grade, counted as a fail`;
  }
}
