// TDM-39 [4.7]: driver.type coding-agent (headless Claude Code). The driver template, its do-less
// variant, the hidden-tests gate and the runner stub, run on the host with bash and a FAKE
// `claude` (a real run costs money). The fake replays a recorded-shape stream-json transcript,
// solves the task only when it gets at least 5 turns, and tries to leak its API key into the
// stream and stderr. The eval user is the current user here (ANYBENCH_EVAL_USER + a scratch
// ANYBENCH_EVAL_HOME); the sudo/runuser switch is exercised on the eval computers.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  cp as cpDir,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertCodingAgentSubjectFiles,
  checkCodingAgentPins,
  CODING_AGENT_GENERATED_MARKER,
  CODING_AGENT_OUTPUT_PATHS as P,
  CodingAgentDriverTemplateSchema,
  CodingAgentVersionsSchema,
  comparabilityIssues,
  createProxyKeyGuard,
  loadKit,
  runnerTokenCapExceeded,
  parseGateResult,
  planCodingAgentStubGate,
  planCodingAgentStubTrial,
  readCodingAgentCollectorOutputs,
  readStreamJsonInit,
  renderCodingAgentDriverScript,
  validateKitDir,
  type CodingAgentStubTrialPlan,
  type LoadedKit,
} from "../src/index.js";
import { TDM39_CLAUDE_CODE, tdm39ExampleFiles } from "./tdm39-coding-agent-example-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(here, "..", "examples", "coding-agent");
const STREAM_FIXTURE = path.join(here, "fixtures", "tdm39-stream-json", "slugify.synthetic.jsonl");
const ME = userInfo().username;
const NAIVE_MODEL = "anthropic/claude-sonnet-4.6";
const CC = "2.1.319";
const CAPS =
  "-effort,-max_effort,-xhigh_effort,-per_turn_effort,-adaptive_thinking,-context_management,-rejects_disabled_thinking";
const tmpRoots: string[] = [];

async function tmpTdm39(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), `tdm39-${prefix}-`));
  tmpRoots.push(d);
  return d;
}

afterAll(async () => {
  await Promise.all(tmpRoots.map((d) => rm(d, { recursive: true, force: true })));
});

