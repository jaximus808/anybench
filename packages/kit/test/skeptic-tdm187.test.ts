// TDM-187 [16.16]: the skeptic's deterministic checks on fixture kits (copies of the examples
// with one flaw planted each), the reference Tandem kit as a known case, and the model-family rule.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkSkepticModel,
  contentWords,
  decideSkepticVerdict,
  extractTestFacts,
  isMovingModelAlias,
  modelFamily,
  runSkepticChecks,
  SkepticFindingSchema,
  type SkepticFinding,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(here, "..", "examples");
const TANDEM_KIT = path.join(here, "..", "..", "..", "kits", "tandem-vs-claude-code");
const tmpRoots: string[] = [];

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** A copy of an example kit in a temp dir, edited by `edit(dir)`. */
function fixtureKitTdm187(example: string, edit: (dir: string) => void = () => {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "tdm187-skeptic-"));
  tmpRoots.push(root);
  const dir = path.join(root, example);
  cpSync(path.join(EXAMPLES, example), dir, { recursive: true });
  edit(dir);
  return dir;
}

function replaceIn(file: string, from: string | RegExp, to: string): void {
  const text = readFileSync(file, "utf8");
  const next = text.replace(from, to);
  if (next === text) throw new Error(`fixture edit did not apply to ${file}: ${String(from)}`);
  writeFileSync(file, next);
}

const blocks = (fs: readonly SkepticFinding[], check?: string) =>
  fs.filter((f) => f.severity === "block" && (check === undefined || f.check === check));

