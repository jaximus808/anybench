// TDM-233 [18.12]: the skeptic on kits/tandem-long-horizon. Its blocks were false positives on
// content that is correct by design, fixed by two explicit kit declarations the checks honour
// narrowly, plus one real gap fixed in the kit (a partial oracle):
//   - workloads[].instruction_kind: contract — the instruction IS the contract the hidden tests
//     check (17.2 rule 9), so shared test names / asserted values are not leakage; the skeptic
//     checks instead that it copies no oracle or hidden-test code, and always discloses it;
//   - gates[].fixtures — the grader's own byte-identical copy of an input file (tracker-v1.json);
//   - proof.do_less partial-oracle — the oracle with the webhooks area cut out (real: before it,
//     nothing showed the gate refuses a near miss).
// Every exemption needs the declaration, and the undeclared fixtures (skeptic-tdm187) still block.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  decideSkepticVerdict,
  lineOfText,
  matchesKitPattern,
  runSkepticChecks,
  type SkepticFinding,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KITS = path.join(here, "..", "..", "..", "kits");
const LH_KIT = path.join(KITS, "tandem-long-horizon");
const EXAMPLES = path.join(here, "..", "examples");
const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** A copy of a kit in a temp dir (node_modules skipped), edited by `edit(dir)`. */
function copyKitTdm233(src: string, edit: (dir: string) => void = () => {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "tdm233-skeptic-"));
  roots.push(root);
  const dir = path.join(root, path.basename(src));
  cpSync(src, dir, { recursive: true, filter: (p) => !p.includes("node_modules") });
  edit(dir);
  return dir;
}

function replaceInTdm233(file: string, from: string | RegExp, to: string): void {
  const text = readFileSync(file, "utf8");
  const next = text.replace(from, to);
  if (next === text) throw new Error(`fixture edit did not apply to ${file}: ${String(from)}`);
  writeFileSync(file, next);
}

const blocksTdm233 = (fs: readonly SkepticFinding[], check?: string) =>
  fs.filter((f) => f.severity === "block" && (check === undefined || f.check === check));
const INSTR = "workloads/project-tracker/instruction.md";
const appendToInstr = (d: string, text: string) =>
  writeFileSync(path.join(d, INSTR), `${readFileSync(path.join(d, INSTR), "utf8")}\n${text}\n`);

