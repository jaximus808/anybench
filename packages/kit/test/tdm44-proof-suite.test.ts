// TDM-44 [4.12] done conditions on the suite logic, with REAL gates (the kit's check.sh on the
// host) and simulated trials:
//   - the honest-vs-cheater kit (examples/cli: ripgrep vs GNU grep, truncate / first-match
//     do-less, a planted delay) passes all six;
//   - a kit with an always-pass gate is rejected with "do-less passed the gate";
//   - a kit containing an sk-ant- string is rejected, before anything runs;
//   - rule 4: no proof reason or evidence carries a contender metric value;
//   - a no-op-only do-less fails; a captured reference is written to reference/ only, proven on a
//     fresh run, cross-checked by the baseline, and rolled back when unproven;
//   - the mutation kill rate on the coding-agent oracle, with the real hidden tests under node.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatSchemaIssues,
  PROOF_CHECKS,
  safeParseKitSpec,
  type ProofCheckResult,
} from "@anybench/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  DO_LESS_PASSED,
  findSecretsInText,
  loadKit,
  mutateSource,
  readBundle,
  runProofSuite,
  runProofSuiteReport,
  scanKitForSecrets,
  writeBundle,
  type ProofTrialRequest,
} from "../src/index.js";
import {
  cliBehaviourTdm44,
  copyKitTdm44,
  hostProofRunnerTdm44,
  TDM44_HONEST_WALL,
  TDM44_PLANTED_WALL,
  TDM44_RSS,
} from "./tdm44-proof-helpers.js";

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../examples");
const CLI = path.join(EXAMPLES, "cli");
const CODING = path.join(EXAMPLES, "coding-agent");
// A fake key in the shape of an Anthropic API key, assembled so this file holds no key literal.
const FAKE_ANTHROPIC_KEY = ["sk", "ant", "api03", "tdm44FAKEKEYdoNotUse0000000000"].join("-");

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempKit(src: string): string {
  const d = copyKitTdm44(src);
  temps.push(d);
  return d;
}
const byCheck = (checks: ProofCheckResult[]) => Object.fromEntries(checks.map((c) => [c.check, c]));

describe("honest-vs-cheater (examples/cli) through the proof suite", () => {
  it("passes all six checks", async () => {
    const kit = await loadKit(CLI);
    const runner = hostProofRunnerTdm44(kit, cliBehaviourTdm44(CLI));
    const report = await runProofSuiteReport(kit, { runner, concurrency: 3 });
    const c = byCheck(report.checks);
    expect(report.checks.map((x) => x.check)).toEqual([...PROOF_CHECKS]);
    for (const check of PROOF_CHECKS)
      expect(c[check]!.pass, `${check}: ${c[check]!.reason}`).toBe(true);
    expect(c.do_less_fails!.reason).toBe(
      "every do-less variant fails the gate ('truncated-output', 'first-match-only')",
    );
    expect(c.regression_scores_lower!.reason).toBe(
      "planted regression 'planted-delay' scored lower on wall (n=3 each)",
    );
    expect(c.oracle_passes!.reason).toContain(
      "oracle 'grep-reference' passed same-matches on 2/2 workload(s)",
    );
    expect(c.oracle_passes!.reason).toContain(
      "the gate gave the same verdict 3 times on literal-search",
    );
    // The do-less evidence quotes the real gate's reason.
    expect(c.do_less_fails!.evidence.join("\n")).toContain("(output truncated?)");
    expect(report.infra).toEqual([]);
    // The neutral oracle overlay on gnu-grep IS the gnu-grep baseline run: one trial, not two.
    const gnu = runner.trials.filter((t) => t.contenderId === "gnu-grep");
    expect(gnu).toHaveLength(2);
    // Do-less stops at the first workload that fails.
    expect(runner.trials.filter((t) => t.overlay?.id === "truncated-output")).toHaveLength(1);
  });

  it("rule 4: no reason or evidence carries a contender metric value or a contender's gate reason", async () => {
    const kit = await loadKit(CLI);
    const runner = hostProofRunnerTdm44(kit, cliBehaviourTdm44(CLI));
    const checks = await runProofSuite(kit, { runner });
    const text = JSON.stringify(checks);
    for (const v of [TDM44_HONEST_WALL, TDM44_PLANTED_WALL, TDM44_RSS]) {
      for (const form of [String(v), v.toFixed(3), v.toFixed(2), String(Math.round(v * 1000))]) {
        if (form === "0" || form === "0.00" || form === "0.01" || form.length < 3) continue;
        expect(text, `metric value ${form} leaked`).not.toContain(form);
      }
    }
    // A contender's own (un-overlaid) gate reason never appears, only pass/fail. (The oracle and
    // do-less are proof overlays: their gate reasons are evidence.)
    const contenderChecks = checks.filter((x) =>
      ["smoke_passes", "baselines_in_range", "regression_scores_lower"].includes(x.check),
    );
    expect(JSON.stringify(contenderChecks)).not.toContain("equal the reference");
  });
});

