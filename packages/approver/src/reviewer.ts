// The thing that decides. `approveAll` is the deterministic stand-in for auto and human-sim;
// `naiveReviewer` is the llm-reviewer: a Naïve agent on a different model that sees only what a
// human reviewer on the board would see (titles and bodies), never the kit, gates or hidden tests.

import { runSession, type MicroUsd, type NaiveClient } from "@anybench/naive";
import { z } from "zod";
import type { LeakGuard } from "./leak-guard.js";

export interface ReviewRequest {
  kind: "epic" | "task" | "tool" | "question";
  title: string;
  body: string;
  /** For a task: its epic's title and body. For a tool call: the arguments as JSON. */
  context?: string;
  /** For a question: the field keys to answer. */
  fields?: { key: string; optional?: boolean }[];
}

export const ReviewDecisionSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().min(1).max(1000),
  /** Question answers, keyed by field key. */
  answers: z.record(z.string(), z.string().max(1000)).optional(),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export interface Reviewer {
  /** `agent:<name>` for an agent reviewer, `human-sim` for the deterministic one. */
  readonly decidedBy: string;
  /** `key` is stable per decision (idempotency for paid reviewers). */
  review(request: ReviewRequest, key: string): Promise<ReviewDecision>;
}

/** Approves everything with a fixed reason. The same for every contender by construction. */
export function approveAllReviewer(decidedBy = "human-sim"): Reviewer {
  return {
    decidedBy,
    review: () =>
      Promise.resolve({ decision: "approve", reason: "simulated approval (approve-all policy)" }),
  };
}

/** The instruction every llm-reviewer session gets. Identical for every contender (rule 4). */
export const REVIEWER_INSTRUCTION = [
  "You stand in for the human who approves work on a task board during a benchmark.",
  "Approve a proposal when it is a plausible, scoped step toward the stated goal and names what it",
  "touches. Reject only when it is empty, unrelated to the goal, or plainly destructive.",
  "You cannot see the grading. Do not invent requirements and never give the solution.",
  "Reply with {decision, reason}; keep the reason to one sentence about the proposal itself.",
].join(" ");

export interface NaiveReviewerOptions {
  client: NaiveClient;
  agentId: string;
  /** Board name, stamped as `agent:<name>`. */
  name: string;
  /** Spend cap per review, integer micro-USD. */
  budgetMicroUsd: MicroUsd;
  guard: LeakGuard;
}

export function naiveReviewer(options: NaiveReviewerOptions): Reviewer {
  return {
    decidedBy: `agent:${options.name}`,
    async review(request, key) {
      const input = options.guard.check(
        JSON.stringify(
          {
            instruction: REVIEWER_INSTRUCTION,
            proposal: {
              kind: request.kind,
              title: request.title,
              body: request.body,
              ...(request.context ? { context: request.context } : {}),
              ...(request.fields ? { answer_fields: request.fields.map((f) => f.key) } : {}),
            },
          },
          null,
          2,
        ),
        "reviewer prompt",
      );
      const result = await runSession(options.client, {
        agentId: options.agentId,
        role: "approver-reviewer",
        input,
        output: { schema: ReviewDecisionSchema },
        budgetMicroUsd: options.budgetMicroUsd,
        idempotencyKey: `approver:${key}`.slice(0, 255),
      });
      if (result.status !== "completed") {
        throw new Error(`reviewer session ${result.sessionId} parked waiting for a human`);
      }
      const out = result.output;
      options.guard.check(out.reason, "reviewer reason");
      for (const v of Object.values(out.answers ?? {})) options.guard.check(v, "reviewer answer");
      return out;
    },
  };
}
