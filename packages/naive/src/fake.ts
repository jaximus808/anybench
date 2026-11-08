// FakeNaive: an in-memory NaiveClient for offline tests. No network, no spend.
//
//   const naive = new FakeNaive();
//   naive.script("understander", { output: { kind: "cli", ... }, costMicroUsd: 2_000n });
//   const { agent } = await ensureAgent(naive, spec);
//   const result = await runSession(naive, { agentId: agent.id, role: "understander", ... });
//   expect(naive.spentMicroUsd()).toBe(2_000n);
//
// Scripts are keyed by role (the session's `anybench_role` metadata, else the agent's). Queued
// scripts are used first-in first-out; `scriptDefault` answers once a role's queue is empty. A
// session with no script throws, so a test never passes on output it did not choose.

import { AGENT_ROLE_KEY } from "./agents.js";
import { FakeNaiveComputers, type FakeNaiveComputersOptions } from "./fake-computers.js";
import {
  NaiveError,
  naiveErrorFor,
  NaiveInsufficientCreditsError,
  NaiveNotFoundError,
  NaiveConflictError,
  NaiveSubscriptionRequiredError,
} from "./errors.js";
import type { MicroUsd } from "./money.js";
import {
  AgentWriteSchema,
  SessionCreateInputSchema,
  type AgentWrite,
  type NaiveAgent,
  type NaiveBalance,
  type NaiveClient,
  type NaiveEvent,
  type NaivePendingAction,
  type NaiveSession,
  type NaiveSpend,
  type NaiveStopReason,
  type NaiveSubscription,
  type SessionCreateInput,
  type StreamOptions,
} from "./types.js";

export interface FakeScriptContext {
  role: string;
  /** The message the session was created with. */
  message: string;
  /** `message` parsed as JSON when it is JSON, else the string. */
  input: unknown;
  agent: NaiveAgent;
  metadata: Record<string, unknown>;
  outputSchema: Record<string, unknown> | undefined;
}

export interface FakeScript {
  /** The session's `structured_output` (the output_schema document). A function gets the context. */
  output?: unknown;
  /** The agent's final message. Defaults to JSON of `output`, or "ok". */
  text?: string | ((ctx: FakeScriptContext) => string);
  /** Extra events between `session.running` and the final message, e.g. tool calls. */
  events?: Array<{ type: string; data?: Record<string, unknown> }>;
  /** What the session spends. Default 1_000n (0.1¢). Capped at the session budget. */
  costMicroUsd?: MicroUsd;
  /** Default `end_turn`. */
  stopReason?: NaiveStopReason;
  /** Default `idle`; `failed` with `stopReason: "error"` simulates a crashed run. */
  status?: "idle" | "failed";
  stopCode?: string;
  /** Parks the session on these (use with `stopReason: "awaiting_approval"` or `"awaiting_answer"`). */
  pendingActions?: NaivePendingAction[];
  /** The session stays `running` after its first events until `cancel()` (or `fake.release(id)`). */
  hang?: boolean;
  /** The first stream throws a retryable 503 right after delivering this seq. */
  dropStreamAfterSeq?: number;
  /** `sessions.create` throws this instead of creating a session. */
  createError?: NaiveError;
}

export type FakeScriptInput = FakeScript | ((ctx: FakeScriptContext) => FakeScript);

export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeSessionCreateRecord {
  sessionId: string;
  idempotencyKey: string;
  role: string;
  body: SessionCreateInput;
  replayed: boolean;
}

interface FakeAgentRecord {
  agent: NaiveAgent;
  versions: AgentWrite[];
}

interface FakeSessionRecord {
  session: NaiveSession;
  events: NaiveEvent[];
  /** The rest of the script, appended on `release` (hang). */
  pending: Array<{ type: string; data: Record<string, unknown> }>;
  final: Pick<
    NaiveSession,
    "status" | "stopReason" | "stopCode" | "structuredOutput" | "pendingActions"
  > & {
    consumedMicroUsd: MicroUsd;
  };
  dropAfterSeq: number | undefined;
  waiters: Array<() => void>;
  charged: boolean;
}

export interface FakeNaiveOptions {
  balanceMicroUsd?: MicroUsd;
  subscription?: NaiveSubscription["status"];
  mode?: "live" | "test";
  /** Clock for event timestamps. */
  now?: () => Date;
  /** How the fake computers behave (provisioning delay, fs/exec lag, homes, time scale). */
  computers?: FakeNaiveComputersOptions;
}