describe("rejections", () => {
  it("an always-pass gate is rejected with 'do-less passed the gate'", async () => {
    const dir = tempKit(CLI);
    writeFileSync(
      path.join(dir, "gates/same-matches/check.sh"),
      '#!/usr/bin/env bash\nprintf \'{"pass":true,"reason":"ok","evidence":[]}\\n\' > "$3"\n',
    );
    const kit = await loadKit(dir);
    const checks = byCheck(
      await runProofSuite(kit, { runner: hostProofRunnerTdm44(kit, cliBehaviourTdm44(dir)) }),
    );
    expect(checks.do_less_fails!.pass).toBe(false);
    expect(checks.do_less_fails!.reason).toBe(
      `${DO_LESS_PASSED}: 'truncated-output' passed same-matches on literal-search, unicode-regex; 'first-match-only' passed same-matches on literal-search, unicode-regex`,
    );
    expect(checks.oracle_passes!.pass).toBe(true); // the oracle passes too: only do-less shows it
  });

  it("a kit containing an sk-ant- string is rejected before anything runs", async () => {
    const dir = tempKit(CLI);
    const f = path.join(dir, "adapters/ripgrep/install.sh");
    writeFileSync(f, `${readFileSync(f, "utf8")}\n# ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}\n`);
    const kit = await loadKit(dir);
    const runner = hostProofRunnerTdm44(kit, cliBehaviourTdm44(dir));
    const checks = await runProofSuite(kit, { runner });
    const c = byCheck(checks);
    expect(c.no_secret_in_kit!.pass).toBe(false);
    expect(c.no_secret_in_kit!.reason).toMatch(
      /^secret in kit: ANTHROPIC_API_KEY in adapters\/ripgrep\/install\.sh:\d+$/,
    );
    expect(JSON.stringify(checks)).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(checks.filter((x) => x.pass)).toEqual([]);
    expect(runner.trials).toEqual([]);
    expect(runner.gateCalls).toEqual([]);
  });

  it("an exact configured secret value is found, and never echoed", async () => {
    const dir = tempKit(CLI);
    const value = "tdm44-worker-secret-value-9f8e7d";
    writeFileSync(path.join(dir, "reference/same-matches/notes.txt"), `token: ${value}\n`);
    const scan = await scanKitForSecrets(dir, { exactValues: [value, "short"] });
    expect(scan.findings).toEqual([
      { file: "reference/same-matches/notes.txt", line: 1, kind: "EXACT_VALUE" },
    ]);
    const kit = await loadKit(dir);
    const checks = await runProofSuite(kit, {
      runner: hostProofRunnerTdm44(kit, cliBehaviourTdm44(dir)),
      secretValues: [value],
    });
    expect(byCheck(checks).no_secret_in_kit!.pass).toBe(false);
    expect(JSON.stringify(checks)).not.toContain(value);
  });

  it("catches the key shapes the brief names", () => {
    const samples: Record<string, string> = {
      ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
      GITHUB_TOKEN: ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("_"),
      AWS_ACCESS_KEY_ID: ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
      PRIVATE_KEY: ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
      STRIPE_WEBHOOK_SECRET: ["whsec", "abcdefghij0123"].join("_"),
    };
    for (const [kind, text] of Object.entries(samples)) {
      expect(
        findSecretsInText(`x ${text} y`).map((h) => h.kind),
        kind,
      ).toContain(kind);
    }
    expect(findSecretsInText("task-management-system-for-teams and sk-ant- docs")).toEqual([]);
  });

  it("a kit whose only do-less is a no-op fails do_less_fails", async () => {
    const dir = tempKit(CLI);
    const y = path.join(dir, "anybench.yaml");
    const yaml = readFileSync(y, "utf8").replace(
      / {2}do_less:\n[\s\S]*?\n {2}regression:/,
      `  do_less:\n    - id: no-op\n      dir: proof/do_less/first-match/\n      contender: ripgrep\n      env: { MAX_COUNT: "1" }\n  regression:`,
    );
    writeFileSync(y, yaml);
    const kit = await loadKit(dir);
    const c = byCheck(
      await runProofSuite(kit, {
        runner: hostProofRunnerTdm44(kit, (req, n) => {
          const b = cliBehaviourTdm44(dir)(
            {
              ...req,
              overlay:
                req.overlay?.id === "no-op"
                  ? { ...req.overlay, id: "first-match-only" }
                  : req.overlay,
            },
            n,
          );
          return b;
        }),
      }),
    );
    expect(c.do_less_fails!.pass).toBe(false);
    expect(c.do_less_fails!.reason).toMatch(
      /^the only do-less variant is a no-op, which is too weak/,
    );
  });

  it("a planted regression that is not slower fails with a check-level reason", async () => {
    const kit = await loadKit(CLI);
    const flat = (req: ProofTrialRequest, n: number) => {
      const b = cliBehaviourTdm44(CLI)(
        { ...req, overlay: req.overlay?.id === "planted-delay" ? null : req.overlay },
        n,
      );
      return b;
    };
    const c = byCheck(
      await runProofSuite(kit, { runner: hostProofRunnerTdm44(kit, flat), regressionRepeats: 5 }),
    );
    expect(c.regression_scores_lower!.pass).toBe(false);
    expect(c.regression_scores_lower!.reason).toBe(
      "planted regression 'planted-delay' did not score lower on wall, rss (n=5)",
    );
  });
});

