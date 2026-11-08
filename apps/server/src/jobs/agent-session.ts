// TDM-55 [6.1]: run ONE agent role session for an orchestrator stage, with persistence.
//
//   runAgentStage(deps, {ctx, role, input, schema, budgetMicroUsd})
//     1. ensure the role's Naïve agent (ensureAgent, cached per process and spec fingerprint);
//     2. agent_sessions row with a deterministic id from ctx.idempotencyKey + role, which is also the
//        Naïve idempotencyKey: a stage that runs again replays the same session, never a second one;
//     3. naive_session_id written in onSession, before any event is streamed;
//     4. every event → agent_events (unique (session, naive_seq): a replay is a no-op), last_seq
//        advanced after it, assistant messages → `agent.message` on the run (redacted, truncated);
//     5. a rerun of a row that has a naive_session_id resumes with afterSeq = last_seq;
//     6. final status, stop_reason, cost; the zod-validated output → StageResult.
//
// Outcomes. Output invalid, budget exceeded, a session waiting on a human, a failed session and a
// non-transient Naïve refusal (credits, auth, validation) hold the run (`needs_human`) with a
// reason. Transient Naïve errors (429/5xx/network) and our own bugs throw, so the job retries and
// resumes from last_seq. An aborted ctx.signal cancels the Naïve session (runSession does) and the
// row ends `cancelled`; a later visit with a live signal starts a fresh Naïve session for the row.
//
// Spend. Our own agents are COGS covered by the run fee (plan.md section 8), not user usage: each
// session's consumed micro-USD is written once to cost_entries (source "naive", ref = the Naïve
// session id, run_id) as deltas over what was already recorded for that Naïve session, in the same
// transaction as the row update. runs.spent_micro_usd and usage_entries are NOT touched, and the
// `agent.message` events carry cost_delta_micro_usd 0 (they must not move the user's spent counter).
import { createHash } from "node:crypto";
import { redact, redactJson, uuidv7 } from "@anybench/core";
import { roleAgentSpec, RoleError, type RoleSpecOverrides } from "@anybench/agents";
import {
  agentFingerprint,
  ensureAgent,
  NaiveBudgetExceededError,
  NaiveCancelledError,
  NaiveError,
  NaiveOutputInvalidError,
  NaiveSessionFailedError,
  retryOnNaiveCapacity,
  runSession,
  type AgentSpec,
  type EnsuredAgent,
  type NaiveClient,
  type NaiveEvent,
  type NaivePendingAction,
  type RunSessionResult,
} from "@anybench/naive";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { agentEvents } from "../db/schema/agent_events.js";
import { agentSessions } from "../db/schema/agent_sessions.js";
import { costEntries } from "../db/schema/cost_entries.js";
import {
  stageHold,
  stageOk,
  type StageContext,
  type StageEventDraft,
  type StageResult,
} from "../orchestrator/ports.js";

