// TDM-220 [19.4]: every tool of the Anybench MCP server, called through an in-memory MCP client,
// against a fake API (test/fake-api.ts). The tool list must be exactly MCP_TOOLS (the catalog
// the web docs render), the API key must never appear in a result, and push_kit must never upload
// an invalid kit.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  HIDDEN_TEST_FRACTION_METRIC,
  KIT_UPLOAD_LIMITS,
  LONG_HORIZON_MIN_FEATURE_AREAS,
  LONG_HORIZON_MIN_WALL_S,
  MCP_TOOLS,
  MCP_TOOL_NAMES,
  PROOF_CHECKS,
} from "@anybench/core";
import { KIT_TEMPLATES, type LocalProofResult } from "@anybench/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FAIRNESS_RULES,
  PROOF_CHECK_GUIDE,
  WATCH_DEFAULT_UNTIL,
  createAnybenchMcpServer,
  kitGuide,
  type AnybenchMcpDeps,
} from "../src/index.js";
import { KEY, RUN_ID, TRIAL_ID, startFakeApi, type FakeApi } from "./fake-api.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Called {
  isError: boolean;
  text: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Every text a tool returned in this file, to check the key never leaks. */
const seen: string[] = [];

async function connect(deps: AnybenchMcpDeps) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createAnybenchMcpServer(deps);
  await server.connect(serverSide);
  const client = new Client({ name: "tdm220-test", version: "0.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Called> => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    const text = r.content.map((c) => c.text).join("\n");
    seen.push(text);
    return { isError: r.isError === true, text, json: () => JSON.parse(text) };
  };
  return { client, call, close: () => client.close() };
}

let tmp: string;
let api: FakeApi;
let env: Record<string, string>;
let mcp: Awaited<ReturnType<typeof connect>>;
const proofCalls: { dir: string; opts: unknown }[] = [];

const passing: LocalProofResult = {
  ok: true,
  status: "pass",
  error: null,
  dir: "/k",
  image: "node:22",
  checks: [
    {
      check: "oracle_passes",
      pass: true,
      reason: "oracle 'reference-solution' passed every gate it covers (1/1 workloads)",
      units: [
        {
          variant: "oracle",
          workloadId: "slugify",
          ok: true,
          reason: "oracle passed 1/1 gate(s) on slugify",
          setupExit: 0,
          driverExit: 0,
          log: "",
          gates: [
            {
              gateId: "hidden-tests",
              status: "pass",
              reason: "7/7 hidden tests pass",
              checkExit: 0,
              log: "",
            },
          ],
        },
      ],
    },
    {
      check: "do_nothing_fails",
      pass: false,
      reason: "the untouched starting workspace passed every gate on slugify",
      units: [
        {
          variant: "do-nothing",
          workloadId: "slugify",
          ok: false,
          reason: "do-nothing passed hidden-tests",
          setupExit: 0,
          driverExit: 0,
          log: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
          gates: [],
        },
      ],
    },
  ],
  durationMs: 9100,
  outDir: null,
};

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "ab-mcp-tdm220-"));
  api = await startFakeApi();
  env = {
    ANYBENCH_API_KEY: KEY,
    ANYBENCH_API_URL: api.url,
    ANYBENCH_WEB_URL: "https://web.test",
    ANYBENCH_PROOF_IMAGE: "node:22-slim",
  };
  mcp = await connect({
    env,
    cwd: tmp,
    pollMs: 5,
    runLocalProof: async (dir, opts) => {
      proofCalls.push({ dir, opts });
      opts?.onLog?.("[proof] oracle slugify: setup");
      return passing;
    },
  });
});

afterAll(async () => {
  await mcp.close();
  await api.close();
  await rm(tmp, { recursive: true, force: true });
  // The key went to every API call, and must be in no tool result.
  expect(seen.length).toBeGreaterThan(20);
  for (const t of seen) expect(t).not.toContain(KEY);
});

// ---------------------------------------------------------------------------------------------

describe("the tool list (TDM-220)", () => {
  it("is exactly the MCP_TOOLS catalog, each with a description and an object input schema", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const t of tools) {
      const info = MCP_TOOLS.find((x) => x.name === t.name)!;
      expect(t.description).toContain(info.does);
      expect(t.description).toContain(info.scope === "local" ? "needs no API key" : info.scope);
      expect(t.inputSchema.type).toBe("object");
    }
    const start = tools.find((t) => t.name === "start_run")!;
    expect(Object.keys(start.inputSchema.properties ?? {}).sort()).toEqual(
      ["auto_go", "budget_micro_usd", "budget_usd", "kit_id", "question"].sort(),
    );
  });

  it("rejects malformed input before a handler runs", async () => {
    const r = await mcp.call("get_run", { run_id: "not-a-uuid" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/expected a UUID/);
    expect(
      (await mcp.call("scaffold_kit", { dir: path.join(tmp, "x"), template: "nope" })).isError,
    ).toBe(true);
    expect((await mcp.call("validate_kit", {})).isError).toBe(true);
  });
});

