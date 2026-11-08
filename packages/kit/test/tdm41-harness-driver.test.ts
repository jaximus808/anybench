// TDM-41 [4.9]: driver.type harness and the Tandem adapter, without Docker. The docker-local run of
// a real Tandem trial is packages/kit/test/tdm41-harness-docker.test.ts.
import { spawnSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectHarness,
  expandVarySetups,
  harnessDriverEnv,
  HarnessConfigError,
  loadHarnessConfig,
  loadKit,
  parseHarnessConfig,
  planHarnessStubTrial,
  readFlatConfig,
  summarizeBoard,
  summarizeSession,
  usdTextToMicroUsd,
  type LoadedKit,
  type TandemAction,
} from "../src/index.js";
import { ADAPTER_TDM41, REPO_TDM41, toyKitDirTdm41 } from "./tdm41-harness-helpers.js";

describe("adapters/tandem/harness.yaml", () => {
  it("validates, and run.sh's line parser reads what YAML reads", async () => {
    const file = path.join(ADAPTER_TDM41, "harness.yaml");
    const cfg = await loadHarnessConfig(file);
    expect(cfg).toMatchObject({
      harness: "tandem",
      workers_env: "TANDEM_WORKERS",
      completion: "epics-drained",
      disallowed_tools: "Task Agent",
    });
    expect(cfg.scrub.split(" ")).toEqual([".mcp.json", "AGENTS.md", "CLAUDE.md", ".tandem"]);
    const flat = readFlatConfig(await readFile(file, "utf8"));
    expect(flat.get("timeout_s")).toBe(String(cfg.timeout_s));
    for (const p of [cfg.planner_prompt, cfg.worker_prompt])
      await expect(readFile(path.join(ADAPTER_TDM41, p), "utf8")).resolves.toContain("{{TASK}}");
  });

  it("refuses what the line parser would misread", () => {
    const base = (extra: string) =>
      [
        "schema_version: 1",
        "harness: tandem",
        "planner_prompt: planner-prompt.md",
        "worker_prompt: worker-prompt.md",
        "workers_env: TANDEM_WORKERS",
        "completion: epics-drained",
        "timeout_s: 60",
        "startup_timeout_s: 5",
        "epic_timeout_s: 5",
        "poll_s: 1",
        "drain_grace_s: 0",
        "stop_grace_s: 1",
        "max_worker_restarts: 0",
        "scrub: .mcp.json",
        extra,
      ].join("\n");
    expect(parseHarnessConfig(base("")).timeout_s).toBe(60);
    const msg = (t: string) => {
      try {
        parseHarnessConfig(t);
        return "";
      } catch (e) {
        expect(e).toBeInstanceOf(HarnessConfigError);
        return (e as Error).message;
      }
    };
    expect(msg(base('disallowed_tools: "Task Agent"'))).toMatch(/run.sh would read/);
    expect(msg(base("disallowed_tools:\n  - Task"))).toMatch(/one scalar/);
    expect(msg(base("timeout_s: 90"))).toMatch(/Map keys must be unique|unique/i);
    expect(msg(base("bogus: 1"))).toMatch(/bogus/);
    expect(msg(base("").replace("timeout_s: 60", "timeout_s: soon"))).toMatch(/timeout_s/);
  });
});

