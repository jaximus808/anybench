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
//   present   manifest.json exists for this attempt and lists at least one file under
//             workspace/ (FROZEN_WORKSPACE_DIR, TDM-248: the driver's stream.jsonl, versions.json
//             and logs are not a workspace).
//   grading   pending      present, the gate has not written its verdict yet (the run waits);
//             graded       the gate scored the frozen outputs (trials.gate holds the verdict);
//             unavailable  present, but our scoring could not grade it (no bundle in the store,
//                          the scoring computer failed past its retries, the kit did not load):
//                          the trial counts as failed with no partial credit;
//             none         nothing to grade (no manifest, or only the runner's own files).
//
// An infra failure (failed_infra: the computer died, no frozen workspace) is unchanged: excluded
// from scoring, retried, never billed.
//
// TDM-248 [21.8]: a failed_subject trial that OUR runner stopped (token cap, the run's budget
// stop, wall-clock cap) and whose workspace was then not frozen lost its work to us, not to the
// subject (harness league run 1: the runner killed the driver before it copied the workspace).
// It is "not graded (infra)" (workspaceLostByInfra): left out of scoring like failed_infra,
// never a 0, and the report names it. The runner now freezes the workspace itself after such a
// stop (`runner_froze`); a runner freeze that found nothing is the subject's empty workspace.
import { z } from "zod";

/** Where the frozen workspace sits in the outputs: every workspace gate reads $EVAL_OUT/workspace/. */
export const FROZEN_WORKSPACE_DIR = "workspace";

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
  /** Of which are under workspace/ (FROZEN_WORKSPACE_DIR). */
  workspace_files: z.int().nonnegative(),
  /**
   * TDM-248: the runner itself froze EVAL_WS after it stopped the subject (manifest.json
   * `workspace_freeze`, no error). Absent on manifests from older runners.
   */
  runner_froze: z.boolean().optional(),
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

/**
 * TDM-248: failure classes that mean our runner (or the executor) stopped the subject: the token
 * cap or the run's budget stop (`budget`), the wall-clock cap.
 */
export const RUNNER_STOP_FAILURE_CLASSES = ["budget", "wall_clock_exceeded", "wall_clock"] as const;

/** The verdict every workspace gate writes when the outputs carry no workspace/ at all. */
export const NO_WORKSPACE_VERDICT = /the outputs have no workspace\//;

/**
 * TDM-248: our infra lost this trial's workspace, so it is "not graded (infra)": a failed_subject
 * trial our runner stopped, with no runner freeze, and either nothing frozen (`grading: none`) or
 * a gate that found no workspace/ in the outputs (manifests from before TDM-248 counted the
 * driver's own logs as workspace files, so those trials were "graded" on nothing). Never true for
 * a trial the subject ended itself, for one the runner froze (even empty), or for one our scoring
 * could not grade (`unavailable`, TDM-232: a fail, since a contender could provoke that).
 */
export function workspaceLostByInfra(input: {
  state: string;
  failureClass: string | null | undefined;
  frozen: unknown;
  /** The trial's gate verdict reasons (its gate.json `reason`s). */
  gateReasons?: readonly string[];
  /** The graded hidden-test fraction, when its gate wrote one. */
  hiddenTestFraction?: number | undefined;
}): boolean {
  if (input.state !== "failed_subject") return false;
  if (!(RUNNER_STOP_FAILURE_CLASSES as readonly string[]).includes(input.failureClass ?? ""))
    return false;
  const f = frozenWorkspaceOf(input.frozen);
  if (!f || f.runner_froze === true) return false;
  if (f.grading === "none") return true;
  return (
    f.grading === "graded" &&
    input.hiddenTestFraction === undefined &&
    (input.gateReasons ?? []).some((r) => NO_WORKSPACE_VERDICT.test(r))
  );
}

/** TDM-248: the report's words for a trial whose workspace our infra lost. */
export const NOT_GRADED_INFRA =
  "not graded (infra): our runner stopped it before its workspace was saved, so it is left out of scoring (not counted as 0) and has to run again";

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
  /** TDM-248: the trial's gate verdict reasons, to recognise a workspace our infra lost. */
  gateReasons?: readonly string[];
  /** TDM-248: the trial's state (default failed_subject: the note is for those). */
  state?: string;
}): string {
  const stop = subjectStopWords(input.failureClass);
  const frozen = frozenWorkspaceOf(input.frozen);
  if (
    workspaceLostByInfra({
      state: input.state ?? "failed_subject",
      failureClass: input.failureClass,
      frozen: input.frozen,
      ...(input.gateReasons ? { gateReasons: input.gateReasons } : {}),
      hiddenTestFraction: input.hiddenTestFraction,
    })
  ) {
    return `${stop}; ${NOT_GRADED_INFRA}`;
  }
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
      return frozen?.runner_froze
        ? `${stop}; its workspace was frozen empty, counted as a fail`
        : `${stop}; no frozen workspace to grade, counted as a fail`;
  }
}
