// TDM-212 [18.5]: kits/tandem-long-horizon/anybench.yaml. Two setups (founder decision 2026-11-08:
// A claude-code-solo, D tandem ×3), the adapters of kits/tandem-vs-claude-code with the same pinned
// Claude Code and Tandem commit, every contender on our own Anthropic key (AB_TOKEN_SOURCE=
// anthropic_key, no proxy capability switches) and the first-party id claude-opus-5-5, a 3 h wall
// cap and a $25 spend cap. The drivers refuse any other token source, never leak the key, stop
// before the cap so the workspace is graded, and feed the runner's spend cap. The skeptic finds no
// comparability problem (token_source_unequal) and no horizon_mismatch (TDM-215).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAgentDriver, safeParseKitSpec, type KitSpec } from "@anybench/core";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  comparabilityIssues,
  isPinnedModelId,
  isPinnedVersion,
  runSkepticChecks,
  validateKitDir,
} from "../src/index.js";

const KITS_TDM212 = join(dirname(fileURLToPath(import.meta.url)), "../../../kits");
const KIT_TDM212 = join(KITS_TDM212, "tandem-long-horizon");
const TEMPLATE_TDM212 = join(KITS_TDM212, "tandem-vs-claude-code");
const MODEL_TDM212 = "claude-opus-5-5";
// Not a real key: the shape the redactors look for.
const FAKE_KEY_TDM212 = "sk-ant-api03-tdm212-fake-key-000000000000000000000000";

function specTdm212(dir: string): KitSpec {
  const r = safeParseKitSpec(parse(readFileSync(join(dir, "anybench.yaml"), "utf8")));
  if (!r.success) throw new Error(r.errors.join("\n"));
  return r.data;
}
const readTdm212 = (p: string) => readFileSync(join(KIT_TDM212, p), "utf8");

