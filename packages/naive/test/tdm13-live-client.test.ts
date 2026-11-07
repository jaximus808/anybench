// The live client end to end through the real SDK, against a mocked `fetch`. No network.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createNaiveClient,
  createNaiveClientFromEnv,
  ensureAgent,
  NaiveBudgetExceededError,
  NaiveConflictError,
  NaiveError,
  NaiveInsufficientCreditsError,
  NaiveSubscriptionRequiredError,
  runSession,
} from "../src/index.js";

const NOW = "2026-11-07T00:00:00Z";

function tdm13AgentJson(overrides: Record<string, unknown> = {}) {
  return {
    model: "anthropic/claude-sonnet",
    window: "immediate",
    system: "You are a test agent.",
    tools: { default_config: { permission: "allow" }, configs: {} },
    mcp_servers: [],
    skills: [],
    multiagent: null,
    budget: { cap_micro_usd: 50_000_000, max_task_micro_usd: 5_000_000, period: "month" },
    output_schema: null,
    structured_output_required: false,
    description: null,
    metadata: {},
    id: "agt_01hxxxxxxxxxxxxxxxxxxxxxxx",
    object: "agent",
    name: "anybench-understander",
    harness: "pi",
    current_version: 1,
    created_at: NOW,
    ...overrides,
  };
}

function tdm13SessionJson(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses_01hxxxxxxxxxxxxxxxxxxxxxxx",
    object: "session",
    agent_id: "agt_01hxxxxxxxxxxxxxxxxxxxxxxx",
    agent_version: 1,
    deployment_id: null,
    identity_id: null,
    computer_id: null,
    parent_session_id: null,
    root_session_id: null,
    thread_role: null,
    model: null,
    mode: "build",
    status: "running",
    stop_reason: null,
    window: "immediate",
    budget_micro_usd: 2_000_000,
    consumed_micro_usd: 0,
    token_usage: { input: 0, cache_write: 0, cache_read: 0, output: 0, reasoning: 0 },
    pending_actions: [],
    output_schema: null,
    structured_output: null,
    last_seq: 0,
    metadata: {},
    started_at: null,
    ended_at: null,
    created_at: NOW,
    ...overrides,
  };
}

function tdm13Event(seq: number, type: string, data: Record<string, unknown> = {}) {
  return {
    id: `evt_${String(seq).padStart(26, "0")}`,
    seq,
    type,
    session_id: "ses_01hxxxxxxxxxxxxxxxxxxxxxxx",
    data,
    created_at: NOW,
  };
}

