// Approver config: one per run, built from the kit's `human_in_loop`, shared by every contender.
// The hash goes on every event so the report can prove every contender got the same stand-in.

import { createHash } from "node:crypto";
import { HumanInLoopSchema } from "@anybench/core";
import { z } from "zod";
import { APPROVER_POLICIES } from "./events.js";

export const ApproverConfigSchema = z.strictObject({
  kind: z.enum(["tandem", "naive"]),
  policy: z.enum(APPROVER_POLICIES),
  /**
   * llm-reviewer only: the reviewer agent's model. Must differ from every model under test
   * (checked by `assertReviewerModelDiffers`); Tandem also enforces it with requireCrossModelReview.
   */
  reviewer_model: z.string().min(1).optional(),
  /** Name the reviewer registers on the board as (`agent:<name>` on the stamp). */
  reviewer_name: z.string().min(1).max(120).default("anybench-reviewer"),
  /** Fixed answer for Naïve questions under auto / human-sim. Must not carry task answers. */
  default_answer: z
    .string()
    .min(1)
    .max(500)
    .default("No further input is available. Use your best judgement and continue."),
});
export type ApproverConfig = z.infer<typeof ApproverConfigSchema>;
export type ApproverConfigInput = z.input<typeof ApproverConfigSchema>;

/** Builds the run's config from `kit.human_in_loop` (validated with core's HumanInLoopSchema). */
export function approverConfigFromKit(
  humanInLoop: unknown,
  extra: Omit<ApproverConfigInput, "kind" | "policy"> = {},
): ApproverConfig {
  const hil = HumanInLoopSchema.parse(humanInLoop);
  return ApproverConfigSchema.parse({ ...extra, kind: hil.kind, policy: hil.policy });
}

/** Stable 16-hex hash of the config (key order independent). */
export function approverConfigHash(config: ApproverConfig): string {
  const sorted = Object.fromEntries(
    Object.entries(config).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

/** The reviewer must not be the model under test (plan.md P3 llm-reviewer, rule 8 spirit). */
export function assertReviewerModelDiffers(config: ApproverConfig, subjectModels: string[]): void {
  if (config.policy !== "llm-reviewer") return;
  if (!config.reviewer_model) throw new Error("llm-reviewer needs reviewer_model");
  const r = config.reviewer_model.toLowerCase();
  for (const m of subjectModels) {
    if (m.toLowerCase() === r) {
      throw new Error(`reviewer model '${config.reviewer_model}' is also a model under test`);
    }
  }
}