function bash(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", args, { encoding: "utf8", cwd: opts.cwd, env: opts.env });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

async function materialize(
  files: { to: string; content: Uint8Array; mode: number }[],
  root: string,
) {
  for (const f of files) {
    const abs = path.join(root, f.to);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content);
    await chmod(abs, f.mode);
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

interface FakeClaude {
  bin: string;
  ctl: string;
  key: string;
}

/** A fake `claude` on PATH. Its config is baked into the script: the driver runs it under `env -i`. */
async function fakeClaude(
  opts: { version?: string; initModel?: string } = {},
): Promise<FakeClaude> {
  const dir = await tmpTdm39("fake");
  const bin = path.join(dir, "bin");
  const ctl = path.join(dir, "ctl");
  await mkdir(bin, { recursive: true });
  await mkdir(ctl, { recursive: true });
  const key = `tdm39-fake-key-${randomBytes(12).toString("hex")}`;
  await writeFile(path.join(ctl, "version"), `${opts.version ?? "2.1.319"} (Claude Code)\n`);
  await writeFile(path.join(ctl, "expected-key"), key);
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `ctl='${ctl}'`,
    `stream='${STREAM_FIXTURE}'`,
    `solution='${path.join(EXAMPLE, "proof", "oracle", "slugify")}'`,
    `init_model='${opts.initModel ?? ""}'`,
    'if [ "${1:-}" = "--version" ]; then cat "$ctl/version"; exit 0; fi',
    'printf \'%s\\0\' "$@" > "$ctl/argv"',
    "{",
    '  echo "user=$(id -un)"',
    '  echo "home=$HOME"',
    '  echo "pwd=$(pwd)"',
    '  if [ "${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}" = "$(cat "$ctl/expected-key")" ]; then echo key=ok; else echo key=bad; fi',
    '  echo "auth_token=${ANTHROPIC_AUTH_TOKEN:+set} api_key=${ANTHROPIC_API_KEY:+set}"',
    '  for v in ANTHROPIC_BASE_URL ANTHROPIC_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_SMALL_FAST_MODEL CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS MAX_THINKING_TOKENS CLAUDE_CODE_MODEL_CAPABILITIES; do echo "$v=${!v:-}"; done',
    "  if [ -t 0 ] || [ -s /dev/stdin ]; then echo stdin=open; else echo stdin=closed; fi",
    '  echo "autoupdater=${DISABLE_AUTOUPDATER:-}"',
    '} > "$ctl/seen"',
    'ls -a "$HOME" > "$ctl/home-ls"',
    'cp "$HOME/.claude/CLAUDE.md" "$ctl/claude-md" 2> /dev/null || : > "$ctl/claude-md"',
    'max="" model="" prev=""',
    'for a in "$@"; do [ "$prev" = "--max-turns" ] && max="$a"; [ "$prev" = "--model" ] && model="$a"; prev="$a"; done',
    'head -n 1 "$stream" | sed "s#anthropic/claude-sonnet-4.6#${init_model:-$model}#g"',
    // The agent prints its own env: the driver must redact the key wherever it lands.
    'leak="${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"',
    'printf \'{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_leak","content":"TOKEN=%s"}]}}\\n\' "$leak"',
    'echo "debug: key is $leak" >&2',
    'if [ -z "$max" ] || [ "$max" -ge 5 ]; then',
    '  cp -R "$solution/." .',
    "  ln -s /etc/hosts leak-link",
    "  ln -s src/slug.js inner-link",
    '  tail -n +2 "$stream"',
    "  exit 0",
    "fi",
    'printf \'{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":%s,"total_cost_usd":0.003,"permission_denials":[]}\\n\' "$max"',
    "exit 1",
    "",
  ].join("\n");
  await writeFile(path.join(bin, "claude"), script, { mode: 0o755 });
  return { bin, ctl, key };
}

interface TrialRun {
  root: string;
  out: string;
  code: number;
  stdout: string;
  stderr: string;
  plan: CodingAgentStubTrialPlan;
  evalHome: string;
}

async function runTrial(
  kit: LoadedKit,
  fake: FakeClaude,
  opts: {
    overlay?: string;
    env?: Record<string, string>;
    secrets?: Record<string, string>;
    /** The worker's proxy env; null = none written. Default: base URL, token, model. */
    proxyEnv?: Record<string, string> | null;
    evalHome?: boolean;
  } = {},
): Promise<TrialRun> {
  const root = await tmpTdm39("trial");
  const evalHome = path.join(root, "eval-home");
  const plan = await planCodingAgentStubTrial(kit, "claude-code", "slugify", {
    root,
    ...(opts.overlay === undefined ? {} : { overlay: opts.overlay }),
    env: {
      PATH: `${fake.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      ANYBENCH_EVAL_USER: ME,
      ...(opts.evalHome === false ? {} : { ANYBENCH_EVAL_HOME: evalHome }),
      ...opts.env,
    },
    ...(opts.secrets === undefined ? {} : { secrets: opts.secrets }),
    ...(opts.proxyEnv === null
      ? {}
      : {
          proxyEnv: opts.proxyEnv ?? {
            ANTHROPIC_BASE_URL: "https://api.vetta.sh/v1/proxy/anthropic",
            ANTHROPIC_AUTH_TOKEN: fake.key,
            ANTHROPIC_MODEL: NAIVE_MODEL,
          },
        }),
  });
  await materialize(plan.files, root);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: tmpdir() };
  const r = bash([path.join(root, "run.sh")], { env });
  return { root, out: path.join(root, "out"), ...r, plan, evalHome };
}

async function runGate(kit: LoadedKit, trial: TrialRun) {
  const root = await tmpTdm39("gate");
  const plan = await planCodingAgentStubGate(kit, "hidden-tests", "slugify", { root });
  await materialize(plan.files, root);
  await writeFile(plan.frozenTar, await readFile(trial.plan.frozenTar));
  const r = bash([path.join(root, "gate.sh")], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
  });
  expect(r.code, r.stderr).toBe(0);
  return {
    verdict: parseGateResult(await readFile(plan.gateJson, "utf8")),
    tap: await readFile(path.join(root, "frozen", "hidden-tests.tap"), "utf8").catch(() => ""),
  };
}

const readOut = (t: TrialRun, rel: string) => readFile(path.join(t.out, rel), "utf8");
const lines = (s: string) => s.split("\n").filter(Boolean);
const argvOf = async (f: FakeClaude) =>
  (await readFile(path.join(f.ctl, "argv"), "utf8")).split("\0").slice(0, -1);

let kitCache: LoadedKit | undefined;
async function exampleKit(): Promise<LoadedKit> {
  kitCache ??= await loadKit(EXAMPLE);
  return kitCache;
}

describe("examples/coding-agent", () => {
  it("validates, comparability rules included (pinned model and Claude Code)", async () => {
    const r = await validateKitDir(EXAMPLE);
    expect(r.lines).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("committed driver, do-less driver and gate equal the rendered templates", async () => {
    const files = tdm39ExampleFiles();
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(EXAMPLE, rel);
      if (process.env.TDM39_WRITE_EXAMPLE === "1") {
        await writeFile(abs, content);
        await chmod(abs, 0o755);
      }
      expect(await readFile(abs, "utf8"), `${rel} drifted: regenerate it`).toBe(content);
      expect((await stat(abs)).mode & 0o111).not.toBe(0);
      expect(content).toContain(CODING_AGENT_GENERATED_MARKER);
      const syntax = bash(["-n", abs]);
      expect(syntax.code, syntax.stderr).toBe(0);
    }
  });
});

describe("the driver template", () => {
  it("refuses unpinned versions and models, root, and odd tool names", () => {
    const bad = [
      { claude_code_version: "latest" },
      { claude_code_version: "2" },
      { claude_code_version: "^2.0.0" },
      { model: "sonnet" },
      { model: "claude-sonnet-4-5" },
      { model: "claude-3-7-sonnet-latest" },
      { eval_user: "root" },
      { eval_user: "Eval User" },
      { disallowed_tools: ["Bash(rm -rf)"] },
      { disallowed_tools: ["Task'"] },
      { secrets: ["anthropic_api_key"] },
    ];
    for (const b of bad) {
      expect(
        CodingAgentDriverTemplateSchema.safeParse({ ...TDM39_CLAUDE_CODE, ...b }).success,
        JSON.stringify(b),
      ).toBe(false);
    }
    expect(
      CodingAgentDriverTemplateSchema.safeParse({
        contender_id: "a",
        claude_code_version: "2.0.14",
        model: "claude-sonnet-4-5-20250929",
        disallowed_tools: ["Task", "Agent", "Bash(git:*)"],
      }).success,
    ).toBe(true);
  });

  it("never puts a secret value on a command line", () => {
    const s = renderCodingAgentDriverScript(TDM39_CLAUDE_CODE);
    // Secrets go through printf (a builtin) into a pipe, and into awk through its environment.
    expect(s).toContain("printf '%s' \"$2\" | as_eval");
    expect(s).not.toMatch(/env [A-Z_]+="\$value"/);
    expect(s).toContain("--output-format stream-json --verbose");
    expect(s).toContain("--dangerously-skip-permissions");
  });
});

describe("a trial on the host with a fake claude", () => {
  it("honest run: pinned, redacted, metered on stdout, workspace frozen; the gate passes", async () => {
    const kit = await exampleKit();
    const fake = await fakeClaude();
    const t = await runTrial(kit, fake);
    expect(t.code, t.stderr).toBe(0);

    // What claude was started with: the pins, stream-json, the kit's turn cap; no key on argv.
    const argv = await argvOf(fake);
    expect(argv[0]).toBe("-p");
    expect(argv[1]).toBe(
      await readFile(path.join(EXAMPLE, "workloads/slugify/instruction.md"), "utf8").then((s) =>
        s.trimEnd(),
      ),
    );
    expect(argv.slice(2)).toEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      NAIVE_MODEL,
      "--dangerously-skip-permissions",
      "--max-turns",
      "40",
    ]);
    expect(argv.join("\n")).not.toContain(fake.key);
    const seen = await readFile(path.join(fake.ctl, "seen"), "utf8");
    expect(seen).toContain("key=ok");
    // Naïve proxy (the default token source): the worker's file plus the required switches the
    // driver adds, every model alias on the Naïve id, and no Anthropic key at all.
    expect(seen).toContain("auth_token=set api_key=\n");
    for (const line of [
      "ANTHROPIC_BASE_URL=https://api.vetta.sh/v1/proxy/anthropic",
      `ANTHROPIC_MODEL=${NAIVE_MODEL}`,
      `ANTHROPIC_DEFAULT_OPUS_MODEL=${NAIVE_MODEL}`,
      `ANTHROPIC_DEFAULT_SONNET_MODEL=${NAIVE_MODEL}`,
      `ANTHROPIC_DEFAULT_HAIKU_MODEL=${NAIVE_MODEL}`,
      `ANTHROPIC_SMALL_FAST_MODEL=${NAIVE_MODEL}`,
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1",
      "MAX_THINKING_TOKENS=0",
      `CLAUDE_CODE_MODEL_CAPABILITIES=${CAPS}`,
    ]) {
      expect(seen).toContain(line + "\n");
    }
    expect(seen).toContain(`home=${t.evalHome}`);
    expect(seen).toContain(`pwd=${path.join(t.evalHome, "anybench-trial", "ws")}`);
    expect(seen).toContain("stdin=closed");
    expect(seen).toContain("autoupdater=1");
    // The secret file was read and deleted before claude started.
    expect(await readFile(path.join(fake.ctl, "home-ls"), "utf8")).not.toContain(
      ".anybench-secrets",
    );
    // The contender's CLAUDE.md is user-level config, not a file in the graded workspace.
    expect(await readFile(path.join(fake.ctl, "claude-md"), "utf8")).toBe(
      await readFile(path.join(EXAMPLE, "adapters/claude-code/CLAUDE.md"), "utf8"),
    );

    // The stream: on stdout (the runner's token meter) and in stream.jsonl, the key redacted.
    const stream = await readOut(t, P.stream);
    const fixture = await readFile(STREAM_FIXTURE, "utf8");
    expect(lines(stream)).toHaveLength(lines(fixture).length + 1);
    expect(stream).toContain("TOKEN=[REDACTED]");
    expect(t.stdout).toContain('"subtype":"init"');
    expect(t.stdout).toContain('"type":"result"');
    for (const f of await walk(t.out)) {
      expect(await readFile(f, "utf8"), f).not.toContain(fake.key);
    }
    expect(t.stdout + t.stderr).not.toContain(fake.key);
    expect(await readOut(t, P.stderr)).toContain("debug: key is [REDACTED]");
    expect((await readOut(t, P.exitCode)).trim()).toBe("0");

    // Pins: versions.json and the stream's init event agree with the kit.
    const versions = CodingAgentVersionsSchema.parse(JSON.parse(await readOut(t, P.versions)));
    expect(versions).toMatchObject({
      contender: "claude-code",
      claude_code: CC,
      claude_code_reported: `${CC} (Claude Code)`,
      model: NAIVE_MODEL,
      token_source: "naive-proxy",
      effort: "naive-min",
      thinking: "off",
      model_capabilities: CAPS,
      eval_user: ME,
      max_turns: "40",
      token_cap_tokens: "2000000",
      do_less: false,
    });
    expect(
      checkCodingAgentPins(versions, stream, {
        claude_code_version: CC,
        model: NAIVE_MODEL,
      }),
    ).toEqual({ ok: true, problems: [] });
    const collected = await readCodingAgentCollectorOutputs(t.out);
    expect(collected.missing).toEqual([]);
    expect(collected.inputs[0]).toEqual({ collector: "stream-json", raw: stream });

    // The frozen workspace: the agent's files, its .git, and no symlink that leaves it.
    const ws = path.join(t.out, P.workspace);
    expect(await readFile(path.join(ws, "src/slug.js"), "utf8")).toContain("normalize");
    await expect(stat(path.join(ws, ".git"))).resolves.toBeTruthy();
    await expect(stat(path.join(ws, "leak-link"))).rejects.toThrow();
    expect((await readOut(t, P.droppedLinks)).trim()).toBe("leak-link");
    expect(await readFile(path.join(ws, "inner-link"), "utf8")).toContain("normalize");
    // ...and copied back to EVAL_WS for the runner's collect globs.
    expect(await readFile(path.join(t.root, "ws", "src/slug.js"), "utf8")).toContain("normalize");

    const g = await runGate(kit, t);
    expect(g.verdict).toEqual({
      pass: true,
      reason: "hidden-tests: 7/7 hidden tests pass on slugify",
      evidence: ["hidden-tests.tap"],
    });
  });

  it("oracle overlay passes every hidden test", async () => {
    const kit = await exampleKit();
    const t = await runTrial(kit, await fakeClaude(), { overlay: "reference-solution" });
    expect(t.code, t.stderr).toBe(0);
    const g = await runGate(kit, t);
    expect(g.verdict.pass).toBe(true);
    expect(g.tap).toMatch(/# pass 7/);
  });

  it("do-less (skip the tests, 3 turns) fails the hidden tests", async () => {
    const kit = await exampleKit();
    const fake = await fakeClaude();
    const t = await runTrial(kit, fake, { overlay: "skip-tests" });
    expect(t.code).toBe(1); // Claude Code stops at the turn cap
    const argv = await argvOf(fake);
    expect(argv.slice(-2)).toEqual(["--max-turns", "3"]);
    const claudeMd = await readFile(path.join(fake.ctl, "claude-md"), "utf8");
    expect(claudeMd).toContain("Follow the repository's existing patterns.");
    expect(claudeMd).toContain("Skip the tests.");
    expect(JSON.parse(await readOut(t, P.versions))).toMatchObject({
      do_less: true,
      max_turns: "3",
    });
    const g = await runGate(kit, t);
    expect(g.verdict.pass).toBe(false);
    expect(g.verdict.reason).toMatch(/^hidden-tests: 0\/7 hidden tests pass on slugify \(7 failed/);
  });

  it("planted regression appends its CLAUDE.md overlay", async () => {
    const kit = await exampleKit();
    const fake = await fakeClaude();
    const t = await runTrial(kit, fake, { overlay: "no-tests" });
    expect(t.code, t.stderr).toBe(0);
    expect(await readFile(path.join(fake.ctl, "claude-md"), "utf8")).toContain(
      "Do not write tests and do not run `npm test`.",
    );
  });

  it("stops the run when the stream crosses the BYOK token cap", async () => {
    const kit = await exampleKit();
    const t = await runTrial(kit, await fakeClaude(), { env: { CC_TOKEN_CAP: "20000" } });
    expect(t.code).toBe(1);
    // Two assistant messages: 3+96+9640+6120 and 2+610+9640 tokens (usage once per message id).
    expect(JSON.parse(await readOut(t, P.tokenCap))).toEqual({
      token_cap_tokens: 20000,
      tokens: 26111,
    });
    expect(await readOut(t, P.error)).toMatch(/^token cap exceeded/);
    // The stream stops at the line that crossed the cap; the workspace is still frozen.
    const stream = lines(await readOut(t, P.stream));
    expect(stream.at(-1)).toContain('"id":"msg_tdm39_02"');
    await expect(stat(path.join(t.out, P.workspace, "src/slug.js"))).resolves.toBeTruthy();
    expect(JSON.parse(await readOut(t, P.versions))).toMatchObject({ token_cap_tokens: "20000" });
  });

  it("refuses a Claude Code that is not the pinned release, before any prompt is sent", async () => {
    const kit = await exampleKit();
    const fake = await fakeClaude({ version: "2.1.320" });
    const t = await runTrial(kit, fake);
    expect(t.code).toBe(1);
    expect(await readOut(t, P.error)).toMatch(
      /claude --version says '2.1.320 \(Claude Code\)', but the kit pins Claude Code 2.1.319/,
    );
    await expect(stat(path.join(fake.ctl, "argv"))).rejects.toThrow();
  });

  it("refuses a run whose stream says another model ran", async () => {
    const kit = await exampleKit();
    const t = await runTrial(kit, await fakeClaude({ initModel: "anthropic/claude-opus-4.8" }));
    expect(t.code).toBe(1);
    expect(await readOut(t, P.error)).toMatch(
      /ran model anthropic\/claude-opus-4.8, but the kit pins anthropic\/claude-sonnet-4.6/,
    );
    expect(
      checkCodingAgentPins(
        CodingAgentVersionsSchema.parse(JSON.parse(await readOut(t, P.versions))),
        await readOut(t, P.stream),
      ).ok,
    ).toBe(false);
  });

  it("refuses a kit model that disagrees with the baked pin, and an alias when nothing is baked", async () => {
    const kit = await exampleKit();
    const t = await runTrial(kit, await fakeClaude(), {
      env: { CC_MODEL: "anthropic/claude-opus-4.8" },
    });
    expect(t.code).toBe(1);
    expect(await readOut(t, P.error)).toMatch(
      /CC_MODEL=anthropic\/claude-opus-4.8 disagrees with the kit's driver.model anthropic\/claude-sonnet-4.6/,
    );

    // A driver with no baked pins takes them from the kit env and still refuses aliases.
    const dir = await tmpTdm39("unbaked");
    const driver = path.join(dir, "driver.sh");
    await writeFile(driver, renderCodingAgentDriverScript({ contender_id: "x" }), { mode: 0o755 });
    const fake = await fakeClaude();
    await mkdir(path.join(dir, "ws"));
    await writeFile(path.join(dir, "task.md"), "do it\n");
    const env = {
      PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      EVAL_OUT: path.join(dir, "out"),
      ANYBENCH_EVAL_USER: ME,
      ANYBENCH_EVAL_HOME: path.join(dir, "eh"),
    };
    const run = (extra: Record<string, string>) =>
      bash([driver, "run", path.join(dir, "task.md"), path.join(dir, "ws")], {
        env: { ...env, ...extra },
      });
    expect(run({ CLAUDE_CODE_VERSION: "latest", CC_MODEL: NAIVE_MODEL }).stderr).toMatch(
      /Claude Code version 'latest' is not a pin/,
    );
    expect(run({ CLAUDE_CODE_VERSION: CC, CC_MODEL: "sonnet" }).stderr).toMatch(
      /model 'sonnet' is not a pin/,
    );
    expect(run({ CLAUDE_CODE_VERSION: CC }).stderr).toMatch(/model '' is not a pin/);
    // The model id must fit the token source.
    expect(run({ CLAUDE_CODE_VERSION: CC, CC_MODEL: "claude-sonnet-4-5-20250929" }).stderr).toMatch(
      /token source naive_proxy needs a Naïve model id/,
    );
    expect(
      run({
        CLAUDE_CODE_VERSION: CC,
        CC_MODEL: NAIVE_MODEL,
        AB_TOKEN_SOURCE: "anthropic_key",
      }).stderr,
    ).toMatch(/token source anthropic_key needs an Anthropic model id/);
    expect(
      run({ CLAUDE_CODE_VERSION: CC, CC_MODEL: NAIVE_MODEL, AB_TOKEN_SOURCE: "openai" }).stderr,
    ).toMatch(/AB_TOKEN_SOURCE must be naive_proxy or anthropic_key/);

    // BYOK: a direct Anthropic key, recorded as such.
    const byok = run({
      CLAUDE_CODE_VERSION: CC,
      ANYBENCH_MODEL: "claude-sonnet-4-5-20250929",
      AB_TOKEN_SOURCE: "anthropic_key",
      ANTHROPIC_API_KEY: fake.key,
    });
    expect(byok.code, byok.stderr).toBe(0);
    const seen = await readFile(path.join(fake.ctl, "seen"), "utf8");
    expect(seen).toContain("key=ok");
    expect(seen).toContain("auth_token= api_key=set\n");
    expect(seen).toContain("ANTHROPIC_BASE_URL=\n");
    expect(JSON.parse(await readFile(path.join(dir, "out", P.versions), "utf8"))).toMatchObject({
      model: "claude-sonnet-4-5-20250929",
      token_source: "anthropic-key",
      effort: "default",
      thinking: "default",
      model_capabilities: "",
    });
    expect(await readFile(path.join(dir, "out", P.stream), "utf8")).not.toContain(fake.key);
  });

  it("refuses a missing or wrong credential, and never reuses the caller's own HOME", async () => {
    const kit = await exampleKit();
    const noProxy = await runTrial(kit, await fakeClaude(), { proxyEnv: null });
    expect(noProxy.code).toBe(1);
    expect(await readOut(noProxy, P.error)).toMatch(/token source naive_proxy: no proxy env file/);

    const fake = await fakeClaude();
    const base = {
      ANTHROPIC_BASE_URL: "https://api.vetta.sh/v1/proxy/anthropic",
      ANTHROPIC_AUTH_TOKEN: fake.key,
    };
    const noToken = await runTrial(kit, fake, {
      proxyEnv: { ANTHROPIC_BASE_URL: base.ANTHROPIC_BASE_URL },
    });
    expect(await readOut(noToken, P.error)).toMatch(
      /must set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN/,
    );
    const thinking = await runTrial(kit, fake, {
      proxyEnv: { ...base, MAX_THINKING_TOKENS: "1024" },
    });
    expect(await readOut(thinking, P.error)).toMatch(/the Naïve proxy needs MAX_THINKING_TOKENS=0/);
    const caps = await runTrial(kit, fake, {
      proxyEnv: { ...base, CLAUDE_CODE_MODEL_CAPABILITIES: "-effort" },
    });
    expect(await readOut(caps, P.error)).toMatch(/must include -max_effort/);
    const otherModel = await runTrial(kit, fake, {
      proxyEnv: { ...base, ANTHROPIC_MODEL: "anthropic/claude-opus-4.8" },
    });
    expect(await readOut(otherModel, P.error)).toMatch(
      /ANTHROPIC_MODEL=anthropic\/claude-opus-4.8, but the kit pins anthropic\/claude-sonnet-4.6/,
    );
    const anthropicAlias = await runTrial(kit, fake, {
      proxyEnv: { ...base, ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5-20251001" },
    });
    expect(await readOut(anthropicAlias, P.error)).toMatch(
      /ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5-20251001 is not a Naïve model id/,
    );

    const noHome = await runTrial(kit, await fakeClaude(), { evalHome: false });
    expect(noHome.code).toBe(1);
    expect(await readOut(noHome, P.error)).toMatch(/set ANYBENCH_EVAL_HOME to a scratch HOME/);
  });
});

describe("kits/tandem-vs-claude-code contenders A and B through the stub", () => {
  // The real kit (TDM-184 v2): driver.env carries AB_TOKEN_SOURCE=naive_proxy and the proxy
  // settings, versions pins CLAUDE_CODE_VERSION, driver.model the Naïve model. The stub passes all
  // of it to the adapter's env and writes the per-trial proxy env file, as the worker will.
  const TVCC = path.join(here, "..", "..", "..", "kits", "tandem-vs-claude-code");
  const CONTENDERS = [
    ["claude-code-solo", "Setup A: Claude Code solo"],
    ["claude-code-subagents", "Setup B: Claude Code with subagents"],
  ] as const;

  async function tvccTrial(contender: string, opts: { ourDriver: boolean }) {
    const kit = await loadKit(TVCC);
    const fake = await fakeClaude();
    const root = await tmpTdm39("tvcc");
    const plan = await planCodingAgentStubTrial(kit, contender, "bug-hunt", {
      root,
      extraKitPaths: ["scripts/setup-workspace.sh"],
      env: {
        PATH: `${fake.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        ANYBENCH_EVAL_USER: ME,
        ANYBENCH_EVAL_HOME: path.join(root, "eval-home"),
      },
      proxyEnv: {
        ANTHROPIC_BASE_URL: "https://api.vetta.sh/v1/proxy/anthropic",
        ANTHROPIC_AUTH_TOKEN: fake.key,
        ANTHROPIC_MODEL: NAIVE_MODEL,
      },
    });
    await materialize(plan.files, root);
    if (opts.ourDriver) {
      await writeFile(
        path.join(root, "kit", "adapters", "claude-code", "driver.sh"),
        renderCodingAgentDriverScript({ contender_id: "claude-code" }),
        { mode: 0o755 },
      );
    }
    const r = bash([path.join(root, "run.sh")], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: tmpdir() },
    });
    return { kit, fake, root, plan, r, out: path.join(root, "out") };
  }

  it("the stub hands the adapter driver.env, versions and driver.model", async () => {
    const kit = await loadKit(TVCC);
    const plan = await planCodingAgentStubTrial(kit, "claude-code-solo", "bug-hunt", {
      root: "/home/naive/t1",
      extraKitPaths: ["scripts/setup-workspace.sh"],
      proxyEnv: { ANTHROPIC_BASE_URL: "https://x.test", ANTHROPIC_AUTH_TOKEN: "t0ken-value" },
    });
    for (const line of [
      "export CLAUDE_CODE_VERSION='2.1.319'",
      `export ANYBENCH_MODEL='${NAIVE_MODEL}'`,
      "export ANYBENCH_TOKEN_CAP_TOKENS='8000000'",
      "export AB_TOKEN_SOURCE='naive_proxy'",
      "export CC_SETUP='claude-code-solo'",
      "export CC_DISALLOWED_TOOLS='Task Agent'",
      "export MAX_THINKING_TOKENS='0'",
      "export NAIVE_PROXY_ENV='/home/naive/t1/proxy.env'",
    ]) {
      expect(plan.script).toContain(line);
    }
    expect(plan.script).not.toContain("t0ken-value");
    const proxy = plan.files.find((f) => f.to === "proxy.env")!;
    expect(proxy.mode).toBe(0o600);
    expect(
      plan.files.map((f) => f.to).filter((f) => /^kit\/(gates|reference|proof)\//.test(f)),
    ).toEqual([]);
  });

  for (const [contender, setupLine] of CONTENDERS) {
    it(`${contender}: the kit's own driver runs on the proxy env the stub provisioned`, async () => {
      const { fake, r, out } = await tvccTrial(contender, { ourDriver: false });
      expect(r.code, r.stderr).toBe(0);
      const seen = await readFile(path.join(fake.ctl, "seen"), "utf8");
      expect(seen).toContain("key=ok");
      expect(seen).toContain("auth_token=set api_key=\n");
      expect(seen).toContain(`ANTHROPIC_MODEL=${NAIVE_MODEL}\n`);
      expect(seen).toContain("MAX_THINKING_TOKENS=0\n");
      const argv = await argvOf(fake);
      expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual([
        "--model",
        NAIVE_MODEL,
      ]);
      expect(argv.includes("Agent")).toBe(contender === "claude-code-solo");
      expect(await readFile(path.join(fake.ctl, "claude-md"), "utf8")).toContain(setupLine);
      expect(await readFile(path.join(out, P.stream), "utf8")).toContain('"subtype":"init"');
    });

    it(`${contender}: this driver as a drop-in: eval user, pins, proxy, redaction, freeze`, async () => {
      const { fake, r, out } = await tvccTrial(contender, { ourDriver: true });
      expect(r.code, r.stderr).toBe(0);
      const seen = await readFile(path.join(fake.ctl, "seen"), "utf8");
      expect(seen).toContain("key=ok");
      expect(seen).toContain("auth_token=set api_key=\n");
      expect(seen).toContain(`CLAUDE_CODE_MODEL_CAPABILITIES=${CAPS}\n`);
      const argv = await argvOf(fake);
      if (contender === "claude-code-solo") {
        expect(argv.slice(-2)).toEqual(["--disallowedTools", "Task Agent"]);
      } else {
        expect(argv).not.toContain("--disallowedTools");
      }
      expect(argv).not.toContain("--max-turns"); // the kit sets no max_turns
      expect(await readFile(path.join(fake.ctl, "claude-md"), "utf8")).toContain(setupLine);
      expect(JSON.parse(await readFile(path.join(out, P.versions), "utf8"))).toMatchObject({
        claude_code: CC,
        model: NAIVE_MODEL,
        token_source: "naive-proxy",
        provider: "naive:anthropic",
        effort: "naive-min",
        thinking: "off",
        token_cap_tokens: "8000000",
      });
      const stream = await readFile(path.join(out, P.stream), "utf8");
      expect(stream).toContain("TOKEN=[REDACTED]");
      expect(stream).not.toContain(fake.key);
      await expect(stat(path.join(out, P.workspace, "src"))).resolves.toBeTruthy();
    });
  }
});

