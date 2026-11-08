// TDM-186 [16.15]: test-runner detection, the commands each runner gets, and the parsers that turn
// a run's output into per-test outcomes (FAIL_TO_PASS / PASS_TO_PASS are per test, not per run).
//
// Supported: node --test (TAP), vitest / jest (jest-compatible JSON), mocha (JSON), pytest (-rA
// summary), go test -json, cargo test. Anything else is refused with a reason, never guessed.
import { shQuote } from "../drivers/cli/shell.js";
import {
  MineRunnerSpecSchema,
  type MineRunnerSpec,
  type TestOutcome,
  type TestRunnerKind,
} from "./schema.js";

export interface DetectTestRunnerInput {
  /** Every file path in the parent tree. */
  paths: readonly string[];
  /** A file's text in the parent tree, undefined when absent. */
  read(path: string): Promise<string | undefined>;
  /** The changed test files (their paths after the commit). */
  testFiles: readonly string[];
  /** A changed test file's text after the commit. */
  readTest(path: string): Promise<string | undefined>;
  /** The digest's `test_commands` (ingest), used as a hint when the manifests don't settle it. */
  testCommands?: readonly string[];
  /** Use this runner instead of detecting one. */
  force?: TestRunnerKind;
  /** No changed test file is runnable (only data / fixtures changed): run the whole suite. Default true. */
  suiteFallback?: boolean;
}

export type DetectTestRunnerResult =
  | { ok: true; runner: MineRunnerSpec }
  | { ok: false; code: "no_runner" | "no_runnable_tests"; reason: string };

const BASE_ENV: Record<string, string> = {
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  TZ: "UTC",
  COLUMNS: "300",
};

const HELPER_DIR_RE =
  /(^|\/)(fixtures?|__fixtures__|__snapshots__|__mocks__|helpers?|support|utils?|data|testdata)\//i;
const JS_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/;
const NODE_TEST_RE =
  /(\.test|-test|_test)\.[cm]?js$|(^|\/)test-[^/]*\.[cm]?js$|(^|\/)test\.[cm]?js$|(^|\/)tests?\/(.+\/)?[^/]+\.[cm]?js$/;
const PY_TEST_RE = /(^|\/)test_[^/]*\.py$|_test\.py$/;

