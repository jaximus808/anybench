// The runner-side http-agent driver (TDM-40 [4.8]): post each conversation's turns to the
// agent's chat endpoint, record latency / cost / outcome per turn, and write the transcripts and
// metric rows to EVAL_OUT. The gate never runs here: it reads these files later, frozen, on the
// scoring computer.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { addMicro, type MicroUsd } from "@anybench/core";
import {
  encodeHttpAgentMetricsJsonl,
  collectHttpAgent,
  type HttpAgentMetricRow,
} from "./collect.js";
import type { Conversation } from "./conversation.js";
import {
  extractHttpAgentTurn,
  fillRequestTemplate,
  resolveHttpAgentHeaders,
  type ChatMessage,
  type HttpAgentConfig,
} from "./mapping.js";
import type { SimulatedUser } from "./simulated-user.js";
import {
  httpAgentJson,
  TURNS_JSONL,
  writeTranscript,
  type Transcript,
  type TranscriptEndedBy,
  type TranscriptTurn,
} from "./transcript.js";

/** Metric rows in bench MetricSchema JSONL form. Its own file, so it never clobbers another collector's. */
export const HTTP_AGENT_METRICS_JSONL = "http-agent.metrics.jsonl";

export class HttpAgentRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpAgentRunError";
  }
}

export interface RunConversationSetOptions {
  conversations: readonly Conversation[];
  config: HttpAgentConfig;
  /** The chat endpoint; overrides `config.endpoint`. */
  endpoint?: string;
  /** EVAL_OUT. transcripts/, http-agent.jsonl and http-agent.metrics.jsonl are written here. */
  outDir: string;
  /** Required when any conversation has `simulated_user`. */
  simulatedUser?: SimulatedUser;
  /** driver.max_turns: a cap on user turns per conversation, scripted and simulated. */
  maxTurns?: number;
  /** driver.model, for `{{model}}` in the request template. */
  model?: string;
  /** For `${NAME}` in config headers. Default process.env. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Millisecond clock for latency. Default performance.now. */
  now?: () => number;
  signal?: AbortSignal;
}

export interface RunConversationSetResult {
  transcripts: Transcript[];
  metrics: HttpAgentMetricRow[];
  /** True when every conversation completed with no failed turn. */
  ok: boolean;
}