describe("adapters/tandem scripts", () => {
  it.each(["run.sh", "driver.sh", "install.sh", "install-tandem.sh", "healthcheck.sh"])(
    "%s parses (bash -n)",
    (f) => {
      const r = spawnSync("bash", ["-n", path.join(ADAPTER_TDM41, f)], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    },
  );

  it("run.sh refuses to start without a policy, and never guesses one", () => {
    const r = spawnSync("bash", [path.join(ADAPTER_TDM41, "run.sh"), "/dev/null", "/tmp"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, EVAL_OUT: tmpdir(), TANDEM_WORKERS: "2" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ANYBENCH_HIL_POLICY is not set/);
  });

  it("the driver delegates `run` to run.sh and accepts the no-op verbs", () => {
    for (const v of ["start", "ready", "stop"]) {
      const r = spawnSync("bash", [path.join(ADAPTER_TDM41, "driver.sh"), v]);
      expect(r.status).toBe(0);
    }
  });
});

describe("harnessDriverEnv and the runner stub", () => {
  let kit: LoadedKit;
  beforeAll(async () => {
    kit = await loadKit(await toyKitDirTdm41());
  });

  it("carries human_in_loop and the wall-clock cap to the driver", () => {
    expect(harnessDriverEnv(kit.spec, "tandem", "toy")).toEqual({
      ANYBENCH_HIL_KIND: "tandem",
      ANYBENCH_HIL_POLICY: "auto",
      ANYBENCH_WALL_CAP_S: "600",
    });
  });

  it("ships only adapters/tandem/ and the workload to the subject computer", async () => {
    const plan = await planHarnessStubTrial(kit, "tandem", "toy", { root: "/home/naive/t1" });
    const to = plan.files.map((f) => f.to);
    expect(to).toContain("kit/adapters/tandem/run.sh");
    expect(to).toContain("kit/adapters/tandem/harness.yaml");
    expect(to).toContain("kit/workloads/toy/input/FAKE_PLAN.json");
    expect(to.filter((t) => /(^|\/)(gates|reference|proof)\//.test(t))).toEqual([]);
    expect(plan.script).toContain("export ANYBENCH_HIL_POLICY='auto'");
    expect(plan.script).toContain("export TANDEM_WORKERS='2'");
    expect(plan.script).not.toMatch(/hidden-tests/);
  });

  it("a do-less overlay replaces only the driver", async () => {
    const plan = await planHarnessStubTrial(kit, "tandem", "toy", {
      root: "/home/naive/t2",
      overlay: "no-op",
    });
    const driver = plan.files.find((f) => f.to === "kit/adapters/tandem/driver.sh")!;
    expect(new TextDecoder().decode(driver.content)).toMatch(
      /Do-less: a harness that does nothing/,
    );
    expect(plan.overlayId).toBe("no-op");
  });

  it("refuses a vary setup that names a bad env var", async () => {
    await expect(
      planHarnessStubTrial(kit, "tandem", "toy", { root: "/r", setup: { "bad-name": "1" } }),
    ).rejects.toThrow(/bad env name/);
  });
});

describe("the runner stub on the real flagship kit's contender C", () => {
  it("ships adapters/tandem/ and the workload only, with the kit's env for a vary setup", async () => {
    const kit = await loadKit(path.join(REPO_TDM41, "kits/tandem-vs-claude-code"));
    const setups = expandVarySetups(kit.spec, "tandem");
    expect(setups.map((s) => s.setupId)).toEqual([
      "tandem@TANDEM_WORKERS=1",
      "tandem@TANDEM_WORKERS=3",
      "tandem@TANDEM_WORKERS=5",
    ]);
    const plan = await planHarnessStubTrial(kit, "tandem", "todo-api", {
      root: "/home/naive/c",
      setup: setups[2]!.env,
    });
    const to = plan.files.map((f) => f.to);
    expect(to).toContain("kit/adapters/tandem/run.sh");
    expect(to).toContain("kit/workloads/todo-api/instruction.md");
    expect(to.filter((t) => /(^|\/)(gates|reference|proof)\//.test(t))).toEqual([]);
    for (const line of [
      "export TANDEM_WORKERS='5'",
      "export AB_TOKEN_SOURCE='naive_proxy'",
      "export CC_MODEL='anthropic/claude-sonnet-4.6'",
      "export TANDEM_MCP_VERSION='3.2.0'",
      "export CLAUDE_CODE_VERSION='2.1.319'",
      `export ANYBENCH_HIL_POLICY='${kit.spec.human_in_loop!.policy}'`,
    ])
      expect(plan.script).toContain(line);
  });
});

describe("collectors", () => {
  const actions: TandemAction[] = [
    {
      type: "epic",
      state: "approved",
      ticket: null,
      approved_by: "human",
      claimed_by: null,
      payload: {},
    },
    {
      type: "task",
      state: "done",
      ticket: 1,
      approved_by: "policy:epic",
      claimed_by: "w2",
      payload: {
        claim: { generation: 2, holder: "w2" },
        contention: [
          { kind: "lost_claim", agent: "w1", holder: "w2" },
          { kind: "fenced_write", agent: "w1", holder: "w2", count: 3 },
        ],
      },
    },
    {
      type: "task",
      state: "failed",
      ticket: 2,
      approved_by: "policy:epic",
      claimed_by: "w1",
      payload: { claim: { generation: 1, holder: "w1" } },
    },
    {
      type: "task",
      state: "proposed",
      ticket: 3,
      approved_by: null,
      claimed_by: null,
      payload: {},
    },
  ];

  it("summarizes claims, takeovers, conflicts and approvals from the board", () => {
    expect(summarizeBoard(actions)).toEqual({
      epics: 1,
      tickets: 3,
      tickets_by_state: { done: 1, failed: 1, proposed: 1 },
      claims: 3,
      claim_takeovers: 1,
      claim_conflicts: 1,
      fenced_writes: 3,
      contended_tickets: 1,
      claimants: 2,
      approvals_by: { human: 1, "policy:epic": 2 },
    });
  });

  it("reads money from the JSON text, never through a float", () => {
    expect(usdTextToMicroUsd("0.0125")).toBe(12_500n);
    expect(usdTextToMicroUsd("1.2345675")).toBe(1_234_568n);
    expect(usdTextToMicroUsd("3e-6")).toBe(3n);
    expect(() => usdTextToMicroUsd("NaN")).toThrow();
    const s = summarizeSession(
      "worker-1",
      [
        '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","name":"Bash"}],"usage":{"input_tokens":10,"output_tokens":5}}}',
        '{"type":"assistant","message":{"id":"m1","content":[{"type":"text"}],"usage":{"input_tokens":10,"output_tokens":7}}}',
        "not json",
        '{"type":"result","subtype":"success","num_turns":4,"total_cost_usd":0.30000000000000004}',
      ].join("\n"),
    );
    expect(s).toMatchObject({
      has_result: true,
      cost_micro_usd: 300_000n,
      turns: 4,
      tool_calls: 1,
    });
    expect(s.tokens).toEqual({ input: 10, output: 7, cache_read: 0, cache_creation: 0 });
  });

  it("collects an EVAL_OUT, with no cost row when a session never reported one", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "tdm41-out-"));
    await mkdir(path.join(out, "tandem/streams"), { recursive: true });
    await writeFile(
      path.join(out, "tandem/actions.json"),
      JSON.stringify({
        actions: actions.map((a) => ({ ...a, approvedBy: a.approved_by, claimedBy: a.claimed_by })),
      }),
    );
    await writeFile(
      path.join(out, "tandem/metrics.json"),
      JSON.stringify({
        counters: { claims: 3, claim_conflicts: 1, ttl_expiries: 0, fenced_writes: 3 },
      }),
    );
    await writeFile(
      path.join(out, "tandem/run.json"),
      JSON.stringify({ outcome: "completed", workers: 2, wall_ms: 1234 }),
    );
    const result = '{"type":"result","subtype":"success","num_turns":2,"total_cost_usd":0.01}\n';
    await writeFile(path.join(out, "tandem/streams/planner.jsonl"), result);
    await writeFile(path.join(out, "tandem/streams/worker-1.jsonl"), result);
    let c = await collectHarness(out);
    const row = (name: string, labels?: Record<string, string>) =>
      c.rows.find((r) => r.name === name && JSON.stringify(r.labels) === JSON.stringify(labels))
        ?.value;
    expect(c.board_source).toBe("actions.json");
    expect(row("tandem_claims")).toBe(3);
    expect(row("tandem_claim_conflicts")).toBe(1);
    expect(row("tandem_api_fenced_writes")).toBe(3);
    expect(row("tandem_approvals_by", { by: "human" })).toBe(1);
    expect(row("cost_micro_usd")).toBe(20_000n);
    expect(row("harness_outcome", { outcome: "completed" })).toBe(1);
    expect(c.rows.every((r) => r.collector !== undefined)).toBe(true);

    await writeFile(
      path.join(out, "tandem/streams/worker-2.jsonl"),
      '{"type":"assistant","message":{"id":"x","usage":{"input_tokens":1}}}\n',
    );
    c = await collectHarness(out);
    expect(row("cost_micro_usd")).toBeUndefined();
    expect(row("sessions_without_cost")).toBe(1);
    await rm(out, { recursive: true, force: true });
  });

  it("reads the board from a tandem.db (node:sqlite)", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "tdm41-db-"));
    await mkdir(path.join(out, "tandem"), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(out, "tandem/tandem.db"));
    db.exec(
      "CREATE TABLE actions (id TEXT PRIMARY KEY, type TEXT, state TEXT, ticket INTEGER, approved_by TEXT, claimed_by TEXT, payload TEXT)",
    );
    const ins = db.prepare("INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?)");
    actions.forEach((a, i) =>
      ins.run(
        `a${i}`,
        a.type,
        a.state,
        a.ticket,
        a.approved_by,
        a.claimed_by,
        JSON.stringify(a.payload),
      ),
    );
    db.close();
    const c = await collectHarness(out);
    expect(c.board_source).toBe("tandem.db");
    expect(c.board).toEqual(summarizeBoard(actions));
    await rm(out, { recursive: true, force: true });
  });
});

