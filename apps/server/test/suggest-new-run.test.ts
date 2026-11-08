// New run screen: POST /runs/suggest on FakeNaive (no DB, no network). The suggester reads the
// README and tree through an injected fetch, runs one bounded session, and any failure is a 503
// the screen falls back from.
import {
  ApiErrorBodySchema,
  apiRoutes,
  createApiClient,
  RunSuggestionSchema,
  type ApiClient,
} from "@anybench/core";
import { NaiveSessionFailedError } from "@anybench/naive";
import { FakeNaive } from "@anybench/naive";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Database } from "../src/db/client.js";
import type { AuthActor } from "../src/lib/auth-key.js";
import {
  createRunSuggester,
  slidingWindowLimiter,
  SUGGEST_BUDGET_MICRO_USD,
  SUGGEST_ROLE,
  type FetchLike,
  type RunSuggester,
} from "../src/lib/suggest.js";
import { configTdm14, recordingSentryTdm14, silentLoggerTdm14 } from "./helpers/server-tdm14.js";

const BASE = "http://api.test";
const ALICE = "0192f5d0-0000-7000-8000-0000000000a1";

const SUGGESTION = {
  project_summary: "Tandem is a shared task board that coordinates parallel coding agents.",
  questions: [
    "Is Tandem faster than Claude Code with subagents on multi-file refactors?",
    "Does Tandem finish more tasks than plain Claude Code for the same budget?",
  ],
  alternatives: [
    { name: "Claude Code with subagents", reason: "The built-in way to run agents in parallel." },
    { name: "plain Claude Code", reason: "The single-agent baseline." },
  ],
  options: { runs_per_setup: 3, approvals: "reviewer" },
};

const README = "# Tandem\n\nA shared task board for humans and coding agents.";

function githubFetch(calls: string[] = [], ok = true): FetchLike {
  return async (url) => {
    calls.push(url);
    if (!ok) return new Response("not found", { status: 404 });
    if (url.includes("/readme")) return new Response(README, { status: 200 });
    if (url.includes("/git/trees/"))
      return Response.json({
        tree: [
          { path: "package.json", type: "blob" },
          { path: "src/index.ts", type: "blob" },
          { path: "node_modules/x/index.js", type: "blob" },
          { path: "src", type: "tree" },
        ],
        truncated: false,
      });
    return new Response("?", { status: 404 });
  };
}

type Who = "session" | "apiKey" | null;

function appWith(opts: { suggester: RunSuggester | null; who?: Who; max?: number }) {
  const who = opts.who === undefined ? "session" : opts.who;
  const actor: AuthActor | null =
    who === null
      ? null
      : {
          kind: "user",
          userId: ALICE,
          via: who,
          ...(who === "apiKey"
            ? { apiKey: { id: "k1", scopes: ["runs:write", "runs:read"], runIds: null } }
            : {}),
        };
  const app = createApp({
    config: configTdm14("postgres://unused.invalid/db"),
    logger: silentLoggerTdm14(),
    // Never touched: the suggest route reads no table.
    db: {} as Database,
    sentry: recordingSentryTdm14(),
    authenticate: () => Promise.resolve(actor),
    suggester: opts.suggester,
    suggestLimiter: slidingWindowLimiter(opts.max ?? 10, 60_000),
  });
  const client: ApiClient = createApiClient(
    BASE,
    { kind: "apiKey", key: "unused" },
    { fetch: (url, init) => Promise.resolve(app.request(url, init)) },
  );
  return { app, client };
}