function sse(events: unknown[]): Response {
  const body = events
    .map((e) => `id: ${(e as { seq: number }).seq}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envelope(status: number, code: string, type = "invalid_request"): Response {
  return json({ error: { type, code, message: `${code} (mock)`, request_id: "req_mock" } }, status);
}

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

type Route = (req: Recorded) => Response | Promise<Response>;

function tdm13MockFetch(routes: Record<string, Route>) {
  const requests: Recorded[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const rec: Recorded = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(rec);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return envelope(404, "not_found", "not_found");
    return route(rec);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("createNaiveClient (mocked fetch)", () => {
  it("validates options and env", () => {
    expect(() => createNaiveClient({ apiKey: "" })).toThrow();
    expect(() => createNaiveClientFromEnv({})).toThrow();
    const client = createNaiveClientFromEnv({
      NAIVE_API_KEY: "k",
      NAIVE_BASE_URL: "https://example.test",
    });
    expect(client.kind).toBe("live");
  });

  it("runs a session: create with budget + idempotency key, stream, structured output", async () => {
    const OutputSchema = z.object({ kind: z.string(), summary: z.string() });
    const events = [
      tdm13Event(1, "session.running"),
      tdm13Event(2, "message.completed", { role: "user", content: "{}" }),
      tdm13Event(3, "message.completed", { content: "done" }),
      tdm13Event(4, "session.idle", { stop_reason: "end_turn" }),
    ];
    const { fetch, requests } = tdm13MockFetch({
      "POST /v1/sessions": () => json(tdm13SessionJson()),
      "GET /v1/sessions/ses_01hxxxxxxxxxxxxxxxxxxxxxxx/stream": () => sse(events),
      "GET /v1/sessions/ses_01hxxxxxxxxxxxxxxxxxxxxxxx": () =>
        json(
          tdm13SessionJson({
            status: "idle",
            stop_reason: "end_turn",
            consumed_micro_usd: 12_345,
            last_seq: 4,
            structured_output: { kind: "cli", summary: "a tool" },
          }),
        ),
    });
    const client = createNaiveClient({ apiKey: "test-key", baseUrl: "https://naive.test", fetch });
    const seen: number[] = [];
    const result = await runSession(client, {
      agentId: "agt_01hxxxxxxxxxxxxxxxxxxxxxxx",
      role: "understander",
      input: { digest: "x" },
      output: { schema: OutputSchema },
      budgetMicroUsd: 2_000_000n,
      idempotencyKey: "agent_session_42",
      onEvent: (e) => void seen.push(e.seq),
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output).toEqual({ kind: "cli", summary: "a tool" });
    expect(result.costMicroUsd).toBe(12_345n);
    expect(result.text).toBe("done");
    expect(seen).toEqual([1, 2, 3, 4]);

    const create = requests.find((r) => r.method === "POST" && r.path === "/v1/sessions");
    expect(create?.headers.get("idempotency-key")).toBe("agent_session_42");
    expect(create?.headers.get("authorization")).toBe("Bearer test-key");
    const body = create?.body as Record<string, unknown>;
    expect(body.budget_micro_usd).toBe(2_000_000);
    expect(body.structured_output_required).toBe(true);
    expect(body.output_schema).toMatchObject({ type: "object" });
    expect(body.metadata).toMatchObject({
      anybench_role: "understander",
      anybench_session_key: "agent_session_42",
    });
  });

  it("resumes with afterSeq: streams from after_seq and never re-delivers", async () => {
    const all = [
      tdm13Event(1, "session.running"),
      tdm13Event(2, "message.completed", { content: "hi" }),
      tdm13Event(3, "session.idle", { stop_reason: "end_turn" }),
    ];
    let gets = 0;
    const { fetch, requests } = tdm13MockFetch({
      // runSession's resume read sees it running; the final read sees it idle.
      "GET /v1/sessions/ses_01hxxxxxxxxxxxxxxxxxxxxxxx": () => {
        gets += 1;
        return gets <= 1
          ? json(tdm13SessionJson({ status: "running", last_seq: 1 }))
          : json(tdm13SessionJson({ status: "idle", stop_reason: "end_turn", last_seq: 3 }));
      },
      "GET /v1/sessions/ses_01hxxxxxxxxxxxxxxxxxxxxxxx/stream": (req) => {
        const after = Number(req.query.get("after_seq") ?? 0);
        // Overlap on purpose: the server replays seq `after`, which must be dropped.
        return sse(all.filter((e) => e.seq >= Math.max(1, after)));
      },
    });
    const client = createNaiveClient({ apiKey: "k", baseUrl: "https://naive.test", fetch });
    const seen: number[] = [];
    const result = await runSession(client, {
      agentId: "agt_01hxxxxxxxxxxxxxxxxxxxxxxx",
      role: "understander",
      input: "hello",
      budgetMicroUsd: 1_000_000n,
      idempotencyKey: "k1",
      resume: { sessionId: "ses_01hxxxxxxxxxxxxxxxxxxxxxxx", afterSeq: 1 },
      onEvent: (e) => void seen.push(e.seq),
    });
    expect(seen).toEqual([2, 3]);
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.output).toBe("hi");
    // A resume replays the log from 0 (to recover the final message) but only delivers seq > afterSeq.
    const streamCall = requests.find((r) => r.path.endsWith("/stream"));
    expect(streamCall?.query.get("after_seq")).toBe("0");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("maps 402 subscription_required and insufficient_credits to typed errors", async () => {
    const { fetch } = tdm13MockFetch({
      "POST /v1/sessions": () => envelope(402, "subscription_required", "payment_required"),
      "GET /v1/credits/balance": () => envelope(402, "insufficient_credits", "payment_required"),
    });
    const client = createNaiveClient({ apiKey: "k", baseUrl: "https://naive.test", fetch });
    const run = runSession(client, {
      agentId: "agt_01hxxxxxxxxxxxxxxxxxxxxxxx",
      role: "x",
      input: "x",
      budgetMicroUsd: 1n,
      idempotencyKey: "k",
    });
    await expect(run).rejects.toBeInstanceOf(NaiveSubscriptionRequiredError);
    await expect(run).rejects.toMatchObject({
      status: 402,
      code: "subscription_required",
      requestId: "req_mock",
    });
    await expect(client.credits.show()).rejects.toBeInstanceOf(NaiveInsufficientCreditsError);
  });

  it("turns budget.exceeded into NaiveBudgetExceededError", async () => {
    const { fetch } = tdm13MockFetch({
      "POST /v1/sessions": () => json(tdm13SessionJson({ budget_micro_usd: 500 })),
      "GET /v1/sessions/ses_01hxxxxxxxxxxxxxxxxxxxxxxx/stream": () =>
        sse([
          tdm13Event(1, "session.running"),
          tdm13Event(2, "budget.exceeded", { budget_micro_usd: 500, consumed_micro_usd: 500 }),
          tdm13Event(3, "session.idle", { stop_reason: "budget_paused" }),
        ]),
      "GET /v1/sessions/ses_01hxxxxxxxxxxxxxxxxxxxxxxx": () =>
        json(
          tdm13SessionJson({
            status: "idle",
            stop_reason: "budget_paused",
            budget_micro_usd: 500,
            consumed_micro_usd: 500,
            last_seq: 3,
          }),
        ),
    });
    const client = createNaiveClient({ apiKey: "k", baseUrl: "https://naive.test", fetch });
    const error = await runSession(client, {
      agentId: "agt_01hxxxxxxxxxxxxxxxxxxxxxxx",
      role: "x",
      input: "x",
      budgetMicroUsd: 500n,
      idempotencyKey: "k",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NaiveBudgetExceededError);
    expect((error as NaiveBudgetExceededError).consumedMicroUsd).toBe(500n);
    expect((error as NaiveBudgetExceededError).lastSeq).toBe(3);
  });

  it("cancel tolerates a session that already ended (409 session_terminal)", async () => {
    const { fetch } = tdm13MockFetch({
      "POST /v1/sessions/ses_01hxxxxxxxxxxxxxxxxxxxxxxx/cancel": () =>
        envelope(409, "session_terminal", "conflict"),
      "GET /v1/sessions/ses_01hxxxxxxxxxxxxxxxxxxxxxxx": () =>
        json(tdm13SessionJson({ status: "completed", stop_reason: "end_turn" })),
      "POST /v1/sessions/ses_01hyyyyyyyyyyyyyyyyyyyyyyy/cancel": () =>
        envelope(409, "session_running", "conflict"),
    });
    const client = createNaiveClient({ apiKey: "k", baseUrl: "https://naive.test", fetch });
    await expect(client.sessions.cancel("ses_01hxxxxxxxxxxxxxxxxxxxxxxx")).resolves.toMatchObject({
      status: "completed",
    });
    await expect(client.sessions.cancel("ses_01hyyyyyyyyyyyyyyyyyyyyyyy")).rejects.toBeInstanceOf(
      NaiveConflictError,
    );
  });

  it("ensureAgent creates through POST /v1/agents with integer micro-USD and handoffs off", async () => {
    let created: Record<string, unknown> | undefined;
    const { fetch } = tdm13MockFetch({
      "GET /v1/agents": () => json({ data: [], has_more: false, next_cursor: null }),
      "POST /v1/agents": (req) => {
        created = req.body as Record<string, unknown>;
        return json(tdm13AgentJson({ metadata: created.metadata }));
      },
    });
    const client = createNaiveClient({ apiKey: "k", baseUrl: "https://naive.test", fetch });
    const ensured = await ensureAgent(client, {
      role: "understander",
      model: "anthropic/claude-sonnet",
      system: "prompt",
      budget: { capMicroUsd: 50_000_000n, maxTaskMicroUsd: 5_000_000n },
      outputSchema: { type: "object" },
    });
    expect(ensured.action).toBe("created");
    expect(created).toMatchObject({
      name: "anybench-understander",
      handoffs: false,
      budget: { cap_micro_usd: 50_000_000, max_task_micro_usd: 5_000_000, period: "month" },
      output_schema: { type: "object" },
      structured_output_required: true,
    });
  });

  it("an unreadable 2xx body is response_unreadable and not retryable", async () => {
    const { fetch } = tdm13MockFetch({
      "GET /v1/credits/balance": () => json({ nope: true }),
      "GET /v1/credits/subscription": () =>
        new Response("<html>bad gateway</html>", { status: 502 }),
    });
    const client = createNaiveClient({ apiKey: "k", baseUrl: "https://naive.test", fetch });
    const e1 = await client.credits.show().catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(NaiveError);
    expect((e1 as NaiveError).code).toBe("response_unreadable");
    expect((e1 as NaiveError).retryable).toBe(false);
    const e2 = await client.credits.subscription().catch((e: unknown) => e);
    expect((e2 as NaiveError).code).toBe("provider_error");
    expect((e2 as NaiveError).retryable).toBe(true);
  });
});
