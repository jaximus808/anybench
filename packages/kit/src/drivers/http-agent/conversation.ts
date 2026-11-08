// Conversation sets for driver.type `http-agent` (TDM-40 [4.8], plan.md P2 driver table).
//
//   workloads/<workload>/conversations/<conversation>.json
//
// One file is one conversation: the user turns the runner posts, the labels the gate scores
// (per-turn `expect`, a final `expected.answer`, an `expected.outcome`), and optional tool
// expectations. A conversation with `simulated_user` keeps going after its scripted turns: a
// reviewer-model session (Naïve) plays the user until it says it is done or `max_turns` is hit.
//
// The runner sends the agent only `turns[].user` (and the simulated user's messages). Labels are
// read by the gate, on the scoring computer, from the frozen transcripts plus these files.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { formatSchemaIssues, KitSlugSchema } from "@anybench/core";
import { z } from "zod";

/** Where a workload's conversations live, relative to the workload dir. */
export const CONVERSATIONS_DIR = "conversations";

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

export const ConversationTurnSchema = z.strictObject({
  /** What the user says on this turn. */
  user: z.string().min(1),
  /** Label for the agent's reply to this turn. Omit for turns the gate does not score. */
  expect: AnswerMatcherSchema.optional(),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

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

export const SimulatedUserPlanSchema = z.strictObject({
  /** What the simulated user is trying to get done; the reviewer session plays toward it. */
  goal: z.string().min(1),
  persona: z.string().min(1).optional(),
  /** Total user turns (scripted plus simulated) before the runner stops the conversation. */
  max_turns: z.int().min(1).max(50).default(6),
});
export type SimulatedUserPlan = z.infer<typeof SimulatedUserPlanSchema>;

export const ConversationExpectedSchema = z.strictObject({
  /** Label for the agent's final reply. */
  answer: AnswerMatcherSchema.optional(),
  /** The agent's reported outcome (response mapping `outcome`), e.g. `resolved`, `escalated`. */
  outcome: z.string().min(1).optional(),
});
export type ConversationExpected = z.infer<typeof ConversationExpectedSchema>;

export const ConversationSchema = z
  .strictObject({
    id: KitSlugSchema,
    title: z.string().min(1).optional(),
    /** Opening (and any further scripted) user turns, posted in order. */
    turns: z
      .array(ConversationTurnSchema)
      .min(1, { error: "a conversation needs at least one turn" }),
    expected: ConversationExpectedSchema.optional(),
    tools: z.array(ToolExpectationSchema).optional(),
    simulated_user: SimulatedUserPlanSchema.optional(),
    /** Plain values the request template can reference as `{{context.<key>}}`. */
    context: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((c, ctx) => {
    // An unlabeled conversation is allowed: the gate then needs an oracle transcript for it.
    if (c.simulated_user && c.simulated_user.max_turns < c.turns.length) {
      ctx.addIssue({
        code: "custom",
        path: ["simulated_user", "max_turns"],
        message: `max_turns (${c.simulated_user.max_turns}) is less than the ${c.turns.length} scripted turns`,
      });
    }
  });
export type Conversation = z.infer<typeof ConversationSchema>;
export type ConversationInput = z.input<typeof ConversationSchema>;

/** True when the conversation carries at least one label the gate can score without an oracle. */
export function isLabeledConversation(c: Conversation): boolean {
  return (
    c.turns.some((t) => t.expect !== undefined) ||
    c.expected?.answer !== undefined ||
    c.expected?.outcome !== undefined ||
    (c.tools?.length ?? 0) > 0
  );
}

export class ConversationSetError extends Error {
  constructor(
    readonly dir: string,
    readonly problems: string[],
  ) {
    super(`invalid conversation set in ${dir}:\n  ${problems.join("\n  ")}`);
    this.name = "ConversationSetError";
  }
}

/**
 * Resolve the conversations dir: `dir` itself when it holds `*.json`, else `dir/conversations`
 * (so a driver can be handed either EVAL_IN or the workload folder).
 */
export async function resolveConversationsDir(dir: string): Promise<string> {
  const nested = path.join(dir, CONVERSATIONS_DIR);
  try {
    await readdir(nested);
    return nested;
  } catch {
    return dir;
  }
}

/**
 * Load every `*.json` in a conversations dir, sorted by file name. Throws ConversationSetError
 * listing every bad file (`file: path: message`); ids must be unique and match the file name.
 */
export async function loadConversationSet(dir: string): Promise<Conversation[]> {
  const root = await resolveConversationsDir(dir);
  let names: string[];
  try {
    names = (await readdir(root)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    throw new ConversationSetError(root, ["directory does not exist"]);
  }
  if (names.length === 0) throw new ConversationSetError(root, ["no *.json conversation files"]);
  const problems: string[] = [];
  const out: Conversation[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(root, name), "utf8"));
    } catch (e) {
      problems.push(`${name}: invalid JSON (${(e as Error).message})`);
      continue;
    }
    const r = ConversationSchema.safeParse(raw);
    if (!r.success) {
      for (const line of formatSchemaIssues(r.error)) problems.push(`${name}: ${line}`);
      continue;
    }
    const c = r.data;
    if (`${c.id}.json` !== name) problems.push(`${name}: id '${c.id}' must match the file name`);
    if (seen.has(c.id)) problems.push(`${name}: duplicate conversation id '${c.id}'`);
    seen.add(c.id);
    out.push(c);
  }
  if (problems.length > 0) throw new ConversationSetError(root, problems);
  return out;
}
