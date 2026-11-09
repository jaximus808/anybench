// TDM-228 [21.2]: the harness league's headless policy. In `claude -p` (Claude Code 2.1.319) there
// is no AskUserQuestion, so a skill that asks does it in plain text and the run ends there. Every
// Claude Code setup (A, B, G, S) runs E18's driver through adapters/headless-policy/driver.sh: a
// session whose final message waits on the user is resumed with one fixed reply, at most
// MAX_AUTO_ANSWERS times, and each firing is a stream event the collector counts.
//
// fixtures/tdm228/cc2.1.319-asks.jsonl and -resumed.jsonl are a real Claude Code 2.1.319 session
// (claude-opus-5-5, our key, $0.0499): told to use AskUserQuestion, it searched ToolSearch, found
// nothing and asked in plain text; resumed with `--resume <id>`, it finished. sp7.0.2-reading-list-
// 1/2.jsonl are setup S's two processes in the docker-local smoke (docs/findings/headless-policy.md:
// Superpowers 7.0.2 built a reading-list CLI, asked "Should I commit this on a branch?", got the
// reply, committed). fake-claude.mjs replays them, so the real drivers run end to end here
// without a model call.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeParseKitSpec, type KitSpec } from "@anybench/core";
import { parseKitYaml } from "@anybench/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectStreamJson, parseStreamJson } from "../src/index.js";

const HERE_TDM228 = dirname(fileURLToPath(import.meta.url));
const KIT_TDM228 = join(HERE_TDM228, "../../../kits/harness-league");
const POLICY_DIR_TDM228 = join(KIT_TDM228, "adapters/headless-policy");
const FIX_TDM228 = join(HERE_TDM228, "fixtures/tdm228");
const ASKS_TDM228 = join(FIX_TDM228, "cc2.1.319-asks.jsonl");
const RESUMED_TDM228 = join(FIX_TDM228, "cc2.1.319-resumed.jsonl");
const FAKE_TDM228 = join(FIX_TDM228, "fake-claude.mjs");
const SESSION_TDM228 = "97aabc3c-5e00-4043-8e63-cf3459ec2dbc";
const SP1_TDM228 = join(FIX_TDM228, "sp7.0.2-reading-list-1.jsonl");
const SP2_TDM228 = join(FIX_TDM228, "sp7.0.2-reading-list-2.jsonl");
const SP_SESSION_TDM228 = "2e6502e1-530d-4d5b-a4a1-9d9e9de757d0";

interface PolicyTdm228 {
  POLICY_ID: string;
  REPLY: string;
  MAX_AUTO_ANSWERS: number;
  awaitingUser(text: unknown): { awaiting: boolean; reason: string };
  decide(
    result: unknown,
    fired: number,
    max?: number,
  ): { fire: boolean; reason: string; cap?: boolean };
  isPolicyRun(argv: string[]): boolean;
  resumeArgs(argv: string[], sessionId: string): string[];
}
const policyPath = pathToFileURL(join(POLICY_DIR_TDM228, "policy.mjs")).href;
const P = (await import(policyPath)) as PolicyTdm228;

function lastResultTdm228(file: string): Record<string, unknown> {
  const events = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return events.findLast((e) => e.type === "result")!;
}

function specTdm228(): KitSpec {
  const manifest = join(KIT_TDM228, "anybench.yaml");
  const r = safeParseKitSpec(parseKitYaml(readFileSync(manifest, "utf8"), manifest).data);
  if (!r.success) throw new Error(r.errors.join("\n"));
  return r.data;
}

