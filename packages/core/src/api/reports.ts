// Report routes (plan.md P4): one-sentence answer, table, breakdown, where it breaks,
// bottlenecks, proof. Renders as a page, Markdown and JSON. Ticket 7.5; built by packages/report.
//
// The core rule holds in the schema: a measured value is only present when its gate passed, and a
// contender only has a score when every measured number behind it was gated.
import { z } from "zod";
import { ContenderIdSchema, KitIdSchema, RunIdSchema, TrialIdSchema } from "../ids.js";
import { ContenderRoleSchema } from "../schemas/contender.js";
import { IsoDateTimeSchema } from "./common.js";
import { ProofCheckResultSchema } from "./kits.js";
import { defineRoute, defineRoutes } from "./route.js";
import { FAILURE_CLASSES } from "./trials.js";

const Score = z.number().min(0).max(100);

// TDM-175 [16.4]: every comparison with the baseline carries a verdict (plan.md 17.2 rule 2).
// Built by @anybench/bench `decide` (Comparison); the schema re-checks the honesty rules so a
// report that breaks them can't be stored or rendered.
export const VERDICTS = ["better", "worse", "indistinguishable"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

const Probability = z.number().min(0).max(1);
const Finite = z.number().finite();

export const RequirementComparisonSchema = z
  .object({
    baseline_id: z.string().min(1),
    verdict: VerdictSchema,
    test: z.enum([
      "newcombe",
      "fisher_exact",
      "mann_whitney_exact",
      "mann_whitney_asymptotic",
      "task_paired",
    ]),
    p: Probability,
    /** Holm-adjusted across the report's `family` comparisons. */
    p_adjusted: Probability,
    alpha: z.number().gt(0).lt(1),
    family: z.int().min(1),
    effect: z.object({
      measure: z.enum(["rate_diff", "cliffs_delta"]),
      /** Oriented: positive means the contender is better than the baseline. */
      value: Finite,
      hodges_lehmann: Finite.nullable(),
    }),
    /** CI of the difference; `level` is the coverage attained (small n may fall short). */
    diff_ci: z.object({
      lo: Finite,
      hi: Finite,
      level: z.number().gt(0).max(1),
      requested_level: z.number().gt(0).lt(1),
      attained: z.boolean(),
      unit: z.enum(["rate", "metric", "cliffs_delta"]),
    }),
    n: z.object({ candidate: z.int().min(1), baseline: z.int().min(1), tasks: z.int().min(1) }),
    /** Smallest detectable difference at 80% power; null when none is detectable at this n. */
    mde: z.object({
      value: z.number().min(0).nullable(),
      unit: z.enum(["rate", "cliffs_delta"]),
      metric_shift: Finite.nullable(),
    }),
    /** `these_tasks`: an agent result on fewer than 20 tasks speaks for those tasks only. */
    claim: z.enum(["general", "these_tasks"]),
    downgraded: z.enum(["survivorship", "effect_size", "multiplicity"]).nullable(),
    statement: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (c.verdict !== "indistinguishable" && !(c.p_adjusted < c.alpha))
      issue("verdict", `'${c.verdict}' needs a Holm-adjusted p below alpha`);
    if (c.verdict === "better" && c.effect.value <= 0)
      issue("verdict", "'better' needs a positive effect");
    if (c.verdict === "worse" && c.effect.value >= 0)
      issue("verdict", "'worse' needs a negative effect");
    if (
      c.verdict === "indistinguishable" &&
      !c.statement.startsWith("no detectable difference at n=")
    )
      issue("statement", "an indistinguishable result reads 'no detectable difference at n=…'");
    if (c.verdict !== "indistinguishable" && c.statement.startsWith("no detectable"))
      issue("statement", "statement contradicts the verdict");
  });
export type RequirementComparison = z.infer<typeof RequirementComparisonSchema>;

/**
 * E18: one task's result vs the baseline, with the task's repeats as the unit (exact
 * Mann–Whitney, Fisher for pass rates), Holm across every task × requirement test. It speaks for
 * that task only: never a general claim.
 */
export const TaskComparisonSchema = z
  .object({
    workload_id: z.string().min(1),
    comparison: RequirementComparisonSchema,
  })
  .superRefine((t, ctx) => {
    if (t.comparison.claim !== "these_tasks")
      ctx.addIssue({
        code: "custom",
        path: ["comparison", "claim"],
        message: "a per-task result speaks for its task only (claim 'these_tasks')",
      });
    if (t.comparison.test === "task_paired")
      ctx.addIssue({
        code: "custom",
        path: ["comparison", "test"],
        message: "a per-task result compares one task's repeats, not tasks",
      });
  });
export type TaskComparison = z.infer<typeof TaskComparisonSchema>;

/** E18: the report's per-task section (agent and harness kits). Optional: older reports lack it. */
export const PerTaskSectionSchema = z.object({
  /** Tasks compared, in kit order. */
  tasks: z.array(z.string().min(1)),
  /** Tests in the per-task Holm family. */
  family: z.int().min(0),
  alpha: z.number().gt(0).lt(1),
  /** Always shown next to the per-task results ("3 tasks: this doesn't generalise …"). */
  scope: z.string().min(1),
  /** Requirements where every task agrees and is significant ("Tandem was faster on all 3 tasks tested"). */
  headline: z.array(z.string().min(1)),
});
export type PerTaskSection = z.infer<typeof PerTaskSectionSchema>;

export const RequirementResultSchema = z
  .object({
    requirement_id: z.string().min(1),
    type: z.enum(["measured", "reviewed"]),
    title: z.string(),
    /** Median over gated trials (measured) or mean rubric score (reviewed); null when ungated. */
    value: z.number().finite().nullable(),
    unit: z.string().nullable(),
    ci95: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
    gate_id: z.string().nullable(),
    /** Fraction of trials whose gate passed (measured only). */
    gate_pass_rate: z.number().min(0).max(1).nullable(),
    score: Score.nullable(),
    /** Applicable trials behind the value (TDM-175). */
    n: z.int().min(0).nullable().optional(),
    /**
     * The value is a median over solved trials only, so failures are not in it: the report warns,
     * and it can never be `better`.
     */
    survivorship: z.boolean().optional(),
    /** vs the baseline; null for the baseline itself. Optional for reports before TDM-175. */
    comparison: RequirementComparisonSchema.nullable().optional(),
    /** E18, agent and harness kits: per task vs the baseline. Optional: older reports lack it. */
    by_task: z.array(TaskComparisonSchema).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.survivorship === true && r.comparison?.verdict === "better")
      ctx.addIssue({
        code: "custom",
        path: ["comparison", "verdict"],
        message: "a median over solved trials only (survivorship) can never be 'better'",
      });
    r.by_task?.forEach((t, i) => {
      if (r.survivorship === true && t.comparison.verdict === "better")
        ctx.addIssue({
          code: "custom",
          path: ["by_task", i, "comparison", "verdict"],
          message: "a median over solved trials only (survivorship) can never be 'better'",
        });
    });
    if (r.type !== "measured") return;
    if (r.gate_id === null)
      ctx.addIssue({
        code: "custom",
        path: ["gate_id"],
        message: "measured requirement needs a gate",
      });
    if (r.value !== null && !(r.gate_pass_rate !== null && r.gate_pass_rate > 0))
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "no speed or quality number without a correctness gate: no gated trial passed",
      });
  });