/** agent_sessions.status values this helper writes (the API's AgentSession vocabulary). */
export const AGENT_SESSION_STATUS = {
  pending: "pending",
  running: "running",
  /** Parked on a human (an `ask` tool call or a question). Still live on Naïve. */
  waiting: "waiting",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/** Longest `agent.message` text put on the run's event stream. */
export const AGENT_MESSAGE_MAX_CHARS = 2_000;

export interface AgentStageDeps {
  db: Database;
  client: NaiveClient;
}

export interface RunAgentStageArgs<T> {
  ctx: StageContext;
  /** The role (a packages/agents/<role> folder unless `agent` says otherwise). */
  role: string;
  /** The task: a string is sent as is, anything else as pretty JSON. */
  input: unknown;
  /** The correctness gate on the session's structured output. */
  schema: z.ZodType<T>;
  /** Cap for this session, integer micro-USD. */
  budgetMicroUsd: bigint;
  /**
   * The agent to run: an already ensured agent, an ensureAgent spec, or overrides for the role's
   * folder spec (e.g. a cheaper model). Default: `roleAgentSpec(role)`.
   */
  agent?: EnsuredAgent | AgentSpec | { overrides: RoleSpecOverrides };
  /** The JSON schema Naïve is told to match. Default: the spec's output schema, else the zod schema's. */
  jsonSchema?: Record<string, unknown>;
}

export interface AgentStageOutput<T> {
  output: T;
  /** What this agent session has cost in total, integer micro-USD. */
  costMicroUsd: bigint;
  /** agent_sessions.id. */
  sessionId: string;
  naiveSessionId: string;
  /** True when the row was already settled and the result was read back, not re-run. */
  replayed: boolean;
}

// ---------- ids ----------

/**
 * agent_sessions.id for a stage visit and role: a name-based UUID (RFC 9562 version 8, from
 * sha256) of `<idempotencyKey>\0<role>`, so a rerun of the same visit lands on the same row.
 */
export function agentSessionIdFor(idempotencyKey: string, role: string): string {
  const h = createHash("sha256")
    .update(`anybench:agent_session:${idempotencyKey}\0${role}`)
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x80; // version 8
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------- agent cache ----------

const agentCache = new WeakMap<NaiveClient, Map<string, Promise<EnsuredAgent>>>();

/** ensureAgent once per process, client and spec fingerprint (a changed spec is ensured again). */
export function ensureAgentCached(client: NaiveClient, spec: AgentSpec): Promise<EnsuredAgent> {
  let byKey = agentCache.get(client);
  if (!byKey) {
    byKey = new Map();
    agentCache.set(client, byKey);
  }
  const key = `${spec.role}:${agentFingerprint(spec)}`;
  let hit = byKey.get(key);
  if (!hit) {
    // A 429 "at capacity" was refused (nothing written): retry ensureAgent whole with backoff.
    hit = retryOnNaiveCapacity(`ensureAgent ${spec.role}`, () => ensureAgent(client, spec));
    byKey.set(key, hit);
    hit.catch(() => byKey.delete(key));
  }
  return hit;
}

function isEnsured(a: unknown): a is EnsuredAgent {
  return typeof a === "object" && a !== null && "agent" in a && "fingerprint" in a;
}

// ---------- helpers ----------

type SessionRow = typeof agentSessions.$inferSelect;

const SETTLED = new Set<string>([
  AGENT_SESSION_STATUS.done,
  AGENT_SESSION_STATUS.failed,
  AGENT_SESSION_STATUS.cancelled,
]);

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max
    ? { text, truncated: false }
    : { text: `${text.slice(0, max - 1)}…`, truncated: true };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((c) =>
      c && typeof c === "object" && "text" in c && typeof c.text === "string"
        ? c.text
        : JSON.stringify(c),
    );
    return parts.join("");
  }
  return JSON.stringify(content ?? "");
}

function issuesText(issues: readonly unknown[]): string {
  return issues
    .slice(0, 5)
    .map((i) => {
      const issue = i as { path?: unknown[]; message?: string };
      const p = Array.isArray(issue.path) && issue.path.length ? issue.path.join(".") : "(root)";
      return `${p}: ${issue.message ?? "invalid"}`;
    })
    .join("; ");
}

/** The API's PendingActionSchema shape (packages/core api/runs.ts). */
function pendingActionOf(actions: readonly NaivePendingAction[]): unknown {
  const a = actions[0];
  if (!a) return null;
  if (a.kind === "question") return { kind: "answer", question: redact(a.prompt ?? a.name) };
  return {
    kind: "confirm_tool",
    tool_use_id: a.toolCallId,
    tool: a.name,
    input_preview: truncate(redact(JSON.stringify(a.args)), 500).text,
  };
}

// ---------- the stage helper ----------