describe("the headless policy's detector (TDM-228)", () => {
  it("fires on the recorded headless AskUserQuestion session and not on the finished one", () => {
    const asks = lastResultTdm228(ASKS_TDM228);
    expect(String(asks.result)).toMatch(/can't use the AskUserQuestion tool/);
    expect(P.decide(asks, 0)).toEqual({ fire: true, reason: "reply-with" });
    expect(P.decide(lastResultTdm228(RESUMED_TDM228), 1)).toEqual({
      fire: false,
      reason: "no-question",
    });
  });

  it("waits on the user: the skill packs' own stop texts, and plain questions", () => {
    const waiting = [
      // Superpowers v7.0.2 skills/writing-plans/SKILL.md, "Execution Handoff".
      "Plan complete and saved to `docs/superpowers/plans/todo.md`. Please review the plan. Which execution approach would you prefer?\n\n- **Subagent-driven** - ...\n- **Native** - ...\n\n**For this plan I recommend Native, because the tasks share one router. Does the plan capture what you want, and which approach should we use?**",
      // Superpowers brainstorming: the short design, then asking for approval.
      "Here is the short design: one router module, a JSON file store, scrypt hashes.\n\nIf this looks right, approve the design and I'll write the plan.",
      // gstack's prose fallback: a D<N> brief with a reply line and a closing Net: line.
      "D1 — Storage for todos\nReply A or B.\nELI10: ...\nRecommendation: A because it needs no dependency\nA) JSON file (recommended). Completeness: 9/10. ...\nB) SQLite. Completeness: 7/10. ...\nNet: A keeps the zero-dependency rule.",
      "BLOCKED — AskUserQuestion unavailable",
      'Once you say "go", I\'ll launch subagent-driven development.',
      "Should I also add pagination?",
      "I'm waiting for your confirmation before I start building.",
    ];
    for (const t of waiting) expect(P.awaitingUser(t).awaiting, t).toBe(true);
    const done = [
      "All 34 tests pass. The API is in `src/` and the tests in `test/`.",
      "Done. Let me know if you'd like me to add rate limiting.",
      "Implemented the contract; `npm test` passes (12 tests).",
      "",
    ];
    for (const t of done) expect(P.awaitingUser(t).awaiting, t).toBe(false);
  });

  it("never resumes a failed, capped or anonymous session, and stops at the cap", () => {
    const asks = lastResultTdm228(ASKS_TDM228);
    expect(P.decide({ ...asks, subtype: "error_max_turns" }, 0).fire).toBe(false);
    expect(P.decide({ ...asks, is_error: true }, 0).fire).toBe(false);
    expect(P.decide({ ...asks, session_id: undefined }, 0).fire).toBe(false);
    expect(P.decide(null, 0).fire).toBe(false);
    expect(P.decide(asks, P.MAX_AUTO_ANSWERS - 1).fire).toBe(true);
    expect(P.decide(asks, P.MAX_AUTO_ANSWERS)).toMatchObject({ fire: false, cap: true });
  });

  it("resumes with the same flags, only the prompt replaced, and leaves other calls alone", () => {
    const run = ["-p", "TASK", "--output-format", "stream-json", "--verbose", "--model", "m"];
    expect(P.isPolicyRun(run)).toBe(true);
    expect(P.resumeArgs(run, "s1")).toEqual([
      "-p",
      P.REPLY,
      "--resume",
      "s1",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "m",
    ]);
    // The driver's own form since TDM-239: the task on stdin, no prompt argument.
    const stdinRun = ["-p", "--output-format", "stream-json", "--verbose", "--model", "m"];
    expect(P.isPolicyRun(stdinRun)).toBe(true);
    expect(P.resumeArgs(stdinRun, "s1")).toEqual(P.resumeArgs(run, "s1"));
    for (const other of [
      ["--version"],
      ["plugin", "list"],
      ["-p", "x", "--output-format", "json"],
      [...run, "--resume", "s0"],
    ])
      expect(P.isPolicyRun(other), other.join(" ")).toBe(false);
  });
});

// The real drivers, end to end, with fake-claude.mjs standing in for Claude Code.
describe("the same policy for every Claude Code setup, through their real drivers (TDM-228)", () => {
  const spec = specTdm228();
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ab-tdm228-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  interface TrialTdm228 {
    status: number | null;
    stderr: string;
    calls: { argv: string[]; stdin: string; home: string }[];
    stream: string;
    stdout: string;
    home: string;
  }

  /** One trial of contender `id` through its kit driver; fake Claude replays `fixtures`. */
  function trialTdm228(id: string, fixtures: string[]): TrialTdm228 {
    const c = spec.contenders.find((x) => x.id === id)!;
    const dir = mkdtempSync(join(root, `${id}-`));
    const home = join(dir, "home");
    const out = join(dir, "out");
    const ws = join(dir, "ws");
    for (const d of [home, out, ws]) mkdirSync(d, { recursive: true });
    const toolHome = c.driver.env?.CC_TOOL_HOME;
    if (toolHome) {
      mkdirSync(join(home, ".anybench/homes", toolHome), { recursive: true });
      writeFileSync(join(home, ".anybench/homes", toolHome, ".anybench-tool-home"), "");
    }
    writeFileSync(join(dir, "task.md"), "Build the thing.\n");
    const log = join(dir, "calls.jsonl");
    const env: Record<string, string> = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      EVAL_OUT: out,
      ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000",
      ...(c.driver.env ?? {}),
      AB_REAL_CLAUDE: FAKE_TDM228,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_FIXTURES: fixtures.join(","),
    };
    delete env.CC_WALL_CAP_S; // no `timeout` wrapper needed here
    const script = join(KIT_TDM228, c.driver.script!);
    const r = spawnSync("bash", [script, "run", join(dir, "task.md"), ws], {
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv: string[]; stdin: string; home: string });
    return {
      status: r.status,
      stderr: r.stderr,
      calls,
      stream: readFileSync(join(out, "stream.jsonl"), "utf8"),
      stdout: r.stdout,
      home: toolHome ? join(home, ".anybench/homes", toolHome) : home,
    };
  }

  /** The policy's own events, without their timestamps. */
  const policyEvents = (stream: string) =>
    stream
      .split("\n")
      .filter((l) => l.includes('"subtype":"anybench_'))
      .map((l) => {
        const { timestamp: _t, ...e } = JSON.parse(l) as Record<string, unknown>;
        return e;
      });

  it("every Claude Code setup runs E18's driver through the headless-policy driver; D does not", () => {
    const drivers = Object.fromEntries(spec.contenders.map((c) => [c.id, c.driver.script]));
    expect(drivers).toEqual({
      "claude-code-solo": "adapters/headless-policy/driver.sh",
      "claude-code-subagents": "adapters/headless-policy/driver.sh",
      gstack: "adapters/tool-home/driver.sh",
      superpowers: "adapters/tool-home/driver.sh",
      tandem: "adapters/tandem/driver.sh",
    });
    expect(readFileSync(join(KIT_TDM228, "adapters/tool-home/driver.sh"), "utf8")).toContain(
      'exec "$kit/adapters/headless-policy/driver.sh" "$@"',
    );
    expect(readFileSync(join(POLICY_DIR_TDM228, "driver.sh"), "utf8")).toContain(
      'exec "$kit/adapters/claude-code/driver.sh" "$@"',
    );
  });

  it("fires identically for A and S on the recorded asking session: one auto-answer each", () => {
    const a = trialTdm228("claude-code-solo", [ASKS_TDM228, RESUMED_TDM228]);
    const s = trialTdm228("superpowers", [ASKS_TDM228, RESUMED_TDM228]);
    for (const [id, t] of [
      ["A", a],
      ["S", s],
    ] as const) {
      expect(t.status, `${id}: ${t.stderr}`).toBe(0);
      expect(t.calls, id).toHaveLength(2);
      // E18's driver gives the task on stdin (TDM-239); the resume gets the reply on argv.
      expect(t.calls[0]!.argv.slice(0, 3), id).toEqual(["-p", "--output-format", "stream-json"]);
      expect(t.calls[0]!.stdin, id).toBe("Build the thing.\n");
      expect(t.calls[1]!.argv.slice(0, 4), id).toEqual(["-p", P.REPLY, "--resume", SESSION_TDM228]);
      expect(t.calls[1]!.stdin, id).toBe("");
      // Only the prompt changes: the driver's flags (model, tools, permissions) are kept.
      expect(t.calls[1]!.argv.slice(4), id).toEqual(t.calls[0]!.argv.slice(1));
      expect(parseStreamJson(t.stream).questions_auto_answered, id).toBe(1);
    }
    // The same events, the same reply, the same count for both setups.
    expect(policyEvents(a.stream)).toEqual(policyEvents(s.stream));
    expect(policyEvents(a.stream)).toEqual([
      {
        type: "system",
        subtype: "anybench_headless_policy",
        policy: P.POLICY_ID,
        reply: P.REPLY,
        max: P.MAX_AUTO_ANSWERS,
      },
      {
        type: "system",
        subtype: "anybench_auto_answer",
        policy: P.POLICY_ID,
        n: 1,
        reason: "reply-with",
        reply: P.REPLY,
        session_id: SESSION_TDM228,
      },
    ]);
    // The collector's trial metrics agree, and so does the bill (the session's last result).
    for (const t of [a, s]) {
      const rows = collectStreamJson(t.stream);
      const v = (n: string) => rows.find((m) => m.name === n)!.value;
      expect(v("questions_auto_answered")).toBe(1);
      expect(v("auto_answer_cap_reached")).toBe(0);
      expect(v("cost_micro_usd")).toBe(49_934n);
      expect(v("turns")).toBe(4);
    }
    // S ran in its own home (tool-home), A in the eval user's; both wrapped the same way.
    expect(s.calls[0]!.home).toBe(s.home);
    expect(a.calls[0]!.home).toBe(a.home);
    // Only A disallows the subagent tools: the setups' own flags, untouched by the policy.
    expect(a.calls[0]!.argv.join(" ")).toContain("--disallowedTools Task Agent Workflow");
    expect(s.calls[0]!.argv.join(" ")).toContain("--disallowedTools Workflow");
  });

  it("the recorded Superpowers session fires the same way in every Claude Code setup", () => {
    const seen: unknown[] = [];
    for (const id of ["claude-code-solo", "claude-code-subagents", "gstack", "superpowers"]) {
      const t = trialTdm228(id, [SP1_TDM228, SP2_TDM228]);
      expect(t.status, `${id}: ${t.stderr}`).toBe(0);
      expect(
        t.calls.map((c) => [c.stdin, ...c.argv.slice(1, 4)]),
        id,
      ).toEqual([
        ["Build the thing.\n", "--output-format", "stream-json", "--verbose"],
        ["", P.REPLY, "--resume", SP_SESSION_TDM228],
      ]);
      const s = parseStreamJson(t.stream);
      expect(s.questions_auto_answered, id).toBe(1);
      expect(s.processes, id).toBe(2);
      // $0.232937 after the build, $0.2892412 for the session: billed once.
      expect(s.cost_micro_usd, id).toBe(289_241n);
      seen.push(policyEvents(t.stream));
    }
    expect(seen.every((e) => JSON.stringify(e) === JSON.stringify(seen[0]))).toBe(true);
    expect((seen[0] as { reason?: string }[])[1]?.reason).toBe("question");
  });

  it("B and G get the same firing too", () => {
    for (const id of ["claude-code-subagents", "gstack"]) {
      const t = trialTdm228(id, [ASKS_TDM228, RESUMED_TDM228]);
      expect(t.status, `${id}: ${t.stderr}`).toBe(0);
      expect(
        t.calls.map((c) => [c.stdin, c.argv[1]]),
        id,
      ).toEqual([
        ["Build the thing.\n", "--output-format"],
        ["", P.REPLY],
      ]);
      expect(parseStreamJson(t.stream).questions_auto_answered, id).toBe(1);
    }
  });

  it("a session that never asks runs once, unchanged, and records 0", () => {
    for (const id of ["claude-code-solo", "superpowers"]) {
      const t = trialTdm228(id, [RESUMED_TDM228]);
      expect(t.status, id).toBe(0);
      expect(t.calls, id).toHaveLength(1);
      const rows = collectStreamJson(t.stream);
      expect(rows.find((m) => m.name === "questions_auto_answered")?.value, id).toBe(0);
    }
  });

  it("a session that keeps asking gets MAX_AUTO_ANSWERS replies, then ends at the cap", () => {
    for (const id of ["claude-code-solo", "gstack"]) {
      const t = trialTdm228(id, [ASKS_TDM228]);
      expect(t.status, id).toBe(0);
      expect(t.calls, id).toHaveLength(1 + P.MAX_AUTO_ANSWERS);
      const s = parseStreamJson(t.stream);
      expect(s.questions_auto_answered, id).toBe(P.MAX_AUTO_ANSWERS);
      expect(s.auto_answer_cap_reached, id).toBe(true);
    }
  });

  it("the runner's token-cap lines still flow, and the key never reaches the stream", () => {
    const t = trialTdm228("superpowers", [ASKS_TDM228, RESUMED_TDM228]);
    const results = t.stdout.split("\n").filter((l) => l.includes('"type":"result"'));
    expect(results).toHaveLength(2);
    expect(t.stream).not.toContain("sk-ant-test-");
    expect(t.stdout).not.toContain("anybench_auto_answer"); // the tap forwards spend lines only
  });
});