describe("skeptic deterministic checks (TDM-187)", () => {
  it("the cli example has no blocks (pass)", async () => {
    const r = await runSkepticChecks(path.join(EXAMPLES, "cli"));
    expect(r.material).not.toBeNull();
    expect(blocks(r.findings)).toEqual([]);
    expect(decideSkepticVerdict(r.findings)).toBe("pass");
    // Every finding has the shape, with path:line evidence.
    for (const f of r.findings) expect(SkepticFindingSchema.parse(f)).toEqual(f);
  });

  it("a bug ticket that lists every rule the hidden tests assert → block (solution_leakage)", async () => {
    const dir = fixtureKitTdm187("coding-agent", (d) => {
      writeFileSync(
        path.join(d, "workloads/slugify/instruction.md"),
        [
          "# Fix the broken slugify (ticket #42)",
          "",
          "Users report that post URLs come out wrong for some titles. Fix `slugify(title)`:",
          "",
          "- lower-case the title and join words with -;",
          "- strip accents (é becomes e);",
          "- collapse every run of other characters into one -;",
          "- keep digits;",
          "- no - at the start or the end;",
          "- an empty result is untitled.",
          "",
        ].join("\n"),
      );
    });
    const r = await runSkepticChecks(dir);
    const leak = blocks(r.findings, "solution_leakage");
    expect(leak.map((f) => f.why).join("\n")).toMatch(/bug ticket whose bullet list restates/);
    expect(leak[0]!.evidence).toMatch(/^workloads\/slugify\/instruction\.md:\d+$/);
    expect(decideSkepticVerdict(r.findings)).toBe("repair");
  });

  it("an instruction that quotes the asserted values → block; the same task without them does not", async () => {
    const leaky = await runSkepticChecks(path.join(EXAMPLES, "coding-agent"));
    const leak = blocks(leaky.findings, "solution_leakage");
    expect(leak).toHaveLength(1);
    expect(leak[0]!.why).toContain("Crème brûlée");

    const clean = fixtureKitTdm187("coding-agent", (d) => {
      replaceIn(path.join(d, "workloads/slugify/instruction.md"), /^`slugify\(.*\n/m, "");
    });
    const r = await runSkepticChecks(clean);
    expect(blocks(r.findings, "solution_leakage")).toEqual([]);
  });

  it("an instruction file for one coding-agent contender and not the other → block (one_sided_assist)", async () => {
    const dir = fixtureKitTdm187("coding-agent", (d) => {
      replaceIn(
        path.join(d, "anybench.yaml"),
        "\nworkloads:\n",
        [
          "",
          "  - id: claude-code-bare",
          "    role: competitor",
          "    source: { github: anthropics/claude-code, ref: v2.1.319 }",
          "    install: { script: adapters/claude-code/install.sh, healthcheck: adapters/claude-code/healthcheck.sh }",
          "    driver:",
          "      type: coding-agent",
          "      script: adapters/claude-code/driver.sh",
          "      verbs:",
          "        run: adapters/claude-code/driver.sh run {task} {workspace}",
          "      wall_clock_cap_s: 1800",
          "      model: anthropic/claude-sonnet-4.6",
          "      token_cap_tokens: 2000000",
          "      max_turns: 40",
          '    versions: { CLAUDE_CODE_VERSION: "2.1.319" }',
          "",
          "workloads:",
          "",
        ].join("\n"),
      );
    });
    const r = await runSkepticChecks(dir);
    expect(blocks(r.findings, "kit_invalid")).toEqual([]);
    const assist = blocks(r.findings, "one_sided_assist");
    expect(assist).toHaveLength(1);
    expect(assist[0]!.why).toMatch(
      /'claude-code' gets adapters\/claude-code\/CLAUDE\.md but 'claude-code-bare' gets no instruction file/,
    );
    expect(assist[0]!.evidence).toMatch(/^anybench\.yaml:\d+$/);
  });

  it("contender help that names a task or a hidden test → block (one_sided_assist)", async () => {
    const dir = fixtureKitTdm187("coding-agent", (d) => {
      writeFileSync(
        path.join(d, "adapters/claude-code/CLAUDE.md"),
        "# Help\n\nFor the slugify task, remember: strip accents and keep digits.\n",
      );
    });
    const r = await runSkepticChecks(dir);
    const assist = blocks(r.findings, "one_sided_assist");
    expect(assist.map((f) => f.evidence)).toContain("adapters/claude-code/CLAUDE.md:3");
  });

  it("a do-less set that is only a no-op → block (weak_do_less); none at all → block", async () => {
    const noop = fixtureKitTdm187("cli", (d) => {
      replaceIn(
        path.join(d, "anybench.yaml"),
        / {2}do_less:\n[\s\S]*?(?= {2}regression:)/,
        [
          "  do_less:",
          "    - id: do-nothing",
          "      dir: proof/do_less/truncate/",
          "      contender: ripgrep",
          "      driver_patch: proof/do_less/truncate/driver.sh",
          "      kind: noop",
          "",
        ].join("\n"),
      );
    });
    const r = await runSkepticChecks(noop);
    const weak = blocks(r.findings, "weak_do_less");
    expect(weak).toHaveLength(1);
    expect(weak[0]!.why).toMatch(/'do-nothing' is a no-op/);

    const none = fixtureKitTdm187("cli", (d) => {
      replaceIn(path.join(d, "anybench.yaml"), / {2}do_less:\n[\s\S]*?(?= {2}regression:)/, "");
    });
    const r2 = await runSkepticChecks(none);
    expect(blocks(r2.findings, "weak_do_less")[0]!.why).toMatch(/no do-less variant/);
  });

  it("proof results where a do-less passed the gate → block (noop_passable)", async () => {
    const r = await runSkepticChecks(path.join(EXAMPLES, "cli"), {
      proof: [
        {
          check: "do_less_fails",
          pass: false,
          reason:
            "do-less passed the gate: 'truncated-output' passed same-matches on literal-search",
          evidence: ["do-less 'truncated-output' (cheat): passed every gate on every workload"],
        },
      ],
    });
    const noop = blocks(r.findings, "noop_passable");
    expect(noop).toHaveLength(1);
    expect(noop[0]!.why).toMatch(/'truncated-output' \(cheat\) passed every gate/);
  });

  it("an answer-bearing file under workloads/ → block (answer_in_workloads)", async () => {
    const dir = fixtureKitTdm187("cli", (d) => {
      cpSync(
        path.join(d, "reference/same-matches/unicode-regex/stdout.txt"),
        path.join(d, "workloads/unicode-regex/input/tree/notes.txt"),
      );
      mkdirSync(path.join(d, "workloads/unicode-regex/input/tree/expected"), { recursive: true });
      writeFileSync(path.join(d, "workloads/unicode-regex/input/tree/expected/out.txt"), "x\n");
    });
    const r = await runSkepticChecks(dir);
    const ans = blocks(r.findings, "answer_in_workloads");
    expect(ans.map((f) => f.evidence).sort()).toEqual([
      "workloads/unicode-regex/input/tree/expected/out.txt:1",
      "workloads/unicode-regex/input/tree/notes.txt:1",
    ]);
    // Both come from the TDM-60 no-leak lint, reused (not re-implemented).
    expect(ans.every((f) => f.why.endsWith("(no-leak lint)"))).toBe(true);
  });

  it("a weighted vanity metric → block; LLM-judged quality with weight → warn (one_sided_weight)", async () => {
    const dir = fixtureKitTdm187("coding-agent", (d) => {
      const y = path.join(d, "anybench.yaml");
      replaceIn(
        y,
        "\nproof:\n",
        [
          "  - id: turns",
          "    type: measured",
          "    title: Turns used",
          "    metric: turns",
          "    better: lower",
          "    gate_id: hidden-tests",
          "",
          "proof:",
          "",
        ].join("\n"),
      );
      replaceIn(
        y,
        "weights: { tests-pass: 60, cost: 20, wall: 20 }",
        "weights: { tests-pass: 50, cost: 20, wall: 20, turns: 10 }",
      );
    });
    const r = await runSkepticChecks(dir);
    const w = blocks(r.findings, "one_sided_weight");
    expect(w).toHaveLength(1);
    expect(w[0]!.why).toMatch(/turns, a vanity metric .* weight 10/);
  });

  it("comparability: the validator's issues are reused, not redone", async () => {
    const dir = fixtureKitTdm187("coding-agent", (d) => {
      replaceIn(
        path.join(d, "anybench.yaml"),
        'CLAUDE_CODE_VERSION: "2.1.319"',
        'CLAUDE_CODE_VERSION: "latest"',
      );
    });
    const r = await runSkepticChecks(dir);
    const comp = blocks(r.findings, "comparability");
    expect(comp).toHaveLength(1);
    expect(comp[0]!.why).toMatch(/CLAUDE_CODE_VERSION 'latest' is not a pinned version/);
    expect(comp[0]!.evidence).toMatch(/^anybench\.yaml:\d+$/);
    // The other checks still ran on the parsed spec.
    expect(r.material).not.toBeNull();
  });

  it("contamination: a reference captured from the subject itself → block (hold)", async () => {
    const dir = fixtureKitTdm187("cli", (d) => {
      const y = path.join(d, "anybench.yaml");
      replaceIn(y, "    contender: gnu-grep\n", "    contender: ripgrep\n");
      // No other implementation to cross-check the captured reference.
      replaceIn(y, / {2}- id: gnu-grep\n[\s\S]*?(?=\nworkloads:)/, "");
      replaceIn(
        y,
        "    reference: reference/same-matches/\n",
        "    reference: reference/same-matches/\n    capture: { from: oracle }\n",
      );
    });
    const r = await runSkepticChecks(dir);
    const c = blocks(r.findings, "contamination");
    expect(c).toHaveLength(1);
    expect(c[0]!.why).toMatch(/oracle is the subject 'ripgrep' itself/);
    expect(decideSkepticVerdict(r.findings)).toBe("hold");
  });

  it("contamination: a reference captured from the subject but cross-checked by a baseline → warn only", async () => {
    const dir = fixtureKitTdm187("cli", (d) => {
      const y = path.join(d, "anybench.yaml");
      replaceIn(y, "    contender: gnu-grep\n", "    contender: ripgrep\n");
      replaceIn(
        y,
        "    reference: reference/same-matches/\n",
        "    reference: reference/same-matches/\n    capture: { from: oracle }\n",
      );
    });
    const r = await runSkepticChecks(dir);
    const c = r.findings.filter((f) => f.check === "contamination");
    expect(c.map((f) => f.severity)).toEqual(["warn"]);
    expect(c[0]!.why).toMatch(/rests on 'gnu-grep' agreeing through the same gate/);
  });

  it("contamination: a mined task dated before a contender's cutoff → block; cutoff unknown → warn", async () => {
    const dir = fixtureKitTdm187("coding-agent", (d) => {
      mkdirSync(path.join(d, "mined"));
      writeFileSync(
        path.join(d, "mined/slugify.json"),
        `${JSON.stringify({ id: "slugify", commit: "a".repeat(40), commit_date: "2025-03-01T10:00:00Z" }, null, 2)}\n`,
      );
    });
    const known = await runSkepticChecks(dir, {
      modelCutoffs: { "anthropic/claude-sonnet-4.6": "2025-08-01" },
    });
    expect(blocks(known.findings, "contamination")[0]!.why).toMatch(
      /dated 2025-03-01, on or before the training cutoff/,
    );
    const unknown = await runSkepticChecks(dir);
    const warn = unknown.findings.filter((f) => f.check === "contamination");
    expect(warn.map((f) => f.severity)).toEqual(["warn"]);
    expect(warn[0]!.evidence).toBe("mined/slugify.json:4");
  });

  it("a kit text that claims 'beats' on too few tasks → block; repeats under the agent floor → block", async () => {
    const dir = fixtureKitTdm187("coding-agent", (d) => {
      const y = path.join(d, "anybench.yaml");
      replaceIn(
        y,
        "summary: Headless Claude Code",
        "summary: Shows that headless Claude Code beats the rest. Headless Claude Code",
      );
      replaceIn(y, "repeats: 10", "repeats: 3");
    });
    const r = await runSkepticChecks(dir);
    const few = blocks(r.findings, "too_few_tasks").map((f) => f.why);
    expect(few.some((w) => /claims "beats" on 1 task/.test(w))).toBe(true);
    expect(few.some((w) => /repeats 3 is below the agent floor of 4/.test(w))).toBe(true);
  });

  it("the reference Tandem kit (known case): bug-hunt leaks, the do-less is only a no-op", async () => {
    const r = await runSkepticChecks(TANDEM_KIT);
    const b = blocks(r.findings);
    expect(b.map((f) => f.check).sort()).toEqual([
      "solution_leakage",
      "solution_leakage",
      "weak_do_less",
    ]);
    // Both leaks are in bug-hunt: the RFC 4180 rule list and its quoted expected values.
    expect(
      b
        .filter((f) => f.check === "solution_leakage")
        .every((f) => f.evidence.startsWith("workloads/bug-hunt/instruction.md:")),
    ).toBe(true);
    // The build-to-contract tasks state their contract: that is not leakage.
    expect(b.some((f) => /todo-api|auth-refactor/.test(f.evidence))).toBe(false);
    const warns = r.findings.filter((f) => f.severity === "warn").map((f) => f.check);
    expect(warns).toEqual(
      expect.arrayContaining(["too_few_tasks", "one_sided_weight", "answer_in_workloads"]),
    );
    expect(decideSkepticVerdict(r.findings)).toBe("repair");
  });

  it("a missing kit dir is a block, not a throw", async () => {
    const r = await runSkepticChecks(path.join(tmpdir(), "tdm187-no-such-kit"));
    expect(r.material).toBeNull();
    expect(r.findings.map((f) => f.check)).toEqual(["kit_invalid"]);
  });

  it("extractTestFacts: node:test names, assertion literals and messages; tests.json names", () => {
    const facts = extractTestFacts({
      path: "gates/g/w/a.test.ts",
      text: [
        'test("parses a quoted field", () => {',
        "  assert.equal(parse('\"a,b\"'), \"a,b\", 'the quoted comma stays inside the field');",
        "});",
      ].join("\n"),
    });
    expect(facts.map((f) => [f.kind, f.value, f.line])).toEqual([
      ["name", "parses a quoted field", 1],
      ["literal", '"a,b"', 2],
      ["literal", "a,b", 2],
      ["message", "the quoted comma stays inside the field", 2],
    ]);
    const json = extractTestFacts({
      path: "gates/g/w/tests.json",
      text: JSON.stringify(
        { tests: [{ file: "a.test.ts", name: "one rule" }], FAIL_TO_PASS: ["t::two"] },
        null,
        2,
      ),
    });
    expect(json.map((f) => f.value)).toEqual(["one rule", "t::two"]);
    expect([...contentWords("toCsv quotes fields containing commas")]).toEqual([
      "quot",
      "field",
      "contain",
      "comma",
    ]);
  });
});

describe("skeptic model families (TDM-187)", () => {
  it("reads the family from the model id", () => {
    expect(modelFamily("anthropic/claude-opus-5.5")).toBe("anthropic");
    expect(modelFamily("claude-sonnet-4-5-20250929")).toBe("anthropic");
    expect(modelFamily("some-reseller/claude-haiku-4.5")).toBe("anthropic");
    expect(modelFamily("deepseek/deepseek-v4-flash-0731")).toBe("deepseek");
    expect(modelFamily("openai/gpt-5-mini")).toBe("openai");
    expect(modelFamily("openai/o3")).toBe("openai");
    expect(modelFamily("gpt-4o-2024-08-06")).toBe("openai");
    expect(modelFamily("google/gemini-3.1-flash-lite")).toBe("google");
    expect(modelFamily("google/gemma-4-31B-it")).toBe("google");
    expect(modelFamily("qwen/qwen3.8-flash")).toBe("qwen");
    expect(modelFamily("mistralai/mistral-small-2603")).toBe("mistral");
    expect(modelFamily("z-ai/glm-5.3-flash")).toBe("zhipu");
    expect(modelFamily("zai-org/GLM-5.2-FP8")).toBe("zhipu");
    expect(modelFamily("meta-llama/llama-4-scout")).toBe("meta");
    expect(modelFamily("fireworks/ember-1")).toBe("fireworks");
    expect(modelFamily("vetta/auto")).toBeNull();
    expect(isMovingModelAlias("~google/gemini-flash-latest")).toBe(true);
    expect(isMovingModelAlias("google/gemini-3.1-flash-lite")).toBe(false);
  });

  it("refuses a Claude model, the designer's family, a contender's family, routers and aliases", () => {
    const rule = { designer: ["deepseek/deepseek-v4-flash-0731"], contenders: ["openai/gpt-5.5"] };
    expect(checkSkepticModel("anthropic/claude-haiku-4.5", rule)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/from anthropic/),
    });
    expect(checkSkepticModel("deepseek/deepseek-v4-pro", rule)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/the kit designer's family/),
    });
    expect(checkSkepticModel("openai/gpt-5-mini", rule)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/contender model 'openai\/gpt-5.5'/),
    });
    expect(checkSkepticModel("vetta/auto", rule).ok).toBe(false);
    expect(checkSkepticModel("~google/gemini-flash-latest", rule).ok).toBe(false);
    expect(checkSkepticModel("google/gemini-3.1-flash-lite", rule)).toEqual({
      ok: true,
      model: "google/gemini-3.1-flash-lite",
      family: "google",
    });
    // A bare family name works as the designer.
    expect(
      checkSkepticModel("google/gemini-3.1-flash-lite", { designer: ["google"], contenders: [] })
        .ok,
    ).toBe(false);
  });
});
