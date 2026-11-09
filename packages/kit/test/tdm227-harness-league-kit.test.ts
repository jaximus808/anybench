// TDM-227 [21.1]: kits/harness-league, the E21 league on E18's whole-app arena. Five setups (A solo,
// B subagents, G gstack, S superpowers, D Tandem ×3) on kits/tandem-long-horizon's workloads, gate,
// requirements and proof, which are byte-identical copies (scripts/sync-shared.mjs --check), so
// E18's PROOF.md sign-off holds. Every setup: the same pinned model and Claude Code, the same caps,
// the same token source, the same task-agnostic CLAUDE.md lines; each skill pack pinned to an exact
// commit and installed in a home of its own, so it never loads in another setup's trial.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAgentDriver, safeParseKitSpec, type KitSpec } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  comparabilityIssues,
  isPinnedVersion,
  runSkepticChecks,
  validateKitDir,
} from "../src/index.js";

const KITS_TDM227 = join(dirname(fileURLToPath(import.meta.url)), "../../../kits");
const KIT_TDM227 = join(KITS_TDM227, "harness-league");
const LONG_TDM227 = join(KITS_TDM227, "tandem-long-horizon");
const MODEL_TDM227 = "claude-opus-5-5";
const GSTACK_COMMIT_TDM227 = "910093087dec4877f99dfaed6600784942ed7a7b";
const SUPERPOWERS_COMMIT_TDM227 = "22f0b463e7a5e579904dd6211a520321035526f7";

function specTdm227(dir: string): KitSpec {
  const r = safeParseKitSpec(parse(readFileSync(join(dir, "anybench.yaml"), "utf8")));
  if (!r.success) throw new Error(r.errors.join("\n"));
  return r.data;
}
const readTdm227 = (p: string) => readFileSync(join(KIT_TDM227, p), "utf8");

