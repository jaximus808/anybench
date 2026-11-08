// TDM-186 [16.15]: the task miner's records (contract C4 in the kit-builder plan).
//
// A *candidate* is a commit that changed tests together with non-test source (the fix). A *mined
// task* is a candidate that verified on a fresh, history-free snapshot of its parent: the changed
// tests fail before the fix and pass after it, the same way in every run. The task record is
// designer material (kit designer, TDM-60): it lands under `mined/` in the kit, never under
// `workloads/`, and it carries the failing-test output BEFORE the fix as the raw material for
// symptom-only issue text. It never carries the diff or the test source.
import { z } from "zod";

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "must be a relative path");

export const MINED_TASK_RECORD_VERSION = "anybench.mined-task/v1";
export const MINED_TASK_ID_RE = /^mined-[a-f0-9]{10}$/;

export const MineFileChangeSchema = z.strictObject({
  path: RelPath,
  status: z.enum(["added", "modified"]),
  added: z.int().min(0),
  deleted: z.int().min(0),
});
export type MineFileChange = z.infer<typeof MineFileChangeSchema>;

export const MineCandidateSchema = z.strictObject({
  sha: Sha,
  parent: Sha,
  author_date: z.iso.datetime({ offset: true }),
  commit_date: z.iso.datetime({ offset: true }),
  /** For the report only. Never issue-text material: subjects routinely name the fix. */
  subject: z.string(),
  test_files: z.array(MineFileChangeSchema).min(1),
  fix_files: z.array(MineFileChangeSchema).min(1),
  /** Changed docs / changelog files that are neither test nor fix (not part of the oracle). */
  ignored_files: z.array(RelPath),
  stats: z.strictObject({
    files_changed: z.int().min(0),
    test_lines: z.int().min(0),
    fix_lines: z.int().min(0),
  }),
});
export type MineCandidate = z.infer<typeof MineCandidateSchema>;

export const MINE_DROP_CODES = [
  // selection (from the commit alone)
  "merge",
  "root_commit",
  "shallow_boundary",
  "no_test_change",
  "docs_only",
  "lockfile_only",
  "vendored_only",
  "tests_only",
  "no_source_change",
  "deletes_or_renames",
  "binary_change",
  "too_large",
  "over_limit",
  // verification (on the computer)
  "no_runner",
  "no_runnable_tests",
  "history_leak",
  "install_failed",
  "no_tests_ran",
  "passes_before_fix",
  "fails_after_fix",
  "flaky",
  "verify_error",
] as const;
export const MineDropCodeSchema = z.enum(MINE_DROP_CODES);
export type MineDropCode = z.infer<typeof MineDropCodeSchema>;

export const MineDropSchema = z.strictObject({
  sha: Sha,
  stage: z.enum(["select", "verify"]),
  code: MineDropCodeSchema,
  detail: z.string(),
});
export type MineDrop = z.infer<typeof MineDropSchema>;

export const TEST_RUNNER_KINDS = [
  "node-test",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "go",
  "cargo",
] as const;
export const TestRunnerKindSchema = z.enum(TEST_RUNNER_KINDS);
export type TestRunnerKind = z.infer<typeof TestRunnerKindSchema>;

/** How to run a task's tests, as data (the gate and the proof stage replay it verbatim). */
export const MineRunnerSpecSchema = z.strictObject({
  kind: TestRunnerKindSchema,
  /** Run once in the workspace root before the tests (dependency install), or null. */
  install_command: z.string().min(1).nullable(),
  /**
   * Run in the workspace root. Writes machine-readable results to "$AB_RESULT" when the runner
   * has a JSON reporter (vitest, jest, mocha); otherwise its stdout+stderr is the result.
   */
  test_command: z.string().min(1),
  /** The test files passed to the runner (empty = the runner's own discovery). */
  targets: z.array(RelPath),
  /** Extra non-secret env the commands need (CI=1, NO_COLOR=1, ...). */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
});
export type MineRunnerSpec = z.infer<typeof MineRunnerSpecSchema>;