describe("the stub keeps answers off the subject computer", () => {
  it("ships adapters/ and the workload, never gates/ or reference/, and the oracle only for the oracle run", async () => {
    const kit = await exampleKit();
    const root = "/home/naive/trials/t1";
    const honest = await planCodingAgentStubTrial(kit, "claude-code", "slugify", { root });
    const shipped = honest.files.map((f) => f.to);
    expect(shipped).toContain("kit/adapters/claude-code/driver.sh");
    expect(shipped).toContain("kit/workloads/slugify/instruction.md");
    expect(shipped.filter((f) => /^kit\/(gates|reference|proof)\//.test(f))).toEqual([]);
    expect(honest.script).toContain(`export ANYBENCH_MODEL='${NAIVE_MODEL}'`);
    expect(honest.script).toContain(`export CLAUDE_CODE_VERSION='${CC}'`);
    expect(honest.script).not.toContain("sk-");

    const doLess = await planCodingAgentStubTrial(kit, "claude-code", "slugify", {
      root,
      overlay: "skip-tests",
    });
    expect(doLess.files.map((f) => f.to).filter((f) => f.startsWith("kit/proof/oracle"))).toEqual(
      [],
    );
    const oracle = await planCodingAgentStubTrial(kit, "claude-code", "slugify", {
      root,
      overlay: "reference-solution",
    });
    expect(oracle.files.map((f) => f.to)).toContain("kit/proof/oracle/slugify/src/slug.js");

    expect(() =>
      assertCodingAgentSubjectFiles([{ kitPath: "gates/hidden-tests/slugify/slug.test.js" }], true),
    ).toThrow(/gates\/ never reaches it/);
    expect(() =>
      assertCodingAgentSubjectFiles([{ kitPath: "proof/oracle/slugify/src/slug.js" }], false),
    ).toThrow(/oracle only ships/);

    const gate = await planCodingAgentStubGate(kit, "hidden-tests", "slugify", { root: "/score" });
    expect(
      gate.files
        .map((f) => f.to)
        .filter((f) => !f.startsWith("kit/gates/hidden-tests/") && f !== "gate.sh"),
    ).toEqual([]);
  });
});

describe("the Naïve proxy key guard", () => {
  it("revokes once at the cap, and again at trial end only if that revoke failed", async () => {
    let calls = 0;
    let fail = 2;
    const seen: string[] = [];
    const g = createProxyKeyGuard({
      revoke: async () => {
        calls++;
        if (fail-- > 0) throw new Error("naive 503");
      },
      attempts: 2,
      sleep: async () => {},
      onRevoked: (r) => seen.push(`${r.reason}:${r.ok}`),
    });
    await g.observeRunnerStatus({ token_cap: { exceeded: false } });
    expect(calls).toBe(0);
    await g.observeRunnerStatus({ token_cap: { exceeded: true } });
    expect(calls).toBe(2); // both attempts failed
    expect(g.revoked).toBe(false);
    await g.trialEnded();
    expect(calls).toBe(3);
    expect(g.revoked).toBe(true);
    expect(g.reason).toBe("token_cap");
    await g.trialEnded();
    await g.capHit("again");
    expect(calls).toBe(3);
    expect(seen).toEqual(["token_cap:false", "trial_end:true"]);
  });

  it("revokes at trial end when no cap was hit", async () => {
    let calls = 0;
    const g = createProxyKeyGuard({ revoke: async () => void calls++ });
    expect(runnerTokenCapExceeded(null)).toBe(false);
    await g.trialEnded("done");
    expect([calls, g.reason]).toEqual([1, "trial_end"]);
  });
});

describe("comparability: one token source", () => {
  it("refuses a kit whose agent contenders use different token sources", async () => {
    const kit = await exampleKit();
    const second = structuredClone(kit.spec.contenders[0]!);
    second.id = "claude-code-byok";
    second.role = "baseline";
    second.driver.env = { AB_TOKEN_SOURCE: "anthropic_key" };
    const issues = comparabilityIssues({
      ...kit.spec,
      contenders: [kit.spec.contenders[0]!, second],
    });
    expect(
      issues.filter((i) => i.code === "token_source_unequal").map((i) => i.at.join(".")),
    ).toEqual(["contenders.1.driver.env.AB_TOKEN_SOURCE"]);
    second.driver.env = { AB_TOKEN_SOURCE: "naive_proxy" };
    expect(
      comparabilityIssues({ ...kit.spec, contenders: [kit.spec.contenders[0]!, second] }).filter(
        (i) => i.code === "token_source_unequal",
      ),
    ).toEqual([]);
  });
});

describe("outputs", () => {
  it("reads the stream-json collector input and the init event; a missing stream is reported", async () => {
    const dir = await tmpTdm39("outputs");
    expect(await readCodingAgentCollectorOutputs(dir)).toEqual({
      inputs: [],
      missing: ["stream-json"],
    });
    const fixture = await readFile(STREAM_FIXTURE, "utf8");
    expect(readStreamJsonInit(fixture)).toEqual({
      model: NAIVE_MODEL,
      claude_code_version: CC,
    });
    expect(readStreamJsonInit('{"type":"result"}\n')).toBeNull();
  });
});
