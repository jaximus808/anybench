// Conversation inputs for driver.type `http-agent` (TDM-40 [4.8], plan.md P2 driver table).
//
//   workloads/<workload>/conversations/<conversation>.json     inputs: ship to the agent's computer
//   gates/<gate>/reference/<workload>/<conversation>.json      labels: scoring computer only (labels.ts)
//
// An input file holds only what the agent may see: the scripted user turns, an optional
// simulated-user plan, and template context. The schema is strict, and a label key (`expect`,
// `expected`, `tools`, `oracle`) in a workload file is a validation error with its own message:
// the workload is copied to the computer that runs the agent, so a label there is an answer key
// the agent could read.
//
// `simulated_user.goal` and `persona` are agent-visible too: the simulated user's messages are
// built from them and posted to the agent. They must never contain the expected answer.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { formatSchemaIssues, KitSlugSchema } from "@anybench/core";
import { z } from "zod";

/** Where a workload's conversation inputs live, relative to the workload dir. */
export const CONVERSATIONS_DIR = "conversations";

/** Keys that only belong in a label file. Finding one in a workload input is an error. */
export const LABEL_KEYS = ["expect", "expected", "tools", "oracle"] as const;

export const ConversationTurnSchema = z.strictObject({
  /** What the user says on this turn. */
  user: z.string().min(1),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

export const SimulatedUserPlanSchema = z.strictObject({
  /**
   * What the simulated user is trying to get done. Agent-visible (it shapes the messages the
   * agent receives): never put the expected answer here.
   */
  goal: z.string().min(1),
  /** Agent-visible, like `goal`. */
  persona: z.string().min(1).optional(),
  /** Total user turns (scripted plus simulated) before the runner stops the conversation. */
  max_turns: z.int().min(1).max(50).default(6),
});
export type SimulatedUserPlan = z.infer<typeof SimulatedUserPlanSchema>;

export const ConversationSchema = z
  .strictObject({
    id: KitSlugSchema,
    title: z.string().min(1).optional(),
    /** Opening (and any further scripted) user turns, posted in order. */
    turns: z
      .array(ConversationTurnSchema)
      .min(1, { error: "a conversation needs at least one turn" }),
    simulated_user: SimulatedUserPlanSchema.optional(),
    /** Plain values the request template can reference as `{{context.<key>}}`. Agent-visible. */
    context: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((c, ctx) => {
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

/** `path: message` for every label key found in a raw input document. */
export function labelKeysIn(raw: unknown): string[] {
  const found: string[] = [];
  const msg = (where: string, key: string) =>
    `${where}: '${key}' is a label: labels go in gates/<gate>/reference/<workload>/, never in the workload (it ships to the agent's computer)`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return found;
  const doc = raw as Record<string, unknown>;
  for (const k of LABEL_KEYS) if (k in doc) found.push(msg(k, k));
  if (Array.isArray(doc.turns)) {
    doc.turns.forEach((t, i) => {
      if (t !== null && typeof t === "object" && !Array.isArray(t))
        for (const k of LABEL_KEYS) if (k in t) found.push(msg(`turns[${i}].${k}`, k));
    });
  }
  return found;
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
 * Resolve the conversations dir: `dir/conversations` when it exists (a workload dir or EVAL_IN),
 * else `dir` itself.
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
 * Read every `*.json` in a dir, sorted by file name, through `parse`. Shared by the input and
 * label loaders. Ids must be unique and match the file name. Throws ConversationSetError listing
 * every bad file (`file: path: message`).
 */
export async function loadJsonSet<T extends { id: string }>(
  root: string,
  parse: (raw: unknown, file: string) => { data?: T; problems: string[] },
  what: string,
): Promise<T[]> {
  let names: string[];
  try {
    names = (await readdir(root)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    throw new ConversationSetError(root, ["directory does not exist"]);
  }
  if (names.length === 0) throw new ConversationSetError(root, [`no *.json ${what} files`]);
  const problems: string[] = [];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(root, name), "utf8"));
    } catch (e) {
      problems.push(`${name}: invalid JSON (${(e as Error).message})`);
      continue;
    }
    const r = parse(raw, name);
    for (const p of r.problems) problems.push(`${name}: ${p}`);
    if (r.data === undefined) continue;
    const c = r.data;
    if (`${c.id}.json` !== name) problems.push(`${name}: id '${c.id}' must match the file name`);
    if (seen.has(c.id)) problems.push(`${name}: duplicate ${what} id '${c.id}'`);
    seen.add(c.id);
    out.push(c);
  }
  if (problems.length > 0) throw new ConversationSetError(root, problems);
  return out;
}

/** Parse one input document: label keys first (clear message), then the strict schema. */
export function parseConversation(raw: unknown): { data?: Conversation; problems: string[] } {
  const labels = labelKeysIn(raw);
  const r = ConversationSchema.safeParse(raw);
  if (labels.length > 0) return { problems: labels };
  if (!r.success) return { problems: formatSchemaIssues(r.error) };
  return { data: r.data, problems: [] };
}

/**
 * Load the conversation inputs of a workload (`dir` or `dir/conversations`). This is all the
 * runner reads; it never sees a label.
 */
export async function loadConversationSet(dir: string): Promise<Conversation[]> {
  return loadJsonSet(await resolveConversationsDir(dir), parseConversation, "conversation");
}
