// TDM-40 [4.8]: driver.type http-agent: conversation sets, runner-side driver, collectors,
// labeled-answers gate, simulated user (FakeNaive) and the example kit against a stub agent.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GateResultSchema } from "@anybench/core";
import { ensureAgent } from "@anybench/naive";
import { FakeNaive } from "@anybench/naive/fake";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectHttpAgent,
  ConversationSetError,
  ConversationSchema,
  extractHttpAgentTurn,
  fillRequestTemplate,
  HTTP_AGENT_METRICS_JSONL,
  HttpAgentMetricRowSchema,
  httpAgentCliMain,
  HttpAgentRunError,
  loadConversationSet,
  loadHttpAgentConfig,
  matchAnswer,
  naiveSimulatedUser,
  nearestRankPercentile,
  parseHttpAgentConfig,
  resolveHttpAgentHeaders,
  runConversationSet,
  runHttpAgentGate,
  scoreConversation,
  SIMULATED_USER_ROLE,
  simulatedUserAgentSpec,
  validateKitDir,
  type ConversationInput,
  type HttpAgentMetricRow,
  type Transcript,
} from "../src/index.js";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const KIT_PKG = path.join(here, "..");
const EXAMPLE = path.join(KIT_PKG, "examples", "http-agent");
const ADAPTER = path.join(EXAMPLE, "adapters", "support-bot");
const STUB_SERVER = path.join(ADAPTER, "server.ts");
const WORKLOAD = path.join(EXAMPLE, "workloads", "support-basics");
const CONVERSATIONS = path.join(WORKLOAD, "conversations");
const BIN = path.join(KIT_PKG, "src", "drivers", "http-agent", "bin.ts");

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "anybench-http-agent-tdm40-"));
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      const exited = new Promise((r) => c.once("exit", r));
      c.kill("SIGTERM");
      await exited;
    }
  }
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Start the example's stub agent on a random free port (PORT=0); resolves with its base URL. */
async function startStub(env: Record<string, string> = {}): Promise<string> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", STUB_SERVER],
    {
      env: { PATH: process.env.PATH ?? "", PORT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString();
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m?.[1]) resolve(m[1]);
    });
    child.stderr?.on("data", (b: Buffer) => (err += b.toString()));
    child.once("exit", (code) => reject(new Error(`stub agent exited ${code}: ${err}`)));
  });
}

/** Run the gate in its own process, the way check.sh does on the scoring computer. */
async function gateInChildProcess(
  conversationsDir: string,
  outDir: string,
): Promise<{ gate: unknown; stdout: string; pid: number | undefined }> {
  const verdict = path.join(outDir, "..", "gate.json");
  const p = execFileP(
    process.execPath,
    [
      "--import",
      "tsx",
      BIN,
      "gate",
      "--conversations",
      conversationsDir,
      "--out",
      outDir,
      "--verdict",
      verdict,
    ],
    { cwd: KIT_PKG, timeout: 25_000 },
  );
  const pid = p.child.pid;
  const { stdout } = await p;
  return { gate: JSON.parse(await readFile(verdict, "utf8")), stdout, pid };
}

/** A fetch that answers from a function and a clock that advances by each answer's `ms`. */
function fakeAgent(
  answer: (
    body: Record<string, unknown>,
    n: number,
  ) => { status?: number; ms: number; json: unknown; headers?: Record<string, string> },
) {
  let clock = 0;
  const requests: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    const a = answer(body, requests.length - 1);
    clock += a.ms;
    return new Response(typeof a.json === "string" ? a.json : JSON.stringify(a.json), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json", ...(a.headers ?? {}) },
    });
  };
  return { fetch: fetchFn, now: () => clock, requests };
}

async function writeConversations(dir: string, convs: ConversationInput[]): Promise<string> {
  const cdir = path.join(dir, "conversations");
  await mkdir(cdir, { recursive: true });
  for (const c of convs) await writeFile(path.join(cdir, `${c.id}.json`), JSON.stringify(c));
  return cdir;
}

const rowsNamed = (rows: HttpAgentMetricRow[], name: string) =>
  rows.filter((r) => r.name === name && r.labels === undefined);

// ---------------------------------------------------------------------------------------------

