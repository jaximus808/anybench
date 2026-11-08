// The live NaiveClient: a thin adapter over @usenaive-sdk/managed-agents that converts money to
// bigint, maps the SDK's ApiError onto our typed errors, and exposes only what Anybench uses.

import { createClient, type Session, type VettaClient } from "@usenaive-sdk/managed-agents";
import { z } from "zod";
import { liveComputers } from "./computers.js";
import { mapNaiveError, NaiveConflictError } from "./errors.js";
import { fromWireMicroUsd, toWireMicroUsd } from "./money.js";
import { naiveRetryFetch, type NaiveRetryFetchOptions } from "./retry-fetch.js";
import {
  AgentWriteSchema,
  SessionCreateInputSchema,
  type AgentWrite,
  type NaiveAgent,
  type NaiveClient,
  type NaiveEvent,
  type NaiveSession,
  type SessionCreateInput,
  type StreamOptions,
} from "./types.js";

type SdkAgent = Awaited<ReturnType<VettaClient["agents"]["get"]>>;
type SdkEvent = VettaClient["stream"] extends (...args: never[]) => AsyncGenerator<infer E>
  ? E
  : never;
type SdkAgentCreate = Parameters<VettaClient["agents"]["create"]>[0];

export const DEFAULT_NAIVE_BASE_URL = "https://api.vetta.sh";

export const NaiveClientOptionsSchema = z.object({
  apiKey: z.string().min(1, "NAIVE_API_KEY is required"),
  baseUrl: z.string().url().default(DEFAULT_NAIVE_BASE_URL),
});

export interface NaiveClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injected in tests to record or mock traffic. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests for deterministic keys on writes that do not carry their own. */
  idempotencyKey?: () => string;
  /**
   * Bounded retry of Naïve's transient refusals (429 on any call; 502/503/504 and dropped
   * connections on reads). On by default; `false` turns it off (tests asserting a raw error).
   */
  retry?: NaiveRetryFetchOptions | false;
}

/** The fetch a live SDK client gets: the injected one (or global), wrapped in `naiveRetryFetch`. */
export function naiveClientFetch(options: {
  fetch?: typeof globalThis.fetch;
  retry?: NaiveRetryFetchOptions | false;
}): typeof globalThis.fetch | undefined {
  if (options.retry === false) return options.fetch;
  const inner = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return naiveRetryFetch(inner, options.retry ?? {});
}

/** Builds the live client. Never call this in a test without `NAIVE_LIVE=1`; use a mocked `fetch` or `FakeNaive`. */
export function createNaiveClient(options: NaiveClientOptions): NaiveClient {
  const parsed = NaiveClientOptionsSchema.parse({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });
  const fetch = naiveClientFetch(options);
  const sdk = createClient({
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrl,
    ...(fetch ? { fetch } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  });
  return new LiveNaiveClient(sdk);
}

/** `createNaiveClient` from `NAIVE_API_KEY` / `NAIVE_BASE_URL`. */
export function createNaiveClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  extra: Omit<NaiveClientOptions, "apiKey" | "baseUrl"> = {},
): NaiveClient {
  const parsed = z
    .object({ NAIVE_API_KEY: z.string().min(1), NAIVE_BASE_URL: z.string().url().optional() })
    .parse({ NAIVE_API_KEY: env.NAIVE_API_KEY, NAIVE_BASE_URL: env.NAIVE_BASE_URL || undefined });
  return createNaiveClient({
    apiKey: parsed.NAIVE_API_KEY,
    ...(parsed.NAIVE_BASE_URL ? { baseUrl: parsed.NAIVE_BASE_URL } : {}),
    ...extra,
  });
}

async function call<T>(fn: () => Promise<T>, sessionId?: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapNaiveError(error, sessionId);
  }
}

export function agentFromSdk(agent: SdkAgent): NaiveAgent {
  return {
    id: agent.id,
    name: agent.name,
    version: agent.current_version,
    model: agent.model,
    harness: agent.harness,
    metadata: agent.metadata,
  };
}

export function sessionFromSdk(session: Session): NaiveSession {
  return {
    id: session.id,
    agentId: session.agent_id,
    agentVersion: session.agent_version,
    status: session.status,
    stopReason: session.stop_reason,
    stopCode: session.stop_code ?? null,
    budgetMicroUsd: fromWireMicroUsd(session.budget_micro_usd),
    consumedMicroUsd: fromWireMicroUsd(session.consumed_micro_usd),
    lastSeq: session.last_seq,
    structuredOutput: session.structured_output,
    pendingActions: session.pending_actions.map((a) => ({
      kind: a.kind,
      toolCallId: a.tool_call_id,
      name: a.name,
      args: a.args,
      ...(a.question ? { prompt: a.question.prompt } : {}),
    })),
    metadata: session.metadata,
  };
}

export function eventFromSdk(event: SdkEvent): NaiveEvent {
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    sessionId: event.session_id,
    data: event.data,
    createdAt: event.created_at,
  };
}

