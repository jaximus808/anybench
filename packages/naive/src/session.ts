// runSession: one bounded agent task on Naïve, from create to a validated result.
//
//   create (idempotent) → stream events (resumable with afterSeq, deduped, reconnected)
//   → read the settled session → gate the output against the caller's schema → result.
//
// The correctness gate is the point: a session that ended cleanly but produced no structured output,
// or one that does not parse, is a NaiveOutputInvalidError, never a result.

import { z } from "zod";
import { AGENT_ROLE_KEY } from "./agents.js";
import {
  mapNaiveError,
  NaiveBudgetExceededError,
  NaiveCancelledError,
  NaiveError,
  NaiveOutputInvalidError,
  NaiveSessionFailedError,
} from "./errors.js";
import type { MicroUsd } from "./money.js";
import {
  WINDOWS,
  type NaiveClient,
  type NaiveEvent,
  type NaivePendingAction,
  type NaiveSession,
  type NaiveStopReason,
} from "./types.js";

/** Metadata key carrying the Anybench idempotency key / agent_session_id on every session we create. */
export const SESSION_KEY_METADATA = "anybench_session_key";

export interface RunSessionOptions<T> {
  /** The Naïve agent to run (from `ensureAgent`). */
  agentId: string;
  agentVersion?: number;
  /** Anybench role. Stamped on the session metadata; FakeNaive scripts key on it. */
  role: string;
  /** The task. A string is sent as is; anything else is sent as pretty JSON. */
  input: unknown;
  /**
   * The output contract. `schema` parses `structured_output` (the gate); `jsonSchema` is what Naïve
   * is told the document must match, and defaults to `z.toJSONSchema(schema)`. With neither, the
   * result's `output` is the agent's final message text.
   */
  output?: { schema: z.ZodType<T>; jsonSchema?: Record<string, unknown> };
  /** Spend cap for this session, integer micro-USD. Required: no agent work without a budget. */
  budgetMicroUsd: MicroUsd;
  /** `agent_session_id`. The same key replays the first create, so a retried job never double-spends. */
  idempotencyKey: string;
  /**
   * Re-attach to a session already created (after a worker restart): skip create, and deliver only
   * events after `afterSeq` to `onEvent` (the log is re-read from 0 to recover the final message).
   */
  resume?: { sessionId: string; afterSeq: number };
  /** Called once per event, in seq order, awaited. Persist `agent_events` + `last_seq` here. */
  onEvent?: (event: NaiveEvent) => void | Promise<void>;
  /** Called once with the session as soon as it exists (persist `naive_session_id` before streaming). */
  onSession?: (session: NaiveSession) => void | Promise<void>;
  /** Aborting cancels the Naïve session and rejects with NaiveCancelledError. */
  signal?: AbortSignal;
  window?: (typeof WINDOWS)[number];
  metadata?: Record<string, unknown>;
  /** Stream reconnects this call tolerates on top of the SDK's own. Default 3. */
  maxReconnects?: number;
}

interface RunSessionBase {
  sessionId: string;
  lastSeq: number;
  costMicroUsd: MicroUsd;
  budgetMicroUsd: MicroUsd;
  stopReason: NaiveStopReason | null;
  /** Events delivered to `onEvent` by this call (not counting any at or before `resume.afterSeq`). */
  eventCount: number;
}

export type RunSessionResult<T> =
  | (RunSessionBase & { status: "completed"; output: T; text: string | null })
  /** Parked on an `ask` tool call or a question: a human has to answer before it can go on. */
  | (RunSessionBase & {
      status: "awaiting_human";
      pendingActions: NaivePendingAction[];
      text: string | null;
    });

const OptionsSchema = z.object({
  agentId: z.string().min(1),
  agentVersion: z.number().int().positive().optional(),
  role: z.string().min(1),
  budgetMicroUsd: z.bigint().positive("budgetMicroUsd must be > 0"),
  idempotencyKey: z.string().min(1).max(255),
  resume: z
    .object({ sessionId: z.string().min(1), afterSeq: z.number().int().nonnegative() })
    .optional(),
  maxReconnects: z.number().int().nonnegative().optional(),
});

const TURN_ENDED: ReadonlySet<NaiveStopReason> = new Set(["end_turn", "awaiting_input"]);
const NEEDS_HUMAN: ReadonlySet<NaiveStopReason> = new Set(["awaiting_approval", "awaiting_answer"]);