describe("skeptic on kits/tandem-long-horizon (TDM-233)", () => {
  it("passes with zero blocking issues; the contract and the fixture copy are disclosed as warnings", async () => {
    const r = await runSkepticChecks(LH_KIT);
    expect(blocksTdm233(r.findings)).toEqual([]);
    expect(decideSkepticVerdict(r.findings)).toBe("pass");
    const contract = r.findings.find(
      (f) => f.check === "solution_leakage" && /declares its instruction a contract/.test(f.why),
    );
    expect(contract).toMatchObject({
      severity: "warn",
      evidence: expect.stringMatching(/^anybench\.yaml:\d+$/),
    });
    expect(contract!.why).toMatch(/copies no line of the oracle's code \(\d+ lines compared\)/);
    const fixture = r.findings.find((f) => f.check === "answer_in_workloads");
    expect(fixture).toMatchObject({
      severity: "warn",
      evidence: "workloads/project-tracker/input/fixtures/tracker-v1.json:1",
    });
    expect(fixture!.why).toMatch(/gate 'hidden-tests' declares as its own copy/);
  });

  it("without instruction_kind: contract the instruction blocks exactly as before", async () => {
    const dir = copyKitTdm233(LH_KIT, (d) =>
      replaceInTdm233(path.join(d, "anybench.yaml"), /\n {4}instruction_kind: contract\n/, "\n"),
    );
    const r = await runSkepticChecks(dir);
    const leak = blocksTdm233(r.findings, "solution_leakage");
    expect(leak.map((f) => f.why).join("\n")).toMatch(
      /copies the hidden assertion message "an attempt in flight/,
    );
    expect(leak.map((f) => f.why).join("\n")).toMatch(
      /quotes 11 value\(s\) the hidden assertions use/,
    );
    // The wrapped message is found on its own line, not line 1's fallback.
    expect(leak.map((f) => f.evidence)).toContain(`${INSTR}:454`);
    expect(blocksTdm233(r.findings, "answer_in_workloads").map((f) => f.evidence)).toEqual([
      `${INSTR}:317`,
    ]);
    expect(r.findings.some((f) => /declares its instruction a contract/.test(f.why))).toBe(false);
  });

  it("without gates[].fixtures the byte-identical tracker-v1.json blocks as before", async () => {
    const dir = copyKitTdm233(LH_KIT, (d) =>
      replaceInTdm233(path.join(d, "anybench.yaml"), /\n {4}fixtures: \[[^\]]*\]\n/, "\n"),
    );
    const r = await runSkepticChecks(dir);
    expect(blocksTdm233(r.findings, "answer_in_workloads").map((f) => f.why)).toEqual([
      expect.stringMatching(
        /tracker-v1\.json: identical to the scoring file gates\/hidden-tests\/project-tracker\/fixtures\/tracker-v1\.json/,
      ),
    ]);
  });

  it("a contract that carries the oracle's code → block", async () => {
    const dir = copyKitTdm233(LH_KIT, (d) => {
      const store = readFileSync(path.join(d, "proof/oracle/project-tracker/src/store.ts"), "utf8");
      const fn = store.split("\n").slice(60, 120).join("\n");
      appendToInstr(d, `## Appendix\n\n\`\`\`ts\n${fn}\n\`\`\``);
    });
    const r = await runSkepticChecks(dir);
    const leak = blocksTdm233(r.findings, "solution_leakage");
    expect(leak).toHaveLength(1);
    expect(leak[0]!.why).toMatch(
      /declared a contract .* carries \d+ line\(s\) of the oracle's or the hidden tests' code/,
    );
    expect(leak[0]!.why).toContain("proof/oracle/project-tracker/src/store.ts:");
    expect(leak[0]!.evidence).toMatch(new RegExp(`^${INSTR}:\\d+$`));
    expect(decideSkepticVerdict(r.findings)).toBe("repair");
  });

  it("a contract that carries a hidden test's code → block", async () => {
    const dir = copyKitTdm233(LH_KIT, (d) => {
      const t = readFileSync(
        path.join(d, "gates/hidden-tests/project-tracker/webhooks.test.ts"),
        "utf8",
      );
      appendToInstr(d, `\`\`\`ts\n${t.split("\n").slice(245, 262).join("\n")}\n\`\`\``);
    });
    const r = await runSkepticChecks(dir);
    const leak = blocksTdm233(r.findings, "solution_leakage");
    expect(leak).toHaveLength(1);
    expect(leak[0]!.why).toContain("gates/hidden-tests/project-tracker/webhooks.test.ts:");
  });

  it("a contract still may not point at scoring files or name a hidden test file", async () => {
    const dir = copyKitTdm233(LH_KIT, (d) =>
      appendToInstr(d, "The graders live in gates/hidden-tests/; start with webhooks.test.ts."),
    );
    const r = await runSkepticChecks(dir);
    const why = blocksTdm233(r.findings).map((f) => f.why);
    expect(why.some((w) => /points at scoring-only kit files/.test(w))).toBe(true);
    expect(why.some((w) => /names the hidden test file webhooks\.test\.ts/.test(w))).toBe(true);
  });

  it("a declared fixture never covers another scoring file or an answer-shaped one", async () => {
    const dir = copyKitTdm233(LH_KIT, (d) => {
      const gate = path.join(d, "gates/hidden-tests/project-tracker");
      const input = path.join(d, "workloads/project-tracker/input");
      // A hidden helper copied into the workspace: not under the declared fixtures/.
      cpSync(path.join(gate, "helpers.ts"), path.join(input, "src/helpers.ts"));
      // An expected output placed under the declared fixtures/ dir and shipped.
      writeFileSync(
        path.join(gate, "fixtures/export-golden.json"),
        '{"expected": "the whole export"}\n',
      );
      writeFileSync(path.join(input, "fixtures/sample.json"), '{"expected": "the whole export"}\n');
    });
    const r = await runSkepticChecks(dir);
    expect(
      blocksTdm233(r.findings, "answer_in_workloads")
        .map((f) => f.evidence)
        .sort(),
    ).toEqual([
      "workloads/project-tracker/input/fixtures/sample.json:1",
      "workloads/project-tracker/input/src/helpers.ts:1",
    ]);
  });

  it("declaring a bug ticket a contract does not excuse its rule list", async () => {
    const dir = copyKitTdm233(path.join(EXAMPLES, "coding-agent"), (d) => {
      replaceInTdm233(
        path.join(d, "anybench.yaml"),
        "    instruction: workloads/slugify/instruction.md\n",
        "    instruction: workloads/slugify/instruction.md\n    instruction_kind: contract\n",
      );
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
    expect(
      blocksTdm233(r.findings, "solution_leakage")
        .map((f) => f.why)
        .join("\n"),
    ).toMatch(/bug ticket whose bullet list restates/);
  });

  it("holds once project-tracker-xl lands: listed or not yet listed, with the gate's xl fixture copy", async () => {
    // TDM-236 writes gates/hidden-tests/project-tracker-xl/ (with its own copy of tracker-v1.json);
    // TDM-238 the xl oracle. Before the manifest lists xl, and after.
    const addXlFixture = (d: string) => {
      mkdirSync(path.join(d, "gates/hidden-tests/project-tracker-xl/fixtures"), {
        recursive: true,
      });
      cpSync(
        path.join(d, "workloads/project-tracker-xl/input/fixtures/tracker-v1.json"),
        path.join(d, "gates/hidden-tests/project-tracker-xl/fixtures/tracker-v1.json"),
      );
    };
    const unlisted = copyKitTdm233(LH_KIT, addXlFixture);
    expect(blocksTdm233((await runSkepticChecks(unlisted)).findings)).toEqual([]);

    const listed = copyKitTdm233(LH_KIT, (d) => {
      addXlFixture(d);
      replaceInTdm233(
        path.join(d, "anybench.yaml"),
        "\n# Collectors are omitted on purpose",
        [
          "  - id: project-tracker-xl",
          "    title: Build the xl project tracker API",
          "    input: workloads/project-tracker-xl/input/",
          "    instruction: workloads/project-tracker-xl/instruction.md",
          "    instruction_kind: contract",
          "    setup: workloads/project-tracker-xl/setup.sh",
          "    timeout_s: 10800",
          "",
          "# Collectors are omitted on purpose",
        ].join("\n"),
      );
    });
    const r = await runSkepticChecks(listed);
    expect(blocksTdm233(r.findings)).toEqual([]);
    const xl = r.findings.find((f) => /workload 'project-tracker-xl' declares/.test(f.why));
    expect(xl?.severity).toBe("warn");
    expect(
      r.findings.filter((f) => f.check === "answer_in_workloads").map((f) => f.severity),
    ).toEqual(["warn", "warn"]);
  });
});

describe("skeptic helpers (TDM-233)", () => {
  it("matchesKitPattern: a trailing / covers a subtree, a * segment matches one segment", () => {
    const p = "gates/hidden-tests/*/fixtures/";
    expect(
      matchesKitPattern(p, "gates/hidden-tests/project-tracker/fixtures/tracker-v1.json"),
    ).toBe(true);
    expect(matchesKitPattern(p, "gates/hidden-tests/a/fixtures/deep/x.json")).toBe(true);
    expect(matchesKitPattern(p, "gates/hidden-tests/a/b/fixtures/x.json")).toBe(false);
    expect(matchesKitPattern(p, "gates/hidden-tests/a/fixtures")).toBe(false);
    expect(matchesKitPattern("gates/g/seed.json", "gates/g/seed.json")).toBe(true);
    expect(matchesKitPattern("gates/g/seed.json", "gates/g/seed.json.bak")).toBe(false);
  });

  it("lineOfText finds a phrase that wraps across lines", () => {
    expect(
      lineOfText(
        "one\ntwo counts finished (an attempt in flight\nis not counted)",
        "an attempt in flight is not counted",
      ),
    ).toBe(2);
  });
});
