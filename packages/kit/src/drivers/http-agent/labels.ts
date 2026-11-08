// Conversation labels for the http-agent gate (TDM-40 [4.8]).
//
//   gates/<gate>/reference/<workload>/<conversation>.json
//
// A label file holds the answer key for the conversation input of the same id: per-turn
// `expect` by scripted turn index, the final `expected.answer` and `expected.outcome`, and tool
// expectations. `oracle: true` says the conversation is scored by matching the oracle run's
// final answer instead (the gate needs `--oracle` then). Labels never go in the workload: only
// the scoring computer, which never runs the agent, reads them.
import { formatSchemaIssues, KitSlugSchema } from "@anybench/core";
import { z } from "zod";
import { loadJsonSet } from "./conversation.js";

/**
 * How a reply is checked against a label. Every field given must hold. Text checks are
 * case-insensitive and whitespace-collapsed unless `case_sensitive` is set.
 */
export const AnswerMatcherSchema = z
  .strictObject({
    /** The whole reply equals this (after normalizing). */
    equals: z.string().min(1).optional(),
    /** Every string appears in the reply. */
    contains: z.array(z.string().min(1)).min(1).optional(),
    /** At least one string appears in the reply. */
    any_of: z.array(z.string().min(1)).min(1).optional(),
    /** None of these appear in the reply (e.g. a wrong order number). */
    not_contains: z.array(z.string().min(1)).min(1).optional(),
    /** A JavaScript regular expression the reply matches (flags: `i` unless case_sensitive). */
    regex: z
      .string()
      .min(1)
      .refine(
        (r) => {
          try {
            new RegExp(r);
            return true;
          } catch {
            return false;
          }
        },
        { error: "must be a valid regular expression" },
      )
      .optional(),
    /** A number in the reply within `tolerance` of `value` (e.g. a computed total). */
    number: z
      .strictObject({ value: z.number(), tolerance: z.number().nonnegative().default(0) })
      .optional(),
    case_sensitive: z.boolean().default(false),
  })
  .refine(
    (m) =>
      m.equals !== undefined ||
      m.contains !== undefined ||
      m.any_of !== undefined ||
      m.not_contains !== undefined ||
      m.regex !== undefined ||
      m.number !== undefined,
    {
      error:
        "a matcher needs at least one of equals, contains, any_of, not_contains, regex, number",
    },
  );
export type AnswerMatcher = z.infer<typeof AnswerMatcherSchema>;

/** A tool call the agent is expected (or forbidden) to make, as reported in its responses. */
export const ToolExpectationSchema = z.strictObject({
  name: z.string().min(1),
  /** Every key here must appear in the call's args with an equal value (subset match). */
  args: z.record(z.string(), z.unknown()).optional(),
  /** At least this many matching calls across the conversation. */
  min_calls: z.int().min(1).default(1),
  /** The agent must make no matching call. */
  forbidden: z.boolean().default(false),
});
export type ToolExpectation = z.infer<typeof ToolExpectationSchema>;

export const TurnLabelSchema = z.strictObject({
  /** 0-based index into the input's scripted `turns`. */
  index: z.int().nonnegative(),
  expect: AnswerMatcherSchema,
});
export type TurnLabel = z.infer<typeof TurnLabelSchema>;

export const ConversationExpectedSchema = z.strictObject({
  /** Label for the agent's final reply. */
  answer: AnswerMatcherSchema.optional(),
  /** The agent's reported outcome (response mapping `outcome`), e.g. `resolved`, `escalated`. */
  outcome: z.string().min(1).optional(),
});
export type ConversationExpected = z.infer<typeof ConversationExpectedSchema>;

export const ConversationLabelSchema = z
  .strictObject({
    /** The conversation input this labels (same id, same file name). */
    id: KitSlugSchema,
    turns: z.array(TurnLabelSchema).optional(),
    expected: ConversationExpectedSchema.optional(),
    tools: z.array(ToolExpectationSchema).optional(),
    /** Score by matching the oracle run's final answer (needs the gate's `--oracle`). */
    oracle: z.boolean().default(false),
  })
  .superRefine((l, ctx) => {
    const seen = new Set<number>();
    (l.turns ?? []).forEach((t, i) => {
      if (seen.has(t.index))
        ctx.addIssue({
          code: "custom",
          path: ["turns", i, "index"],
          message: `turn ${t.index} is labeled twice`,
        });
      seen.add(t.index);
    });
    if (!l.oracle && labelCheckCount(l) === 0)
      ctx.addIssue({
        code: "custom",
        path: [],
        message:
          "a label needs at least one check (turns, expected.answer, expected.outcome, tools) or oracle: true",
      });
  });
export type ConversationLabel = z.infer<typeof ConversationLabelSchema>;
export type ConversationLabelInput = z.input<typeof ConversationLabelSchema>;

/** Number of label-based checks (oracle match not counted). */
export function labelCheckCount(l: {
  turns?: unknown[] | undefined;
  expected?: { answer?: unknown; outcome?: unknown } | undefined;
  tools?: unknown[] | undefined;
}): number {
  return (
    (l.turns?.length ?? 0) +
    (l.expected?.answer !== undefined ? 1 : 0) +
    (l.expected?.outcome !== undefined ? 1 : 0) +
    (l.tools?.length ?? 0)
  );
}

/** Load every label in `dir` (`gates/<gate>/reference/<workload>/`). Throws ConversationSetError. */
export async function loadLabelSet(dir: string): Promise<ConversationLabel[]> {
  return loadJsonSet(
    dir,
    (raw) => {
      const r = ConversationLabelSchema.safeParse(raw);
      return r.success ? { data: r.data, problems: [] } : { problems: formatSchemaIssues(r.error) };
    },
    "label",
  );
}