describe("reference capture from the oracle", () => {
  /** The cli example with unicode-regex's reference removed and marked captured; oracle = `oracleOn`. */
  const captureKit = (oracleOn: "ripgrep" | "gnu-grep") => {
    const dir = tempKit(CLI);
    rmSync(path.join(dir, "reference/same-matches/unicode-regex"), { recursive: true });
    const y = path.join(dir, "anybench.yaml");
    writeFileSync(
      y,
      readFileSync(y, "utf8")
        .replace(
          "    reference: reference/same-matches/\n",
          "    reference: reference/same-matches/\n    capture: { from: oracle }\n",
        )
        .replace(
          "    dir: proof/oracle/\n    contender: gnu-grep\n",
          `    dir: proof/oracle/\n    contender: ${oracleOn}\n`,
        ),
    );
    return dir;
  };

  it("captures the absent reference into reference/, proves it on a fresh run and with the baseline", async () => {
    // v1: the oracle is the subject's pinned release; GNU grep (the baseline) must agree.
    const dir = captureKit("ripgrep");
    const kit = await loadKit(dir);
    // The simulated contenders print what the committed example reference says.
    const runner = hostProofRunnerTdm44(kit, cliBehaviourTdm44(CLI));
    const report = await runProofSuiteReport(kit, { runner });
    const c = byCheck(report.checks);
    expect(report.captured).toEqual(["reference/same-matches/unicode-regex/stdout.txt"]);
    expect(readFileSync(path.join(dir, report.captured[0]!), "utf8")).toBe(
      readFileSync(path.join(CLI, "reference/same-matches/unicode-regex/stdout.txt"), "utf8"),
    );
    expect(c.oracle_passes!.pass, c.oracle_passes!.reason).toBe(true);
    expect(c.oracle_passes!.reason).toContain(
      "the gate gave the same verdict 3 times on unicode-regex; captured reference(s) for unicode-regex confirmed",
    );
    // capture run + the fresh verification run: two oracle trials on unicode-regex.
    const oracleOnUni = runner.trials.filter(
      (t) => t.overlay?.id === "grep-reference" && t.workloadId === "unicode-regex",
    );
    expect(oracleOnUni).toHaveLength(2);
    expect(existsSync(path.join(dir, "workloads/unicode-regex/stdout.txt"))).toBe(false);
  });

  it("without an independent baseline the capture is not confirmed and is rolled back", async () => {
    // The oracle is gnu-grep, which is also the only baseline: nothing independent agrees.
    const dir = captureKit("gnu-grep");
    const kit = await loadKit(dir);
    const report = await runProofSuiteReport(kit, {
      runner: hostProofRunnerTdm44(kit, cliBehaviourTdm44(CLI)),
    });
    const c = byCheck(report.checks);
    expect(c.oracle_passes!.pass).toBe(false);
    expect(c.oracle_passes!.reason).toBe(
      "the reference captured from oracle 'grep-reference' has no independent baseline (a different implementation) to agree with it",
    );
    expect(report.captured).toEqual([]);
    expect(existsSync(path.join(dir, "reference/same-matches/unicode-regex/stdout.txt"))).toBe(
      false,
    );
  });
});