const DEFAULT_COST = 1_000n;

export class FakeNaive implements NaiveClient {
  readonly kind = "fake" as const;
  /** Every call, in order. */
  readonly calls: FakeCall[] = [];
  /** Every `sessions.create`, including idempotent replays. */
  readonly sessionCreates: FakeSessionCreateRecord[] = [];

  private balance: MicroUsd;
  private subscriptionStatus: NaiveSubscription["status"];
  private readonly mode: "live" | "test";
  private readonly now: () => Date;
  private readonly agentRecords = new Map<string, FakeAgentRecord>();
  private readonly sessionRecords = new Map<string, FakeSessionRecord>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly queues = new Map<string, FakeScriptInput[]>();
  private readonly defaults = new Map<string, FakeScriptInput>();
  private readonly failures = new Map<string, NaiveError[]>();
  private counter = 0;
  /** In-memory micro-VMs (see fake-computers.ts); its test controls hang off it too. */
  readonly computers: FakeNaiveComputers;

  constructor(options: FakeNaiveOptions = {}) {
    this.balance = options.balanceMicroUsd ?? 250_000_000n;
    this.subscriptionStatus = options.subscription ?? "active";
    this.mode = options.mode ?? "test";
    this.now = options.now ?? (() => new Date("2026-11-07T00:00:00.000Z"));
    this.computers = new FakeNaiveComputers(
      {
        enter: (method, args) => this.enter(method, args),
        balance: () => this.balance,
        charge: (amount) => {
          this.balance -= amount;
        },
        id: (prefix) => this.id(prefix),
        now: () => this.now(),
      },
      options.computers,
    );
  }

  // ── test controls ──────────────────────────────────────────────────────────

  /** Queue one or more scripts for `role`, used in order by the next sessions of that role. */
  script(role: string, ...scripts: FakeScriptInput[]): this {
    const queue = this.queues.get(role) ?? [];
    queue.push(...scripts);
    this.queues.set(role, queue);
    return this;
  }

  /** The script for `role` once its queue is empty. */
  scriptDefault(role: string, script: FakeScriptInput): this {
    this.defaults.set(role, script);
    return this;
  }

  /** The next call to `method` (e.g. "sessions.create", "agents.list") throws `error`. */
  failNext(method: string, error: NaiveError): this {
    const list = this.failures.get(method) ?? [];
    list.push(error);
    this.failures.set(method, list);
    return this;
  }

  setSubscription(status: NaiveSubscription["status"]): this {
    this.subscriptionStatus = status;
    return this;
  }

  setBalance(balanceMicroUsd: MicroUsd): this {
    this.balance = balanceMicroUsd;
    return this;
  }

  /** Total charged across every session, integer micro-USD. */
  spentMicroUsd(query: { sessionId?: string; agentId?: string } = {}): MicroUsd {
    let total = 0n;
    for (const rec of this.sessionRecords.values()) {
      if (query.sessionId && rec.session.id !== query.sessionId) continue;
      if (query.agentId && rec.session.agentId !== query.agentId) continue;
      total += rec.session.consumedMicroUsd;
    }
    return total;
  }

  /** Spend per session id. */
  spendBySession(): Map<string, MicroUsd> {
    return new Map(
      [...this.sessionRecords.values()].map((r) => [r.session.id, r.session.consumedMicroUsd]),
    );
  }

  /** The full event log of a session (what a stream from seq 0 would deliver). */
  eventsOf(sessionId: string): NaiveEvent[] {
    return [...this.record(sessionId).events];
  }

  sessionOf(sessionId: string): NaiveSession {
    return structuredClone(this.record(sessionId).session);
  }

  allSessions(): NaiveSession[] {
    return [...this.sessionRecords.values()].map((r) => structuredClone(r.session));
  }

  allAgents(): NaiveAgent[] {
    return [...this.agentRecords.values()].map((r) => structuredClone(r.agent));
  }

  /** Every version written for an agent, oldest first. */
  agentVersions(agentId: string): AgentWrite[] {
    const rec = this.agentRecords.get(agentId);
    if (!rec) throw new Error(`FakeNaive: no agent ${agentId}`);
    return structuredClone(rec.versions);
  }

  /** Finishes a `hang: true` session as its script says. */
  release(sessionId: string): void {
    const rec = this.record(sessionId);
    if (rec.session.status !== "running") return;
    for (const e of rec.pending) this.append(rec, e.type, e.data);
    rec.pending = [];
    this.settle(rec);
  }

