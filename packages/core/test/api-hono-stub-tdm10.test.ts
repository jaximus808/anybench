// Hono stub (TDM-10): mounts every route descriptor on a Hono app through the transport-agnostic
// helpers, implements a few with typed handlers, and drives them with createApiClient. This proves
// the contract types compile on both sides and that bigint money survives the wire.
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ALL_ROUTES,
  ApiClientError,
  apiError,
  apiRoutes,
  createApiClient,
  encodeAnybenchEvent,
  encodeRouteResponse,
  formatSseFrame,
  newId,
  parseRouteRequest,
  RunIdSchema,
  SSE_PING,
  stringifyJson,
  successStatus,
  TrialIdSchema,
  type AnybenchEvent,
  type RouteHandler,
  type RouteHandlers,
  type RouteSpec,
  type RunId,
} from "../src/index.js";

const NOW_TDM10 = "2026-11-07T21:00:00Z";
const RUN_ID_TDM10 = newId(RunIdSchema);

class StubHttpErrorTdm10 extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`stub ${status}`);
  }
}

type AnyHandler = (req: never, ctx: never) => unknown;

function buildStubTdm10() {
  const handlers = new Map<string, AnyHandler>();
  const impl = <R extends RouteSpec>(route: R, handler: RouteHandler<NoInfer<R>>) =>
    handlers.set(route.id, handler as AnyHandler);

  // A whole group, typed with RouteHandlers: missing or mistyped handlers fail to compile.
  const alertHandlers: RouteHandlers<typeof apiRoutes.alerts> = {
    list: (req) => {
      expectTypeOf(req.query.limit).toEqualTypeOf<number>();
      return { items: [], next_cursor: null };
    },
    ack: () => {
      throw new StubHttpErrorTdm10(404, apiError("not_found", "no such alert"));
    },
    resolve: () => {
      throw new StubHttpErrorTdm10(404, apiError("not_found", "no such alert"));
    },
  };
  for (const [k, h] of Object.entries(alertHandlers)) {
    handlers.set(apiRoutes.alerts[k as keyof typeof alertHandlers].id, h as AnyHandler);
  }

  const run = (over: Partial<{ state: "intake" | "running"; budget: bigint }> = {}) => ({
    id: RUN_ID_TDM10,
    project_id: null,
    question: "Is Tandem faster than plain Claude Code?",
    state: over.state ?? "intake",
    budget_micro_usd: over.budget ?? 25_000_000n,
    spent_micro_usd: 1_250_000n,
    estimate_micro_usd: null,
    kit_id: null,
    paused_reason: null,
    cancel_requested_at: null,
    comped: false,
    created_at: NOW_TDM10,
    updated_at: NOW_TDM10,
  });

  impl(apiRoutes.runs.create, (req) => {
    expectTypeOf(req.body.budget_micro_usd).toEqualTypeOf<bigint>();
    expect(typeof req.body.budget_micro_usd).toBe("bigint");
    expect(req.headers["idempotency-key"]).toBe("create-tdm10-0001");
    return {
      run: { ...run(), question: req.body.question, budget_micro_usd: req.body.budget_micro_usd },
    };
  });
  impl(apiRoutes.runs.get, (req) => {
    expectTypeOf(req.params.id).toEqualTypeOf<RunId>();
    return {
      run: run({ state: "running" }),
      counters: {
        trials_total: 12,
        trials_done: 3,
        trials_running: 2,
        trials_failed: 0,
        spent_micro_usd: "1250000",
        projected_micro_usd: 4_000_000n,
        elapsed_s: 90,
        eta_s: null,
        last_seq: 7,
      },
      open_alerts: [],
      agents: [],
    };
  });
  impl(apiRoutes.runs.go, () => {
    throw new StubHttpErrorTdm10(402, {
      reason: "no_payment_method",
      link_card_url: "https://anybench.jaxonp.com/billing",
    });
  });
  impl(apiRoutes.reports.markdown, () => "# Report\n\nTandem x3 wins.");
  impl(apiRoutes.events.ingest, (req) => ({
    accepted: req.body.events.length,
    duplicate: false,
    cancel_requested: false,
    trial_state: "running" as const,
    lease_until: NOW_TDM10,
  }));
  // A broken handler: returns a float where money belongs. The contract catches it server-side.
  impl(apiRoutes.billing.summary, () => ({ broken: 1.5 }) as never);

  const app = new Hono();
  let streamConnects = 0;
  const seenLastEventIds: (string | undefined)[] = [];

  for (const route of ALL_ROUTES) {
    app.on(route.method, route.path, async (c) => {
      let body: unknown;
      if (route.body && route.method !== "GET") {
        body = route.rawBody ? await c.req.text() : await c.req.json().catch(() => undefined);
      }
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => (headers[k] = v));
      const parsed = parseRouteRequest(route, {
        params: c.req.param() as Record<string, string>,
        query: c.req.query(),
        headers,
        body,
      });
      if (!parsed.ok) return c.json(parsed.error, parsed.status);

      if (route.id === apiRoutes.events.stream.id) {
        streamConnects += 1;
        seenLastEventIds.push(headers["last-event-id"]);
        const ev = (seq: number) => event(RUN_ID_TDM10, seq);
        const text =
          streamConnects === 1
            ? formatSseFrame({
                retry: 5,
                data: stringifyJson(encodeAnybenchEvent(ev(1))),
                id: "1",
              }) +
              SSE_PING +
              formatSseFrame({ id: "2", data: stringifyJson(encodeAnybenchEvent(ev(2))) })
            : formatSseFrame({ id: "3", data: stringifyJson(encodeAnybenchEvent(ev(3))) }) +
              formatSseFrame({
                event: "end",
                data: JSON.stringify({ state: "delivered", last_seq: 3 }),
              });
        return new Response(text, { headers: { "content-type": "text/event-stream" } });
      }

      const handler = handlers.get(route.id);
      if (!handler) return c.json(apiError("not_implemented", route.id), 501);
      try {
        const result = await (handler as (req: unknown) => unknown)(parsed.request);
        const status = successStatus(route) as ContentfulStatusCode;
        if (route.kind === "text") return c.text(route.response.parse(result) as string, status);
        return c.json(encodeRouteResponse(route, result as never) as object, status);
      } catch (e) {
        if (e instanceof StubHttpErrorTdm10) {
          return c.json(e.body as object, e.status as ContentfulStatusCode);
        }
        return c.json(apiError("internal", "contract violation in handler"), 500);
      }
    });
  }
  return { app, seenLastEventIds };
}