export const TestOutcomeSchema = z.enum(["pass", "fail", "skip"]);
export type TestOutcome = z.infer<typeof TestOutcomeSchema>;

export const MineRunSummarySchema = z.strictObject({
  exit_code: z.int(),
  passed: z.int().min(0),
  failed: z.int().min(0),
  skipped: z.int().min(0),
  duration_ms: z.int().min(0),
});
export type MineRunSummary = z.infer<typeof MineRunSummarySchema>;

export const MineSymptomSchema = z.strictObject({
  /** A FAIL_TO_PASS test id. */
  test: z.string().min(1),
  /** The runner's failure text for it before the fix (assertion message, error), capped. */
  message: z.string(),
});
export type MineSymptom = z.infer<typeof MineSymptomSchema>;

export const MinedTaskSchema = z.strictObject({
  record: z.literal(MINED_TASK_RECORD_VERSION),
  /** Workload id. A hash of the commit, so the id itself does not point at the upstream fix. */
  id: z.string().regex(MINED_TASK_ID_RE),
  source: z.strictObject({
    /** The repo's GitHub URL when known. */
    repo: z.string().optional(),
    commit: Sha,
    parent: Sha,
    author_date: z.iso.datetime({ offset: true }),
    commit_date: z.iso.datetime({ offset: true }),
  }),
  /** Commit date relative to a model's training cutoff, when one was given. */
  cutoff: z
    .strictObject({
      model_cutoff: z.iso.date(),
      after_cutoff: z.boolean(),
      days_after_cutoff: z.int(),
    })
    .optional(),
  held_out: z.boolean(),
  /** The module the fix lives in (common directory of the fix files, ≤2 levels), for grouping. */
  area: z.string().min(1),
  files: z.strictObject({
    test_files: z.array(MineFileChangeSchema).min(1),
    fix_files: z.array(MineFileChangeSchema).min(1),
    ignored_files: z.array(RelPath),
  }),
  diff_stats: z.strictObject({
    files_changed: z.int().min(0),
    test_lines: z.int().min(0),
    fix_lines: z.int().min(0),
  }),
  runner: MineRunnerSpecSchema,
  fail_to_pass: z.array(z.string().min(1)).min(1),
  pass_to_pass: z.array(z.string().min(1)),
  /** Tests that flipped between runs of one state; kept out of PASS_TO_PASS. */
  flaky_excluded: z.array(z.string().min(1)),
  /** Tests that passed before and fail after (the fix broke them upstream); not graded. */
  pass_to_fail: z.array(z.string().min(1)),
  runs: z.strictObject({
    before: z.array(MineRunSummarySchema).min(1),
    after: z.array(MineRunSummarySchema).min(1),
  }),
  /** Raw material for user-visible symptom issue text: what the failing tests printed. */
  symptoms: z.array(MineSymptomSchema),
  /** The tail of the first before-fix run's output (ANSI stripped, capped). */
  before_output_excerpt: z.string(),
});
export type MinedTask = z.infer<typeof MinedTaskSchema>;

export const MinedTaskGroupSchema = z.strictObject({
  id: z.string().regex(/^group-[0-9]{2,}$/),
  area: z.string().min(1),
  task_ids: z.array(z.string().regex(MINED_TASK_ID_RE)).min(1),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  held_out_tasks: z.int().min(0),
});
export type MinedTaskGroup = z.infer<typeof MinedTaskGroupSchema>;

export const MineReportSchema = z.strictObject({
  record: z.literal("anybench.mine-report/v1"),
  repo: z.string().optional(),
  head: Sha,
  commits_scanned: z.int().min(0),
  candidates: z.int().min(0),
  verified: z.int().min(0),
  held_out: z.int().min(0),
  task_ids: z.array(z.string().regex(MINED_TASK_ID_RE)),
  drop_counts: z.partialRecord(MineDropCodeSchema, z.int().min(1)),
  /** Every verify-stage drop, plus the select-stage drops other than no_test_change (capped). */
  dropped: z.array(MineDropSchema),
});
export type MineReport = z.infer<typeof MineReportSchema>;
