// TDM-186 follow-up: runner detection in monorepos (nearest enclosing manifest) and TypeScript
// under node --test (only with a loader the repo declares). No computer.
import { describe, expect, it } from "vitest";
import {
  classifyTestRuns,
  detectTestRunner,
  isCommitTest,
  MineRunnerSpecSchema,
  scriptNodeTestFlags,
} from "../src/index.js";

const detect = (files: Record<string, string>, tests: string[], testText = "") =>
  detectTestRunner({
    paths: Object.keys(files),
    read: async (p: string) => files[p],
    testFiles: tests,
    readTest: async () => testText,
  });
const pkg = (v: object) => JSON.stringify(v);

describe("nested modules", () => {
  it("runs go test from the nearest go.mod, targets relative to it", async () => {
    const r = await detect(
      { "package.json": pkg({ private: true }), "apps/api/go.mod": "module x", "README.md": "" },
      ["apps/api/internal/store/store_test.go", "apps/api/internal/store/sqlite/db_test.go"],
    );
    expect(r).toMatchObject({
      ok: true,
      runner: {
        kind: "go",
        module_dir: "apps/api",
        install_command: "cd 'apps/api' && go mod download",
        test_command:
          "cd 'apps/api' && go test -count=1 -json './internal/store' './internal/store/sqlite'",
        targets: [
          "apps/api/internal/store/store_test.go",
          "apps/api/internal/store/sqlite/db_test.go",
        ],
      },
    });
  });

  it("keeps root modules exactly as before", async () => {
    const r = await detect({ "go.mod": "module x" }, ["pkg/a_test.go"]);
    expect(r.ok && r.runner.test_command).toBe("go test -count=1 -json './pkg'");
    expect(r.ok && r.runner.install_command).toBe("go mod download");
    expect(r.ok && r.runner.module_dir).toBe(".");
  });

  it("refuses Go tests with no enclosing go.mod, and tests spanning modules", async () => {
    expect(await detect({ "apps/api/main.go": "" }, ["apps/api/a_test.go"])).toEqual({
      ok: false,
      code: "no_runner",
      reason: "Go test file apps/api/a_test.go has no enclosing go.mod",
    });
    const files = { "apps/api/go.mod": "", "apps/worker/go.mod": "" };
    expect(await detect(files, ["apps/api/a_test.go", "apps/worker/b_test.go"])).toEqual({
      ok: false,
      code: "no_runner",
      reason:
        "the changed tests span 2 modules (apps/api, apps/worker); a mined task verifies one module",
    });
  });

  it("runs cargo from the crate, and pytest from the nearest pyproject", async () => {
    const rs = await detect({ "Cargo.toml": "[workspace]", "crates/a/Cargo.toml": "" }, [
      "crates/a/tests/it.rs",
    ]);
    expect(rs.ok && rs.runner.test_command).toBe(
      "cd 'crates/a' && cargo test --no-fail-fast --color never --test 'it'",
    );
    expect(rs.ok && rs.runner.install_command).toBe("cd 'crates/a' && cargo fetch");
    const py = await detect(
      {
        "services/py/pyproject.toml": "",
        "services/py/requirements-dev.txt": "",
        "services/py/src/pkg/__init__.py": "",
        "requirements.txt": "",
      },
      ["services/py/tests/test_x.py"],
    );
    expect(py.ok && py.runner.module_dir).toBe("services/py");
    expect(py.ok && py.runner.test_command).toBe(
      "cd 'services/py' && python3 -m pytest -rA --tb=short -p no:cacheprovider --color=no 'tests/test_x.py'",
    );
    const install = py.ok ? (py.runner.install_command ?? "") : "";
    expect(install).toMatch(/^cd 'services\/py' && \{ /);
    expect(install).toContain("-r 'requirements-dev.txt'");
    expect(install).not.toContain("-r 'requirements.txt'"); // the root's, not this module's
    expect(install).toContain("-e .");
    expect(py.ok && py.runner.env.PYTHONPATH).toBe("src");
  });

  it("runs a workspace package's runner from the package, installing at the lockfile", async () => {
    const r = await detect(
      {
        "package.json": pkg({ private: true, devDependencies: { concurrently: "1" } }),
        "pnpm-lock.yaml": "",
        "apps/web/package.json": pkg({ devDependencies: { vitest: "1" } }),
      },
      ["apps/web/src/a.test.ts"],
    );
    expect(r).toMatchObject({
      ok: true,
      runner: {
        kind: "vitest",
        module_dir: "apps/web",
        install_command: "corepack pnpm install --frozen-lockfile --filter './apps/web...'",
        env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      },
    });
    expect(r.ok && r.runner.test_command).toBe(
      `cd 'apps/web' && npx --no-install vitest run --reporter=json --outputFile="$AB_RESULT" 'src/a.test.ts'`,
    );
    // a package with neither a test script nor devDependencies is not a module of its own
    const up = await detect(
      {
        "package.json": pkg({ devDependencies: { jest: "1" } }),
        "package-lock.json": "{}",
        "libs/x/package.json": pkg({ name: "x" }),
      },
      ["libs/x/a.test.js"],
    );
    expect(up.ok && up.runner.module_dir).toBe(".");
    expect(up.ok && up.runner.kind).toBe("jest");
  });

  it("yarn: --immutable with .yarnrc.yml (berry), --frozen-lockfile without (classic)", async () => {
    const base = { "package.json": pkg({ devDependencies: { jest: "1" } }), "yarn.lock": "" };
    const classic = await detect(base, ["a.test.js"]);
    expect(classic.ok && classic.runner.install_command).toBe(
      "corepack yarn install --frozen-lockfile",
    );
    const berry = await detect({ ...base, ".yarnrc.yml": "" }, ["a.test.js"]);
    expect(berry.ok && berry.runner.install_command).toBe("corepack yarn install --immutable");
  });

  it("only test data changed: the module of its nearest manifest", async () => {
    const r = await detect({ "package.json": pkg({}), "apps/api/go.mod": "" }, [
      "apps/api/testdata/case.json",
    ]);
    expect(r.ok && r.runner.test_command).toBe("cd 'apps/api' && go test -count=1 -json ./...");
  });
});

describe("TypeScript under node --test", () => {
  const gw = (p: object, extra: Record<string, string> = {}) => ({
    "package.json": pkg({ private: true }),
    "pnpm-lock.yaml": "",
    "apps/gw/package.json": pkg(p),
    "apps/gw/test/a.test.ts": "",
    "apps/gw/test/b.test.ts": "",
    "apps/gw/test/types.d.ts": "",
    ...extra,
  });
  const cmd = async (files: Record<string, string>, tests = ["apps/gw/test/a.test.ts"]) => {
    const r = await detect(files, tests, `import { test } from "node:test";`);
    if (!r.ok) throw new Error(r.reason);
    return r.runner.test_command;
  };

  it("reads the loader from the test script, exactly", async () => {
    expect(scriptNodeTestFlags("tsx --test test/*.test.ts")).toEqual(["--import", "tsx"]);
    expect(scriptNodeTestFlags("node --import tsx --test")).toEqual(["--import", "tsx"]);
    expect(scriptNodeTestFlags("node --import=tsx --test")).toEqual(["--import", "tsx"]);
    expect(scriptNodeTestFlags("tsc && node --experimental-strip-types --test")).toEqual([
      "--experimental-strip-types",
    ]);
    expect(scriptNodeTestFlags("node --loader ts-node/esm --test")).toEqual([
      "--loader",
      "ts-node/esm",
    ]);
    expect(scriptNodeTestFlags("node --test")).toEqual([]);
    expect(scriptNodeTestFlags("vitest run")).toBeUndefined();
    const c = await cmd(
      gw({ scripts: { test: "tsx --test test/*.test.ts" }, devDependencies: { tsx: "4" } }),
    );
    expect(c).toBe(
      `cd 'apps/gw' && { rc=0; for f in 'test/a.test.ts'; do printf '# anybench-file: %s\\n' 'apps/gw/'"$f"; ` +
        `node '--import' 'tsx' --test --test-reporter=tap "$f" || rc=$?; done; exit $rc; }`,
    );
    expect(
      await cmd(gw({ scripts: { test: "node --experimental-strip-types --test" } })),
    ).toContain(`node '--experimental-strip-types' --test`);
  });

  it("reads the loader from devDependencies", async () => {
    const t = { test: "node --test" };
    expect(await cmd(gw({ scripts: t, devDependencies: { tsx: "4" } }))).toContain(
      `node '--import' 'tsx' --test`,
    );
    expect(
      await cmd(gw({ type: "module", scripts: t, devDependencies: { "ts-node": "10" } })),
    ).toContain(`node '--loader' 'ts-node/esm' --test`);
    expect(await cmd(gw({ scripts: t, devDependencies: { "ts-node": "10" } }))).toContain(
      `node '--require' 'ts-node/register' --test`,
    );
    expect(await cmd(gw({ scripts: t, devDependencies: { "@swc-node/register": "1" } }))).toContain(
      `node '--require' '@swc-node/register' --test`,
    );
    expect(await cmd(gw({ scripts: t, devDependencies: { "esbuild-register": "3" } }))).toContain(
      `node '--require' 'esbuild-register' --test`,
    );
  });

  it("refuses with a reason when no loader is declared", async () => {
    const r = await detect(gw({ scripts: { test: "node --test" } }), ["apps/gw/test/a.test.ts"]);
    expect(r).toEqual({
      ok: false,
      code: "no_runner",
      reason:
        "node --test on TypeScript test files needs a loader, and apps/gw/package.json declares none " +
        "(tsx / ts-node / @swc-node/register / esbuild-register, or --experimental-strip-types in its test script)",
    });
  });

  it("JavaScript tests do not pick up a TypeScript devDependency", async () => {
    const r = await detect(
      { "package.json": pkg({ scripts: { test: "node --test" }, devDependencies: { tsx: "4" } }) },
      ["test/a.test.js"],
    );
    expect(r.ok && r.runner.test_command).toContain("node --test --test-reporter=tap");
  });

  it("whole-suite fallback lists the module's .ts tests (node's discovery skips them)", async () => {
    const files = gw({ scripts: { test: "tsx --test test/*.test.ts" } });
    const r = await detect(files, ["apps/gw/test/a.test.ts", "apps/gw/test/fixtures/x.json"]);
    expect(r.ok && r.runner.targets).toEqual(["apps/gw/test/a.test.ts", "apps/gw/test/b.test.ts"]);
  });

  it("records without module_dir still parse (backward compatible)", () => {
    expect(
      MineRunnerSpecSchema.parse({
        kind: "node-test",
        install_command: null,
        test_command: "node --test",
        targets: [],
        env: {},
      }).module_dir,
    ).toBeUndefined();
    expect(() =>
      MineRunnerSpecSchema.parse({
        kind: "go",
        install_command: null,
        test_command: "go test ./...",
        targets: [],
        module_dir: "../x",
        env: {},
      }),
    ).toThrow();
  });
});

describe("classifyTestRuns", () => {
  it("keeps the 3/3 rules and sets unstable test ids aside instead of dropping the task", () => {
    const m = "missing" as const;
    expect(classifyTestRuns([m, m, m], ["pass", "pass", "pass"])).toBe("f2p");
    expect(classifyTestRuns(["fail", "fail", "fail"], ["pass", "pass", "pass"])).toBe("f2p");
    expect(classifyTestRuns(["pass", "pass", "pass"], ["pass", "pass", "pass"])).toBe("p2p");
    expect(classifyTestRuns(["pass", "pass", "pass"], ["fail", "fail", "fail"])).toBe("p2f");
    expect(classifyTestRuns(["fail", "fail", "fail"], ["pass", "fail", "pass"])).toBe(
      "flaky_target",
    );
    expect(classifyTestRuns(["fail", "pass", "fail"], ["pass", "pass", "pass"])).toBe(
      "flaky_target",
    );
    // a subtest named with a random UUID: present in one run only, never failing
    expect(classifyTestRuns([m, m, m], ["pass", m, m])).toBe("flaky_other");
    expect(classifyTestRuns(["pass", m, m], [m, "pass", m])).toBe("flaky_other");
    // missing after a failure is still a real flip
    expect(classifyTestRuns(["fail", "fail", "fail"], ["pass", m, "fail"])).toBe("flaky_target");
    expect(classifyTestRuns(["skip", "skip", "skip"], ["skip", "skip", "skip"])).toBe("none");
  });
});

describe("isCommitTest", () => {
  it("a flaky bystander in a package that failed to build does not drop the task", () => {
    const go = [
      {
        path: "apps/api/internal/api/rework_test.go",
        text: "package api\n\nfunc TestRework(t *testing.T) {}\nfunc TestReworkTwice(t *testing.T) {}\n",
      },
    ];
    const pkg = "github.com/x/api/internal/api";
    expect(isCommitTest("go", `${pkg}/TestRework`, go)).toBe(true);
    expect(isCommitTest("go", `${pkg}/TestRework/sub_case`, go)).toBe(true);
    expect(isCommitTest("go", `${pkg}/TestReworkTwice`, go)).toBe(true);
    expect(isCommitTest("go", `${pkg}/TestReworkThrice`, go)).toBe(false);
    expect(isCommitTest("go", `${pkg}/TestContention`, go)).toBe(false);
    const m = "missing" as const;
    expect(classifyTestRuns([m, m, m], ["pass", "fail", "fail"], false)).toBe("flaky_other");
    expect(classifyTestRuns([m, m, m], ["pass", "fail", "fail"], true)).toBe("flaky_target");
    // file-prefixed ids, repo- or module-relative
    const ts = [{ path: "apps/gw/test/a.test.ts", text: "" }];
    expect(isCommitTest("node-test", "apps/gw/test/a.test.ts > x", ts, "apps/gw")).toBe(true);
    expect(isCommitTest("node-test", "apps/gw/test/b.test.ts > x", ts, "apps/gw")).toBe(false);
    const py = [{ path: "svc/tests/test_a.py", text: "" }];
    expect(isCommitTest("pytest", "tests/test_a.py::test_x", py, "svc")).toBe(true);
    expect(isCommitTest("cargo", "anything", [])).toBe(true);
  });
});