describe("board.ts (completion detector and built-in approver) against a canned Tandem API", () => {
  let epics: unknown = { epics: [], unepiced: { total: 0, byState: {} } };
  let api = "";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/mcp/auth") return res.end(JSON.stringify({ token: "t", role: "write" }));
    if (req.url?.startsWith("/api/canvas/epics")) return res.end(JSON.stringify(epics));
    res.statusCode = 404;
    res.end("{}");
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    api = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const board = (...args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(process.execPath, [path.join(ADAPTER_TDM41, "board.ts"), ...args]);
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d: Buffer) => (stdout += d));
      p.stderr.on("data", (d: Buffer) => (stderr += d));
      p.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  const status = async () =>
    JSON.parse((await board("status", "--api", api, "--code", "ABCD1234")).stdout) as Record<
      string,
      unknown
    >;
  const epic = (state: string, byState: Record<string, number>, drained: boolean) => ({
    state,
    tasks: { total: Object.values(byState).reduce((a, b) => a + b, 0), byState },
    drained,
  });

  it("is not complete on an empty board, a proposed epic, or open tickets", async () => {
    expect(await status()).toMatchObject({ complete: false, has_approved_work: false, epics: 0 });
    epics = { epics: [epic("proposed", { proposed: 2 }, false)], unepiced: { byState: {} } };
    expect(await status()).toMatchObject({ complete: false, has_approved_work: false });
    epics = {
      epics: [epic("approved", { done: 1, executing: 1 }, false)],
      unepiced: { byState: {} },
    };
    expect(await status()).toMatchObject({ complete: false, has_approved_work: true });
  });

  it("is complete when every approved epic drained (failed tickets are terminal too)", async () => {
    epics = {
      epics: [
        epic("approved", { done: 1, failed: 1 }, true),
        epic("rejected", { proposed: 1 }, false),
      ],
      unepiced: { byState: {} },
    };
    expect(await status()).toMatchObject({ complete: true, drained: 1 });
    epics = {
      epics: [epic("approved", { done: 2 }, true), epic("proposed", { proposed: 1 }, false)],
      unepiced: { byState: {} },
    };
    expect(await status()).toMatchObject({ complete: false });
  });

  it("refuses llm-reviewer instead of approving blindly", async () => {
    const r = await board(
      "approve",
      "--api",
      api,
      "--code",
      "ABCD1234",
      "--policy",
      "llm-reviewer",
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/eval-approver/);
  });
});