async function post(app: ReturnType<typeof createApp>, body: unknown) {
  const res = await app.request(`${BASE}/runs/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : undefined };
}

const body = { source: { kind: "github", github: "https://github.com/jaximus808/tandem" } };

describe("POST /runs/suggest (New run screen)", () => {
  it("returns a schema-valid suggestion from one bounded Naïve session", async () => {
    const naive = new FakeNaive();
    naive.script(SUGGEST_ROLE, { output: SUGGESTION, costMicroUsd: 12_000n });
    const fetched: string[] = [];
    const { client } = appWith({
      suggester: createRunSuggester({ client: naive, fetch: githubFetch(fetched) }),
    });
    const out = await client.runs.suggest({
      body: { source: { kind: "github", github: "jaximus808/tandem", ref: "main" } },
    });
    expect(RunSuggestionSchema.parse(out.suggestion)).toEqual(SUGGESTION);
    expect(out.cost_micro_usd).toBe(12_000n);

    // One session, capped at ~$0.05, told the output schema, fed the README and the tree.
    expect(naive.sessionCreates).toHaveLength(1);
    const create = naive.sessionCreates[0]!;
    expect(create.role).toBe(SUGGEST_ROLE);
    expect(create.body.budgetMicroUsd).toBe(SUGGEST_BUDGET_MICRO_USD);
    expect(create.body.outputSchema).toBeTruthy();
    expect(create.body.structuredOutputRequired).toBe(true);
    const task = JSON.parse(create.body.message) as { readme: string; tree: string[]; ref: string };
    expect(task.readme).toBe(README);
    expect(task.tree).toEqual(["package.json", "src/index.ts"]);
    expect(task.ref).toBe("main");
    expect(fetched.some((u) => u.includes("/repos/jaximus808/tandem/readme?ref=main"))).toBe(true);
  });

  it("is signed-in only: 401 without a session, 403 for an API key", async () => {
    const naive = new FakeNaive();
    const suggester = createRunSuggester({ client: naive, fetch: githubFetch() });
    const anon = await post(appWith({ suggester, who: null }).app, body);
    expect(anon.status).toBe(401);
    const key = await post(appWith({ suggester, who: "apiKey" }).app, body);
    expect(key.status).toBe(403);
    expect(naive.sessionCreates).toHaveLength(0);
  });

  it("answers 503 when the session's output does not match the schema", async () => {
    const naive = new FakeNaive();
    naive.script(SUGGEST_ROLE, { output: { project_summary: "x", questions: ["only one"] } });
    const { app } = appWith({
      suggester: createRunSuggester({ client: naive, fetch: githubFetch() }),
    });
    const r = await post(app, body);
    expect(r.status).toBe(503);
    expect(ApiErrorBodySchema.parse(r.json).error.code).toBe("unavailable");
  });

  it("answers 503 when the session fails to start", async () => {
    const naive = new FakeNaive();
    naive.script(SUGGEST_ROLE, {
      createError: new NaiveSessionFailedError("boom", {
        code: "session_failed",
        sessionStatus: "failed",
        stopReason: "error",
        stopCode: null,
        lastSeq: 0,
      }),
    });
    const { app } = appWith({
      suggester: createRunSuggester({ client: naive, fetch: githubFetch() }),
    });
    expect((await post(app, body)).status).toBe(503);
  });

  it("times out, cancels the session and answers 503", async () => {
    const naive = new FakeNaive();
    naive.script(SUGGEST_ROLE, { output: SUGGESTION, hang: true });
    const { app } = appWith({
      suggester: createRunSuggester({ client: naive, fetch: githubFetch(), timeoutMs: 100 }),
    });
    const r = await post(app, body);
    expect(r.status).toBe(503);
    expect(naive.calls.some((c) => c.method === "sessions.cancel")).toBe(true);
  });

  it("spends nothing when the repo cannot be read", async () => {
    const naive = new FakeNaive();
    const { app } = appWith({
      suggester: createRunSuggester({ client: naive, fetch: githubFetch([], false) }),
    });
    expect((await post(app, body)).status).toBe(503);
    expect(naive.sessionCreates).toHaveLength(0);
  });

  it("answers 503 when Naïve is not configured", async () => {
    const { app } = appWith({ suggester: null });
    expect((await post(app, body)).status).toBe(503);
  });

  it("refuses a non-GitHub source", async () => {
    const naive = new FakeNaive();
    const { app } = appWith({
      suggester: createRunSuggester({ client: naive, fetch: githubFetch() }),
    });
    const r = await post(app, { source: { kind: "github", github: "https://gitlab.com/a/b" } });
    expect(r.status).toBe(400);
    expect(naive.sessionCreates).toHaveLength(0);
  });

  it("rate-limits per user", async () => {
    const naive = new FakeNaive();
    naive.scriptDefault(SUGGEST_ROLE, { output: SUGGESTION });
    const { app } = appWith({
      suggester: createRunSuggester({ client: naive, fetch: githubFetch() }),
      max: 2,
    });
    expect((await post(app, body)).status).toBe(200);
    expect((await post(app, body)).status).toBe(200);
    const third = await post(app, body);
    expect(third.status).toBe(429);
    expect(ApiErrorBodySchema.parse(third.json).error.code).toBe("rate_limited");
    expect(naive.sessionCreates).toHaveLength(2);
  });

  it("is in the contract as a session-only POST", () => {
    expect(apiRoutes.runs.suggest.method).toBe("POST");
    expect(apiRoutes.runs.suggest.path).toBe("/runs/suggest");
    expect(apiRoutes.runs.suggest.auth).toEqual(["session"]);
  });
});