export async function runAgentStage<T>(
  deps: AgentStageDeps,
  args: RunAgentStageArgs<T>,
): Promise<StageResult<AgentStageOutput<T>>> {
  const { db, client } = deps;
  const { ctx, role } = args;
  const budget = z.bigint().positive("budgetMicroUsd must be > 0").parse(args.budgetMicroUsd);
  const id = agentSessionIdFor(ctx.idempotencyKey, role);

  // 1. The agent.
  let ensured: EnsuredAgent;
  let spec: AgentSpec | null = null;
  try {
    if (isEnsured(args.agent)) {
      ensured = args.agent;
    } else {
      spec =
        args.agent && "system" in args.agent
          ? args.agent
          : roleAgentSpec(
              role,
              args.agent && "overrides" in args.agent ? args.agent.overrides : {},
            );
      ensured = await ensureAgentCached(client, spec);
    }
  } catch (error) {
    if (error instanceof RoleError) return stageHold(`agent role "${role}": ${error.message}`);
    return naiveOutcome(error, role);
  }
  const jsonSchema =
    args.jsonSchema ??
    (spec?.outputSchema as Record<string, unknown> | undefined) ??
    (z.toJSONSchema(args.schema) as Record<string, unknown>);

  // 2. The row (deterministic id; a rerun finds it).
  await db
    .insert(agentSessions)
    .values({
      id,
      runId: ctx.run.id,
      role,
      budgetMicroUsd: budget,
      status: AGENT_SESSION_STATUS.pending,
    })
    .onConflictDoNothing({ target: agentSessions.id });
  let [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, id));
  if (!row) throw new Error(`agent_sessions row ${id} vanished`);
  if (row.role !== role || row.runId !== ctx.run.id) {
    throw new Error(`agent_sessions ${id} belongs to ${row.role} / run ${row.runId ?? "none"}`);
  }

  // A cancelled row seen with a live signal (a worker shutdown or lost lease cancelled it, and the
  // stage runs again): start a fresh Naïve session. Its key names the cancelled one, so this is
  // deterministic too. Old events are dropped (the transcript of a cancelled session).
  let naiveKey = id;
  if (row.status === AGENT_SESSION_STATUS.cancelled && !ctx.signal.aborted) {
    if (row.naiveSessionId) naiveKey = `${id}:after:${row.naiveSessionId}`;
    row = await restartRow(db, row);
  }
  const wasSettled = SETTLED.has(row.status);

  // 3. Session: resume when we know its Naïve id, else create (idempotent on naiveKey).
  const resume = row.naiveSessionId
    ? { sessionId: row.naiveSessionId, afterSeq: row.lastSeq }
    : undefined;
  let naiveSessionId = row.naiveSessionId;
  let lastSeq = row.lastSeq;

  // A failure in our own persistence (DB, emit) must not look like a dropped stream: runSession
  // would reconnect past the event. Remember the first one, persist nothing after it, and rethrow
  // it as is, so the job retries and resumes from the last persisted seq.
  let hookError: unknown = null;
  const onEvent = async (event: NaiveEvent): Promise<void> => {
    if (hookError !== null) throw hookError;
    try {
      await persistEvent(event);
    } catch (error) {
      hookError = error;
      throw error;
    }
  };
  const persistEvent = async (event: NaiveEvent): Promise<void> => {
    const payload = redactJson(event.data);
    await db
      .insert(agentEvents)
      .values({
        agentSessionId: id,
        naiveSeq: event.seq,
        type: event.type,
        payload,
        at: new Date(event.createdAt),
      })
      .onConflictDoNothing();
    if (event.seq > lastSeq) {
      const draft = messageDraft(id, role, event);
      // At-least-once: emitted before last_seq moves, so a crash in between re-emits, never drops.
      if (draft) await ctx.emit([draft]);
      lastSeq = event.seq;
      await db
        .update(agentSessions)
        .set({
          lastSeq: sql`greatest(${agentSessions.lastSeq}, ${event.seq})`,
          updatedAt: sql`now()`,
        })
        .where(eq(agentSessions.id, id));
    }
  };

  let result: RunSessionResult<T>;
  try {
    result = await runSession<T>(client, {
      agentId: ensured.agent.id,
      agentVersion: ensured.agent.version,
      role,
      input: args.input,
      output: { schema: args.schema, jsonSchema },
      budgetMicroUsd: budget,
      idempotencyKey: naiveKey,
      ...(resume ? { resume } : {}),
      signal: ctx.signal,
      metadata: { run_id: ctx.run.id, agent_session_id: id },
      onSession: async (session) => {
        naiveSessionId = session.id;
        if (row.naiveSessionId === session.id && wasSettled) return;
        await db
          .update(agentSessions)
          .set({
            naiveSessionId: session.id,
            status: wasSettled ? row.status : AGENT_SESSION_STATUS.running,
            updatedAt: sql`now()`,
          })
          .where(eq(agentSessions.id, id));
      },
      onEvent,
    });
  } catch (error) {
    if (hookError !== null) throw hookError;
    return settleError(deps, { id, role, runId: ctx.run.id, naiveSessionId }, error);
  }

  // runSession reconnects past a failing onEvent and can still return: our persistence broke, so
  // nothing after it was stored. Retry the stage (it resumes from the last persisted seq).
  if (hookError !== null) throw hookError;

  // 4. Settle.
  if (result.status === "awaiting_human") {
    await settle(db, id, ctx.run.id, result.sessionId, {
      status: AGENT_SESSION_STATUS.waiting,
      costMicroUsd: result.costMicroUsd,
      stopReason: result.stopReason,
      lastSeq: result.lastSeq,
      pendingAction: pendingActionOf(result.pendingActions),
    });
    const first = result.pendingActions[0];
    const what = first
      ? first.kind === "question"
        ? `a question (${truncate(redact(first.prompt ?? first.name), 200).text})`
        : `approval of tool ${first.name}`
      : "a human";
    return stageHold(`the ${role} agent is waiting for ${what} (session ${id})`);
  }
  const cost = await settle(db, id, ctx.run.id, result.sessionId, {
    status: AGENT_SESSION_STATUS.done,
    costMicroUsd: result.costMicroUsd,
    stopReason: result.stopReason,
    lastSeq: result.lastSeq,
    pendingAction: null,
  });
  return stageOk({
    output: result.output,
    costMicroUsd: cost,
    sessionId: id,
    naiveSessionId: result.sessionId,
    replayed: wasSettled,
  });
}