describe("mutation kill rate (coding-agent example, real hidden tests under node)", () => {
  it("kills the oracle's mutants and lists survivors", async () => {
    const kit = await loadKit(CODING);
    const input = path.join(CODING, "workloads/slugify/input");
    const oracleSrc = readFileSync(path.join(CODING, "proof/oracle/slugify/src/slug.js"));
    const runner = hostProofRunnerTdm44(kit, (req) => {
      const files: Record<string, string | Uint8Array> = {
        "workspace/package.json": readFileSync(path.join(input, "package.json")),
        "workspace/README.md": readFileSync(path.join(input, "README.md")),
        "workspace/src/slug.js": readFileSync(path.join(input, "src/slug.js")),
      };
      // The oracle and the honest agent solve it; skip-tests leaves the stub.
      if (req.overlay?.id !== "skip-tests") files["workspace/src/slug.js"] = oracleSrc;
      return {
        files,
        metrics: [
          {
            name: "wall_s",
            value: req.overlay?.id === "no-tests" ? 90 : 30,
            gate_id: "hidden-tests",
            level: "trial",
          },
        ],
      };
    });
    const report = await runProofSuiteReport(kit, { runner, concurrency: 4 });
    const c = byCheck(report.checks);
    expect(c.oracle_passes!.pass, c.oracle_passes!.reason).toBe(true);
    expect(report.mutation).not.toBeNull();
    const m = report.mutation!;
    expect(m.total).toBeGreaterThanOrEqual(4);
    expect(m.killed / m.total).toBeGreaterThanOrEqual(0.9);
    expect(c.do_less_fails!.pass, c.do_less_fails!.reason).toBe(true);
    expect(c.do_less_fails!.reason).toContain(
      `the hidden tests killed ${m.killed}/${m.total} oracle mutants`,
    );
    expect(c.do_less_fails!.evidence.join("\n")).toContain("mutation kill rate on the oracle");
    // The example has no baseline contender: that check says so.
    expect(c.baselines_in_range!.reason).toContain("no baseline contender");
    console.log(JSON.stringify({ mutation: m }));
  }, 120_000);

  it("a weak hidden-test gate lets mutants survive: do_less_fails names them", async () => {
    const dir = tempKit(CODING);
    // Seven tests that only check slugify returns a string: the stub (which throws) fails them,
    // but almost every mutant of the oracle still passes.
    const weak = [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { slugify } from "../src/slug.js";',
      ...Array.from(
        { length: 7 },
        (_, i) =>
          `test("returns a string ${i}", () => { assert.equal(typeof slugify("T ${i}"), "string"); });`,
      ),
      "",
    ].join("\n");
    writeFileSync(path.join(dir, "gates/hidden-tests/slugify/slug.test.js"), weak);
    const kit = await loadKit(dir);
    const input = path.join(dir, "workloads/slugify/input");
    const oracleSrc = readFileSync(path.join(dir, "proof/oracle/slugify/src/slug.js"));
    const runner = hostProofRunnerTdm44(kit, (req) => ({
      files: {
        "workspace/package.json": readFileSync(path.join(input, "package.json")),
        "workspace/src/slug.js":
          req.overlay?.id === "skip-tests"
            ? readFileSync(path.join(input, "src/slug.js"))
            : oracleSrc,
      },
    }));
    const report = await runProofSuiteReport(kit, { runner });
    const c = byCheck(report.checks);
    expect(c.oracle_passes!.pass).toBe(true);
    expect(c.do_less_fails!.pass).toBe(false);
    expect(c.do_less_fails!.reason).toMatch(
      /^the hidden tests killed \d+\/\d+ mutants of the oracle, under the 90% target; survivors: [a-z-]+@src\/slug\.js:\d+/,
    );
    expect(report.mutation!.survivors.length).toBeGreaterThan(0);
  }, 120_000);

  it("operators: flip, drop error branch, off-by-one, return before persist", () => {
    const src = [
      "export function f(a, b) {",
      "  if (a === b) throw new Error('same');",
      "  const n = a.length + 1;",
      "  fs.writeFileSync(p, String(n));",
      "  return n < 10 ? n : 10;",
      "}",
    ].join("\n");
    const ms = mutateSource("src/f.js", src, { perOperatorPerFile: 10 });
    const ops = new Set(ms.map((m) => m.operator));
    expect([...ops].sort()).toEqual([
      "drop-error-branch",
      "drop-statement",
      "flip-comparison",
      "off-by-one",
      "return-before-persist",
    ]);
    expect(ms.find((m) => m.operator === "flip-comparison")!.content).toContain("a !== b");
    expect(ms.find((m) => m.operator === "drop-error-branch")!.content).toContain(
      "if (a === b) void 0;",
    );
    expect(ms.find((m) => m.operator === "return-before-persist")!.content).toContain(
      "  return;\n  fs.writeFileSync",
    );
    expect(ms.every((m) => m.content !== src)).toBe(true);
    expect(mutateSource("README.md", src)).toEqual([]);
    expect(
      mutateSource("a.py", "def g(x):\n    if x == 1:\n        raise ValueError()\n")[0]!.content,
    ).toContain("x != 1");
  });
});