describe("conversation set format", () => {
  it("loads the example set sorted by file name", async () => {
    const set = await loadConversationSet(WORKLOAD); // the workload dir resolves to conversations/
    expect(set.map((c) => c.id)).toEqual([
      "bulk-quote",
      "order-followup",
      "order-status",
      "refund-eligible",
      "refund-too-late",
    ]);
    expect(set.find((c) => c.id === "refund-too-late")?.tools?.[0]).toEqual({
      name: "issue_refund",
      forbidden: true,
      min_calls: 1,
    });
  });

  it("reports every bad file with its path", async () => {
    const d = await tmp();
    await writeFile(path.join(d, "a.json"), JSON.stringify({ id: "b", turns: [{ user: "hi" }] }));
    await writeFile(path.join(d, "c.json"), "{nope");
    await writeFile(
      path.join(d, "d.json"),
      JSON.stringify({ id: "d", turns: [{ user: "hi", expect: { case_sensitive: true } }] }),
    );
    await writeFile(path.join(d, "e.json"), JSON.stringify({ id: "e", turns: [] }));
    const err = await loadConversationSet(d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConversationSetError);
    const problems = (err as ConversationSetError).problems.join("\n");
    expect(problems).toContain("a.json: id 'b' must match the file name");
    expect(problems).toContain("c.json: invalid JSON");
    expect(problems).toContain("d.json: turns[0].expect: a matcher needs at least one of");
    expect(problems).toContain("e.json: turns: a conversation needs at least one turn");
  });

  it("rejects a simulated-user cap below the scripted turns", () => {
    const r = ConversationSchema.safeParse({
      id: "x",
      turns: [{ user: "a" }, { user: "b" }],
      simulated_user: { goal: "g", max_turns: 1 },
    });
    expect(r.success).toBe(false);
  });

  it("matches answers: contains, not_contains, any_of, regex, number, equals", () => {
    const reply = "Order 1077 is eligible for a refund of $1,234.50. Ref RF-1077.";
    expect(
      matchAnswer(reply, { contains: ["ELIGIBLE", "rf-1077"], case_sensitive: false }),
    ).toEqual([]);
    expect(matchAnswer(reply, { not_contains: ["eligible"], case_sensitive: false })).toEqual([
      'contains "eligible", which it must not',
    ]);
    expect(matchAnswer(reply, { any_of: ["denied", "refund"], case_sensitive: false })).toEqual([]);
    expect(matchAnswer(reply, { regex: "RF-\\d{4}", case_sensitive: true })).toEqual([]);
    expect(
      matchAnswer(reply, { number: { value: 1234.5, tolerance: 0 }, case_sensitive: false }),
    ).toEqual([]);
    expect(matchAnswer(reply, { equals: "nope", case_sensitive: false })).toEqual([
      'does not equal "nope"',
    ]);
  });
});

