// L5 gates and L6 review: requirements, correctness gates and the gate.json contract (plan.md P2).
//
// The core rule lives here and in KitSpecSchema: every `measured` requirement names a `gate_id`.
// No speed or quality number without a correctness gate.
import { z } from "zod";
import { KitGlobSchema, KitSlugSchema, KitPathSchema } from "./kit-primitives.js";

/** How a gate decides correctness. One per driver class in plan.md P2, plus `custom`. */
export const GateKindSchema = z.enum([
  "hidden-tests", // coding-agent, harness
  "output-diff", // cli: stdout/file diff against the oracle's output
  "response-diff", // service, web: golden request set
  "db-state", // service: DB state check
  "property-tests", // lib: against a reference implementation
  "reference-grid", // pty: VT parser grid, cell-by-cell + scrollback line hashes
  "a11y-tree", // x11: AT-SPI or the app's export file
  "dom-assert", // web
  "labeled-answers", // http-agent: labeled answers / oracle match
  "custom",
]);
export type GateKind = z.infer<typeof GateKindSchema>;

/** One file the proof stage copies from the oracle's frozen outputs into the reference. */
export const GateCaptureFileSchema = z.strictObject({
  /** Path in the oracle trial's frozen outputs (EVAL_OUT), e.g. `cli/stdout.txt`. */
  from: KitPathSchema,
  /** Path under `<reference>/<workload>/`, e.g. `stdout.txt`. */
  to: KitPathSchema,
});
export type GateCaptureFile = z.infer<typeof GateCaptureFileSchema>;

/** Default capture for an output-diff gate (the cli driver's layout, TDM-36). */
export const DEFAULT_GATE_CAPTURE_FILES: readonly GateCaptureFile[] = [
  { from: "cli/stdout.txt", to: "stdout.txt" },
];

/**
 * TDM-44: the gate's reference for a workload is CAPTURED by the proof stage from the oracle
 * contender's output on the real image when `<reference>/<workload>/` is absent (v1 oracle = a
 * known-good implementation's output). The proof then re-runs the oracle on a fresh computer
 * (the gate must agree 3 times on that output) and a different baseline implementation must pass
 * the same gate. Only `reference/` is ever written, never `workloads/`.
 */
export const GateCaptureSchema = z.strictObject({
  from: z.literal("oracle"),
  /** Default DEFAULT_GATE_CAPTURE_FILES. */
  files: z.array(GateCaptureFileSchema).min(1).optional(),
});
export type GateCapture = z.infer<typeof GateCaptureSchema>;

/** L5 gate. Runs only on the scoring computer, which never ran the subject. */
export const GateSchema = z.strictObject({
  id: KitSlugSchema,
  kind: GateKindSchema,
  /** Defaults to `gates/<id>/check.sh`. */
  check: KitPathSchema.optional(),
  /** Reference outputs, e.g. `gates/<id>/reference/`. */
  reference: KitPathSchema.optional(),
  /** Capture the reference from the proof oracle (TDM-44). Needs `reference`. */
  capture: GateCaptureSchema.optional(),
  /**
   * TDM-233: the grader's own copies of workload INPUT files (a seed data file the hidden tests
   * load), kept under `gates/<id>/` so a contender's edit to the workspace copy can't change the
   * grade. Each entry is a path under `gates/<id>/`; a trailing `/` covers everything under it and
   * a segment that is just `*` matches any one path segment (one workload's dir, say). A file
   * here may be byte-identical to a file under a workload's `input/`: the skeptic reports that as
   * a disclosed warning, not as an answer under workloads/. Never an expected output.
   */
  fixtures: z.array(KitGlobSchema).min(1).optional(),
  description: z.string().min(1).optional(),
  timeout_s: z.int().positive().max(86_400).optional(),
});
export type Gate = z.infer<typeof GateSchema>;