describe("get_kit_guide (TDM-220)", () => {
  it("covers the layout, the six proof checks, partial credit, horizon, contracts and fixtures", async () => {
    const r = await mcp.call("get_kit_guide");
    expect(r.isError).toBe(false);
    expect(r.text).toBe(kitGuide());
    for (const c of PROOF_CHECKS) expect(r.text).toContain(`\`${c}\`: ${PROOF_CHECK_GUIDE[c]}`);
    for (const t of KIT_TEMPLATES) expect(r.text).toContain(`\`${t}\``);
    for (const s of [
      "KitSpec v2",
      "adapters/<contender>/driver.sh",
      "gates/<gate>/check.sh",
      HIDDEN_TEST_FRACTION_METRIC,
      "aggregate: all_trials",
      `${LONG_HORIZON_MIN_WALL_S} s`,
      `${LONG_HORIZON_MIN_FEATURE_AREAS} feature areas`,
      "instruction_kind",
      "`contract`",
      "gates[].fixtures",
      "horizon_mismatch",
      `${KIT_UPLOAD_LIMITS.maxEntries} entries`,
      "$EVAL_OUT/workspace",
      "micro-USD",
    ])
      expect(r.text, s).toContain(s);
  });

  it("lists every fairness rule of plan.md 17.2 under the title plan.md gives it", async () => {
    const plan = await readFile(path.join(REPO, "plan.md"), "utf8");
    const section = plan.slice(plan.indexOf("### 17.2"), plan.indexOf("### 17.3"));
    const titles = [...section.matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)].map((m) => [
      Number(m[1]),
      m[2],
    ]);
    expect(titles.length).toBeGreaterThanOrEqual(10);
    expect(FAIRNESS_RULES.map((r) => [r.n, r.title])).toEqual(titles);
    const guide = kitGuide();
    for (const [n, title] of titles) expect(guide).toContain(`${n}. **${title}**`);
  });
});