export function isRunnableTestFile(kind: TestRunnerKind, path: string): boolean {
  switch (kind) {
    case "node-test":
      return NODE_TEST_RE.test(path) && !HELPER_DIR_RE.test(path);
    case "vitest":
    case "jest":
      return JS_TEST_RE.test(path) && !HELPER_DIR_RE.test(path);
    case "mocha":
      return (
        (JS_TEST_RE.test(path) || /(^|\/)tests?\/(.+\/)?[^/]+\.[cm]?[jt]s$/.test(path)) &&
        !HELPER_DIR_RE.test(path)
      );
    case "pytest":
      return PY_TEST_RE.test(path);
    case "go":
      return path.endsWith("_test.go");
    case "cargo":
      return /(^|\/)tests\/[^/]+\.rs$/.test(path);
  }
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function parsePackageJson(text: string | undefined): PackageJson | undefined {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

function nodeInstall(paths: ReadonlySet<string>, pkg: PackageJson): string | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (Object.keys(deps).length === 0) return null;
  if (paths.has("package-lock.json") || paths.has("npm-shrinkwrap.json"))
    return "npm ci --no-audit --no-fund";
  if (paths.has("pnpm-lock.yaml")) return "corepack pnpm install --frozen-lockfile";
  if (paths.has("yarn.lock")) return "corepack yarn install";
  return "npm install --no-audit --no-fund --no-package-lock";
}

const UNSUPPORTED_NODE = ["ava", "tape", "tap", "uvu", "jasmine", "lab", "karma", "qunit"];

async function detectNode(
  input: DetectTestRunnerInput,
  pathSet: ReadonlySet<string>,
): Promise<{ kind: TestRunnerKind; install: string | null } | { reason: string }> {
  const pkg = parsePackageJson(await input.read("package.json"));
  if (!pkg) return { reason: "no readable package.json at the repo root" };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = `${pkg.scripts?.test ?? ""} ${(input.testCommands ?? []).join(" ")}`;
  const has = (name: string): boolean =>
    name in deps || new RegExp(`(^|[\\s/;&|(])${name}(\\s|$|[;&|)])`).test(script);
  const install = nodeInstall(pathSet, pkg);
  if (has("vitest")) return { kind: "vitest", install };
  if (has("jest")) return { kind: "jest", install };
  if (has("mocha")) return { kind: "mocha", install };
  if (/node\s+(--[a-z-]+\s+)*--test\b/.test(script)) return { kind: "node-test", install };
  for (const t of input.testFiles) {
    const text = await input.readTest(t);
    if (text && /["']node:test["']/.test(text)) return { kind: "node-test", install };
  }
  const other = UNSUPPORTED_NODE.find(has);
  if (other) return { reason: `test runner ${other} is not supported yet` };
  return {
    reason: "package.json names no supported test runner (node --test, vitest, jest, mocha)",
  };
}

function pythonInstall(paths: ReadonlySet<string>): string {
  const parts = ["python3 -m pip install -q pytest"];
  for (const f of [
    "requirements.txt",
    "requirements-dev.txt",
    "requirements-test.txt",
    "requirements_dev.txt",
    "requirements_test.txt",
    "dev-requirements.txt",
    "test-requirements.txt",
    "requirements/test.txt",
    "requirements/dev.txt",
    "requirements/tests.txt",
    "tests/requirements.txt",
    "test/requirements.txt",
  ]) {
    if (paths.has(f)) parts.push(`python3 -m pip install -q -r ${shQuote(f)}`);
  }
  if (paths.has("pyproject.toml") || paths.has("setup.py")) {
    parts.push(
      "{ python3 -m pip install -q -e . || echo 'anybench: editable install failed; testing from the source tree' >&2; }",
    );
  }
  return parts.join(" && ");
}

const langOf = (p: string): "node" | "python" | "go" | "rust" | undefined =>
  /\.[cm]?[jt]sx?$/.test(p)
    ? "node"
    : p.endsWith(".py")
      ? "python"
      : p.endsWith(".go")
        ? "go"
        : p.endsWith(".rs")
          ? "rust"
          : undefined;

function testCommand(kind: TestRunnerKind, targets: readonly string[]): string {
  const files = targets.map(shQuote).join(" ");
  switch (kind) {
    case "node-test":
      // One process per file, so every test id carries its file (node's TAP does not).
      return targets.length === 0
        ? "node --test --test-reporter=tap"
        : `rc=0; for f in ${files}; do printf '# anybench-file: %s\\n' "$f"; node --test --test-reporter=tap "$f" || rc=$?; done; exit $rc`;
    case "vitest":
      return `npx --no-install vitest run --reporter=json --outputFile="$AB_RESULT"${files ? ` ${files}` : ""}`;
    case "jest":
      return `npx --no-install jest --ci --json --outputFile="$AB_RESULT"${files ? ` --runTestsByPath ${files}` : ""}`;
    case "mocha":
      return `npx --no-install mocha --reporter json --reporter-option output="$AB_RESULT"${files ? ` ${files}` : ""}`;
    case "pytest":
      return `python3 -m pytest -rA --tb=short -p no:cacheprovider --color=no${files ? ` ${files}` : ""}`;
    case "go": {
      const pkgs = [
        ...new Set(
          targets.map((t) => `./${t.includes("/") ? t.slice(0, t.lastIndexOf("/")) : "."}`),
        ),
      ];
      return `go test -count=1 -json ${pkgs.length > 0 ? pkgs.map(shQuote).join(" ") : "./..."}`;
    }
    case "cargo": {
      const names = targets.map((t) => (t.split("/").pop() ?? t).replace(/\.rs$/, ""));
      return `cargo test --no-fail-fast --color never${names.map((n) => ` --test ${shQuote(n)}`).join("")}`;
    }
  }
}

const RESULT_FILE_KINDS: ReadonlySet<TestRunnerKind> = new Set(["vitest", "jest", "mocha"]);
export function runnerWritesResultFile(kind: TestRunnerKind): boolean {
  return RESULT_FILE_KINDS.has(kind);
}

/** Build the runner spec for a kind, install and targets. */
export function makeRunnerSpec(
  kind: TestRunnerKind,
  install: string | null,
  targets: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): MineRunnerSpec {
  const env: Record<string, string> = { ...BASE_ENV, ...extraEnv };
  if (kind === "pytest") {
    Object.assign(env, {
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_ROOT_USER_ACTION: "ignore",
      PIP_BREAK_SYSTEM_PACKAGES: "1",
      SETUPTOOLS_SCM_PRETEND_VERSION: "0.0.0",
      PYTHONDONTWRITEBYTECODE: "1",
    });
  }
  if (kind === "go") env.GOFLAGS = "-mod=mod";
  if (install?.startsWith("corepack")) env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  return MineRunnerSpecSchema.parse({
    kind,
    install_command: install,
    test_command: testCommand(kind, targets),
    targets: [...targets],
    env,
  });
}

/** Pick the runner for one candidate from the parent tree, or refuse with a reason. */
export async function detectTestRunner(
  input: DetectTestRunnerInput,
): Promise<DetectTestRunnerResult> {
  const pathSet = new Set(input.paths);
  const lang = input.force
    ? (
        {
          "node-test": "node",
          vitest: "node",
          jest: "node",
          mocha: "node",
          pytest: "python",
          go: "go",
          cargo: "rust",
        } as const
      )[input.force]
    : (input.testFiles.map(langOf).find((l) => l !== undefined) ??
      (pathSet.has("package.json")
        ? "node"
        : pathSet.has("pyproject.toml") || pathSet.has("setup.py")
          ? "python"
          : pathSet.has("go.mod")
            ? "go"
            : pathSet.has("Cargo.toml")
              ? "rust"
              : undefined));
  let kind: TestRunnerKind;
  let install: string | null;
  const extraEnv: Record<string, string> = {};
  switch (lang) {
    case "node": {
      const d = await detectNode(input, pathSet);
      if ("reason" in d) return { ok: false, code: "no_runner", reason: d.reason };
      kind = input.force ?? d.kind;
      install = d.install;
      if (kind === "node-test" && input.testFiles.some((t) => /\.[cm]?tsx?$/.test(t))) {
        return {
          ok: false,
          code: "no_runner",
          reason: "node --test on TypeScript test files needs a loader; not supported yet",
        };
      }
      break;
    }
    case "python":
      kind = "pytest";
      install = pythonInstall(pathSet);
      // src layout: importable even when the editable install fails (old build backends).
      if (input.paths.some((p) => /^src\/[^/]+\/__init__\.py$/.test(p)))
        extraEnv.PYTHONPATH = "src";
      break;
    case "go":
      if (!pathSet.has("go.mod"))
        return { ok: false, code: "no_runner", reason: "Go tests without a root go.mod" };
      kind = "go";
      install = "go mod download";
      break;
    case "rust":
      if (!pathSet.has("Cargo.toml"))
        return { ok: false, code: "no_runner", reason: "Rust tests without a root Cargo.toml" };
      kind = "cargo";
      install = "cargo fetch";
      break;
    default:
      return {
        ok: false,
        code: "no_runner",
        reason:
          "no supported language/manifest (package.json, pyproject.toml/setup.py, go.mod, Cargo.toml)",
      };
  }
  let targets = input.testFiles.filter((t) => isRunnableTestFile(kind, t));
  // Changed test DATA (fixtures, expected outputs) is read by tests the commit did not touch:
  // run the whole suite so those tests are graded too.
  const data = input.testFiles.filter(
    (t) => !isRunnableTestFile(kind, t) && langOf(t) === undefined,
  );
  if (data.length > 0 && input.suiteFallback !== false) targets = [];
  if (targets.length === 0 && input.suiteFallback === false) {
    return {
      ok: false,
      code: "no_runnable_tests",
      reason: `no changed test file is a ${kind} test file (${input.testFiles.join(", ")})`,
    };
  }
  return { ok: true, runner: makeRunnerSpec(kind, install, targets, extraEnv) };
}

// ---------------------------------------------------------------------------------------------
// Parsing a run

export interface ParsedTest {
  outcome: TestOutcome;
  /** Failure text, ANSI and stack frames stripped, capped. */
  message?: string;
}

export interface ParsedRun {
  tests: Map<string, ParsedTest>;
  /** Errors not tied to one test (a test file that failed to load, a build error), by file/package. */
  fileErrors: Map<string, string>;
}

export interface ParseRunInput {
  /** stdout+stderr of the test command. */
  log: string;
  /** "$AB_RESULT" contents, when the runner writes one. */
  result?: string;
  /** Absolute workspace path, stripped from file names in results. */
  workspace: string;
}

const MESSAGE_CAP = 2000;

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

export function cleanMessage(s: string): string {
  const kept = stripAnsi(s)
    .split("\n")
    .filter((l) => !/^\s+at\s/.test(l) && !/^\s*-\s*\/.*:\d+:\d+\)?$/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return kept.length > MESSAGE_CAP ? `${kept.slice(0, MESSAGE_CAP)}…` : kept;
}

function relTo(workspace: string, file: string): string {
  const ws = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return file.startsWith(ws) ? file.slice(ws.length) : file;
}

function yamlMessage(block: readonly string[]): string | undefined {
  let error: string | undefined;
  const extra: string[] = [];
  for (let i = 0; i < block.length; i++) {
    const line = block[i] ?? "";
    const m = /^(\s*)(error|expected|actual):\s?(.*)$/.exec(line);
    if (!m) continue;
    const [, ind = "", key, val = ""] = m;
    let value = val;
    if (/^[|>][-+]?$/.test(val)) {
      const body: string[] = [];
      for (let j = i + 1; j < block.length; j++) {
        const l = block[j] ?? "";
        if (l.trim() !== "" && l.length - l.trimStart().length <= ind.length) break;
        body.push(l.trim());
      }
      value = body.join("\n").trim();
    } else {
      value = value.replace(/^'(.*)'$/s, "$1").replace(/''/g, "'");
    }
    if (key === "error") error = value;
    else extra.push(`${key}: ${value}`);
  }
  if (error === undefined && extra.length === 0) return undefined;
  return [error, ...extra].filter(Boolean).join("\n");
}

const TAP_SUMMARY_RE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \d/;

/** node --test TAP, optionally split into files by `# anybench-file: <path>` markers. */
export function parseNodeTap(log: string): ParsedRun {
  const tests = new Map<string, ParsedTest>();
  const fileErrors = new Map<string, string>();
  const lines = log.split("\n");
  let file: string | undefined;
  let stack: string[] = [];
  let hasChild: boolean[] = [];
  let diag: string[] = [];
  const key = (path: readonly string[]): string => [...(file ? [file] : []), ...path].join(" > ");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const marker = /^# anybench-file: (.+)$/.exec(line);
    if (marker) {
      if (file && diag.length > 0) fileErrors.set(file, cleanMessage(diag.join("\n")));
      file = marker[1];
      stack = [];
      hasChild = [];
      diag = [];
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const depth = Math.floor(indent / 4);
    const sub = /^\s*# Subtest: (.*)$/.exec(line);
    if (sub) {
      stack = stack.slice(0, depth);
      stack[depth] = sub[1] ?? "";
      hasChild = hasChild.slice(0, depth + 1);
      hasChild[depth] = false;
      if (depth > 0) hasChild[depth - 1] = true;
      continue;
    }
    const ok = /^\s*(not )?ok \d+ - (.*?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/i.exec(line);
    if (ok) {
      const name = (ok[2] ?? "").replace(/\\#/g, "#");
      const failed = ok[1] !== undefined;
      const skipped = ok[3] !== undefined;
      const block: string[] = [];
      if ((lines[i + 1] ?? "").trim() === "---") {
        let j = i + 2;
        for (; j < lines.length && (lines[j] ?? "").trim() !== "..."; j++)
          block.push(lines[j] ?? "");
        i = j;
      }
      if (hasChild[depth] === true) continue; // a suite: its leaves carry the outcome
      const id = key([...stack.slice(0, depth), name]);
      const msg = failed ? yamlMessage(block) : undefined;
      tests.set(id, {
        outcome: skipped ? "skip" : failed ? "fail" : "pass",
        ...(msg !== undefined ? { message: cleanMessage(msg) } : {}),
      });
      continue;
    }
    if (depth === 0 && line.startsWith("# ") && !TAP_SUMMARY_RE.test(line))
      diag.push(line.slice(2));
  }
  if (file && diag.length > 0) fileErrors.set(file, cleanMessage(diag.join("\n")));
  else if (!file && diag.length > 0) fileErrors.set("", cleanMessage(diag.join("\n")));
  return { tests, fileErrors };
}

interface JestJson {
  testResults?: Array<{
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: Array<{
      ancestorTitles?: string[];
      title?: string;
      status?: string;
      failureMessages?: string[];
    }>;
  }>;
}

/** jest --json and vitest --reporter=json (the same shape). */
export function parseJestJson(result: string, workspace: string): ParsedRun {
  const tests = new Map<string, ParsedTest>();
  const fileErrors = new Map<string, string>();
  const json = JSON.parse(result) as JestJson;
  for (const tr of json.testResults ?? []) {
    const file = relTo(workspace, tr.name ?? "");
    const results = tr.assertionResults ?? [];
    if (results.length === 0 && (tr.status === "failed" || tr.message)) {
      fileErrors.set(file, cleanMessage(tr.message ?? "test file failed"));
    }
    for (const a of results) {
      const id = [file, ...(a.ancestorTitles ?? []), a.title ?? ""].join(" > ");
      const outcome: TestOutcome =
        a.status === "passed" ? "pass" : a.status === "failed" ? "fail" : "skip";
      const msg = (a.failureMessages ?? []).join("\n");
      tests.set(id, {
        outcome,
        ...(outcome === "fail" && msg ? { message: cleanMessage(msg) } : {}),
      });
    }
  }
  return { tests, fileErrors };
}

interface MochaTest {
  fullTitle?: string;
  title?: string;
  file?: string;
  err?: { message?: string; stack?: string };
}

export function parseMochaJson(result: string, workspace: string): ParsedRun {
  const tests = new Map<string, ParsedTest>();
  const json = JSON.parse(result) as {
    passes?: MochaTest[];
    failures?: MochaTest[];
    pending?: MochaTest[];
  };
  const put = (list: MochaTest[] | undefined, outcome: TestOutcome): void => {
    for (const t of list ?? []) {
      const id = `${relTo(workspace, t.file ?? "")} > ${t.fullTitle ?? t.title ?? ""}`;
      const msg = t.err?.message;
      tests.set(id, {
        outcome,
        ...(outcome === "fail" && msg ? { message: cleanMessage(msg) } : {}),
      });
    }
  };
  put(json.passes, "pass");
  put(json.pending, "skip");
  put(json.failures, "fail");
  return { tests, fileErrors: new Map() };
}

/** pytest -rA: the short test summary lines, plus the `E ` lines of each failure section. */
export function parsePytest(log: string): ParsedRun {
  const tests = new Map<string, ParsedTest>();
  const fileErrors = new Map<string, string>();
  const lines = stripAnsi(log).split("\n");
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const h = /^_{3,} (.+?) _{3,}$/.exec(line);
    if (h) {
      current = [];
      sections.set(h[1] ?? "", current);
      continue;
    }
    if (/^={3,} .* ={3,}$/.test(line)) current = undefined;
    const e = /^E\s+(.*)$/.exec(line);
    if (e && current) current.push(e[1] ?? "");
  }
  for (const line of lines) {
    const m = /^(PASSED|FAILED|ERROR|XFAIL|XPASS) (\S+(?:\[[^\]]*\])?)(?: - (.*))?$/.exec(line);
    if (!m) continue;
    const [, status, id = "", summary] = m;
    if (!id.includes("::")) {
      if (status === "ERROR") {
        const sec = sections.get(`ERROR collecting ${id}`) ?? [];
        fileErrors.set(
          id,
          cleanMessage(sec.length > 0 ? sec.join("\n") : (summary ?? "collection error")),
        );
      }
      continue;
    }
    const outcome: TestOutcome =
      status === "PASSED" || status === "XPASS" ? "pass" : status === "XFAIL" ? "skip" : "fail";
    const sec = sections.get(id.split("::").slice(1).join(".")) ?? [];
    const msg = sec.length > 0 ? sec.join("\n") : summary;
    tests.set(id, {
      outcome,
      ...(outcome === "fail" && msg ? { message: cleanMessage(msg) } : {}),
    });
  }
  // pytest ≥ 9 reports unittest subTest failures as `SUBFAILED[<label>] <id> - <msg>` while the
  // parent test itself says PASSED: a failed subtest fails its parent.
  const subFails = new Map<string, string[]>();
  for (const line of lines) {
    const m = /^SUBFAILED(\[[^\]]*\]|\([^)]*\))? (\S+?)(?: - (.*))?$/.exec(line);
    if (!m) continue;
    const [, label = "", id = "", summary = ""] = m;
    (subFails.get(id) ?? subFails.set(id, []).get(id))?.push(`${label} ${summary}`.trim());
  }
  for (const [id, msgs] of subFails) {
    tests.set(id, { outcome: "fail", message: cleanMessage(msgs.join("\n")) });
  }
  return { tests, fileErrors };
}

/** go test -json event lines. Non-JSON lines (build errors) become a `(build)` error. */
export function parseGoJson(log: string): ParsedRun {
  const tests = new Map<string, ParsedTest>();
  const fileErrors = new Map<string, string>();
  const output = new Map<string, string[]>();
  const build: string[] = [];
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    let ev: { Action?: string; Package?: string; Test?: string; Output?: string };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      build.push(line);
      continue;
    }
    const k = ev.Test ? `${ev.Package ?? ""}/${ev.Test}` : `${ev.Package ?? ""}`;
    if (ev.Action === "output" || ev.Action === "build-output") {
      const out = ev.Output ?? "";
      if (!/^(=== (RUN|PAUSE|CONT)|--- (PASS|FAIL|SKIP))/.test(out.trimStart()))
        (output.get(k) ?? output.set(k, []).get(k))?.push(out.replace(/\n$/, ""));
      continue;
    }
    if (ev.Action !== "pass" && ev.Action !== "fail" && ev.Action !== "skip") continue;
    if (ev.Test) {
      const outcome: TestOutcome = ev.Action;
      const msg = (output.get(k) ?? []).join("\n");
      tests.set(k, {
        outcome,
        ...(outcome === "fail" && msg ? { message: cleanMessage(msg) } : {}),
      });
    } else if (ev.Action === "fail") {
      fileErrors.set(k, cleanMessage((output.get(k) ?? ["package failed"]).join("\n")));
    }
  }
  if (build.length > 0) fileErrors.set("(build)", cleanMessage(build.join("\n")));
  return { tests, fileErrors };
}