  // ── NaiveClient ────────────────────────────────────────────────────────────

  readonly agents: NaiveClient["agents"] = {
    findByName: async (name) => {
      this.enter("agents.list", [name]);
      const hit = [...this.agentRecords.values()].find((r) => r.agent.name === name);
      return hit ? structuredClone(hit.agent) : null;
    },
    get: async (id) => {
      this.enter("agents.get", [id]);
      return structuredClone(this.agentRecord(id).agent);
    },
    create: async (body) => {
      this.enter("agents.create", [body]);
      const write = AgentWriteSchema.parse(body);
      if ([...this.agentRecords.values()].some((r) => r.agent.name === write.name)) {
        throw new NaiveConflictError(`agent ${write.name} already exists`, {
          code: "conflict",
          status: 409,
        });
      }
      const id = this.id("agt");
      const agent: NaiveAgent = {
        id,
        name: write.name,
        version: 1,
        model: write.model,
        harness: write.harness ?? "pi",
        metadata: write.metadata ?? {},
      };
      this.agentRecords.set(id, { agent, versions: [write] });
      return structuredClone(agent);
    },
    update: async (id, body, opts) => {
      this.enter("agents.update", [id, body, opts]);
      const rec = this.agentRecord(id);
      const write = AgentWriteSchema.parse(body);
      if (opts?.expectedVersion !== undefined && opts.expectedVersion !== rec.agent.version) {
        throw new NaiveConflictError(`agent ${id} is at version ${rec.agent.version}`, {
          code: "version_conflict",
          status: 409,
        });
      }
      rec.versions.push(write);
      rec.agent = {
        ...rec.agent,
        name: write.name,
        version: rec.agent.version + 1,
        model: write.model,
        harness: write.harness ?? rec.agent.harness,
        metadata: write.metadata ?? rec.agent.metadata,
      };
      return structuredClone(rec.agent);
    },
  };

  readonly sessions: NaiveClient["sessions"] = {
    create: async (body, opts) => {
      this.enter("sessions.create", [body, opts]);
      const input = SessionCreateInputSchema.parse(body);
      const replay = this.byIdempotencyKey.get(opts.idempotencyKey);
      if (replay) {
        const rec = this.record(replay);
        this.sessionCreates.push({
          sessionId: replay,
          idempotencyKey: opts.idempotencyKey,
          role: roleOf(rec.session.metadata, undefined),
          body: input,
          replayed: true,
        });
        return structuredClone(rec.session);
      }
      const agentRec = this.agentRecord(input.agentId);
      if (this.balance <= 0n) {
        throw new NaiveInsufficientCreditsError("balance cannot cover the call", {
          code: "insufficient_credits",
          status: 402,
        });
      }
      const metadata = input.metadata ?? {};
      const role = roleOf(metadata, agentRec.agent.metadata);
      const ctx: FakeScriptContext = {
        role,
        message: input.message,
        input: parseMaybeJson(input.message),
        agent: structuredClone(agentRec.agent),
        metadata,
        outputSchema: input.outputSchema,
      };
      const script = this.nextScript(role, ctx);
      if (script.createError) throw script.createError;

      const id = this.id("ses");
      const session: NaiveSession = {
        id,
        agentId: agentRec.agent.id,
        agentVersion: input.agentVersion ?? agentRec.agent.version,
        status: "running",
        stopReason: null,
        stopCode: null,
        budgetMicroUsd: input.budgetMicroUsd,
        consumedMicroUsd: 0n,
        lastSeq: 0,
        structuredOutput: null,
        pendingActions: [],
        metadata,
      };
      const rec = this.buildRecord(session, script, ctx);
      this.sessionRecords.set(id, rec);
      this.byIdempotencyKey.set(opts.idempotencyKey, id);
      this.sessionCreates.push({
        sessionId: id,
        idempotencyKey: opts.idempotencyKey,
        role,
        body: input,
        replayed: false,
      });
      if (!script.hang) this.release(id);
      return structuredClone(rec.session);
    },
    get: async (id) => {
      this.enter("sessions.get", [id]);
      return structuredClone(this.record(id).session);
    },
    cancel: async (id) => {
      this.enter("sessions.cancel", [id]);
      const rec = this.record(id);
      if (
        rec.session.status === "running" ||
        rec.session.status === "queued" ||
        rec.session.status === "idle"
      ) {
        rec.pending = [];
        // A cancelled run still spent what it spent: charge the script's cost (capped at the budget).
        this.charge(rec, rec.final.consumedMicroUsd);
        rec.session.status = "cancelled";
        rec.session.stopReason = "interrupted";
        this.append(rec, "session.idle", { stop_reason: "interrupted", status: "cancelled" });
      }
      return structuredClone(rec.session);
    },
    stream: (id, opts) => this.streamEvents(id, opts),
  };