function messageDraft(id: string, role: string, event: NaiveEvent): StageEventDraft | null {
  if (event.type !== "message.completed") return null;
  const raw = event.data.role;
  if (raw === "user") return null; // our own task message
  const messageRole = raw === "system" ? "system" : "assistant";
  const { text, truncated } = truncate(
    redact(contentText(event.data.content)),
    AGENT_MESSAGE_MAX_CHARS,
  );
  return {
    type: "agent.message",
    source: "agent_session",
    source_id: id,
    severity: "info",
    actor: { kind: "agent", id },
    cost_delta_micro_usd: 0n,
    at: event.createdAt,
    payload: { agent_role: role, naive_seq: event.seq, message_role: messageRole, text, truncated },
  };
}

async function restartRow(db: Database, row: SessionRow): Promise<SessionRow> {
  return db.transaction(async (tx) => {
    await tx.delete(agentEvents).where(eq(agentEvents.agentSessionId, row.id));
    const [next] = await tx
      .update(agentSessions)
      .set({
        naiveSessionId: null,
        status: AGENT_SESSION_STATUS.pending,
        lastSeq: 0,
        stopReason: null,
        pendingAction: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(agentSessions.id, row.id), eq(agentSessions.status, AGENT_SESSION_STATUS.cancelled)),
      )
      .returning();
    return next ?? row;
  });
}

interface SettleFields {
  status: string;
  /** The Naïve session's consumed micro-USD, or null when unknown. */
  costMicroUsd: bigint | null;
  stopReason: string | null;
  lastSeq?: number;
  pendingAction: unknown;
}

/**
 * Writes the row's outcome and books the spend not yet booked for this Naïve session to
 * cost_entries, in one transaction (row locked), so a replay never books twice. Returns the
 * row's total cost.
 */