function agentToSdk(body: AgentWrite): SdkAgentCreate {
  const b = AgentWriteSchema.parse(body);
  const out: SdkAgentCreate = {
    name: b.name,
    model: b.model,
    system: b.system,
    budget: {
      cap_micro_usd: toWireMicroUsd(b.budget.capMicroUsd),
      max_task_micro_usd: toWireMicroUsd(b.budget.maxTaskMicroUsd),
      period: b.budget.period,
    },
    // Our agents never hand work to other agents on their own; a session is one bounded task.
    handoffs: false,
  };
  if (b.harness !== undefined) out.harness = b.harness;
  if (b.window !== undefined) out.window = b.window;
  if (b.description !== undefined) out.description = b.description;
  if (b.outputSchema !== undefined) out.output_schema = b.outputSchema;
  if (b.structuredOutputRequired !== undefined)
    out.structured_output_required = b.structuredOutputRequired;
  if (b.tools !== undefined) out.tools = b.tools as SdkAgentCreate["tools"] & object;
  if (b.metadata !== undefined) out.metadata = b.metadata;
  return out;
}

function sessionToSdk(body: SessionCreateInput): Parameters<VettaClient["sessions"]["create"]>[0] {
  const b = SessionCreateInputSchema.parse(body);
  return {
    agent_id: b.agentId,
    message: b.message,
    budget_micro_usd: toWireMicroUsd(b.budgetMicroUsd),
    ...(b.agentVersion !== undefined ? { agent_version: b.agentVersion } : {}),
    ...(b.outputSchema !== undefined ? { output_schema: b.outputSchema } : {}),
    ...(b.structuredOutputRequired !== undefined
      ? { structured_output_required: b.structuredOutputRequired }
      : {}),
    ...(b.window !== undefined ? { window: b.window } : {}),
    ...(b.metadata !== undefined ? { metadata: b.metadata } : {}),
  };
}

class LiveNaiveClient implements NaiveClient {
  readonly kind = "live" as const;
  readonly computers: NaiveClient["computers"];
  constructor(private readonly sdk: VettaClient) {
    this.computers = liveComputers(sdk);
  }

  readonly agents: NaiveClient["agents"] = {
    findByName: async (name) => {
      let after: string | undefined;
      do {
        const page = await call(() => this.sdk.agents.list({ limit: 100, after }));
        const hit = page.data.find((a) => a.name === name);
        if (hit) return agentFromSdk(hit);
        after = page.has_more ? (page.next_cursor ?? undefined) : undefined;
      } while (after);
      return null;
    },
    get: async (id) => agentFromSdk(await call(() => this.sdk.agents.get(id))),
    create: async (body) =>
      agentFromSdk(await call(() => this.sdk.agents.create(agentToSdk(body)))),
    update: async (id, body, opts) =>
      agentFromSdk(
        await call(() =>
          this.sdk.agents.update(id, {
            ...agentToSdk(body),
            ...(opts?.expectedVersion !== undefined
              ? { expected_version: opts.expectedVersion }
              : {}),
          }),
        ),
      ),
  };

  readonly sessions: NaiveClient["sessions"] = {
    create: async (body, opts) =>
      sessionFromSdk(
        await call(() =>
          this.sdk.sessions.create(sessionToSdk(body), { idempotencyKey: opts.idempotencyKey }),
        ),
      ),
    get: async (id) => sessionFromSdk(await call(() => this.sdk.sessions.get(id), id)),
    cancel: async (id) => {
      try {
        return sessionFromSdk(await this.sdk.sessions.cancel(id));
      } catch (error) {
        const mapped = mapNaiveError(error, id);
        // A completed or failed session cannot be cancelled (409 session_terminal). It is already over.
        if (mapped instanceof NaiveConflictError && mapped.code === "session_terminal") {
          return this.sessions.get(id);
        }
        throw mapped;
      }
    },
    stream: (id, opts) => this.streamEvents(id, opts),
  };

  readonly credits: NaiveClient["credits"] = {
    show: async () => {
      const b = await call(() => this.sdk.credits.show());
      return { balanceMicroUsd: fromWireMicroUsd(b.balance_micro_usd), mode: b.mode };
    },
    spend: async (query = {}) => {
      const s = await call(() =>
        this.sdk.credits.spend({
          ...(query.sessionId ? { session_id: query.sessionId } : {}),
          ...(query.agentId ? { agent_id: query.agentId } : {}),
        }),
      );
      return { spentMicroUsd: fromWireMicroUsd(s.spent_micro_usd) };
    },
    subscription: async () => {
      const s = await call(() => this.sdk.credits.subscription());
      return { status: s.status, plan: s.plan ?? null, graceUntil: s.grace_until };
    },
  };

  private async *streamEvents(id: string, opts: StreamOptions = {}): AsyncGenerator<NaiveEvent> {
    try {
      for await (const event of this.sdk.stream(id, { afterSeq: opts.afterSeq ?? 0 })) {
        yield eventFromSdk(event);
      }
    } catch (error) {
      throw mapNaiveError(error, id);
    }
  }
}