  readonly credits: NaiveClient["credits"] = {
    show: async (): Promise<NaiveBalance> => {
      this.enter("credits.show", [], false);
      return { balanceMicroUsd: this.balance, mode: this.mode };
    },
    spend: async (query = {}): Promise<NaiveSpend> => {
      this.enter("credits.spend", [query], false);
      return { spentMicroUsd: this.spentMicroUsd(query) };
    },
    subscription: async (): Promise<NaiveSubscription> => {
      this.enter("credits.subscription", [], false);
      return {
        status: this.subscriptionStatus,
        plan: this.subscriptionStatus === "none" ? null : "standard",
        graceUntil: null,
      };
    },
  };

  // ── internals ──────────────────────────────────────────────────────────────

  private async *streamEvents(id: string, opts: StreamOptions = {}): AsyncGenerator<NaiveEvent> {
    this.enter("sessions.stream", [id, opts]);
    const rec = this.record(id);
    let cursor = opts.afterSeq ?? 0;
    // Like the SDK: a resume on a settled session ends once caught up.
    const endAt = cursor > 0 && rec.session.status !== "running" ? rec.session.lastSeq : null;
    if (endAt !== null && endAt <= cursor) return;
    for (;;) {
      const next = rec.events.find((e) => e.seq > cursor);
      if (!next) {
        if (rec.session.status !== "running") return;
        await new Promise<void>((resolve) => rec.waiters.push(resolve));
        continue;
      }
      cursor = next.seq;
      yield structuredClone(next);
      if (rec.dropAfterSeq !== undefined && next.seq >= rec.dropAfterSeq) {
        rec.dropAfterSeq = undefined;
        throw new NaiveError("stream dropped (FakeNaive)", {
          code: "provider_error",
          status: 503,
          sessionId: id,
        });
      }
      if (next.type === "session.idle") return;
      if (endAt !== null && next.seq >= endAt) return;
    }
  }

  private buildRecord(
    session: NaiveSession,
    script: FakeScript,
    ctx: FakeScriptContext,
  ): FakeSessionRecord {
    const rec: FakeSessionRecord = {
      session,
      events: [],
      pending: [],
      final: {
        status: "idle",
        stopReason: "end_turn",
        stopCode: null,
        structuredOutput: null,
        pendingActions: [],
        consumedMicroUsd: 0n,
      },
      dropAfterSeq: script.dropStreamAfterSeq,
      waiters: [],
      charged: false,
    };
    const cost = script.costMicroUsd ?? DEFAULT_COST;
    const overBudget = cost > session.budgetMicroUsd;
    const consumed = overBudget ? session.budgetMicroUsd : cost;
    const output =
      typeof script.output === "function"
        ? (script.output as (c: FakeScriptContext) => unknown)(ctx)
        : script.output;
    const text =
      typeof script.text === "function"
        ? script.text(ctx)
        : (script.text ?? (output === undefined ? "ok" : JSON.stringify(output)));

    this.append(rec, "session.running", {});
    this.append(rec, "message.completed", { role: "user", content: ctx.message });
    const rest: Array<{ type: string; data: Record<string, unknown> }> = [];
    for (const e of script.events ?? []) rest.push({ type: e.type, data: e.data ?? {} });
    if (overBudget) {
      rest.push({ type: "session.usage", data: { consumed_micro_usd: Number(consumed) } });
      rest.push({
        type: "budget.exceeded",
        data: {
          budget_micro_usd: Number(session.budgetMicroUsd),
          consumed_micro_usd: Number(consumed),
        },
      });
      rest.push({ type: "session.idle", data: { stop_reason: "budget_paused" } });
      rec.final = { ...rec.final, stopReason: "budget_paused", consumedMicroUsd: consumed };
    } else {
      const stopReason = script.stopReason ?? (script.status === "failed" ? "error" : "end_turn");
      rest.push({ type: "message.delta", data: { content: text } });
      rest.push({ type: "message.completed", data: { content: text } });
      if (script.pendingActions?.length) {
        for (const a of script.pendingActions) {
          rest.push({
            type: "tool.confirm",
            data: { tool_call_id: a.toolCallId, name: a.name, args: a.args },
          });
        }
      }
      rest.push({ type: "session.usage", data: { consumed_micro_usd: Number(consumed) } });
      rest.push({ type: "session.idle", data: { stop_reason: stopReason } });
      rec.final = {
        status: script.status ?? "idle",
        stopReason,
        stopCode: script.stopCode ?? null,
        structuredOutput:
          output !== undefined &&
          output !== null &&
          typeof output === "object" &&
          !Array.isArray(output)
            ? (structuredClone(output) as Record<string, unknown>)
            : null,
        pendingActions: script.pendingActions ?? [],
        consumedMicroUsd: consumed,
      };
    }
    rec.pending = rest;
    return rec;
  }