/** cargo test's `test name ... ok|FAILED|ignored` lines and `---- name stdout ----` sections. */
export function parseCargo(log: string): ParsedRun {
  const tests = new Map<string, ParsedTest>();
  const fileErrors = new Map<string, string>();
  const lines = stripAnsi(log).split("\n");
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const h = /^---- (\S+) stdout ----$/.exec(line);
    if (h) {
      current = [];
      sections.set(h[1] ?? "", current);
      continue;
    }
    if (/^(failures:|test result:)/.test(line)) current = undefined;
    else if (current) current.push(line);
  }
  for (const line of lines) {
    const m = /^test (\S+) \.\.\. (ok|FAILED|ignored)$/.exec(line);
    if (!m) continue;
    const outcome: TestOutcome = m[2] === "ok" ? "pass" : m[2] === "FAILED" ? "fail" : "skip";
    const msg = (sections.get(m[1] ?? "") ?? []).join("\n");
    tests.set(m[1] ?? "", {
      outcome,
      ...(outcome === "fail" && msg ? { message: cleanMessage(msg) } : {}),
    });
  }
  if (tests.size === 0) {
    const errs = lines.filter((l) => /^error(\[E\d+\])?:/.test(l));
    if (errs.length > 0) fileErrors.set("(build)", cleanMessage(errs.join("\n")));
  }
  return { tests, fileErrors };
}

/** Parse one run of `kind`. A missing or unreadable result file parses as no tests. */
export function parseTestRun(kind: TestRunnerKind, input: ParseRunInput): ParsedRun {
  switch (kind) {
    case "node-test":
      return parseNodeTap(input.log);
    case "pytest":
      return parsePytest(input.log);
    case "go":
      return parseGoJson(input.log);
    case "cargo":
      return parseCargo(input.log);
    case "vitest":
    case "jest":
    case "mocha": {
      let result = input.result;
      if (!result && kind === "mocha") {
        // mocha < 9 has no reporter output option: the JSON is on stdout.
        const at = input.log.indexOf('{\n  "stats"');
        if (at >= 0) result = input.log.slice(at, input.log.lastIndexOf("}") + 1);
      }
      if (!result) return { tests: new Map(), fileErrors: new Map() };
      try {
        return kind === "mocha"
          ? parseMochaJson(result, input.workspace)
          : parseJestJson(result, input.workspace);
      } catch {
        return { tests: new Map(), fileErrors: new Map() };
      }
    }
  }
}