describe("kits/harness-league (TDM-227)", () => {
  const kit = specTdm227(KIT_TDM227);
  const long = specTdm227(LONG_TDM227);
  const byId = (k: KitSpec, id: string) => k.contenders.find((c) => c.id === id)!;

  it("validateKitDir accepts the league kit, with no comparability error", async () => {
    const v = await validateKitDir(KIT_TDM227);
    expect(v.lines).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.kit!.contenders.map((c) => c.id)).toEqual([
      "claude-code-solo",
      "claude-code-subagents",
      "gstack",
      "superpowers",
      "tandem",
    ]);
    expect(comparabilityIssues(kit).filter((i) => i.severity === "error")).toEqual([]);
    // Same model for all: not even the model_mismatch warning.
    expect(comparabilityIssues(kit).map((i) => i.code)).not.toContain("model_mismatch");
  });

  it("shares E18's arena byte for byte (sync-shared.mjs --check), so its proof sign-off holds", () => {
    const r = spawnSync("node", [join(KIT_TDM227, "scripts/sync-shared.mjs"), "--check"], {
      encoding: "utf8",
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    // Everything from `workloads:` on is E18's text: workloads, gate, requirements, proof, scoring.
    const tail = (dir: string) => {
      const t = readFileSync(join(dir, "anybench.yaml"), "utf8");
      return t.slice(t.indexOf("\nworkloads:\n"));
    };
    expect(tail(KIT_TDM227)).toBe(tail(LONG_TDM227));
    for (const k of ["workloads", "gates", "requirements", "proof", "scoring", "env"] as const)
      expect(kit[k], k).toEqual(long[k]);
    expect(readTdm227("PROOF.md")).toBe(readFileSync(join(LONG_TDM227, "PROOF.md"), "utf8"));
  });

  it("A and D are E18's setups unchanged; B is E18's planned B on E18's driver and settings", () => {
    for (const id of ["claude-code-solo", "tandem"]) {
      const { found_by: _a, ...a } = byId(kit, id);
      const { found_by: _b, ...b } = byId(long, id);
      expect({ ...a, name: undefined }, id).toEqual({ ...b, name: undefined });
    }
    const a = byId(kit, "claude-code-solo");
    const b = byId(kit, "claude-code-subagents");
    expect(b.install).toEqual(a.install);
    expect(b.driver.script).toBe(a.driver.script);
    expect(b.source).toEqual({
      upload: [
        "adapters/claude-code-subagents/CLAUDE.md",
        "adapters/claude-code-subagents/.claude/",
      ],
    });
    expect(b.driver.env?.CC_SETUP).toBe("claude-code-subagents");
    for (const f of ["implementer", "reviewer", "test-writer"])
      expect(
        existsSync(join(KIT_TDM227, `adapters/claude-code-subagents/.claude/agents/${f}.md`)),
      ).toBe(true);
  });

  it("every setup: same model, Claude Code, caps and token source; Workflow off for all, subagents off only for A and D", () => {
    for (const c of kit.contenders) {
      expect(isAgentDriver(c.driver) ? c.driver.model : undefined, c.id).toBe(MODEL_TDM227);
      expect(c.driver.env?.CC_MODEL, c.id).toBe(MODEL_TDM227);
      for (const k of [
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
      ])
        expect(c.driver.env?.[k], `${c.id} ${k}`).toBe(MODEL_TDM227);
      expect(c.driver.env?.AB_TOKEN_SOURCE, c.id).toBe("anthropic_key");
      expect(c.versions?.CLAUDE_CODE_VERSION, c.id).toBe("2.1.319");
      expect(c.driver.wall_clock_cap_s, c.id).toBe(10_800);
      expect(isAgentDriver(c.driver) ? c.driver.token_cap_micro_usd : undefined, c.id).toBe(
        25_000_000n,
      );
      if (c.driver.type === "coding-agent") expect(c.driver.env?.CC_WALL_CAP_S, c.id).toBe("10800");
    }
    const tools = (id: string) =>
      byId(kit, id).driver.env?.CC_DISALLOWED_TOOLS?.split(/\s+/).sort();
    expect(tools("claude-code-solo")).toEqual(["Agent", "Task", "Workflow"]);
    for (const id of ["claude-code-subagents", "gstack", "superpowers"])
      expect(tools(id), id).toEqual(["Workflow"]);
    expect(readTdm227("adapters/tandem/harness.yaml")).toMatch(
      /^disallowed_tools: Task Agent Workflow$/m,
    );
    expect(kit.human_in_loop).toEqual({ kind: "tandem", policy: "auto" });
  });

  it("pins each skill pack to an exact commit, and the install and health check scripts default to the pins", () => {
    const g = byId(kit, "gstack");
    const s = byId(kit, "superpowers");
    expect(g.versions).toEqual({
      CLAUDE_CODE_VERSION: "2.1.319",
      GSTACK_COMMIT: GSTACK_COMMIT_TDM227,
      BUN_VERSION: "1.4.2",
    });
    expect(s.versions).toEqual({
      CLAUDE_CODE_VERSION: "2.1.319",
      SUPERPOWERS_COMMIT: SUPERPOWERS_COMMIT_TDM227,
      SUPERPOWERS_VERSION: "7.0.2",
    });
    for (const c of [g, s])
      for (const v of Object.values(c.versions!)) expect(isPinnedVersion(v), v).toBe(true);
    expect(g.version).toBe("gstack@1.98.0.0");
    expect(s.version).toBe("superpowers@7.0.2");
    for (const [script, pins] of [
      ["adapters/gstack/install.sh", g.versions!],
      [
        "adapters/superpowers/install.sh",
        { CLAUDE_CODE_VERSION: "2.1.319", SUPERPOWERS_COMMIT: SUPERPOWERS_COMMIT_TDM227 },
      ],
    ] as const)
      for (const [k, v] of Object.entries(pins))
        expect(readTdm227(script), `${script} ${k}`).toContain(`\${${k}:-${v}}`);
    expect(readTdm227("adapters/gstack/healthcheck.sh")).toContain(
      `\${GSTACK_COMMIT:-${GSTACK_COMMIT_TDM227}}`,
    );
    expect(readTdm227("adapters/gstack/healthcheck.sh")).toContain("${BUN_VERSION:-1.4.2}");
    expect(readTdm227("adapters/superpowers/healthcheck.sh")).toContain(
      `\${SUPERPOWERS_COMMIT:-${SUPERPOWERS_COMMIT_TDM227}}`,
    );
    expect(readTdm227("adapters/superpowers/healthcheck.sh")).toContain(
      "${SUPERPOWERS_VERSION:-7.0.2}",
    );
    // The README's install, from the tool's own repository.
    expect(readTdm227("adapters/gstack/install.sh")).toContain(
      "https://github.com/garrytan/gstack.git",
    );
    expect(readTdm227("adapters/gstack/install.sh")).toMatch(/\.\/setup < \/dev\/null/);
    expect(readTdm227("adapters/superpowers/install.sh")).toContain(
      "https://github.com/obra/superpowers.git",
    );
    expect(readTdm227("adapters/superpowers/install.sh")).toMatch(
      /claude plugin install superpowers@superpowers-dev --scope user/,
    );
  });

  it("skill packs install into a home of their own and run through the shared driver with HOME there", () => {
    for (const id of ["gstack", "superpowers"]) {
      const c = byId(kit, id);
      expect(c.driver.script, id).toBe("adapters/tool-home/driver.sh");
      expect(c.driver.env?.CC_TOOL_HOME, id).toBe(id);
      expect(c.driver.env?.CC_SETUP, id).toBe(id);
      expect(readTdm227(`adapters/${id}/install.sh`), id).toContain(
        `tool_home="$HOME/.anybench/homes/${id}"`,
      );
      expect(readTdm227(`adapters/${id}/healthcheck.sh`), id).toMatch(/leaked into the real home/);
      expect(statSync(join(KIT_TDM227, `adapters/${id}/install.sh`)).mode & 0o111, id).not.toBe(0);
    }
    const drv = readTdm227("adapters/tool-home/driver.sh");
    expect(drv).toContain('export HOME="$tool_home"');
    expect(drv).toContain('exec "$kit/adapters/claude-code/driver.sh" "$@"');
  });

  it("every Claude Code setup gets the same task-agnostic lines; a skill pack adds only what its README prescribes", () => {
    const shared = [
      "- Read the task and the repository before changing anything.",
      "- Follow the repository's existing patterns and conventions.",
      "- Write tests for what you build and run the test suite before you finish.",
    ];
    for (const f of ["claude-code-solo", "gstack", "superpowers"]) {
      const text = readTdm227(`adapters/${f}/CLAUDE.md`);
      for (const line of shared) expect(text, f).toContain(line);
    }
    const gstack = readTdm227("adapters/gstack/CLAUDE.md");
    // gstack README: "Your project's CLAUDE.md only needs the browsing rule".
    expect(gstack).toContain(
      "## gstack\nUse /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.\n",
    );
    const superpowers = readTdm227("adapters/superpowers/CLAUDE.md");
    expect(superpowers.split("\n").filter((l) => l.startsWith("- "))).toEqual(shared);
    for (const id of ["gstack", "superpowers"])
      expect(byId(kit, id).source, id).toEqual({ upload: [`adapters/${id}/CLAUDE.md`] });
  });

  it("skeptic: no blocking finding (no one-sided help, no task hint, no comparability problem)", async () => {
    const r = await runSkepticChecks(KIT_TDM227);
    expect(
      r.findings.filter((f) => f.severity === "block").map((f) => `${f.check}: ${f.why}`),
    ).toEqual([]);
  });
});
