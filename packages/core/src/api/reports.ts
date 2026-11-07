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
  })
  .superRefine((r, ctx) => {
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
