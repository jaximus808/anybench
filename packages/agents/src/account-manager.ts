// TDM-167 [15.8a]: the outreach account manager, hackathon cut. It only CLASSIFIES inbound replies
// (the fallback when @anybench/outreach's rules are unsure); it never drafts or sends an answer.
// `account-manager/prompt.md` is the system prompt, `config.json` the model, window, budget and
// toolset, `output.schema.json` the JSON schema Naïve is told to produce (a test keeps it equal to
// `ReplyClassificationSchema`).
//
// The category list is the same as `REPLY_CATEGORIES` in @anybench/outreach (this package can't
// import outreach: outreach depends on agents). The CLI wires the two together, and the compiler
// checks they agree there.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ensureAgent,
  NaiveBudgetExceededError,
  NaiveError,
  runSession,
  type AgentSpec,
  type NaiveClient,
} from "@anybench/naive";
import { z } from "zod";

export const ACCOUNT_MANAGER_ROLE = "account_manager";

export const ACCOUNT_MANAGER_CATEGORIES = [
  "interested",
  "question",
  "not_now",
  "unsubscribe",
  "bounce_or_auto",
  "unclear",
] as const;
export type AccountManagerCategory = (typeof ACCOUNT_MANAGER_CATEGORIES)[number];

export const ReplyClassificationSchema = z.strictObject({
  category: z.enum(ACCOUNT_MANAGER_CATEGORIES),
  reason: z.string().max(400),
});
export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;

const roleFile = (name: string): URL => new URL(`../account-manager/${name}`, import.meta.url);

const wireMicroUsd = z
  .number()
  .int()
  .nonnegative()
  .transform((n) => BigInt(n));

export const AccountManagerConfigSchema = z.strictObject({
  role: z.literal(ACCOUNT_MANAGER_ROLE),
  model: z.string().min(1),
  harness: z.enum(["pi", "claude_code", "vetta", "hermes"]),
  window: z.enum(["immediate", "priority", "loose"]),
  description: z.string().min(1),
  budget: z.strictObject({
    cap_micro_usd: wireMicroUsd,
    max_task_micro_usd: wireMicroUsd,
    period: z.enum(["day", "week", "month"]),
  }),
  tools: z.record(z.string(), z.unknown()),
});
export type AccountManagerConfig = z.infer<typeof AccountManagerConfigSchema>;

export function loadAccountManagerPrompt(): string {
  return readFileSync(roleFile("prompt.md"), "utf8");
}

export function loadAccountManagerConfig(): AccountManagerConfig {
  return AccountManagerConfigSchema.parse(
    JSON.parse(readFileSync(roleFile("config.json"), "utf8")),
  );
}

/** The committed `account-manager/output.schema.json`. */
export function loadAccountManagerOutputJsonSchema(): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(readFileSync(roleFile("output.schema.json"), "utf8")));
}

export function accountManagerAgentSpec(
  options: { model?: string; maxTaskMicroUsd?: bigint } = {},
): AgentSpec {
  const config = loadAccountManagerConfig();
  const maxTask = options.maxTaskMicroUsd ?? config.budget.max_task_micro_usd;
  return {
    role: ACCOUNT_MANAGER_ROLE,
    model: options.model ?? config.model,
    system: loadAccountManagerPrompt(),
    harness: config.harness,
    window: config.window,
    description: config.description,
    budget: {
      capMicroUsd: maxTask > config.budget.cap_micro_usd ? maxTask : config.budget.cap_micro_usd,
      maxTaskMicroUsd: maxTask,
      period: config.budget.period,
    },
    outputSchema: loadAccountManagerOutputJsonSchema(),
    tools: config.tools,
  };
}

export interface ReplyToClassify {
  /** AgentMail message id: the idempotency key, so a re-poll never pays twice for one reply. */
  messageId: string;
  from: string;
  subject: string | undefined;
  text: string;
}

export interface ModelReplyClassification extends ReplyClassification {
  costMicroUsd: bigint;
  sessionId: string;
  model: string;
}

/** Thrown when the session ran (or was refused) without a usable classification. */
export class ReplyClassifierError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** What was spent anyway (0 when refused before running). */
    readonly costMicroUsd: bigint,
  ) {
    super(message);
    this.name = "ReplyClassifierError";
  }
}

export interface NaiveReplyClassifier {
  /** The most one call can spend (its session budget). */
  readonly maxCostMicroUsd: bigint;
  classify(reply: ReplyToClassify): Promise<ModelReplyClassification>;
}

/** Text sent to the model is capped: a reply's new text is short, and the quote must stay cheap. */
const MAX_TEXT_CHARS = 6_000;

export function createNaiveReplyClassifier(o: {
  naive: NaiveClient;
  model?: string;
  /** Per-reply Naïve budget. Default config.json `max_task_micro_usd` ($0.05). */
  budgetMicroUsd?: bigint;
}): NaiveReplyClassifier {
  const config = loadAccountManagerConfig();
  const budget = o.budgetMicroUsd ?? config.budget.max_task_micro_usd;
  if (budget <= 0n) throw new RangeError("reply classifier budget must be > 0 micro-USD");
  const spec = accountManagerAgentSpec({
    ...(o.model ? { model: o.model } : {}),
    maxTaskMicroUsd: budget,
  });
  let ensured: Promise<Awaited<ReturnType<typeof ensureAgent>>> | undefined;

  return {
    maxCostMicroUsd: budget,
    async classify(reply) {
      ensured ??= ensureAgent(o.naive, spec);
      const agent = await ensured;
      const input = {
        from: reply.from,
        subject: reply.subject ?? "",
        text: reply.text.slice(0, MAX_TEXT_CHARS),
      };
      const key = `reply:${createHash("sha256")
        .update(`${reply.messageId}\n${agent.fingerprint}\n${budget}`)
        .digest("hex")
        .slice(0, 40)}`;
      let sessionId: string | undefined;
      try {
        const r = await runSession(o.naive, {
          agentId: agent.agent.id,
          agentVersion: agent.agent.version,
          role: ACCOUNT_MANAGER_ROLE,
          input,
          output: { schema: ReplyClassificationSchema, jsonSchema: spec.outputSchema },
          budgetMicroUsd: budget,
          idempotencyKey: key,
          metadata: { agentmail_message_id: reply.messageId.slice(0, 200) },
          onSession: (s) => {
            sessionId = s.id;
          },
        });
        if (r.status !== "completed") {
          throw new ReplyClassifierError(
            "awaiting_human",
            "classifier session parked on a question",
            r.costMicroUsd,
          );
        }
        return {
          ...r.output,
          costMicroUsd: r.costMicroUsd,
          sessionId: r.sessionId,
          model: agent.agent.model,
        };
      } catch (err) {
        if (err instanceof ReplyClassifierError) throw err;
        if (
          err instanceof NaiveBudgetExceededError &&
          err.consumedMicroUsd === null &&
          !sessionId
        ) {
          throw new ReplyClassifierError("budget_below_quote", err.message, 0n);
        }
        if (err instanceof NaiveError) {
          let spent: bigint = budget;
          const sid = sessionId ?? err.sessionId;
          if (err instanceof NaiveBudgetExceededError && err.consumedMicroUsd !== null) {
            spent = err.consumedMicroUsd;
          } else if (sid) {
            try {
              spent = (await o.naive.sessions.get(sid)).consumedMicroUsd;
            } catch {
              // unknown spend stays the whole budget (conservative)
            }
          }
          throw new ReplyClassifierError(err.code, err.message, spent);
        }
        throw err;
      }
    },
  };
}
