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
//
// TDM-240: the xl gate (gates/hidden-tests/project-tracker-xl/) keeps growing (TDM-236, 237, and an
// xl oracle in TDM-238), so these tests assert what the checks guarantee (no block, each
// declaration disclosed with counts, the blocks back without it, evidence by pattern), never
// exact counts or the one file a copied line was first found in.
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

/** A workload's contract disclosure (warn) and the counts it states. */
function contractWarnTdm240(fs: readonly SkepticFinding[], workload: string) {
  const f = fs.find(
    (x) =>
      x.check === "solution_leakage" &&
      x.why.startsWith(`workload '${workload}' declares its instruction a contract`),
  );
  if (!f) return null;
  const n = (re: RegExp) => Number(re.exec(f.why)?.[1] ?? Number.NaN);
  return {
    finding: f,
    names: n(/(\d+) hidden test name\(s\)/),
    messages: n(/(\d+) assertion message\(s\)/),
    values: n(/(\d+) asserted value\(s\)/),
    oracleLines: n(/oracle's code \((\d+) lines compared/),
    testLines: n(/hidden tests' code \((\d+) lines compared/),
    copiesNone: /it copies no line of the oracle's code/.test(f.why),
  };
}

/** The fixture-copy disclosures (warn) among a run's findings. */
const fixtureWarnsTdm240 = (fs: readonly SkepticFinding[]) =>
  fs.filter((f) => f.check === "answer_in_workloads" && /declares as its own copy/.test(f.why));

const XL_GATE = "gates/hidden-tests/project-tracker-xl";
const XL_INSTR = "workloads/project-tracker-xl/instruction.md";
/** Lists project-tracker-xl in the manifest, as a contract (what TDM-238 will do). */
const listXlTdm240 = (d: string) =>
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
/** Gives the xl gate its own copy of tracker-v1.json (TDM-236 ships one; idempotent). */
const addXlFixtureTdm240 = (d: string) => {
  mkdirSync(path.join(d, XL_GATE, "fixtures"), { recursive: true });
  cpSync(
    path.join(d, "workloads/project-tracker-xl/input/fixtures/tracker-v1.json"),
    path.join(d, XL_GATE, "fixtures/tracker-v1.json"),
  );
};
/** Code lines unique to the synthetic xl test (24+ chars, code punctuation, in no other file). */
const SYNTHETIC_CODE_TDM240 = [
  '  const synthetic = await api.call("GET", "/synthetic/tdm240", undefined, w.owner.token);',
  '  assert.equal(synthetic.body.items.length, 240, "synthetic: one item per ticket");',
  '  assert.deepEqual(synthetic.body.order, ["tdm", "two", "forty"]);',
];
/** A synthetic extra xl hidden test file: a contract sentence as its name, plus its own code. */
const addSyntheticXlTestTdm240 = (d: string) =>
  writeFileSync(
    path.join(d, XL_GATE, "zz-synthetic-tdm240.test.ts"),
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      "",
      'test("two apps created in the same process share no state", async (t) => {',
      ...SYNTHETIC_CODE_TDM240,
      "});",
      "",
    ].join("\n"),
  );

describe("skeptic on kits/tandem-long-horizon (TDM-233)", () => {
  it("passes with zero blocking issues; the contract and the fixture copy are disclosed as warnings", async () => {
    const r = await runSkepticChecks(LH_KIT);
    expect(blocksTdm233(r.findings)).toEqual([]);
    expect(decideSkepticVerdict(r.findings)).toBe("pass");
    const c = contractWarnTdm240(r.findings, "project-tracker");
    expect(c).not.toBeNull();
    expect(c!.finding).toMatchObject({
      severity: "warn",
      evidence: expect.stringMatching(/^anybench\.yaml:\d+$/),
    });
    // What the declaration covered, and that it was checked: no copied code, real comparisons.
    expect(c!.names + c!.messages + c!.values).toBeGreaterThan(0);
    expect(c!.values).toBeGreaterThan(0);
    expect(c!.copiesNone).toBe(true);
    expect(c!.oracleLines).toBeGreaterThan(0);
    expect(c!.testLines).toBeGreaterThan(0);
    const fixtures = fixtureWarnsTdm240(r.findings);
    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures.every((f) => f.severity === "warn")).toBe(true);
    expect(fixtures.map((f) => f.evidence)).toContain(
      "workloads/project-tracker/input/fixtures/tracker-v1.json:1",
    );
    expect(fixtures[0]!.why).toMatch(
      /byte-identical to gates\/hidden-tests\/[^/]+\/fixtures\/tracker-v1\.json, which gate 'hidden-tests' declares as its own copy/,
    );
  });

  it("without instruction_kind: contract the instruction blocks exactly as before", async () => {
    const dir = copyKitTdm233(LH_KIT, (d) =>
      replaceInTdm233(path.join(d, "anybench.yaml"), /\n {4}instruction_kind: contract\n/, "\n"),
    );
    const r = await runSkepticChecks(dir);
    const leak = blocksTdm233(r.findings, "solution_leakage");
    const message = leak.find((f) =>
      /copies the hidden assertion message "an attempt in flight is not counted"/.test(f.why),
    );
    expect(message).toBeDefined();
    // The wrapped message is found on the line that holds it, not line 1's fallback.
    const lines = readFileSync(path.join(dir, INSTR), "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes("an attempt in flight")) + 1;
    expect(at).toBeGreaterThan(1);
    expect(message!.evidence).toBe(`${INSTR}:${at}`);
    const values = leak.find((f) =>
      /quotes (\d+) value\(s\) the hidden assertions use/.test(f.why),
    );
    expect(Number(/quotes (\d+) value/.exec(values?.why ?? "")?.[1])).toBeGreaterThanOrEqual(2);
    const named = blocksTdm233(r.findings, "answer_in_workloads");
    expect(named.length).toBeGreaterThan(0);
    for (const f of named) {
      expect(f.evidence).toMatch(new RegExp(`^${INSTR}:\\d+$`));
      expect(f.why).toMatch(/names the hidden test ".+" and ships to the subject computer/);
    }
    expect(contractWarnTdm240(r.findings, "project-tracker")).toBeNull();
  });

  it("without gates[].fixtures the byte-identical tracker-v1.json blocks as before", async () => {
    const dir = copyKitTdm233(LH_KIT, (d) =>
      replaceInTdm233(path.join(d, "anybench.yaml"), /\n {4}fixtures: \[[^\]]*\]\n/, "\n"),
    );
    const r = await runSkepticChecks(dir);
    const copies = blocksTdm233(r.findings, "answer_in_workloads");
    expect(copies.map((f) => f.evidence)).toContain(
      "workloads/project-tracker/input/fixtures/tracker-v1.json:1",
    );
    for (const f of copies) {
      expect(f.why).toMatch(
        /^workloads\/[^/]+\/input\/fixtures\/tracker-v1\.json: identical to the scoring file gates\/hidden-tests\/[^/]+\/fixtures\/tracker-v1\.json \(no-leak lint\)$/,
      );
    }
    expect(fixtureWarnsTdm240(r.findings)).toEqual([]);
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
    // The same lines may also be in an xl test: any hidden test file can be the one cited.
    expect(leak[0]!.why).toMatch(/\(gates\/hidden-tests\/[^/]+\/[\w.-]+\.test\.ts:\d+\)/);
    expect(leak[0]!.evidence).toMatch(new RegExp(`^${INSTR}:\\d+$`));
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

  it("holds as project-tracker-xl lands: listed or not yet listed, with the gate's xl fixture copy", async () => {
    // TDM-236/237 write gates/hidden-tests/project-tracker-xl/ (with its own tracker-v1.json copy);
    // TDM-238 the xl oracle and the manifest entry. Before the manifest lists xl, and after.
    const unlisted = copyKitTdm233(LH_KIT, addXlFixtureTdm240);
    expect(blocksTdm233((await runSkepticChecks(unlisted)).findings)).toEqual([]);

    const listed = copyKitTdm233(LH_KIT, (d) => {
      addXlFixtureTdm240(d);
      listXlTdm240(d);
    });
    const r = await runSkepticChecks(listed);
    expect(blocksTdm233(r.findings)).toEqual([]);
    for (const w of ["project-tracker", "project-tracker-xl"]) {
      const c = contractWarnTdm240(r.findings, w);
      expect(c?.finding.severity, w).toBe("warn");
      expect(c!.copiesNone, w).toBe(true);
    }
    const fixtures = fixtureWarnsTdm240(r.findings);
    expect(fixtures.map((f) => f.evidence)).toEqual(
      expect.arrayContaining([
        "workloads/project-tracker/input/fixtures/tracker-v1.json:1",
        "workloads/project-tracker-xl/input/fixtures/tracker-v1.json:1",
      ]),
    );
    expect(
      r.findings
        .filter((f) => f.check === "answer_in_workloads")
        .every((f) => f.severity === "warn"),
    ).toBe(true);
  });

  it("still passes with a synthetic extra xl hidden test file; that file's code is checked", async () => {
    // A new xl test whose name is a contract sentence (both instructions state it): no block,
    // listed or not, and the xl contract disclosure counts it.
    const unlisted = copyKitTdm233(LH_KIT, (d) => {
      addXlFixtureTdm240(d);
      addSyntheticXlTestTdm240(d);
    });
    expect(blocksTdm233((await runSkepticChecks(unlisted)).findings)).toEqual([]);

    const listed = copyKitTdm233(LH_KIT, (d) => {
      addXlFixtureTdm240(d);
      addSyntheticXlTestTdm240(d);
      listXlTdm240(d);
    });
    const r = await runSkepticChecks(listed);
    expect(blocksTdm233(r.findings)).toEqual([]);
    const xl = contractWarnTdm240(r.findings, "project-tracker-xl");
    expect(xl?.names).toBeGreaterThan(0);
    expect(xl!.testLines).toBeGreaterThan(0);
    expect(xl!.copiesNone).toBe(true);

    // Control: the same synthetic file's code pasted into the xl contract blocks, citing it.
    const pasted = copyKitTdm233(LH_KIT, (d) => {
      addXlFixtureTdm240(d);
      addSyntheticXlTestTdm240(d);
      listXlTdm240(d);
      const p = path.join(d, XL_INSTR);
      writeFileSync(
        p,
        `${readFileSync(p, "utf8")}\n\`\`\`ts\n${SYNTHETIC_CODE_TDM240.join("\n")}\n\`\`\`\n`,
      );
    });
    const leak = blocksTdm233((await runSkepticChecks(pasted)).findings, "solution_leakage");
    expect(leak).toHaveLength(1);
    expect(leak[0]!.evidence).toMatch(new RegExp(`^${XL_INSTR}:\\d+$`));
    expect(leak[0]!.why).toContain(`${XL_GATE}/zz-synthetic-tdm240.test.ts:`);
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