describe("scaffold_kit and validate_kit (TDM-220)", () => {
  it("scaffolds a kit that validates, relative to the server's cwd", async () => {
    const r = await mcp.call("scaffold_kit", { dir: "kit-a" });
    expect(r.isError).toBe(false);
    const j = r.json();
    expect(j).toMatchObject({
      ok: true,
      dir: path.join(tmp, "kit-a"),
      template: "coding-agent",
      errors: [],
    });
    expect(j.files).toContain("anybench.yaml");
    const v = await mcp.call("validate_kit", { dir: path.join(tmp, "kit-a") });
    expect(v.json()).toMatchObject({
      ok: true,
      errors: [],
      kit: { subject: "claude-code", contenders: ["claude-code"], gates: ["hidden-tests"] },
    });
    expect(v.json().kit.workloads[0]).toMatchObject({
      id: "slugify",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("takes a template, and refuses a non-empty dir unless force", async () => {
    expect(
      (await mcp.call("scaffold_kit", { dir: "kit-cli", template: "cli" })).json(),
    ).toMatchObject({
      ok: true,
      template: "cli",
    });
    const again = await mcp.call("scaffold_kit", { dir: "kit-cli" });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/is not empty/);
    expect((await mcp.call("scaffold_kit", { dir: "kit-cli", force: true })).isError).toBe(false);
  });

  it("returns each error as file:line:col: field: message", async () => {
    await mcp.call("scaffold_kit", { dir: "kit-bad" });
    const manifest = path.join(tmp, "kit-bad", "anybench.yaml");
    const text = await readFile(manifest, "utf8");
    await writeFile(
      manifest,
      text.replace("weights: { tests-pass: 60", "weights: { tests-pass: 70"),
    );
    const v = await mcp.call("validate_kit", { dir: "kit-bad" });
    expect(v.isError).toBe(false);
    expect(v.json().ok).toBe(false);
    expect(v.json().errors.join("\n")).toMatch(
      /^anybench\.yaml:\d+:\d+: scoring\.weights: weights must sum to 100, got 110$/m,
    );
  });
});

describe("run_local_proof (TDM-220)", () => {
  it("passes the image from ANYBENCH_PROOF_IMAGE, the timeout and the cancel signal; trims logs", async () => {
    const r = await mcp.call("run_local_proof", { dir: "kit-a", timeout_s: 60 });
    expect(r.isError).toBe(false);
    const last = proofCalls.at(-1)!;
    expect(last.dir).toBe(path.join(tmp, "kit-a"));
    expect(last.opts).toMatchObject({ image: "node:22-slim", network: false, timeoutMs: 60_000 });
    expect((last.opts as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    const j = r.json();
    expect(j).toMatchObject({ ok: true, status: "pass", duration_s: 9.1 });
    expect(j.checks[0].units[0].gates[0]).toEqual({
      gate: "hidden-tests",
      status: "pass",
      reason: "7/7 hidden tests pass",
    });
    expect(j.checks[1].units[0].log_tail).toHaveLength(15);
    expect(j.checks[1].units[0].log_tail.at(-1)).toBe("line 39");
    expect(j.progress).toEqual(["[proof] oracle slugify: setup"]);
    await mcp.call("run_local_proof", { dir: "kit-a", image: "node:24", network: true });
    expect(proofCalls.at(-1)!.opts).toMatchObject({ image: "node:24", network: true });
  });
});

describe("push_kit and start_run against a fake API (TDM-220)", () => {
  let kitId: string;

  it("refuses without ANYBENCH_API_KEY and uploads nothing", async () => {
    const bare = await connect({ env: { ANYBENCH_API_URL: api.url }, cwd: tmp });
    const before = api.calls.length;
    const r = await bare.call("push_kit", { dir: "kit-a" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ANYBENCH_API_KEY is not set/);
    expect(api.calls.length).toBe(before);
    await bare.close();
  });

  it("never uploads an invalid kit", async () => {
    const before = api.calls.length;
    const r = await mcp.call("push_kit", { dir: "kit-bad" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^push_kit stopped at validate \(nothing uploaded\):/);
    expect(r.text).toMatch(/weights must sum to 100/);
    expect(api.calls.length).toBe(before);
  });

  it("validates, packs and uploads a kit, and returns its kit_id", async () => {
    const before = api.calls.length;
    const r = await mcp.call("push_kit", { dir: "kit-a" });
    expect(r.isError).toBe(false);
    const j = r.json();
    kitId = j.kit_id;
    expect(kitId).toMatch(/^[0-9a-f-]{36}$/);
    expect(j).toMatchObject({ ok: true, name: "claude-code", proven: false, version: 1 });
    expect(j.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(j.log[0]).toMatch(/^packed .*kit-a: \d+ files/);
    expect(api.calls.slice(before)).toEqual([
      "POST /kits/uploads",
      expect.stringMatching(/^PUT \/r2\/[0-9a-f-]{36}$/),
      expect.stringMatching(/^POST \/kits\/uploads\/[0-9a-f-]{36}\/complete$/),
    ]);
  });

  it("starts a run with a decimal-dollar budget, parsed to micro-USD without floats", async () => {
    const r = await mcp.call("start_run", {
      kit_id: kitId,
      question: "Is it any good?",
      budget_usd: "12.50",
    });
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({
      state: "intake",
      kit_id: kitId,
      budget_micro_usd: "12500000",
      url: expect.stringMatching(/^https:\/\/web\.test\/runs\/[0-9a-f-]{36}$/),
    });
    expect(api.runs.at(-1)).toMatchObject({
      body: {
        question: "Is it any good?",
        source: { kind: "kit", kit_id: kitId },
        budget_micro_usd: 12_500_000n,
      },
      idempotency: expect.stringMatching(/^mcp-/),
    });
  });

  it("takes integer micro-USD as a number or a digit string, and auto_go", async () => {
    await mcp.call("start_run", { kit_id: kitId, question: "q", budget_micro_usd: 2_500_000 });
    expect(api.runs.at(-1)!.body.budget_micro_usd).toBe(2_500_000n);
    await mcp.call("start_run", {
      kit_id: kitId,
      question: "q",
      budget_micro_usd: "900000000000000001",
      auto_go: true,
    });
    expect(api.runs.at(-1)!.body).toMatchObject({
      budget_micro_usd: 900_000_000_000_000_001n,
      auto_go: true,
    });
  });

  it("refuses a bad budget without calling the API", async () => {
    const before = api.runs.length;
    const bad = [
      { budget_usd: "1e3" },
      { budget_usd: "1.0000001" },
      { budget_usd: "0" },
      { budget_micro_usd: 2.5 },
      { budget_micro_usd: "-5" },
      { budget_micro_usd: 0 },
      {},
      { budget_usd: "5", budget_micro_usd: 5 },
    ];
    for (const b of bad) {
      const r = await mcp.call("start_run", { kit_id: kitId, question: "q", ...b });
      expect(r.isError, JSON.stringify(b)).toBe(true);
    }
    expect(
      (await mcp.call("start_run", { kit_id: kitId, question: "q", budget_usd: "0" })).text,
    ).toBe("budget_usd must be more than $0");
    expect(api.runs.length).toBe(before);
  });

  it("passes the API's refusal through as a tool error", async () => {
    const r = await mcp.call("start_run", {
      kit_id: "44444444-4444-4444-8444-444444444444",
      question: "q",
      budget_usd: "5",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/runs\.create: no such kit \(HTTP 404, not_found\)/);
  });
});

describe("observe tools against a fake API (TDM-220)", () => {
  it("list_runs, get_run, list_trials, get_trial", async () => {
    const runs = await mcp.call("list_runs", { state: ["running", "proof"], limit: 5 });
    expect(runs.json().items[0]).toMatchObject({
      id: RUN_ID,
      state: "running",
      budget_micro_usd: "25000000",
    });
    expect(
      api.calls.some((c) => /^GET \/runs\?(?=.*limit=5)(?=.*state=running(%2C|,)proof)/.test(c)),
    ).toBe(true);

    const run = await mcp.call("get_run", { run_id: RUN_ID });
    expect(run.json()).toMatchObject({
      run: { id: RUN_ID },
      counters: { trials_total: 4, spent_micro_usd: "1250000" },
      url: `https://web.test/runs/${RUN_ID}`,
    });

    const trials = await mcp.call("list_trials", { run_id: RUN_ID, state: ["done"] });
    expect(trials.json().items[0]).toMatchObject({ id: TRIAL_ID, cost_micro_usd: "310000" });

    const trial = await mcp.call("get_trial", { trial_id: TRIAL_ID });
    expect(trial.json().trial).toMatchObject({
      id: TRIAL_ID,
      gate: { pass: true },
      metrics: { wall_s: 41 },
    });

    const missing = await mcp.call("get_run", { run_id: "55555555-5555-4555-8555-555555555555" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/HTTP 404/);
  });

  it("watch_run polls until a target state, and stops at the timeout or the end", async () => {
    const id = "66666666-6666-4666-8666-666666666666";
    api.states.set(id, ["env_build", "proof", "proof", "awaiting_go"]);
    const r = await mcp.call("watch_run", { run_id: id });
    expect(r.json()).toMatchObject({ reached: true, state: "awaiting_go", polls: 4 });
    expect(WATCH_DEFAULT_UNTIL).toContain("awaiting_go");

    const stuck = "77777777-7777-4777-8777-777777777777";
    api.states.set(stuck, ["running"]);
    const t = await mcp.call("watch_run", { run_id: stuck, until: ["delivered"], timeout_s: 1 });
    expect(t.json()).toMatchObject({ reached: false, state: "running", timed_out: true });
    expect(t.json().polls).toBeGreaterThan(1);

    const failed = "88888888-8888-4888-8888-888888888888";
    api.states.set(failed, ["failed"]);
    const f = await mcp.call("watch_run", { run_id: failed, until: ["delivered"] });
    expect(f.json()).toMatchObject({ reached: false, state: "failed", ended: true, polls: 1 });
  });

  it("get_report: Markdown by default, a clear message before the report exists", async () => {
    const md = await mcp.call("get_report", { run_id: RUN_ID });
    expect(md.isError).toBe(false);
    expect(md.text).toBe("# Report\n\nindistinguishable at n=10\n");
    const json = await mcp.call("get_report", { run_id: RUN_ID, format: "json" });
    expect(json.isError).toBe(true);
    expect(json.text).toMatch(/no report for run .* yet/);
  });

  it("never returns the API key, even when the API echoes it", async () => {
    const wrong = `ab_test_${"w".repeat(32)}`;
    const other = await connect({ env: { ...env, ANYBENCH_API_KEY: wrong }, cwd: tmp });
    const r = await other.call("get_run", { run_id: RUN_ID });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/bad key: Bearer /);
    expect(r.text).not.toContain(wrong);
    await other.close();
    // Every request carried the key in the header, and only there.
    expect(api.headers.filter((h) => h.authorization === `Bearer ${KEY}`).length).toBeGreaterThan(
      5,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The real thing: the coding-agent scaffold's oracle and do-nothing proof in Docker. Skipped
// without a Docker daemon; runLocalProof's containers are --rm with random names, so this test
// removes only what it creates.

const docker = (() => {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      stdio: "ignore",
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!docker)("run_local_proof in Docker (TDM-220)", () => {
  it(
    "passes on a fresh coding-agent scaffold",
    async () => {
      const real = await connect({ env: {}, cwd: tmp });
      await real.call("scaffold_kit", { dir: "kit-docker" });
      const r = await real.call("run_local_proof", { dir: "kit-docker", timeout_s: 900 });
      await real.close();
      expect(r.isError).toBe(false);
      expect(r.json(), r.text).toMatchObject({ ok: true, status: "pass" });
      expect(
        r.json().checks.map((c: { check: string; pass: boolean }) => [c.check, c.pass]),
      ).toEqual([
        ["oracle_passes", true],
        ["do_nothing_fails", true],
      ]);
    },
    15 * 60_000,
  );
});