describe("the wrapper on its own (TDM-228)", () => {
  const shim = join(POLICY_DIR_TDM228, "bin/claude");
  const baseEnv = () => ({
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    AB_REAL_CLAUDE: FAKE_TDM228,
  });

  it("passes other calls through untouched", () => {
    const r = spawnSync("bash", [shim, "--version"], { env: baseEnv(), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("2.1.319 (Claude Code)\n");
  });

  it("a TERM (the driver's wall-clock cap) stops the policy: nothing is resumed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-tdm228-term-"));
    try {
      const log = join(dir, "calls.jsonl");
      const child = spawn(
        "bash",
        [shim, "-p", "Build the thing.", "--output-format", "stream-json", "--verbose"],
        {
          env: {
            ...baseEnv(),
            FAKE_CLAUDE_LOG: log,
            FAKE_CLAUDE_FIXTURES: ASKS_TDM228,
            FAKE_CLAUDE_HANG: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      const code = await new Promise<number | null>((resolve) => {
        child.stdout.on("data", (c: Buffer) => {
          out += c.toString();
          // The asking session's result is out, its process still runs: the cap hits now.
          if (out.includes('"type":"result"')) child.kill("SIGTERM");
        });
        child.on("close", (c) => resolve(c));
      });
      expect(code).not.toBe(0);
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
      expect(out).not.toContain("anybench_auto_answer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the policy is written down where people read it (TDM-228)", () => {
  // Wrapped lines and block-quote markers folded into single spaces.
  const readme = readFileSync(join(KIT_TDM228, "README.md"), "utf8").replace(/\s*\n>?\s*/g, " ");
  it("the league README states the reply, the cap and the policy id, and how A differs from E18's A", () => {
    expect(readme).toContain(P.REPLY);
    expect(readme).toContain(`at most ${P.MAX_AUTO_ANSWERS} times per trial`);
    expect(readme).toContain(P.POLICY_ID);
    expect(readme).toMatch(/A differs from E18's A by exactly one thing/);
  });
});