  private settle(rec: FakeSessionRecord): void {
    const f = rec.final;
    rec.session.status = f.status;
    rec.session.stopReason = f.stopReason;
    rec.session.stopCode = f.stopCode;
    rec.session.structuredOutput = f.structuredOutput;
    rec.session.pendingActions = f.pendingActions;
    this.charge(rec, f.consumedMicroUsd);
    this.wake(rec);
  }

  private charge(rec: FakeSessionRecord, amount: MicroUsd): void {
    if (rec.charged) return;
    rec.charged = true;
    rec.session.consumedMicroUsd = amount;
    this.balance -= amount;
  }

  private append(rec: FakeSessionRecord, type: string, data: Record<string, unknown>): void {
    const seq = rec.events.length + 1;
    rec.events.push({
      id: `evt_${rec.session.id}_${seq}`,
      seq,
      type,
      sessionId: rec.session.id,
      data,
      createdAt: this.now().toISOString(),
    });
    rec.session.lastSeq = seq;
    this.wake(rec);
  }

  private wake(rec: FakeSessionRecord): void {
    const waiters = rec.waiters.splice(0);
    for (const w of waiters) w();
  }

  private nextScript(role: string, ctx: FakeScriptContext): FakeScript {
    const queue = this.queues.get(role);
    const input = queue && queue.length > 0 ? queue.shift() : this.defaults.get(role);
    if (!input) {
      throw new Error(
        `FakeNaive: no script for role "${role}". Call fake.script("${role}", {...}) first.`,
      );
    }
    return typeof input === "function" ? input(ctx) : input;
  }

  /** Records a call, enforces the plan gate (402 on every non-billing route, as Naïve does), and throws queued failures. */
  private enter(method: string, args: unknown[], gated = true): void {
    this.calls.push({ method, args });
    if (gated && this.subscriptionStatus !== "active") {
      throw new NaiveSubscriptionRequiredError("the organization has no active plan", {
        code: "subscription_required",
        status: 402,
      });
    }
    this.throwQueued(method);
  }

  private throwQueued(method: string): void {
    const queued = this.failures.get(method);
    const error = queued?.shift();
    if (error) throw error;
  }

  private record(id: string): FakeSessionRecord {
    const rec = this.sessionRecords.get(id);
    if (!rec)
      throw new NaiveNotFoundError(`no session ${id}`, {
        code: "not_found",
        status: 404,
        sessionId: id,
      });
    return rec;
  }

  private agentRecord(id: string): FakeAgentRecord {
    const rec = this.agentRecords.get(id);
    if (!rec) throw new NaiveNotFoundError(`no agent ${id}`, { code: "not_found", status: 404 });
    return rec;
  }

  /** Ids in Naïve's own shape (`<prefix>_` + 26 lowercase Crockford base32), so they pass the SDK's checks. */
  private id(prefix: string): string {
    this.counter += 1;
    const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
    let n = this.counter;
    let suffix = "";
    do {
      suffix = alphabet.charAt(n % 32) + suffix;
      n = Math.floor(n / 32);
    } while (n > 0);
    return `${prefix}_fake${suffix.padStart(22, "0")}`;
  }
}

function roleOf(
  metadata: Record<string, unknown>,
  agentMetadata: Record<string, unknown> | undefined,
): string {
  const role = metadata[AGENT_ROLE_KEY] ?? agentMetadata?.[AGENT_ROLE_KEY];
  return typeof role === "string" ? role : "unknown";
}

function parseMaybeJson(message: string): unknown {
  try {
    return JSON.parse(message) as unknown;
  } catch {
    return message;
  }
}

/** Builds an error like the one Naïve would answer, for `failNext` / `createError`. */
export function fakeNaiveError(code: string, status: number, message = code): NaiveError {
  return naiveErrorFor(message, { code, status });
}