describe("KitSpec: gates[].capture and proof overlay kind (backward compatible)", () => {
  it("capture needs a reference dir and an oracle that covers the gate", async () => {
    const kit = await loadKit(CLI);
    const base = JSON.parse(JSON.stringify(kit.spec)) as Record<string, unknown> & {
      gates: Record<string, unknown>[];
      proof: Record<string, unknown>;
    };
    const ok = safeParseKitSpec({
      ...base,
      gates: [{ ...base.gates[0], capture: { from: "oracle" } }],
    });
    expect(ok.success).toBe(true);
    const { reference: _r, ...noRef } = base.gates[0]!;
    const bad = safeParseKitSpec({ ...base, gates: [{ ...noRef, capture: { from: "oracle" } }] });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(formatSchemaIssues(bad.error).join("\n")).toContain(
        "captures its reference but sets no reference dir",
      );
    }
    // Every existing kit still parses (no new required field).
    expect(safeParseKitSpec(base).success).toBe(true);
  });
});

describe("bundle", () => {
  it("round-trips files (long paths included) through tar.gz", () => {
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    const files = new Map<string, Uint8Array>([
      ["cli/stdout.txt", new TextEncoder().encode("a\nb\n")],
      [long, new Uint8Array([0, 1, 2, 255])],
    ]);
    const back = readBundle(writeBundle(files));
    expect([...back.keys()].sort()).toEqual([long, "cli/stdout.txt"].sort());
    expect([...back.get(long)!]).toEqual([0, 1, 2, 255]);
  });
});
