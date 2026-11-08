// The narrow, Anybench-shaped view of Naïve that the rest of the repo programs against.
// Money is bigint micro-USD; shapes are ours, not the SDK's, so an SDK bump changes one file.

import { z } from "zod";
import type { NaiveComputersApi } from "./computers.js";
import type { MicroUsd } from "./money.js";

export const SESSION_STATUSES = [
  "queued",
  "running",
  "idle",
  "completed",
  "failed",
  "cancelled",
] as const;
export type NaiveSessionStatus = (typeof SESSION_STATUSES)[number];

export const STOP_REASONS = [
  "end_turn",
  "awaiting_input",
  "awaiting_approval",
  "awaiting_answer",
  "awaiting_delegation",
  "budget_paused",
  "interrupted",
  "max_iterations",
  "context_exhausted",
  "error",
] as const;
export type NaiveStopReason = (typeof STOP_REASONS)[number];

export const HARNESSES = ["pi", "claude_code", "vetta", "hermes"] as const;
export type NaiveHarness = (typeof HARNESSES)[number];

export const WINDOWS = ["immediate", "priority", "loose"] as const;
export type NaiveWindow = (typeof WINDOWS)[number];

const microUsd = z.bigint().nonnegative();
const jsonObject = z.record(z.string(), z.unknown());

/** One agent as we see it. `version` is Naïve's `current_version`. */
export interface NaiveAgent {
  id: string;
  name: string;
  version: number;
  model: string;
  harness: NaiveHarness;
  metadata: Record<string, unknown>;
}

/** A blocked tool call or question (`pending_actions` on the session). */
export interface NaivePendingAction {
  kind: "tool" | "question";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  prompt?: string | undefined;
}

export interface NaiveSession {
  id: string;
  agentId: string;
  agentVersion: number;
  status: NaiveSessionStatus;
  stopReason: NaiveStopReason | null;
  stopCode: string | null;
  budgetMicroUsd: MicroUsd;
  consumedMicroUsd: MicroUsd;
  lastSeq: number;
  structuredOutput: Record<string, unknown> | null;
  pendingActions: NaivePendingAction[];
  metadata: Record<string, unknown>;
}

/** One event off a session's log. `seq` is gap-free and strictly increasing. */
export interface NaiveEvent {
  id: string;
  seq: number;
  type: string;
  sessionId: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface NaiveBalance {
  balanceMicroUsd: MicroUsd;
  mode: "live" | "test";
}

export interface NaiveSpend {
  spentMicroUsd: MicroUsd;
}

export interface NaiveSubscription {
  status: "active" | "none" | "past_due" | "canceled";
  plan: string | null;
  graceUntil: string | null;
}

/** What we write when creating or updating an agent. */
export const AgentWriteSchema = z.object({
  name: z.string().min(1).max(100),
  model: z.string().min(1),
  system: z.string(),
  harness: z.enum(HARNESSES).optional(),
  window: z.enum(WINDOWS).optional(),
  description: z.string().nullable().optional(),
  budget: z
    .object({
      capMicroUsd: microUsd,
      maxTaskMicroUsd: microUsd,
      period: z.enum(["day", "week", "month"]),
    })
    .refine((b) => b.maxTaskMicroUsd <= b.capMicroUsd, {
      message: "maxTaskMicroUsd must be <= capMicroUsd",
    }),
  outputSchema: jsonObject.nullable().optional(),
  structuredOutputRequired: z.boolean().optional(),
  /** Open toolset, passed through to Naïve as `tools` (see the SDK's `ToolsetInput`). */
  tools: jsonObject.optional(),
  metadata: jsonObject.optional(),
});
export type AgentWrite = z.infer<typeof AgentWriteSchema>;

export const SessionCreateInputSchema = z.object({
  agentId: z.string().min(1),
  agentVersion: z.number().int().positive().optional(),
  message: z.string().min(1),
  budgetMicroUsd: microUsd,
  outputSchema: jsonObject.optional(),
  structuredOutputRequired: z.boolean().optional(),
  window: z.enum(WINDOWS).optional(),
  metadata: jsonObject.optional(),
});
export type SessionCreateInput = z.infer<typeof SessionCreateInputSchema>;

export interface StreamOptions {
  /** Exclusive resume point: only events with `seq > afterSeq` are delivered. Default 0. */
  afterSeq?: number;
}

/**
 * The Naïve surface Anybench uses. `createNaiveClient` implements it over the real SDK and
 * `FakeNaive` implements it in memory. Every method throws a `NaiveError` subclass on failure.
 */
export interface NaiveClient {
  readonly kind: "live" | "fake";
  agents: {
    /** The agent with this exact name, or null. Walks every page. */
    findByName(name: string): Promise<NaiveAgent | null>;
    get(id: string): Promise<NaiveAgent>;
    create(body: AgentWrite): Promise<NaiveAgent>;
    /** Mints a new agent version. `expectedVersion` is optimistic concurrency (409 on mismatch). */
    update(id: string, body: AgentWrite, opts?: { expectedVersion?: number }): Promise<NaiveAgent>;
  };
  sessions: {
    /** Creates and starts. The same `idempotencyKey` replays the first create instead of making a second session. */
    create(body: SessionCreateInput, opts: { idempotencyKey: string }): Promise<NaiveSession>;
    get(id: string): Promise<NaiveSession>;
    /** Terminal. Idempotent for an already-cancelled session; a completed/failed one is returned as-is. */
    cancel(id: string): Promise<NaiveSession>;
    /** Resumable event stream; ends at `session.idle` (or once caught up on a settled session). */
    stream(id: string, opts?: StreamOptions): AsyncIterable<NaiveEvent>;
  };
  credits: {
    show(): Promise<NaiveBalance>;
    spend(query?: { sessionId?: string; agentId?: string }): Promise<NaiveSpend>;
    subscription(): Promise<NaiveSubscription>;
  };
  /** Micro-VMs (`/v1/computers`, `/v1/snapshots`). `@anybench/providers` wraps it as a ComputeProvider. */
  computers: NaiveComputersApi;
}