describe("kits/tandem-long-horizon anybench.yaml (TDM-212)", () => {
  const kit = specTdm212(KIT_TDM212);
  const template = specTdm212(TEMPLATE_TDM212);

  it("has two setups: A claude-code-solo (baseline) and D tandem at TANDEM_WORKERS=3 (subject)", () => {
    expect(kit.schema_version).toBe(2);
    expect(kit.contenders.map((c) => [c.id, c.role, c.driver.type])).toEqual([
      ["claude-code-solo", "baseline", "coding-agent"],
      ["tandem", "subject", "harness"],
    ]);
    expect(kit.vary).toEqual({});
    expect(kit.contenders[1]!.driver.env?.TANDEM_WORKERS).toBe("3");
    // Subagents off under both names, and 2.1.319's multi-agent Workflow tool, for A and Tandem.
    expect(kit.contenders[0]!.driver.env?.CC_DISALLOWED_TOOLS?.split(/\s+/).sort()).toEqual([
      "Agent",
      "Task",
      "Workflow",
    ]);
    expect(readTdm212("adapters/tandem/harness.yaml")).toMatch(
      /^disallowed_tools: Task Agent Workflow$/m,
    );
    expect(kit.human_in_loop).toEqual({ kind: "tandem", policy: "auto" });
    // B is a planned third setup, not in the kit yet.
    expect(readTdm212("README.md")).toMatch(
      /`claude-code-subagents`[\s\S]{0,200}planned third setup/,
    );
  });

  it("pins the first-party claude-opus-5-5 everywhere, and counts it as a pinned snapshot", () => {
    expect(isPinnedModelId(MODEL_TDM212)).toBe(true);
    for (const c of kit.contenders) {
      expect(isAgentDriver(c.driver) ? c.driver.model : undefined, c.id).toBe(MODEL_TDM212);
      expect(c.driver.env?.CC_MODEL, c.id).toBe(MODEL_TDM212);
      for (const k of [
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
      ])
        expect(c.driver.env?.[k], `${c.id} ${k}`).toBe(MODEL_TDM212);
    }
  });

  it("uses the template's pinned Claude Code and Tandem commit, and the install scripts default to them", () => {
    const pins = (k: KitSpec, id: string) => k.contenders.find((c) => c.id === id)!;
    for (const id of ["claude-code-solo", "tandem"]) {
      expect(pins(kit, id).versions, id).toEqual(pins(template, id).versions);
      expect(pins(kit, id).source, id).toEqual(pins(template, id).source);
    }
    const cc = kit.contenders[0]!.versions!.CLAUDE_CODE_VERSION!;
    expect(cc).toBe("2.1.319");
    expect(isPinnedVersion(cc)).toBe(true);
    for (const s of ["adapters/claude-code/install.sh", "adapters/tandem/install.sh"])
      expect(readTdm212(s), s).toContain(`\${CLAUDE_CODE_VERSION:-${cc}}`);
    const t = kit.contenders[1]!.versions!;
    for (const s of ["adapters/tandem/install-tandem.sh", "adapters/tandem/healthcheck.sh"]) {
      expect(readTdm212(s), s).toContain(`\${TANDEM_MCP_VERSION:-${t.TANDEM_MCP_VERSION}}`);
      expect(readTdm212(s), s).toContain(`\${TANDEM_VERSION:-${t.TANDEM_VERSION}}`);
    }
    // Copied, not rewritten: the scripts that need no token change are byte-identical.
    for (const s of [
      "adapters/claude-code/install.sh",
      "adapters/claude-code/healthcheck.sh",
      "adapters/claude-code-solo/CLAUDE.md",
      "adapters/tandem/install.sh",
      "adapters/tandem/install-tandem.sh",
      "adapters/tandem/healthcheck.sh",
      "adapters/tandem/driver.sh",
      "adapters/tandem/planner-prompt.md",
      "adapters/tandem/worker-prompt.md",
    ])
      expect(readTdm212(s), s).toBe(readFileSync(join(TEMPLATE_TDM212, s), "utf8"));
  });

  it("every contender is on our own Anthropic key with no proxy capability switches", () => {
    for (const c of kit.contenders) {
      expect(c.driver.env?.AB_TOKEN_SOURCE, c.id).toBe("anthropic_key");
      for (const k of [
        "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
        "MAX_THINKING_TOKENS",
        "CLAUDE_CODE_MODEL_CAPABILITIES",
        "ANTHROPIC_BASE_URL",
        "NAIVE_PROXY_ENV",
      ])
        expect(c.driver.env ?? {}, `${c.id} ${k}`).not.toHaveProperty(k);
    }
    expect(kit.secrets).toEqual(["ANTHROPIC_API_KEY"]);
    expect(kit.env?.network?.allow).toContain("api.anthropic.com");
    expect(kit.env?.network?.allow).not.toContain("api.vetta.sh");
    for (const d of ["adapters/claude-code/driver.sh", "adapters/tandem/run.sh"]) {
      const text = readTdm212(d);
      expect(text, d).toMatch(/AB_TOKEN_SOURCE:-\}" == anthropic_key/);
      expect(text, d).not.toMatch(/AB_TOKEN_SOURCE:-\}" == naive_proxy/);
      expect(text, d).toMatch(/unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL/);
    }
    expect(readTdm212("README.md")).toContain(
      "`tokens: anthropic-key, effort: default, thinking: on`",
    );
  });

  it("gives both setups the same caps: 3 h wall clock and $25 of tokens per trial", () => {
    for (const c of kit.contenders) {
      expect(c.driver.wall_clock_cap_s, c.id).toBe(10_800);
      expect(isAgentDriver(c.driver) ? c.driver.token_cap_micro_usd : undefined, c.id).toBe(
        25_000_000n,
      );
    }
    expect(kit.unequal_caps_reason).toBeUndefined();
    expect(kit.workloads.map((w) => [w.id, w.timeout_s])).toEqual([["project-tracker", 10_800]]);
    expect(kit.contenders[0]!.driver.env?.CC_WALL_CAP_S).toBe("10800");
    expect(readTdm212("adapters/tandem/harness.yaml")).toMatch(/^timeout_s: 10800$/m);
  });

  it("repeats default to 5 per setup, no warm-up, the order rotates", () => {
    expect(kit.repeats).toBe(5);
    expect(kit.schedule.warmups).toBe(0);
    expect(kit.schedule.order_seed).toBeTypeOf("number");
  });

  it("declares the gated requirements: 100% verdict, fraction (all_trials), wall, cost, cost per test, rubric", () => {
    const byId = Object.fromEntries(kit.requirements.map((r) => [r.id, r]));
    for (const r of kit.requirements) expect(r.gate_id, r.id).toBe("hidden-tests");
    expect(byId["tests-pass"]).toMatchObject({ metric: "gate_pass_rate", better: "higher" });
    expect(byId["tests-fraction"]).toMatchObject({
      metric: "hidden_test_fraction",
      aggregate: "all_trials",
      better: "higher",
    });
    expect(byId.wall).toMatchObject({ metric: "wall_s", better: "lower" });
    expect(byId.cost).toMatchObject({ metric: "cost_micro_usd", better: "lower" });
    expect(byId.cost).not.toHaveProperty("aggregate");
    expect(byId["cost-per-test"]).toMatchObject({
      metric: "cost_micro_usd",
      aggregate: "per_test_passed",
    });
    expect(byId.quality).toMatchObject({ type: "reviewed", rubric: "rubric.md" });
    expect(kit.gates.map((g) => [g.id, g.kind])).toEqual([["hidden-tests", "hidden-tests"]]);
    expect(kit.scoring.primary).toBe("tests-fraction");
    expect(Object.values(kit.scoring.weights).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("is comparable: no comparability error, token_source_unequal included", () => {
    const issues = comparabilityIssues(kit);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.map((i) => i.code)).not.toContain("token_source_unequal");
  });

  // Needs the hidden-tests gate (TDM-209 [18.2]) on disk.
  it("passes validateKitDir with no errors", async () => {
    const r = await validateKitDir(KIT_TDM212);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("skeptic: no token_source_unequal and no horizon_mismatch (a 3 h whole-app workload)", async () => {
    const r = await runSkepticChecks(KIT_TDM212);
    const checks = r.findings.map((f) => `${f.check}: ${f.why}`);
    expect(checks.filter((c) => /token_source|comparability/.test(c))).toEqual([]);
    expect(r.findings.filter((f) => f.check === ("horizon_mismatch" as never))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The drivers, with a fake `claude` on PATH (no network, no tokens).

describe("kits/tandem-long-horizon drivers (TDM-212)", () => {
  const root = mkdtempSync(join(tmpdir(), "tdm212-drivers-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Prints what it sees as stream-json: whether a key is there, the proxy switches, the model,
  // then echoes the key (an agent printing its env) and a result with a cost.
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == --version ]]; then echo "2.1.319 (Claude Code)"; exit 0; fi
printf '{"type":"system","subtype":"init","model":"%s","has_key":%s,"base_url":"%s","thinking":"%s","caps":"%s"}\\n' \\
  "\${ANTHROPIC_MODEL:-}" "$([[ -n "\${ANTHROPIC_API_KEY:-}" ]] && echo true || echo false)" \\
  "\${ANTHROPIC_BASE_URL:-}" "\${MAX_THINKING_TOKENS:-}" "\${CLAUDE_CODE_MODEL_CAPABILITIES:-}"
printf '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":5}},"text":"env: ANTHROPIC_API_KEY=%s"}\\n' "\${ANTHROPIC_API_KEY:-}"
echo "stderr has the key too: \${ANTHROPIC_API_KEY:-}" >&2
echo built > app.txt
printf '{"type":"result","total_cost_usd":0.0125}\\n'
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  const PATH = `${bin}:${process.env.PATH}`;

  function runA(name: string, env: Record<string, string>) {
    const dir = join(root, name);
    const ws = join(dir, "ws");
    const out = join(dir, "out");
    const home = join(dir, "home");
    for (const d of [ws, out, home]) mkdirSync(d, { recursive: true });
    writeFileSync(join(dir, "task.md"), "build it\n");
    const r = spawnSync(
      join(KIT_TDM212, "adapters/claude-code/driver.sh"),
      ["run", join(dir, "task.md"), ws],
      {
        encoding: "utf8",
        env: {
          PATH,
          HOME: home,
          EVAL_OUT: out,
          CC_SETUP: "claude-code-solo",
          CC_MODEL: MODEL_TDM212,
          AB_TOKEN_SOURCE: "anthropic_key",
          CC_WALL_CAP_S: "10800",
          // Proxy leftovers in the environment must not reach Claude Code.
          ANTHROPIC_BASE_URL: "https://api.vetta.sh",
          MAX_THINKING_TOKENS: "0",
          CLAUDE_CODE_MODEL_CAPABILITIES: "-effort",
          ...env,
        },
      },
    );
    return { r, out, home };
  }

  it("A: the key comes from EVAL_SECRETS, proxy switches are gone, nothing written leaks it", () => {
    const secrets = join(root, "secrets.env");
    writeFileSync(secrets, `ANTHROPIC_API_KEY="${FAKE_KEY_TDM212}"\n`, { mode: 0o600 });
    const { r, out, home } = runA("ok", { EVAL_SECRETS: secrets });
    expect(r.status, r.stderr).toBe(0);
    const stream = readFileSync(join(out, "stream.jsonl"), "utf8");
    const init = JSON.parse(stream.split("\n")[0]!);
    expect(init).toMatchObject({
      model: MODEL_TDM212,
      has_key: true,
      base_url: "",
      thinking: "",
      caps: "",
    });
    // The key is redacted in the transcript, stderr and stdout (compact spend lines only).
    for (const text of [stream, readFileSync(join(out, "claude.stderr.log"), "utf8"), r.stdout]) {
      expect(text).not.toContain(FAKE_KEY_TDM212);
      expect(text).not.toMatch(/sk-ant-/);
    }
    expect(stream).toContain("[REDACTED]");
    expect(r.stdout.trim().split("\n")).toEqual([
      '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":5}}}',
      '{"type":"result","total_cost_usd":0.0125}',
    ]);
    expect(readFileSync(join(out, "workspace/app.txt"), "utf8")).toBe("built\n");
    expect(JSON.parse(readFileSync(join(out, "versions.json"), "utf8"))).toMatchObject({
      model: MODEL_TDM212,
      token_source: "anthropic_key",
    });
    expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(true);
  });

  it("A: refuses the Naïve proxy, a Naïve model id and a missing key", () => {
    expect(
      runA("proxy", { AB_TOKEN_SOURCE: "naive_proxy", ANTHROPIC_API_KEY: "x".repeat(20) }).r.status,
    ).toBe(2);
    expect(
      runA("naive-id", { CC_MODEL: "anthropic/claude-opus-5.5", ANTHROPIC_API_KEY: "x".repeat(20) })
        .r.stderr,
    ).toMatch(/first-party id/);
    const missing = runA("nokey", {});
    expect(missing.r.status).toBe(2);
    expect(missing.r.stderr).toMatch(/ANTHROPIC_API_KEY is not set/);
  });

  it("Tandem: run.sh refuses any token source but anthropic_key, and a missing key", () => {
    const run = (name: string, env: Record<string, string>) => {
      const dir = join(root, name);
      const ws = join(dir, "ws");
      const out = join(dir, "out");
      for (const d of [ws, out]) mkdirSync(d, { recursive: true });
      writeFileSync(join(dir, "task.md"), "build it\n");
      const r = spawnSync(join(KIT_TDM212, "adapters/tandem/run.sh"), [join(dir, "task.md"), ws], {
        encoding: "utf8",
        env: {
          PATH,
          HOME: dir,
          TMPDIR: dir,
          EVAL_OUT: out,
          CC_MODEL: MODEL_TDM212,
          TANDEM_WORKERS: "3",
          ANYBENCH_HIL_POLICY: "auto",
          TANDEM_BIN: "/usr/bin/true",
          TANDEM_MCP_BIN: "/usr/bin/true",
          ...env,
        },
      });
      return { r, run: JSON.parse(readFileSync(join(out, "tandem/run.json"), "utf8")) };
    };
    const proxy = run("t-proxy", {
      AB_TOKEN_SOURCE: "naive_proxy",
      ANTHROPIC_API_KEY: "x".repeat(20),
    });
    expect(proxy.r.status).toBe(1);
    expect(proxy.run).toMatchObject({ outcome: "startup_failed" });
    expect(proxy.run.reason).toMatch(/anthropic_key/);
    const nokey = run("t-nokey", { AB_TOKEN_SOURCE: "anthropic_key" });
    expect(nokey.run.reason).toMatch(/ANTHROPIC_API_KEY is not set/);
  });
});