describe("request/response mapping", () => {
  const values = {
    messages: [{ role: "user" as const, content: "hi" }],
    message: "hi",
    conversation_id: "c1",
    session_id: null,
    turn: 2,
    model: "m",
    context: { tenant: "acme" },
  };

  it("fills typed placeholders and inline text", () => {
    expect(
      fillRequestTemplate(
        {
          m: "{{messages}}",
          t: "{{turn}}",
          s: "{{session_id}}",
          x: "user {{message}} @ {{context.tenant}}",
          n: [1, "{{model}}"],
        },
        values,
      ),
    ).toEqual({ m: values.messages, t: 2, s: null, x: "user hi @ acme", n: [1, "m"] });
    expect(() => fillRequestTemplate("{{nope}}", values)).toThrow(/unknown template placeholder/);
  });

  it("reads an OpenAI-style response with string tool args and the cost header", () => {
    const cfg = parseHttpAgentConfig({
      response: {
        reply: "choices.0.message.content",
        tool_calls: "choices.0.message.tool_calls",
        tool_name: "function.name",
        tool_args: "function.arguments",
        input_tokens: "usage.prompt_tokens",
      },
    });
    const body = {
      choices: [
        {
          message: {
            content: "done",
            tool_calls: [{ function: { name: "lookup", arguments: '{"id":"7"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 12 },
    };
    const x = extractHttpAgentTurn(body, new Headers({ "X-Cost-Micro-USD": "4321" }), cfg);
    expect(x).toMatchObject({
      reply: "done",
      tool_calls: [{ name: "lookup", args: { id: "7" } }],
      input_tokens: 12,
    });
    expect(x.cost_micro_usd).toBe(4321n);
  });

  it("refuses a float cost instead of rounding it", () => {
    const cfg = parseHttpAgentConfig({ response: { cost_micro_usd: "cost" } });
    const x = extractHttpAgentTurn({ reply: "r", cost: 0.0012 }, new Headers(), cfg);
    expect(x.cost_micro_usd).toBeUndefined();
    expect(x.warnings).toEqual(["cost must be integer micro-USD, got 0.0012"]);
    expect(() => extractHttpAgentTurn({ nope: 1 }, new Headers(), cfg)).toThrow(
      /no string reply at 'reply'/,
    );
  });

  it("fills header secrets from env and names a missing variable, never a value", () => {
    expect(
      resolveHttpAgentHeaders({ authorization: "Bearer ${AGENT_KEY}" }, { AGENT_KEY: "k1" }),
    ).toEqual({
      authorization: "Bearer k1",
    });
    expect(() => resolveHttpAgentHeaders({ authorization: "Bearer ${AGENT_KEY}" }, {})).toThrow(
      "header authorization needs ${AGENT_KEY}, which is not set",
    );
  });

  it("loads the example adapter config", async () => {
    const cfg = await loadHttpAgentConfig(path.join(ADAPTER, "http-agent.json"));
    expect(cfg.response.cost_micro_usd).toBe("usage.cost_micro_usd");
    expect(cfg.request.history).toBe("full");
  });
});

describe("runner-side driver and collectors", () => {
  it("nearest-rank percentiles", () => {
    expect(nearestRankPercentile([30, 10, 20, 100], 50)).toBe(20);
    expect(nearestRankPercentile([30, 10, 20, 100], 95)).toBe(100);
    expect(nearestRankPercentile([5], 95)).toBe(5);
    expect(() => nearestRankPercentile([], 50)).toThrow(RangeError);
  });

  it("records per-turn latency p50/p95, bigint cost and outcome", async () => {
    const out = await tmp();
    const lat = [10, 20, 30, 100];
    const agent = fakeAgent((_b, n) => ({
      ms: lat[n] ?? 1,
      json: {
        reply: `r${n}`,
        outcome: n === 3 ? "resolved" : undefined,
        cost: n === 2 ? undefined : 1000 + n,
      },
    }));
    const conversations = [
      ConversationSchema.parse({ id: "a", turns: [{ user: "1" }, { user: "2" }] }),
      ConversationSchema.parse({ id: "b", turns: [{ user: "3" }, { user: "4" }] }),
    ];
    const r = await runConversationSet({
      conversations,
      config: parseHttpAgentConfig({ response: { cost_micro_usd: "cost", outcome: "outcome" } }),
      endpoint: "http://agent.test/chat?key=secret",
      outDir: out,
      fetch: agent.fetch,
      now: agent.now,
    });
    expect(r.ok).toBe(true);
    // Full history by default: the second turn of each conversation carries the first exchange.
    expect(agent.requests[1]).toEqual({
      conversation_id: "a",
      messages: [
        { role: "user", content: "1" },
        { role: "assistant", content: "r0" },
        { role: "user", content: "2" },
      ],
    });
    const m = r.metrics;
    for (const row of m) expect(HttpAgentMetricRowSchema.safeParse(row).success).toBe(true);
    expect(rowsNamed(m, "latency_p50_ms")[0]?.value).toBe(20);
    expect(rowsNamed(m, "latency_p95_ms")[0]?.value).toBe(100);
    expect(m.filter((x) => x.name === "turn_latency_ms").map((x) => x.value)).toEqual(lat);
    const cost = rowsNamed(m, "cost_micro_usd")[0];
    expect(cost).toMatchObject({
      value: 1000n + 1001n + 1003n,
      unit: "micro_usd",
      collector: "proxy-calls",
    });
    expect(typeof cost?.value).toBe("bigint");
    expect(rowsNamed(m, "cost_unreported_turns")[0]?.value).toBe(1);
    expect(
      m.find((x) => x.name === "conversation_outcome" && x.labels?.outcome === "resolved")?.value,
    ).toBe(1);
    // The transcript keeps the endpoint without its query string.
    const t = JSON.parse(
      await readFile(path.join(out, "transcripts", "a.json"), "utf8"),
    ) as Transcript;
    expect(t.endpoint).toBe("http://agent.test/chat");
    // metrics are written as JSONL with micro-USD as a decimal string.
    const jsonl = await readFile(path.join(out, HTTP_AGENT_METRICS_JSONL), "utf8");
    expect(jsonl).toContain('"name":"cost_micro_usd","value":"3004","unit":"micro_usd"');
  });

  it("an HTTP error ends the conversation and is recorded, not thrown", async () => {
    const out = await tmp();
    const agent = fakeAgent((_b, n) =>
      n === 0 ? { ms: 5, json: { reply: "ok" } } : { status: 503, ms: 7, json: "overloaded" },
    );
    const r = await runConversationSet({
      conversations: [
        ConversationSchema.parse({ id: "a", turns: [{ user: "1" }, { user: "2" }, { user: "3" }] }),
      ],
      config: parseHttpAgentConfig({}),
      endpoint: "http://agent.test/chat",
      outDir: out,
      fetch: agent.fetch,
      now: agent.now,
    });
    expect(r.ok).toBe(false);
    expect(agent.requests).toHaveLength(2);
    expect(r.transcripts[0]).toMatchObject({
      status: "error",
      ended_by: "error",
      error: "turn 1: HTTP 503: overloaded",
    });
    expect(rowsNamed(r.metrics, "turn_errors")[0]?.value).toBe(1);
    expect(rowsNamed(r.metrics, "cost_micro_usd")).toEqual([]); // no cost reported: no cost number
  });

  it("latest-history mode sends only the new message plus the session id", async () => {
    const out = await tmp();
    const agent = fakeAgent((_b, n) => ({ ms: 1, json: { reply: `r${n}`, sid: "s-9" } }));
    await runConversationSet({
      conversations: [ConversationSchema.parse({ id: "a", turns: [{ user: "1" }, { user: "2" }] })],
      config: parseHttpAgentConfig({
        request: {
          history: "latest",
          body: { input: "{{message}}", session: "{{session_id}}", turn: "{{turn}}" },
        },
        response: { session_id: "sid" },
      }),
      endpoint: "http://agent.test/chat",
      outDir: out,
      fetch: agent.fetch,
      now: agent.now,
    });
    expect(agent.requests).toEqual([
      { input: "1", session: null, turn: 0 },
      { input: "2", session: "s-9", turn: 1 },
    ]);
  });

  it("refuses to start without an endpoint", async () => {
    await expect(
      runConversationSet({
        conversations: [ConversationSchema.parse({ id: "a", turns: [{ user: "1" }] })],
        config: parseHttpAgentConfig({}),
        outDir: await tmp(),
      }),
    ).rejects.toThrow(HttpAgentRunError);
  });
});

describe("labeled-answers gate", () => {
  const transcript = (
    id: string,
    replies: string[],
    extra: Partial<Transcript> = {},
  ): Transcript => ({
    conversation_id: id,
    endpoint: "http://x/chat",
    status: "completed",
    ended_by: "script",
    turns: replies.map((reply, index) => ({
      index,
      source: "script",
      user: "u",
      status: "ok",
      reply,
      latency_ms: 1,
      tool_calls: [],
    })),
    ...extra,
  });

  it("an unlabeled conversation needs the oracle's transcript and must match it", () => {
    const c = ConversationSchema.parse({ id: "free", turns: [{ user: "hi" }] });
    expect(scoreConversation(c, transcript("free", ["Hello  there"])).failures[0]).toMatch(
      /no labels and no oracle/,
    );
    expect(
      scoreConversation(c, transcript("free", ["hello there"]), transcript("free", ["Hello there"]))
        .pass,
    ).toBe(true);
    expect(
      scoreConversation(c, transcript("free", ["bye"]), transcript("free", ["Hello there"]))
        .failures[0],
    ).toMatch(/differs from the oracle's/);
  });

  it("a missing transcript or a bad label set fails with the reason in gate.json", async () => {
    const d = await tmp();
    const cdir = await writeConversations(d, [
      { id: "a", turns: [{ user: "x", expect: { contains: ["y"] } }] },
    ]);
    const out = path.join(d, "out");
    await mkdir(out);
    const verdict = path.join(d, "gate.json");
    const r = await runHttpAgentGate({ conversationsDir: cdir, outDir: out, verdictPath: verdict });
    expect(r.gate.pass).toBe(false);
    expect(r.gate.reason).toBe(
      "1 of 1 conversations failed: a: transcript missing: transcripts/a.json does not exist",
    );
    const r2 = await runHttpAgentGate({
      conversationsDir: path.join(d, "nope"),
      outDir: out,
      verdictPath: verdict,
    });
    expect(r2.gate).toEqual({
      pass: false,
      reason: expect.stringMatching(/^gate error: invalid conversation set/),
      evidence: [],
    });
    expect(GateResultSchema.parse(JSON.parse(await readFile(verdict, "utf8")))).toEqual(r2.gate);
  });
});

describe("simulated user (FakeNaive)", () => {
  it("a reviewer session writes the follow-up turns until it is done", async () => {
    const naive = new FakeNaive();
    const seen: unknown[] = [];
    naive.script(
      SIMULATED_USER_ROLE,
      (ctx) => {
        seen.push(ctx.input);
        return {
          output: { done: false, message: "It's order 2001. Where is it right now?" },
          costMicroUsd: 3_000n,
        };
      },
      { output: { done: true, message: null }, costMicroUsd: 1_000n },
    );
    const { agent } = await ensureAgent(
      naive,
      simulatedUserAgentSpec({
        model: "test/sim-user",
        capMicroUsd: 1_000_000n,
        maxTaskMicroUsd: 20_000n,
      }),
    );
    const simulatedUser = naiveSimulatedUser({
      client: naive,
      agentId: agent.id,
      turnBudgetMicroUsd: 20_000n,
      keyPrefix: "trial-1:0",
    });

    const d = await tmp();
    const cdir = await writeConversations(d, [
      {
        id: "lost-order-number",
        turns: [{ user: "Hi, I need help with an order." }],
        simulated_user: { goal: "Find out where order 2001 is.", max_turns: 4 },
        expected: { answer: { contains: ["Denver hub"] }, outcome: "resolved" },
      },
    ]);
    const base = await startStub();
    const out = path.join(d, "out");
    const r = await runConversationSet({
      conversations: await loadConversationSet(cdir),
      config: await loadHttpAgentConfig(path.join(ADAPTER, "http-agent.json")),
      endpoint: `${base}/chat`,
      outDir: out,
      simulatedUser,
    });
    const t = r.transcripts[0];
    expect(t?.ended_by).toBe("simulated_user");
    expect(t?.turns.map((x) => [x.source, x.reply])).toEqual([
      ["script", "Sure, I can help. What is your order number?"],
      ["simulated", expect.stringContaining("Denver hub")],
    ]);
    expect(t?.turns[1]?.simulated_user_micro_usd).toBe(3_000n);
    expect(t?.simulated_user_micro_usd).toBe(4_000n); // includes the session that only said done
    // The simulated user saw the goal and the transcript, never the labels.
    expect(seen[0]).toMatchObject({
      conversation_id: "lost-order-number",
      goal: "Find out where order 2001 is.",
      turn: 1,
      transcript: [
        { role: "user", content: "Hi, I need help with an order." },
        { role: "assistant", content: "Sure, I can help. What is your order number?" },
      ],
    });
    expect(JSON.stringify(seen[0])).not.toContain("Denver");
    expect(naive.spentMicroUsd()).toBe(4_000n);
    expect(rowsNamed(r.metrics, "simulated_user_micro_usd")[0]?.value).toBe(4_000n);
    const gate = await runHttpAgentGate({
      conversationsDir: cdir,
      outDir: out,
      verdictPath: path.join(d, "gate.json"),
    });
    expect(gate.gate.pass).toBe(true);
  });

  it("stops at max_turns when the simulated user never finishes", async () => {
    const naive = new FakeNaive();
    naive.scriptDefault(SIMULATED_USER_ROLE, { output: { done: false, message: "and?" } });
    const { agent } = await ensureAgent(
      naive,
      simulatedUserAgentSpec({
        model: "test/sim-user",
        capMicroUsd: 1_000_000n,
        maxTaskMicroUsd: 20_000n,
      }),
    );
    const agentApi = fakeAgent(() => ({ ms: 1, json: { reply: "hm" } }));
    const r = await runConversationSet({
      conversations: [
        ConversationSchema.parse({
          id: "a",
          turns: [{ user: "hi" }],
          simulated_user: { goal: "g", max_turns: 3 },
        }),
      ],
      config: parseHttpAgentConfig({}),
      endpoint: "http://agent.test/chat",
      outDir: await tmp(),
      simulatedUser: naiveSimulatedUser({
        client: naive,
        agentId: agent.id,
        turnBudgetMicroUsd: 20_000n,
        keyPrefix: "t:0",
      }),
      fetch: agentApi.fetch,
      now: agentApi.now,
    });
    expect(r.transcripts[0]).toMatchObject({ ended_by: "max_turns", status: "completed" });
    expect(agentApi.requests).toHaveLength(3);
  });

  it("a conversation that needs a simulated user fails before any request without one", async () => {
    const agentApi = fakeAgent(() => ({ ms: 1, json: { reply: "x" } }));
    await expect(
      runConversationSet({
        conversations: [
          ConversationSchema.parse({
            id: "a",
            turns: [{ user: "hi" }],
            simulated_user: { goal: "g" },
          }),
        ],
        config: parseHttpAgentConfig({}),
        endpoint: "http://agent.test/chat",
        outDir: await tmp(),
        fetch: agentApi.fetch,
      }),
    ).rejects.toThrow("conversation(s) a need a simulated user: set driver.simulated_user: true");
    expect(agentApi.requests).toHaveLength(0);
  });
});

describe("example kit: examples/http-agent against the stub agent", () => {
  it("validates with no errors and no warnings", async () => {
    const r = await validateKitDir(EXAMPLE);
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.kit?.spec.contenders[0]?.driver.type).toBe("http-agent");
  });

  async function runExample(mode: "correct" | "canned") {
    const base = await startStub({ STUB_AGENT_MODE: mode });
    const d = await tmp();
    const out = path.join(d, "out");
    const r = await runConversationSet({
      conversations: await loadConversationSet(WORKLOAD),
      config: await loadHttpAgentConfig(path.join(ADAPTER, "http-agent.json")),
      endpoint: `${base}/chat`,
      outDir: out,
    });
    expect(r.ok).toBe(true);
    const gate = await gateInChildProcess(CONVERSATIONS, out);
    // The gate ran in a process of its own, not the test's and not the agent's.
    expect(gate.pid).not.toBe(process.pid);
    return { ...gate, metrics: r.metrics, out };
  }

  it("the correct stub agent passes the gate, with latency and cost numbers", async () => {
    const { gate, stdout, metrics, out } = await runExample("correct");
    expect(gate).toEqual({
      pass: true,
      reason: "all 5 conversations match their labels (13 checks)",
      evidence: ["labeled-answers.json"],
    });
    expect(stdout).toContain("PASS");
    expect(rowsNamed(metrics, "latency_p95_ms")).toHaveLength(1);
    expect(typeof rowsNamed(metrics, "cost_micro_usd")[0]?.value).toBe("bigint");
    expect(rowsNamed(metrics, "cost_unreported_turns")[0]?.value).toBe(0);
    const detail = JSON.parse(await readFile(path.join(out, "labeled-answers.json"), "utf8")) as {
      conversations: { pass: boolean }[];
    };
    expect(detail.conversations.every((c) => c.pass)).toBe(true);
  });

  it("the canned-answer agent (do-less) fails the gate with a clear reason", async () => {
    const { gate } = await runExample("canned");
    const g = GateResultSchema.parse(gate);
    expect(g.pass).toBe(false);
    expect(g.reason).toMatch(/^5 of 5 conversations failed: /);
    expect(g.reason).toContain('bulk-quote: turn 0 reply does not contain "$59.97"');
    expect(g.reason).toContain('refund-too-late: final answer does not contain "not eligible"');
    expect(g.reason).toContain('outcome is "resolved", expected "escalated"');
    expect(g.reason).toContain("expected 1+ call(s) to lookup_order");
    expect(g.evidence).toContain("transcripts/bulk-quote.json");
  });

  it(
    "driver.sh start/ready/run/stop and check.sh work end to end",
    { timeout: 60_000 },
    async () => {
      const d = await tmp();
      const ws = path.join(d, "ws");
      const out = path.join(d, "out");
      await mkdir(ws);
      await mkdir(out);
      const shim = path.join(d, "anybench-http-agent");
      await writeFile(
        shim,
        `#!/usr/bin/env bash\ncd ${JSON.stringify(KIT_PKG)} && exec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(BIN)} "$@"\n`,
        {
          mode: 0o755,
        },
      );
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        EVAL_WS: ws,
        ANYBENCH_HTTP_AGENT: shim,
      };
      const driver = path.join(ADAPTER, "driver.sh");
      const sh = (file: string, args: string[]) => execFileP(file, args, { env, timeout: 25_000 });
      try {
        await sh(driver, ["start"]);
        let ready = false;
        for (let i = 0; i < 50 && !ready; i++) {
          ready = await sh(driver, ["ready"]).then(
            () => true,
            () => new Promise<boolean>((r) => setTimeout(() => r(false), 100)),
          );
        }
        expect(ready).toBe(true);
        const run = await sh(driver, ["run", WORKLOAD, out]);
        expect(run.stdout).toContain("order-followup: completed (2 turn(s), ended by script)");
      } finally {
        await sh(driver, ["stop"]);
      }
      const verdict = path.join(d, "gate.json");
      await sh(path.join(EXAMPLE, "gates", "labeled-answers", "check.sh"), [
        out,
        "support-basics",
        verdict,
      ]);
      expect(GateResultSchema.parse(JSON.parse(await readFile(verdict, "utf8"))).pass).toBe(true);
    },
  );
});

describe("anybench-http-agent cli", () => {
  it("exits 2 with usage on a bad command", async () => {
    const err: string[] = [];
    const code = await httpAgentCliMain(["frob"], {
      stdout: () => {},
      stderr: (l) => err.push(l),
      env: {},
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("unknown command 'frob'");
    expect(err.join("\n")).toContain("usage:");
  });

  it("run exits 1 when the agent fails a turn, after writing transcripts", async () => {
    const d = await tmp();
    const cdir = await writeConversations(d, [{ id: "a", turns: [{ user: "x" }] }]);
    const out = path.join(d, "out");
    const fetchFn: typeof fetch = async () => new Response("boom", { status: 500 });
    const lines: string[] = [];
    const code = await httpAgentCliMain(
      ["run", "--in", cdir, "--out", out, "--endpoint", "http://agent.test/chat"],
      { stdout: (l) => lines.push(l), stderr: (l) => lines.push(l), env: {} },
      { fetch: fetchFn },
    );
    expect(code).toBe(1);
    expect(lines).toEqual(["a: error (1 turn(s), ended by error): turn 0: HTTP 500: boom"]);
    expect(
      JSON.parse(await readFile(path.join(out, "transcripts", "a.json"), "utf8")),
    ).toMatchObject({ status: "error" });
  });
});

describe("collectors on a hand-built transcript", () => {
  it("emits no latency or cost rows when no turn was answered", () => {
    const rows = collectHttpAgent([
      {
        conversation_id: "a",
        endpoint: "http://x/chat",
        status: "error",
        ended_by: "error",
        turns: [
          {
            index: 0,
            source: "script",
            user: "u",
            status: "error",
            reply: null,
            latency_ms: 3,
            tool_calls: [],
            error: "x",
          },
        ],
      },
    ]);
    expect(rows.some((r) => r.name.startsWith("latency_"))).toBe(false);
    expect(rows.some((r) => r.name === "cost_micro_usd")).toBe(false);
    expect(rowsNamed(rows, "conversations_errored")[0]?.value).toBe(1);
  });
});