/** `https://host:port/path` without query or credentials, for the transcript. */
function safeEndpoint(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

const round3 = (ms: number) => Math.round(ms * 1000) / 1000;

interface TurnContext {
  conversation: Conversation;
  endpoint: string;
  config: HttpAgentConfig;
  headers: Record<string, string>;
  history: ChatMessage[];
  sessionId: string | null;
  model: string | null;
  fetch: typeof fetch;
  now: () => number;
  signal?: AbortSignal;
}

async function postTurn(
  ctx: TurnContext,
  index: number,
  source: TranscriptTurn["source"],
  user: string,
): Promise<TranscriptTurn> {
  const messages: ChatMessage[] =
    ctx.config.request.history === "full"
      ? [...ctx.history, { role: "user", content: user }]
      : [{ role: "user", content: user }];
  const base = { index, source, user, tool_calls: [] as TranscriptTurn["tool_calls"] };
  let body: string;
  try {
    body = JSON.stringify(
      fillRequestTemplate(ctx.config.request.body, {
        messages,
        message: user,
        conversation_id: ctx.conversation.id,
        session_id: ctx.sessionId,
        turn: index,
        model: ctx.model,
        context: ctx.conversation.context ?? {},
      }),
    );
  } catch (e) {
    throw new HttpAgentRunError(`request template: ${(e as Error).message}`);
  }

  const timeout = AbortSignal.timeout(ctx.config.timeout_ms);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  const t0 = ctx.now();
  let res: Response;
  let text: string;
  try {
    res = await ctx.fetch(ctx.endpoint, {
      method: ctx.config.method,
      headers: { "content-type": "application/json", accept: "application/json", ...ctx.headers },
      body,
      signal,
    });
    text = await res.text();
  } catch (e) {
    const latency_ms = round3(Math.max(0, ctx.now() - t0));
    if (ctx.signal?.aborted) throw e;
    const err = e as Error;
    const what =
      err.name === "TimeoutError" || timeout.aborted
        ? `timed out after ${ctx.config.timeout_ms} ms`
        : `request failed: ${err.message}`;
    return { ...base, status: "error", reply: null, error: what, latency_ms };
  }
  const latency_ms = round3(Math.max(0, ctx.now() - t0));
  const http_status = res.status;
  if (!res.ok) {
    return {
      ...base,
      status: "error",
      reply: null,
      http_status,
      latency_ms,
      error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
    };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return {
      ...base,
      status: "error",
      reply: null,
      http_status,
      latency_ms,
      error: `response is not JSON: ${text.slice(0, 200)}`,
    };
  }
  try {
    const x = extractHttpAgentTurn(doc, res.headers, ctx.config);
    return {
      ...base,
      status: "ok",
      reply: x.reply,
      http_status,
      latency_ms,
      tool_calls: x.tool_calls,
      ...(x.session_id !== undefined ? { session_id: x.session_id } : {}),
      ...(x.outcome !== undefined ? { outcome: x.outcome } : {}),
      ...(x.cost_micro_usd !== undefined ? { cost_micro_usd: x.cost_micro_usd } : {}),
      ...(x.input_tokens !== undefined ? { input_tokens: x.input_tokens } : {}),
      ...(x.output_tokens !== undefined ? { output_tokens: x.output_tokens } : {}),
      ...(x.warnings.length > 0 ? { warnings: x.warnings } : {}),
    };
  } catch (e) {
    return {
      ...base,
      status: "error",
      reply: null,
      http_status,
      latency_ms,
      error: (e as Error).message,
    };
  }
}

async function runConversation(
  conversation: Conversation,
  opts: RunConversationSetOptions,
  endpoint: string,
  headers: Record<string, string>,
): Promise<Transcript> {
  const ctx: TurnContext = {
    conversation,
    endpoint,
    config: opts.config,
    headers,
    history: [],
    sessionId: null,
    model: opts.model ?? null,
    fetch: opts.fetch ?? fetch,
    now: opts.now ?? (() => performance.now()),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const plan = conversation.simulated_user;
  const cap = Math.min(
    plan?.max_turns ?? conversation.turns.length,
    opts.maxTurns ?? Number.MAX_SAFE_INTEGER,
  );
  const turns: TranscriptTurn[] = [];
  /** Every simulated-user session's cost, including the last one that only said `done`. */
  const simCosts: MicroUsd[] = [];
  const done = (ended_by: TranscriptEndedBy, error?: string): Transcript => ({
    conversation_id: conversation.id,
    endpoint: safeEndpoint(endpoint),
    status: ended_by === "error" ? "error" : "completed",
    ended_by,
    ...(error !== undefined ? { error } : {}),
    ...(simCosts.length > 0 ? { simulated_user_micro_usd: addMicro(...simCosts) } : {}),
    turns,
  });

  const take = async (
    source: TranscriptTurn["source"],
    user: string,
    simCost?: MicroUsd,
  ): Promise<TranscriptTurn> => {
    const t = await postTurn(ctx, turns.length, source, user);
    const turn = simCost !== undefined ? { ...t, simulated_user_micro_usd: simCost } : t;
    turns.push(turn);
    if (turn.status === "ok" && turn.reply !== null) {
      ctx.history.push({ role: "user", content: user }, { role: "assistant", content: turn.reply });
      if (turn.session_id !== undefined) ctx.sessionId = turn.session_id;
    }
    return turn;
  };

  for (const scripted of conversation.turns) {
    if (turns.length >= cap) return done("max_turns");
    const t = await take("script", scripted.user);
    if (t.status === "error") return done("error", `turn ${t.index}: ${t.error ?? "failed"}`);
  }
  if (plan === undefined) return done("script");

  const sim = opts.simulatedUser;
  if (sim === undefined) throw new HttpAgentRunError("simulated user missing"); // checked up front
  while (turns.length < cap) {
    let next;
    try {
      next = await sim.next({
        conversation_id: conversation.id,
        goal: plan.goal,
        ...(plan.persona !== undefined ? { persona: plan.persona } : {}),
        turn: turns.length,
        max_turns: cap,
        transcript: [...ctx.history],
      });
    } catch (e) {
      // Our infrastructure failed, not the agent: surface it rather than score a short transcript.
      throw new HttpAgentRunError(
        `simulated user failed on ${conversation.id} turn ${turns.length}: ${(e as Error).message}`,
      );
    }
    simCosts.push(next.costMicroUsd);
    if (next.done || next.message === null || next.message.trim() === "")
      return done("simulated_user");
    const t = await take("simulated", next.message, next.costMicroUsd);
    if (t.status === "error") return done("error", `turn ${t.index}: ${t.error ?? "failed"}`);
  }
  return done("max_turns");
}

/**
 * Run a conversation set against the agent and write everything the gate and the collectors
 * need. Agent failures (HTTP errors, timeouts, a missing reply) are recorded on the transcript
 * and end that conversation; configuration problems throw HttpAgentRunError before any request.
 */
export async function runConversationSet(
  opts: RunConversationSetOptions,
): Promise<RunConversationSetResult> {
  const endpoint = opts.endpoint ?? opts.config.endpoint;
  if (endpoint === undefined)
    throw new HttpAgentRunError(
      "no endpoint: set driver.endpoint, `endpoint` in http-agent.json, or --endpoint",
    );
  try {
    new URL(endpoint);
  } catch {
    throw new HttpAgentRunError(`endpoint is not a URL: ${endpoint}`);
  }
  if (opts.conversations.length === 0) throw new HttpAgentRunError("no conversations to run");
  const needSim = opts.conversations.filter((c) => c.simulated_user !== undefined);
  if (needSim.length > 0 && opts.simulatedUser === undefined) {
    throw new HttpAgentRunError(
      `conversation(s) ${needSim.map((c) => c.id).join(", ")} need a simulated user: set driver.simulated_user: true`,
    );
  }
  let headers: Record<string, string>;
  try {
    headers = resolveHttpAgentHeaders(opts.config.headers, opts.env ?? process.env);
  } catch (e) {
    throw new HttpAgentRunError((e as Error).message);
  }

  await mkdir(opts.outDir, { recursive: true });
  const transcripts: Transcript[] = [];
  const lines: string[] = [];
  for (const c of opts.conversations) {
    const t = await runConversation(c, opts, endpoint, headers);
    await writeTranscript(opts.outDir, t);
    transcripts.push(t);
    for (const turn of t.turns)
      lines.push(httpAgentJson({ conversation_id: t.conversation_id, ...turn }));
  }
  await writeFile(path.join(opts.outDir, TURNS_JSONL), lines.map((l) => l + "\n").join(""));
  const metrics = collectHttpAgent(transcripts);
  await writeFile(
    path.join(opts.outDir, HTTP_AGENT_METRICS_JSONL),
    encodeHttpAgentMetricsJsonl(metrics),
  );
  return { transcripts, metrics, ok: transcripts.every((t) => t.status === "completed") };
}