function messageFor(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

function settled(session: NaiveSession): boolean {
  return session.status !== "running" && session.status !== "queued";
}

/** Cancels a session, tolerating one that already ended. */
export async function cancelSession(client: NaiveClient, sessionId: string): Promise<NaiveSession> {
  return client.sessions.cancel(sessionId);
}

export async function runSession<T = string>(
  client: NaiveClient,
  options: RunSessionOptions<T>,
): Promise<RunSessionResult<T>> {
  const opts = OptionsSchema.parse(options);
  const { signal } = options;
  const maxReconnects = opts.maxReconnects ?? 3;
  const jsonSchema = options.output
    ? (options.output.jsonSchema ??
      (z.toJSONSchema(options.output.schema) as Record<string, unknown>))
    : undefined;

  if (signal?.aborted) {
    throw new NaiveCancelledError("runSession aborted before the session was created", {
      code: "cancelled",
      lastSeq: 0,
    });
  }

  let session: NaiveSession;
  if (opts.resume) {
    session = await client.sessions.get(opts.resume.sessionId);
  } else {
    session = await client.sessions.create(
      {
        agentId: opts.agentId,
        ...(opts.agentVersion !== undefined ? { agentVersion: opts.agentVersion } : {}),
        message: messageFor(options.input),
        budgetMicroUsd: opts.budgetMicroUsd,
        ...(jsonSchema ? { outputSchema: jsonSchema, structuredOutputRequired: true } : {}),
        ...(options.window ? { window: options.window } : {}),
        metadata: {
          ...options.metadata,
          [AGENT_ROLE_KEY]: opts.role,
          [SESSION_KEY_METADATA]: opts.idempotencyKey,
        },
      },
      { idempotencyKey: opts.idempotencyKey },
    );
  }
  const sessionId = session.id;
  await options.onSession?.(session);

  // On resume we re-read the log from 0, so the final message and any budget event before the
  // cursor are still seen, but `onEvent` only gets events after `resume.afterSeq` (already persisted).
  const deliverAfter = opts.resume?.afterSeq ?? 0;
  let lastSeq = 0;
  let eventCount = 0;
  let text: string | null = null;
  let budgetEvent: NaiveEvent | null = null;

  const cancelled = async (): Promise<never> => {
    await client.sessions.cancel(sessionId).catch(() => undefined);
    throw new NaiveCancelledError(`session ${sessionId} cancelled`, {
      code: "cancelled",
      sessionId,
      lastSeq,
    });
  };

  // Stream until the session settles. Each pass resumes after the last seq we delivered.
  let reconnects = 0;
  for (;;) {
    if (signal?.aborted) await cancelled();
    let sawIdle = false;
    try {
      const stream = client.sessions.stream(sessionId, { afterSeq: lastSeq });
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = await nextOrAbort(iterator, signal);
        if (next === ABORTED) {
          void iterator.return?.().catch(() => undefined);
          await cancelled();
        }
        const step = next as IteratorResult<NaiveEvent>;
        if (step.done) break;
        const event = step.value;
        if (event.seq <= lastSeq) continue; // duplicate after a reconnect
        lastSeq = event.seq;
        reconnects = 0;
        if (event.type === "message.completed" && event.data.role !== "user") {
          text =
            typeof event.data.content === "string"
              ? event.data.content
              : JSON.stringify(event.data.content);
        }
        if (event.type === "budget.exceeded") budgetEvent = event;
        if (event.type === "session.idle") sawIdle = true;
        if (event.seq <= deliverAfter) continue;
        eventCount += 1;
        await options.onEvent?.(event);
      }
    } catch (error) {
      const mapped = mapNaiveError(error, sessionId);
      if (!mapped.retryable || reconnects >= maxReconnects) throw mapped;
      reconnects += 1;
      continue;
    }
    session = await client.sessions.get(sessionId);
    if (settled(session) || sawIdle) break;
    // The stream ended without the session settling (connection dropped for good): go again.
    if (reconnects >= maxReconnects) {
      throw new NaiveError(
        `stream for session ${sessionId} ended while the session was still ${session.status}`,
        {
          code: "stream_ended",
          sessionId,
        },
      );
    }
    reconnects += 1;
  }

  if (signal?.aborted) await cancelled();

  const base: RunSessionBase = {
    sessionId,
    lastSeq: Math.max(lastSeq, session.lastSeq),
    costMicroUsd: session.consumedMicroUsd,
    budgetMicroUsd: session.budgetMicroUsd,
    stopReason: session.stopReason,
    eventCount,
  };

  if (budgetEvent || session.stopReason === "budget_paused") {
    throw new NaiveBudgetExceededError(
      `session ${sessionId} hit its budget (${session.consumedMicroUsd} of ${session.budgetMicroUsd} micro-USD)`,
      {
        code: "budget_exceeded",
        sessionId,
        budgetMicroUsd: session.budgetMicroUsd,
        consumedMicroUsd: session.consumedMicroUsd,
        lastSeq: base.lastSeq,
      },
    );
  }
  if (session.status === "cancelled") {
    throw new NaiveCancelledError(`session ${sessionId} was cancelled`, {
      code: "cancelled",
      sessionId,
      lastSeq: base.lastSeq,
    });
  }
  if (session.stopReason && NEEDS_HUMAN.has(session.stopReason)) {
    return { ...base, status: "awaiting_human", pendingActions: session.pendingActions, text };
  }
  if (session.status === "failed" || !session.stopReason || !TURN_ENDED.has(session.stopReason)) {
    throw new NaiveSessionFailedError(
      `session ${sessionId} ended ${session.status}${session.stopReason ? ` (${session.stopReason})` : ""}`,
      {
        code: "session_failed",
        sessionId,
        sessionStatus: session.status,
        stopReason: session.stopReason,
        stopCode: session.stopCode,
        lastSeq: base.lastSeq,
      },
    );
  }

  if (!options.output) {
    if (text === null) {
      throw new NaiveOutputInvalidError(`session ${sessionId} ended without an agent message`, {
        code: "output_missing",
        sessionId,
        issues: [],
        received: null,
      });
    }
    return { ...base, status: "completed", output: text as T, text };
  }

  const received = session.structuredOutput;
  if (received === null) {
    throw new NaiveOutputInvalidError(`session ${sessionId} produced no structured output`, {
      code: "output_missing",
      sessionId,
      issues: [],
      received,
    });
  }
  const parsed = options.output.schema.safeParse(received);
  if (!parsed.success) {
    throw new NaiveOutputInvalidError(`session ${sessionId} output does not match its schema`, {
      code: "output_invalid",
      sessionId,
      issues: parsed.error.issues,
      received,
    });
  }
  return { ...base, status: "completed", output: parsed.data, text };
}

const ABORTED = Symbol("aborted");

function nextOrAbort<V>(
  iterator: AsyncIterator<V>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<V> | typeof ABORTED> {
  if (!signal) return iterator.next();
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