function event(runId: string, seq: number): AnybenchEvent {
  return {
    run_id: runId,
    seq,
    source_id: runId,
    severity: "info",
    actor: { kind: "system" },
    cost_delta_micro_usd: 10_000n * BigInt(seq),
    at: NOW_TDM10,
    type: "run.state_changed",
    source: "run",
    payload: { from: "intake", to: "understand" },
  };
}

function clientTdm10(
  auth: Parameters<typeof createApiClient>[1] = { kind: "apiKey", key: "ab_test_x" },
) {
  const { app, seenLastEventIds } = buildStubTdm10();
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createApiClient("https://api.anybench.test/", auth, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return app.fetch(new Request(url, init));
    },
  });
  return { api, calls, seenLastEventIds };
}

describe("hono stub + client", () => {
  it("mounts every route", () => {
    const { app } = buildStubTdm10();
    expect(app.routes.length).toBe(ALL_ROUTES.length);
  });

  it("round-trips a create with bigint money, typed on both sides", async () => {
    const { api, calls } = clientTdm10();
    const { run } = await api.runs.create({
      headers: { "idempotency-key": "create-tdm10-0001" },
      body: {
        question: "Is Tandem faster?",
        source: { kind: "github", github: "jaximus808/tandem" },
        budget_micro_usd: 30_000_000n,
      },
    });
    expectTypeOf(run.budget_micro_usd).toEqualTypeOf<bigint>();
    expect(run.budget_micro_usd).toBe(30_000_000n);
    expect(run.state).toBe("intake");
    const sent = calls[0]!;
    expect(sent.url).toBe("https://api.anybench.test/runs");
    expect(String(sent.init.body)).toContain('"budget_micro_usd":"30000000"');
    expect((sent.init.headers as Record<string, string>).authorization).toBe("Bearer ab_test_x");
    expect(sent.init.credentials).toBe("omit");
  });

  it("parses decimal-string money in responses to bigint", async () => {
    const { api } = clientTdm10();
    const detail = await api.call(apiRoutes.runs.get, { params: { id: RUN_ID_TDM10 } });
    expect(detail.counters.spent_micro_usd).toBe(1_250_000n);
    expect(detail.counters.projected_micro_usd).toBe(4_000_000n);
  });

  it("uses credentials: include for the browser session", async () => {
    const { api, calls } = clientTdm10({ kind: "session" });
    await api.alerts.list();
    expect(calls[0]!.init.credentials).toBe("include");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(calls[0]!.url).toBe("https://api.anybench.test/alerts?limit=50");
  });

  it("surfaces the run gate's 402 {reason, link_card_url}", async () => {
    const { api } = clientTdm10();
    const err = await api.runs.go({ params: { id: RUN_ID_TDM10 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    const e = err as ApiClientError;
    expect(e.status).toBe(402);
    expect(e.code).toBe("payment_required");
    expect(e.paymentRequired).toEqual({
      reason: "no_payment_method",
      link_card_url: "https://anybench.jaxonp.com/billing",
    });
  });

  it("returns 400 validation_failed with issue paths from the server", async () => {
    const { api } = createApiClientNoValidateTdm10();
    const err = (await api.runs
      .get({ params: { id: "not-a-uuid" as RunId } })
      .catch((e: unknown) => e)) as ApiClientError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("validation_failed");
    expect(err.issues.some((i) => i.startsWith("params.id"))).toBe(true);
  });

  it("validates requests client-side before sending", async () => {
    const { api, calls } = clientTdm10();
    const err = (await api.runs
      .create({
        body: { question: "", source: { kind: "kit", kit_id: "x" }, budget_micro_usd: 0n },
      } as never)
      .catch((e: unknown) => e)) as ApiClientError;
    expect(err.status).toBe(0);
    expect(err.code).toBe("validation_failed");
    expect(calls).toHaveLength(0);
  });

  it("refuses a handler result that breaks the contract", async () => {
    const { api } = clientTdm10({ kind: "session" });
    const err = (await api.billing.summary().catch((e: unknown) => e)) as ApiClientError;
    expect(err.status).toBe(500);
  });

  it("returns text routes as strings and 501 for unimplemented routes", async () => {
    const { api } = clientTdm10();
    const md = await api.reports.markdown({ params: { id: RUN_ID_TDM10 } });
    expect(md).toContain("# Report");
    const err = (await api.kits.list().catch((e: unknown) => e)) as ApiClientError;
    expect([err.status, err.code]).toEqual([501, "not_implemented"]);
  });

  it("posts runner ingest batches with the runner token", async () => {
    const { api, calls } = clientTdm10({ kind: "runner", token: "trial-token-tdm10" });
    const res = await api.events.ingest({
      params: { id: newId(TrialIdSchema) },
      body: {
        batch_seq: 0,
        attempt: 1,
        sent_at: NOW_TDM10,
        heartbeat: { phase: "run", log_offset: 0 },
        events: [
          { kind: "phase", phase: "run", at: NOW_TDM10 },
          {
            kind: "usage",
            input_tokens: 10,
            output_tokens: 5,
            cost_micro_usd: 1234n,
            at: NOW_TDM10,
          },
        ],
      },
    });
    expect(res.accepted).toBe(2);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer trial-token-tdm10",
    );
  });

  it("streams SSE events, reconnects with Last-Event-ID, and stops on `end`", async () => {
    const { api, seenLastEventIds } = clientTdm10();
    const it = api.stream(apiRoutes.events.stream, { params: { id: RUN_ID_TDM10 } });
    const seqs: number[] = [];
    let next = await it.next();
    while (!next.done) {
      expectTypeOf(next.value).toEqualTypeOf<AnybenchEvent>();
      expect(next.value.cost_delta_micro_usd).toBe(10_000n * BigInt(next.value.seq));
      seqs.push(next.value.seq);
      next = await it.next();
    }
    expect(seqs).toEqual([1, 2, 3]);
    expect(next.value).toEqual({ state: "delivered", last_seq: 3 });
    expect(seenLastEventIds).toEqual([undefined, "2"]);
  });

  it("builds URLs for redirect routes and refuses to call them", async () => {
    const { api } = clientTdm10({ kind: "none" });
    expect(api.url(apiRoutes.auth.githubStart, { query: { redirect_to: "/runs" } })).toBe(
      "https://api.anybench.test/auth/github?redirect_to=%2Fruns",
    );
    expect(api.url(apiRoutes.publish.badge, { params: { file: "tandem.svg" } })).toBe(
      "https://api.anybench.test/badge/tandem.svg?variant=score",
    );
    await expect(api.auth.githubStart()).rejects.toThrow(/use client.url/);
  });
});

function createApiClientNoValidateTdm10() {
  const { app } = buildStubTdm10();
  const api = createApiClient(
    "https://api.anybench.test",
    { kind: "session" },
    {
      fetch: async (url, init) => app.fetch(new Request(url, init)),
      validateRequests: false,
    },
  );
  return { api };
}
