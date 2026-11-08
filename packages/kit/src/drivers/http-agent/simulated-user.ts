// Simulated user for driver.type `http-agent` (TDM-40 [4.8], plan.md P2: "a simulated user is a
// reviewer-model session").
//
// After a conversation's scripted turns, a Naïve session plays the user: it reads the goal,
// persona and transcript so far and returns the next user message, or `done`. One bounded
// session per user turn (stateless, idempotent per conversation and turn), through
// `@anybench/naive` runSession, so tests run it against FakeNaive and spend nothing.
import { type MicroUsd } from "@anybench/core";
import { runSession, type AgentSpec, type NaiveClient } from "@anybench/naive";
import { z } from "zod";
import type { ChatMessage } from "./mapping.js";

/** The Naïve role (and FakeNaive script key) of the simulated user. */
export const SIMULATED_USER_ROLE = "simulated-user";

/** What the simulated user session returns for one turn. */
export const SimulatedUserTurnSchema = z
  .strictObject({
    /** True when the user's goal is met (or cannot be) and the conversation should end. */
    done: z.boolean(),
    /** The next user message. Required unless `done`. */
    message: z.string().nullable(),
  })
  .refine((t) => t.done || (t.message !== null && t.message.trim() !== ""), {
    error: "message is required unless done is true",
  });
export type SimulatedUserTurn = z.infer<typeof SimulatedUserTurnSchema>;

/** The task each simulated-user session gets (sent as JSON). */
export interface SimulatedUserRequest {
  conversation_id: string;
  goal: string;
  persona?: string;
  /** 0-based index of the user turn to write. */
  turn: number;
  max_turns: number;
  transcript: ChatMessage[];
}

export interface SimulatedUserReply {
  done: boolean;
  message: string | null;
  /** What producing this turn cost (integer micro-USD). */
  costMicroUsd: MicroUsd;
}

export interface SimulatedUser {
  next(req: SimulatedUserRequest): Promise<SimulatedUserReply>;
}

export const SIMULATED_USER_SYSTEM = [
  "You play the user of a chat agent that is being evaluated.",
  "You get a JSON task: your goal, an optional persona, and the transcript so far.",
  "Write the user's next message: short, natural, in character, moving toward the goal.",
  "Only use facts given in the goal or the transcript. Never answer for the agent.",
  "Set done to true (message null) when the goal is met, or when the agent clearly cannot help.",
].join("\n");

/** The Naïve agent spec for the simulated user, for `ensureAgent`. */
export function simulatedUserAgentSpec(opts: {
  model: string;
  /** Monthly cap for this agent, integer micro-USD. */
  capMicroUsd: MicroUsd;
  /** Per-session cap, integer micro-USD. */
  maxTaskMicroUsd: MicroUsd;
}): AgentSpec {
  return {
    role: SIMULATED_USER_ROLE,
    model: opts.model,
    system: SIMULATED_USER_SYSTEM,
    description: "Anybench http-agent simulated user (TDM-40)",
    budget: { capMicroUsd: opts.capMicroUsd, maxTaskMicroUsd: opts.maxTaskMicroUsd },
    outputSchema: z.toJSONSchema(SimulatedUserTurnSchema) as Record<string, unknown>,
  };
}

export interface NaiveSimulatedUserOptions {
  client: NaiveClient;
  /** From `ensureAgent(client, simulatedUserAgentSpec(...))`. */
  agentId: string;
  /** Budget for each turn's session, integer micro-USD. */
  turnBudgetMicroUsd: MicroUsd;
  /** Idempotency prefix, unique per trial attempt (e.g. `<trial_id>:<attempt>`). */
  keyPrefix: string;
  signal?: AbortSignal;
}

/** A simulated user backed by one Naïve session per turn. */
export function naiveSimulatedUser(opts: NaiveSimulatedUserOptions): SimulatedUser {
  return {
    async next(req) {
      const r = await runSession(opts.client, {
        agentId: opts.agentId,
        role: SIMULATED_USER_ROLE,
        input: req,
        output: { schema: SimulatedUserTurnSchema },
        budgetMicroUsd: opts.turnBudgetMicroUsd,
        idempotencyKey: `${opts.keyPrefix}:sim-user:${req.conversation_id}:${req.turn}`,
        metadata: { conversation_id: req.conversation_id, turn: req.turn },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (r.status !== "completed") {
        throw new Error(
          `simulated user session ${r.sessionId} stopped waiting for a human (${r.stopReason ?? "unknown"})`,
        );
      }
      return { done: r.output.done, message: r.output.message, costMicroUsd: r.costMicroUsd };
    },
  };
}
