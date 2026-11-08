// TDM-186 [16.15]: candidate selection, runner detection and the per-runner parsers (no computer).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignHeldOut,
  buildMineTar,
  detectTestRunner,
  groupMinedTasks,
  isDocPath,
  isLockfilePath,
  minedTaskArea,
  minedTaskId,
  MinedTaskSchema,
  parseCargo,
  parseGoJson,
  parseJestJson,
  parseMochaJson,
  parseNodeTap,
  parsePytest,
  selectMineCandidates,
  type MinedTask,
} from "../src/index.js";
import { buildMineFixtureRepo, type MineFixture } from "./tdm186-mine-fixture.js";

let tmp: string;
let fx: MineFixture;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ab-tdm186-sel-"));
  fx = await buildMineFixtureRepo(join(tmp, "repo"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("selectMineCandidates", () => {
  it("keeps fix+test commits and drops the rest with reasons", async () => {
    const sel = await selectMineCandidates(fx.repo);
    expect(sel.commits_scanned).toBe(13);
    const shas = sel.candidates.map((c) => c.sha);
    expect(shas).toEqual([
      fx.sha.fixPad,
      fx.sha.fixTruncate,
      fx.sha.fixTitleEmpty,
      fx.sha.passesBefore,
      fx.sha.flaky,
      fx.sha.fixClamp,
      fx.sha.fixSlugify,
    ]);
    const code = (sha: string) => sel.dropped.find((d) => d.sha === sha)?.code;
    expect(code(fx.sha.init)).toBe("root_commit");
    expect(code(fx.sha.docs)).toBe("docs_only");
    expect(code(fx.sha.sideDocs)).toBe("docs_only");
    expect(code(fx.sha.testsOnly)).toBe("tests_only");
    expect(code(fx.sha.lockOnly)).toBe("lockfile_only");
    expect(code(fx.sha.merge)).toBe("merge");

    const trunc = sel.candidates.find((c) => c.sha === fx.sha.fixTruncate);
    expect(trunc?.test_files).toEqual([
      { path: "test/truncate.test.js", status: "added", added: 6, deleted: 0 },
    ]);
    expect(trunc?.fix_files.map((f) => f.path)).toEqual(["src/strings.js"]);
    expect(trunc?.ignored_files).toEqual(["CHANGELOG.md"]);
    expect(trunc?.author_date).toBe("2026-03-12T12:00:00Z");
    expect(trunc?.parent).toBe(fx.sha.fixTitleEmpty);
  });

  it("drops oversized diffs", async () => {
    const sel = await selectMineCandidates(fx.repo, { limits: { maxFixLines: 2 } });
    expect(sel.dropped.find((d) => d.sha === fx.sha.fixTruncate)?.code).toBe("too_large");
  });

  it("classifies paths", () => {
    expect(isDocPath("docs/guide.md")).toBe(true);
    expect(isDocPath("LICENSE")).toBe(true);
    expect(isDocPath("docs/conf.py")).toBe(false);
    expect(isLockfilePath("sub/pnpm-lock.yaml")).toBe(true);
  });
});

describe("detectTestRunner", () => {
  const base = (files: Record<string, string>, tests: string[]) => ({
    paths: Object.keys(files),
    read: async (p: string) => files[p],
    testFiles: tests,
    readTest: async () => "",
  });
  it("picks the runner from package.json and refuses unsupported ones", async () => {
    const vit = await detectTestRunner(
      base(
        {
          "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
          "package-lock.json": "{}",
        },
        ["src/a.test.ts"],
      ),
    );
    expect(vit.ok && vit.runner.kind).toBe("vitest");
    expect(vit.ok && vit.runner.install_command).toBe("npm ci --no-audit --no-fund");
    expect(vit.ok && vit.runner.test_command).toContain("'src/a.test.ts'");
    const ava = await detectTestRunner(
      base({ "package.json": JSON.stringify({ devDependencies: { ava: "1" } }) }, ["test/a.js"]),
    );
    expect(ava).toMatchObject({
      ok: false,
      code: "no_runner",
      reason: "test runner ava is not supported yet",
    });
    const none = await detectTestRunner(base({ "main.c": "" }, ["tests/a.c"]));
    expect(none.ok).toBe(false);
  });
  it("uses pytest for Python and installs the project editable", async () => {
    const py = await detectTestRunner(
      base({ "pyproject.toml": "", "requirements-dev.txt": "" }, [
        "tests/test_x.py",
        "tests/data/x.toml",
      ]),
    );
    expect(py.ok && py.runner.kind).toBe("pytest");
    // changed test data is read by tests the commit did not touch: the whole suite runs
    expect(py.ok && py.runner.targets).toEqual([]);
    const only = await detectTestRunner(
      base({ "pyproject.toml": "" }, ["tests/test_x.py", "tests/conftest.py"]),
    );
    expect(only.ok && only.runner.targets).toEqual(["tests/test_x.py"]);
    expect(py.ok && py.runner.install_command).toContain("-r 'requirements-dev.txt'");
    expect(py.ok && py.runner.install_command).toContain("-e .");
  });
  it("falls back to the whole suite when only test data changed, unless told not to", async () => {
    const files = { "go.mod": "module x" };
    const r = await detectTestRunner(base(files, ["testdata/case.txt"]));
    expect(r.ok && r.runner.test_command).toBe("go test -count=1 -json ./...");
    const strict = await detectTestRunner({
      ...base(files, ["testdata/case.txt"]),
      suiteFallback: false,
    });
    expect(strict).toMatchObject({ ok: false, code: "no_runnable_tests" });
  });
});

describe("parsers", () => {
  it("node TAP: per-file ids, nested names, YAML failure text, file-level crashes", () => {
    const log = [
      "# anybench-file: test/a.test.js",
      "TAP version 13",
      "# Subtest: group",
      "    # Subtest: inner fails",
      "    not ok 1 - inner fails",
      "      ---",
      "      error: |-",
      "        Expected values to be strictly equal:",
      "        ",
      "        'a-b' !== 'a_b'",
      "      expected: 'a_b'",
      "      actual: 'a-b'",
      "      stack: |-",
      "        at x (/w/test/a.test.js:3:70)",
      "      ...",
      "    # Subtest: inner ok",
      "    ok 2 - inner ok",
      "    1..2",
      "not ok 1 - group",
      "  ---",
      "  error: '1 subtest failed'",
      "  ...",
      "# Subtest: skipped one",
      "ok 2 - skipped one # SKIP not now",
      "# tests 3",
      "# anybench-file: test/b.test.js",
      "# Error: Cannot find module '../src/pad.js'",
      "#     at Function._resolveFilename (node:internal/modules/cjs/loader:1430:15)",
      "# Subtest: test/b.test.js",
      "not ok 1 - test/b.test.js",
      "  ---",
      "  error: 'test failed'",
      "  ...",
    ].join("\n");
    const r = parseNodeTap(log);
    expect([...r.tests.keys()]).toEqual([
      "test/a.test.js > group > inner fails",
      "test/a.test.js > group > inner ok",
      "test/a.test.js > skipped one",
      "test/b.test.js > test/b.test.js",
    ]);
    expect(r.tests.get("test/a.test.js > group > inner fails")?.message).toBe(
      "Expected values to be strictly equal:\n\n'a-b' !== 'a_b'\nexpected: a_b\nactual: a-b",
    );
    expect(r.tests.get("test/a.test.js > skipped one")?.outcome).toBe("skip");
    expect(r.fileErrors.get("test/b.test.js")).toBe("Error: Cannot find module '../src/pad.js'");
  });

  it("jest/vitest JSON", () => {
    const r = parseJestJson(
      JSON.stringify({
        testResults: [
          {
            name: "/ws/src/a.test.ts",
            status: "failed",
            assertionResults: [
              { ancestorTitles: ["math"], title: "adds", status: "passed", failureMessages: [] },
              {
                ancestorTitles: ["math"],
                title: "subs",
                status: "failed",
                failureMessages: [
                  "\u001b[31mexpected 1 to be 2\u001b[39m\n    at /ws/src/a.test.ts:3:4",
                ],
              },
            ],
          },
          {
            name: "/ws/src/b.test.ts",
            status: "failed",
            message: "Cannot find module './b'",
            assertionResults: [],
          },
        ],
      }),
      "/ws",
    );
    expect(r.tests.get("src/a.test.ts > math > subs")).toEqual({
      outcome: "fail",
      message: "expected 1 to be 2",
    });
    expect(r.tests.get("src/a.test.ts > math > adds")?.outcome).toBe("pass");
    expect(r.fileErrors.get("src/b.test.ts")).toBe("Cannot find module './b'");
  });

  it("mocha JSON", () => {
    const r = parseMochaJson(
      JSON.stringify({
        passes: [{ fullTitle: "cookie parses", file: "/ws/test/parse.js" }],
        failures: [
          {
            fullTitle: "cookie encodes",
            file: "/ws/test/parse.js",
            err: { message: "expected 'a' to equal 'b'" },
          },
        ],
        pending: [],
      }),
      "/ws",
    );
    expect(r.tests.get("test/parse.js > cookie encodes")).toEqual({
      outcome: "fail",
      message: "expected 'a' to equal 'b'",
    });
  });

  it("pytest -rA", () => {
    const log = [
      "=================================== FAILURES ===================================",
      "________________________________ TestX.test_b _________________________________",
      "tests/test_a.py:9: in test_b",
      "    assert f(1) == 2",
      "E   assert 1 == 2",
      "E    +  where 1 = f(1)",
      "=========================== short test summary info ============================",
      "PASSED tests/test_a.py::test_a",
      "FAILED tests/test_a.py::TestX::test_b - assert 1 == 2",
      "ERROR tests/test_c.py - ModuleNotFoundError: No module named 'pkg.new'",
      "XFAIL tests/test_a.py::test_x - reason",
      "PASSED tests/test_data.py::TestData::test_valid",
      "SUBFAILED[localtime] tests/test_data.py::TestData::test_valid - TOMLDecodeError: Expected newline (at line 2, column 5)",
    ].join("\n");
    const r = parsePytest(log);
    expect(r.tests.get("tests/test_a.py::test_a")?.outcome).toBe("pass");
    expect(r.tests.get("tests/test_a.py::TestX::test_b")).toEqual({
      outcome: "fail",
      message: "assert 1 == 2\n+  where 1 = f(1)",
    });
    expect(r.tests.get("tests/test_a.py::test_x")?.outcome).toBe("skip");
    // pytest 9: a failed unittest subTest fails its parent even though the parent says PASSED
    expect(r.tests.get("tests/test_data.py::TestData::test_valid")).toEqual({
      outcome: "fail",
      message: "[localtime] TOMLDecodeError: Expected newline (at line 2, column 5)",
    });
    expect(r.fileErrors.get("tests/test_c.py")).toBe(
      "ModuleNotFoundError: No module named 'pkg.new'",
    );
  });

  it("go test -json", () => {
    const ev = (o: object) => JSON.stringify(o);
    const log = [
      ev({ Action: "run", Package: "x/a", Test: "TestA" }),
      ev({ Action: "output", Package: "x/a", Test: "TestA", Output: "=== RUN   TestA\n" }),
      ev({
        Action: "output",
        Package: "x/a",
        Test: "TestA",
        Output: "    a_test.go:9: got 1, want 2\n",
      }),
      ev({ Action: "fail", Package: "x/a", Test: "TestA" }),
      ev({ Action: "pass", Package: "x/a", Test: "TestB" }),
      "# x/c",
      "c/c_test.go:5:2: undefined: NewThing",
      ev({ Action: "fail", Package: "x/c" }),
    ].join("\n");
    const r = parseGoJson(log);
    expect(r.tests.get("x/a/TestA")).toEqual({
      outcome: "fail",
      message: "a_test.go:9: got 1, want 2",
    });
    expect(r.tests.get("x/a/TestB")?.outcome).toBe("pass");
    expect(r.fileErrors.get("(build)")).toContain("undefined: NewThing");
  });

  it("cargo test", () => {
    const log = [
      "running 2 tests",
      "test parse::ok_case ... ok",
      "test parse::bad_case ... FAILED",
      "",
      "failures:",
      "",
      "---- parse::bad_case stdout ----",
      "thread 'parse::bad_case' panicked at tests/parse.rs:9:5:",
      "assertion `left == right` failed",
      "failures:",
      "test result: FAILED. 1 passed; 1 failed",
    ].join("\n");
    const r = parseCargo(log);
    expect(r.tests.get("parse::ok_case")?.outcome).toBe("pass");
    expect(r.tests.get("parse::bad_case")?.message).toContain("assertion `left == right` failed");
  });
});

describe("tar, ids, areas, held-out, groups", () => {
  it("buildMineTar writes a ustar archive with long names", async () => {
    const long = `${"d/".repeat(60)}file.txt`;
    const tar = buildMineTar([
      { path: "a.txt", mode: "100644", sha: "0".repeat(40), content: Buffer.from("hi\n") },
      { path: long, mode: "100755", sha: "1".repeat(40), content: Buffer.from("x") },
    ]);
    const dir = await mkdtemp(join(tmpdir(), "ab-tdm186-tar-"));
    const { execFileSync } = await import("node:child_process");
    const { writeFile, readFile, stat } = await import("node:fs/promises");
    await writeFile(join(dir, "t.tar"), tar);
    execFileSync("tar", ["-xf", join(dir, "t.tar"), "-C", dir]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hi\n");
    expect((await stat(join(dir, long))).mode & 0o111).not.toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("ids are opaque hashes; areas are the fix's module", () => {
    expect(minedTaskId("a".repeat(40))).toMatch(/^mined-[a-f0-9]{10}$/);
    expect(minedTaskId("a".repeat(40))).not.toContain("aaaa");
    expect(minedTaskArea(["src/core/a.js", "src/core/b/c.js"])).toBe("src/core");
    expect(minedTaskArea(["src/a.js", "lib/b.js"])).toBe(".");
    expect(minedTaskArea(["index.js"])).toBe(".");
  });

  const task = (i: number, area: string, day: number): MinedTask =>
    MinedTaskSchema.parse({
      record: "anybench.mined-task/v1",
      id: minedTaskId(String(i).padStart(40, "0")),
      source: {
        commit: String(i).padStart(40, "0"),
        parent: String(i + 1).padStart(40, "0"),
        author_date: new Date(Date.UTC(2026, 0, day)).toISOString(),
        commit_date: new Date(Date.UTC(2026, 0, day)).toISOString(),
      },
      held_out: false,
      area,
      files: {
        test_files: [{ path: "t/a.test.js", status: "modified", added: 1, deleted: 0 }],
        fix_files: [{ path: `${area}/a.js`, status: "modified", added: 1, deleted: 1 }],
        ignored_files: [],
      },
      diff_stats: { files_changed: 2, test_lines: 1, fix_lines: 2 },
      runner: {
        kind: "node-test",
        install_command: null,
        test_command: "node --test",
        targets: [],
        env: {},
      },
      fail_to_pass: ["t > x"],
      pass_to_pass: [],
      flaky_excluded: [],
      pass_to_fail: [],
      runs: {
        before: [{ exit_code: 1, passed: 0, failed: 1, skipped: 0, duration_ms: 1 }],
        after: [{ exit_code: 0, passed: 1, failed: 0, skipped: 0, duration_ms: 1 }],
      },
      symptoms: [],
      before_output_excerpt: "",
    });

  it("holds out about a third, stably", () => {
    const ts = Array.from({ length: 21 }, (_, i) => task(i, "src", i + 1));
    const a = assignHeldOut(ts);
    expect(a.filter((t) => t.held_out)).toHaveLength(7);
    expect(
      assignHeldOut([...ts].reverse())
        .filter((t) => t.held_out)
        .map((t) => t.id)
        .sort(),
    ).toEqual(
      a
        .filter((t) => t.held_out)
        .map((t) => t.id)
        .sort(),
    );
    expect(assignHeldOut(ts.slice(0, 2)).some((t) => t.held_out)).toBe(false);
  });

  it("groups 5-10 related tasks by area and time", () => {
    const ts = [
      ...Array.from({ length: 12 }, (_, i) => task(i, "src/parser", i + 1)),
      ...Array.from({ length: 3 }, (_, i) => task(100 + i, "src/cli", i + 1)),
      ...Array.from({ length: 3 }, (_, i) => task(200 + i, "lib", i + 2)),
    ];
    const g = groupMinedTasks(ts);
    expect(g.groups.map((x) => [x.area, x.task_ids.length])).toEqual([
      ["src/parser", 10],
      ["mixed:lib,src/cli,src/parser", 8],
    ]);
    expect(g.ungrouped).toEqual([]);
    for (const x of g.groups) expect(x.task_ids.length).toBeGreaterThanOrEqual(5);
  });
});