/** `gate.json` written by `check.sh`: `{pass, reason, evidence[], applicable?}`. */
export const GateResultSchema = z.strictObject({
  pass: z.boolean(),
  reason: z.string(),
  /** Paths (relative to the frozen outputs) that back the verdict. */
  evidence: z.array(z.string()),
  /**
   * `false`: the gate does not apply to this trial (e.g. an API load gate on a workload with no
   * API). The trial then leaves the gate's tally and every requirement on the gate, instead of
   * counting as a failure; `pass` is ignored. Omitted means it applies. (TDM-174; TDM-51's gate
   * runner writes the same optional field.)
   * TDM-51's gate runner stores a not-applicable gate with `pass: false`, so a scorer that
   * ignores this field still fails closed.
   */
  applicable: z.boolean().optional(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

/**
 * Workloads a requirement is scored on. Omit for every workload. A trial on another workload is
 * outside the requirement: it neither feeds nor blocks it (e.g. API p95 only on `todo-api`).
 */
export const RequirementWorkloadsSchema = z.array(KitSlugSchema).min(1);

/**
 * How a measured requirement turns a workload's trials into one value (plan.md 17.2 rule 1).
 * - `median`: median over the gate-passing trials.
 * - `per_solved`: all spend ÷ solved tasks: the metric summed over every trial, passing or not,
 *   divided by the number of passing trials (cost per solved task).
 * - `censored`: time-to-solve: median over every trial, with each failed trial counted at the
 *   cap (`cap`, else the workload's `timeout_s`, else the contenders' `wall_clock_cap_s`).
 * - `all_trials` (TDM-210): the mean of a CORRECTNESS metric over every trial, passing or not
 *   (`hidden_test_fraction`: the share of hidden tests a trial passed). The metric is itself
 *   correctness, so it needs no passing gate; the requirement still names the hidden-tests gate
 *   that produced it (a trial without that gate's result is "gate missing"). Only for
 *   CORRECTNESS_METRICS: a speed or cost number from a failed trial is never averaged in.
 * - `per_test_passed` (TDM-210): cost per hidden test passed, i.e. the metric (money) summed over
 *   every trial divided by the hidden tests those trials passed (`hidden_tests_passed`), so
 *   partial progress has a price. Integer micro-USD in, integer micro-USD out (halves round up).
 * Omit to let the scorer pick: `all_trials` for `hidden_test_fraction`, `per_solved` for
 * `cost_micro_usd`, `censored` for `wall_s` when a cap is known, else `median`.
 */
export const MeasuredAggregateSchema = z.enum([
  "median",
  "per_solved",
  "censored",
  "all_trials",
  "per_test_passed",
]);
export type MeasuredAggregate = z.infer<typeof MeasuredAggregateSchema>;

/**
 * TDM-210: the share of hidden tests a trial passed, in [0, 1], written by the hidden-tests gate
 * into `hidden-tests.metrics.jsonl` (TDM-209 [18.2]). The gate's pass/fail stays 100%-only.
 */
export const HIDDEN_TEST_FRACTION_METRIC = "hidden_test_fraction";
/** Hidden tests a trial passed (a count), from the same gate: the denominator of `per_test_passed`. */
export const HIDDEN_TESTS_PASSED_METRIC = "hidden_tests_passed";
/** Hidden tests a trial was graded on (a count). */
export const HIDDEN_TESTS_TOTAL_METRIC = "hidden_tests_total";
/**
 * Metrics that ARE correctness (computed by a gate on the scoring computer), so they may be
 * averaged over every trial (`aggregate: all_trials`). Speed and cost never are.
 */
export const CORRECTNESS_METRICS: readonly string[] = [HIDDEN_TEST_FRACTION_METRIC];
export function isCorrectnessMetric(metric: string): boolean {
  return CORRECTNESS_METRICS.includes(metric);
}

/** Measured: a number from the collectors, only counted when its gate passed. */
export const MeasuredRequirementSchema = z.strictObject({
  id: KitSlugSchema,
  type: z.literal("measured"),
  title: z.string().min(1),
  /** Metric name as written to `metrics.jsonl` (e.g. `wall_s`, `p95_ms`, `tests_passed`). */
  metric: z.string().min(1),
  unit: z.string().min(1).optional(),
  better: z.enum(["lower", "higher"]),
  /** Human-readable target ("under 120 ms", "all pass"). */
  target: z.string().min(1).optional(),
  gate_id: z
    .string({
      error: (iss) =>
        iss.input === undefined
          ? "measured requirement must name a gate_id: no speed or quality number without a correctness gate"
          : "gate_id must be a string",
    })
    .pipe(KitSlugSchema),
  workloads: RequirementWorkloadsSchema.optional(),
  aggregate: MeasuredAggregateSchema.optional(),
  /** `censored` only: the value a failed trial counts as, in the metric's unit. */
  cap: z.number().positive().optional(),
});
export type MeasuredRequirement = z.infer<typeof MeasuredRequirementSchema>;

/** Reviewed: a reviewer session scores it against the rubric, quoting evidence paths. */
export const ReviewedRequirementSchema = z.strictObject({
  id: KitSlugSchema,
  type: z.literal("reviewed"),
  title: z.string().min(1),
  /** Defaults to `rubric.md`. */
  rubric: KitPathSchema.default("rubric.md"),
  /** Section of the rubric this requirement scores. */
  criterion: z.string().min(1).optional(),
  scale: z
    .strictObject({ min: z.int(), max: z.int() })
    .refine((s) => s.max > s.min, { error: "scale.max must be greater than scale.min" })
    .default({ min: 1, max: 4 }),
  /** A reviewed requirement may also be gated (e.g. only review code whose tests pass). */
  gate_id: KitSlugSchema.optional(),
  workloads: RequirementWorkloadsSchema.optional(),
});
export type ReviewedRequirement = z.infer<typeof ReviewedRequirementSchema>;

export const RequirementSchema = z.discriminatedUnion("type", [
  MeasuredRequirementSchema,
  ReviewedRequirementSchema,
]);
export type Requirement = z.infer<typeof RequirementSchema>;
export type RequirementType = Requirement["type"];
