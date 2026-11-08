// L5 gates and L6 review: requirements, correctness gates and the gate.json contract (plan.md P2).
//
// The core rule lives here and in KitSpecSchema: every `measured` requirement names a `gate_id`.
// No speed or quality number without a correctness gate.
import { z } from "zod";
import { KitSlugSchema, KitPathSchema } from "./kit-primitives.js";

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

/** L5 gate. Runs only on the scoring computer, which never ran the subject. */
export const GateSchema = z.strictObject({
  id: KitSlugSchema,
  kind: GateKindSchema,
  /** Defaults to `gates/<id>/check.sh`. */
  check: KitPathSchema.optional(),
  /** Reference outputs, e.g. `gates/<id>/reference/`. */
  reference: KitPathSchema.optional(),
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
 * Omit to let the scorer pick: `per_solved` for `cost_micro_usd`, `censored` for `wall_s` when a
 * cap is known, else `median`.
 */
export const MeasuredAggregateSchema = z.enum(["median", "per_solved", "censored"]);
export type MeasuredAggregate = z.infer<typeof MeasuredAggregateSchema>;

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