export const ContenderResultSchema = z
  .object({
    contender_id: ContenderIdSchema,
    name: z.string(),
    role: ContenderRoleSchema,
    /** Weighted 0–100 over gated metrics only; null when nothing passed its gate. */
    score: Score.nullable(),
    ci95: z.tuple([Score, Score]).nullable(),
    delta_vs_baseline: z.number().finite().nullable(),
    requirements: z.array(RequirementResultSchema),
    wins: z.array(z.string()),
    losses: z.array(z.string()),
  })
  .superRefine((c, ctx) => {
    const gated = c.requirements.some((r) => r.type === "reviewed" || r.value !== null);
    if (c.score !== null && !gated)
      ctx.addIssue({
        code: "custom",
        path: ["score"],
        message: "a score needs at least one gated or reviewed requirement",
      });
  });
export type ContenderResult = z.infer<typeof ContenderResultSchema>;

export const BottleneckSchema = z.object({
  cause: z.string().min(1),
  evidence: z.array(z.string()),
  suggested_fix: z.string(),
  trial_ids: z.array(TrialIdSchema),
});

export const ReportSchema = z.object({
  run_id: RunIdSchema,
  kit_id: KitIdSchema.nullable(),
  /** The one-sentence answer. */
  answer: z.string(),
  comped: z.boolean(),
  contenders: z.array(ContenderResultSchema),
  where_it_breaks: z.array(
    z.object({
      workload_id: z.string().min(1),
      contender_id: ContenderIdSchema.nullable(),
      summary: z.string(),
    }),
  ),
  bottlenecks: z.array(BottleneckSchema),
  proof: z.array(ProofCheckResultSchema),
  failures: z.record(z.enum(FAILURE_CLASSES), z.int().nonnegative()),
  /** E18: per-task results and their scope line (agent and harness kits). Optional. */
  per_task: PerTaskSectionSchema.optional(),
  /** For runs that ended `failed` or `needs_human`: what went wrong in our own pipeline. */
  postmortem: z
    .object({
      stage: z.string().min(1),
      agent: z.string().nullable(),
      error: z.string(),
      explanation: z.string(),
    })
    .nullable(),
  generated_at: IsoDateTimeSchema,
});
export type Report = z.infer<typeof ReportSchema>;

const runParams = z.object({ id: RunIdSchema });

export const reportRoutes = defineRoutes({
  get: defineRoute({
    id: "reports.get",
    method: "GET",
    path: "/runs/:id/report",
    auth: ["session", "apiKey:runs:read"],
    summary: "The run's report as JSON (404 until analyzing has written it).",
    params: runParams,
    response: z.object({ report: ReportSchema }),
  }),
  markdown: defineRoute({
    id: "reports.markdown",
    method: "GET",
    path: "/runs/:id/report/markdown",
    auth: ["session", "apiKey:runs:read"],
    summary: "The run's report as Markdown (`text/markdown`).",
    params: runParams,
    kind: "text",
    response: z.string(),
  }),
});