async function settle(
  db: Database,
  id: string,
  runId: string,
  naiveSessionId: string | null,
  f: SettleFields,
): Promise<bigint> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .for("update");
    if (!row) throw new Error(`agent_sessions row ${id} vanished`);
    let total = row.costMicroUsd;
    if (naiveSessionId && f.costMicroUsd !== null) {
      const [booked] = await tx
        .select({ sum: sql<string>`coalesce(sum(${costEntries.amountMicroUsd}), 0)::text` })
        .from(costEntries)
        .where(and(eq(costEntries.source, "naive"), eq(costEntries.ref, naiveSessionId)));
      const delta = f.costMicroUsd - BigInt(booked?.sum ?? "0");
      if (delta > 0n) {
        await tx.insert(costEntries).values({
          id: uuidv7(),
          source: "naive",
          runId,
          amountMicroUsd: delta,
          ref: naiveSessionId,
        });
        total += delta;
      }
    }
    await tx
      .update(agentSessions)
      .set({
        status: f.status,
        costMicroUsd: total,
        stopReason: f.stopReason,
        pendingAction: f.pendingAction ?? null,
        ...(f.lastSeq !== undefined
          ? { lastSeq: sql`greatest(${agentSessions.lastSeq}, ${f.lastSeq})` }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(agentSessions.id, id));
    return total;
  });
}

/** What a session that threw means for the stage (and the row). */
async function settleError<T>(
  deps: AgentStageDeps,
  s: { id: string; role: string; runId: string; naiveSessionId: string | null },
  error: unknown,
): Promise<StageResult<T>> {
  const { db, client } = deps;
  const naiveId =
    s.naiveSessionId ?? (error instanceof NaiveError ? (error.sessionId ?? null) : null);
  const consumed = async (): Promise<bigint | null> => {
    if (!naiveId) return null;
    try {
      return (await client.sessions.get(naiveId)).consumedMicroUsd;
    } catch {
      return null;
    }
  };

  if (error instanceof NaiveCancelledError) {
    await settle(db, s.id, s.runId, naiveId, {
      status: AGENT_SESSION_STATUS.cancelled,
      costMicroUsd: await consumed(),
      stopReason: "cancelled",
      pendingAction: null,
    });
    throw error; // the orchestrator sees its own aborted signal and treats the stage as interrupted
  }
  if (error instanceof NaiveBudgetExceededError) {
    await settle(db, s.id, s.runId, naiveId, {
      status: AGENT_SESSION_STATUS.failed,
      costMicroUsd: error.consumedMicroUsd ?? (await consumed()),
      stopReason: "budget_exceeded",
      pendingAction: null,
    });
    return stageHold(
      naiveId
        ? `the ${s.role} agent hit its budget (${error.consumedMicroUsd ?? "?"} of ${error.budgetMicroUsd ?? "?"} micro-USD, session ${s.id})`
        : `Naïve refused the ${s.role} session: its budget is below the pre-flight quote (${error.message})`,
    );
  }
  if (error instanceof NaiveOutputInvalidError) {
    await settle(db, s.id, s.runId, naiveId, {
      status: AGENT_SESSION_STATUS.failed,
      costMicroUsd: await consumed(),
      stopReason: error.code,
      pendingAction: null,
    });
    const detail =
      error.code === "output_missing" ? "no structured output" : issuesText(error.issues);
    return stageHold(`the ${s.role} agent's output failed its schema: ${detail} (session ${s.id})`);
  }
  if (error instanceof NaiveSessionFailedError) {
    await settle(db, s.id, s.runId, naiveId, {
      status: AGENT_SESSION_STATUS.failed,
      costMicroUsd: await consumed(),
      stopReason: error.stopReason ?? error.sessionStatus,
      pendingAction: null,
    });
    return stageHold(
      `the ${s.role} agent session failed (${error.sessionStatus}${error.stopReason ? `, ${error.stopReason}` : ""}${error.stopCode ? `, ${error.stopCode}` : ""}; session ${s.id})`,
    );
  }
  return naiveOutcome(error, s.role);
}

/** Transient (and unknown) errors throw so the job retries; a Naïve refusal holds for a human. */
function naiveOutcome<T>(error: unknown, role: string): StageResult<T> {
  if (error instanceof NaiveError && !error.retryable) {
    return stageHold(`Naïve refused the ${role} session: ${error.code} (${redact(error.message)})`);
  }
  throw error;
}
