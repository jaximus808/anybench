// TDM-186 [16.15]: test-runner detection, the commands each runner gets, and the parsers that turn
// a run's output into per-test outcomes (FAIL_TO_PASS / PASS_TO_PASS are per test, not per run).
//
// Supported: node --test (TAP), vitest / jest (jest-compatible JSON), mocha (JSON), pytest (-rA
// summary), go test -json, cargo test. Anything else is refused with a reason, never guessed.
// Monorepos: each runner runs from the nearest manifest enclosing the changed tests (apps/api/go.mod,
// packages/x/package.json, ...); TypeScript under node --test only with a loader the repo declares.
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
// .ts test files only reach node --test when the module declares a TypeScript loader.
const NODE_TEST_RE =
  /(\.test|-test|_test)\.[cm]?[jt]s$|(^|\/)test-[^/]*\.[cm]?[jt]s$|(^|\/)test\.[cm]?[jt]s$|(^|\/)tests?\/(.+\/)?[^/]+\.[cm]?[jt]s$/;
const PY_TEST_RE = /(^|\/)test_[^/]*\.py$|_test\.py$/;
const TS_RE = /\.[cm]?tsx?$/;
const DTS_RE = /\.d\.[cm]?ts$/;

export function isRunnableTestFile(kind: TestRunnerKind, path: string): boolean {
  switch (kind) {
    case "node-test":
      return NODE_TEST_RE.test(path) && !HELPER_DIR_RE.test(path) && !DTS_RE.test(path);
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

// ---------------------------------------------------------------------------------------------
// Modules: a monorepo's tests run from the nearest enclosing manifest, not the repo root.

type Lang = "node" | "python" | "go" | "rust";
const MANIFESTS: Record<Lang, readonly string[]> = {
  node: ["package.json"],
  python: ["pyproject.toml", "setup.cfg", "setup.py"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
};
const LANG_ORDER: readonly Lang[] = ["node", "python", "go", "rust"];
const FORCE_LANG: Record<TestRunnerKind, Lang> = {
  "node-test": "node",
  vitest: "node",
  jest: "node",
  mocha: "node",
  pytest: "python",
  go: "go",
  cargo: "rust",
};

/** The directories enclosing `path`, nearest first, ending with "." (the repo root). */
function enclosingDirs(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  const out: string[] = [];
  for (let n = parts.length; n > 0; n--) out.push(parts.slice(0, n).join("/"));
  out.push(".");
  return out;
}
const inDir = (dir: string, name: string): string => (dir === "." ? name : `${dir}/${name}`);
const isUnder = (dir: string, path: string): boolean => dir === "." || path.startsWith(`${dir}/`);
const relToDir = (dir: string, path: string): string =>
  dir === "." ? path : path.slice(dir.length + 1);

/** `cmd` run from `dir` (a repo-relative directory), still started in the workspace root. */
function inModule(dir: string, cmd: string): string {
  if (dir === ".") return cmd;
  return `cd ${shQuote(dir)} && ${/[;&|]/.test(cmd) ? `{ ${cmd}; }` : cmd}`;
}

interface PackageJson {
  type?: string;
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

/**
 * The module of one changed test file: the nearest enclosing manifest of `lang`. For node, the
 * nearest package.json with its own test script or devDependencies (a workspace package), else the
 * root package.json. Python falls back to the root (requirements-only repos); Go and Rust need one.
 */
async function moduleOf(
  lang: Lang,
  file: string,
  pathSet: ReadonlySet<string>,
  read: (path: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (lang === "node") {
    let nearest: string | undefined;
    for (const dir of enclosingDirs(file)) {
      const f = inDir(dir, "package.json");
      if (!pathSet.has(f)) continue;
      nearest ??= dir;
      const pkg = parsePackageJson(await read(f));
      if (pkg && (pkg.scripts?.test || Object.keys(pkg.devDependencies ?? {}).length > 0))
        return dir;
    }
    return pathSet.has("package.json") ? "." : nearest;
  }
  for (const dir of enclosingDirs(file)) {
    if (MANIFESTS[lang].some((m) => pathSet.has(inDir(dir, m)))) return dir;
  }
  return lang === "python" ? "." : undefined;
}

/** Only test data changed: the language of the nearest manifest enclosing it. */
function dataLang(files: readonly string[], pathSet: ReadonlySet<string>): Lang | undefined {
  for (const f of files.length > 0 ? files : ["x"]) {
    for (const dir of enclosingDirs(f)) {
      const l = LANG_ORDER.find((k) => MANIFESTS[k].some((m) => pathSet.has(inDir(dir, m))));
      if (l) return l;
    }
  }
  return undefined;
}

/** The node install, run from the dir of the nearest lockfile at or above the module. */
function nodeInstall(
  pathSet: ReadonlySet<string>,
  moduleDir: string,
  pkg: PackageJson,
): { dir: string; command: string } | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (Object.keys(deps).length === 0) return null;
  for (const dir of enclosingDirs(inDir(moduleDir, "package.json"))) {
    const has = (f: string) => pathSet.has(inDir(dir, f));
    if (has("package-lock.json") || has("npm-shrinkwrap.json"))
      return { dir, command: "npm ci --no-audit --no-fund" };
    if (has("pnpm-lock.yaml")) {
      // A workspace package: install it and its workspace deps only, not every app in the repo.
      const filter =
        dir === moduleDir ? "" : ` --filter ${shQuote(`./${relToDir(dir, moduleDir)}...`)}`;
      return { dir, command: `corepack pnpm install --frozen-lockfile${filter}` };
    }
    if (has("yarn.lock"))
      return {
        dir,
        command: has(".yarnrc.yml")
          ? "corepack yarn install --immutable"
          : "corepack yarn install --frozen-lockfile",
      };
  }
  return { dir: moduleDir, command: "npm install --no-audit --no-fund --no-package-lock" };
}

const UNSUPPORTED_NODE = ["ava", "tape", "tap", "uvu", "jasmine", "lab", "karma", "qunit"];
const NODE_TEST_SCRIPT_RE = /(^|[\s;&|(/])(node|tsx)\s+([^;&|]*\s)?--test(?=\s|$|[;&|)])/;
const LOADER_FLAG_RE = /^(--import|--loader|--experimental-loader|--require|-r)(?:=(.+))?$/;
const STRIP_TYPES_FLAGS: ReadonlySet<string> = new Set([
  "--experimental-strip-types",
  "--experimental-transform-types",
]);
const TS_LOADER_RE = /(^|\/)(tsx|ts-node|@swc-node\/register|esbuild-register|@esbuild-kit)\b/;

/**
 * The loader flags a test script gives `node --test` (`node --import tsx --test`, `tsx --test`,
 * `node --experimental-strip-types --test`), exactly as written. Undefined: no node --test there.
 */
export function scriptNodeTestFlags(script: string): string[] | undefined {
  for (const seg of script.split(/&&|\|\||[;|]/)) {
    const tok = seg.trim().split(/\s+/);
    const i = tok.findIndex((t) => t === "node" || t === "tsx" || /\/(node|tsx)$/.test(t));
    if (i < 0 || !tok.includes("--test")) continue;
    const flags: string[] = [];
    if (/(^|\/)tsx$/.test(tok[i] ?? "")) flags.push("--import", "tsx");
    for (let j = i + 1; j < tok.length && tok[j] !== "--test"; j++) {
      const t = tok[j] ?? "";
      const m = LOADER_FLAG_RE.exec(t);
      if (m) {
        const v = m[2] ?? tok[++j];
        if (v) flags.push(m[1] ?? "", v);
      } else if (STRIP_TYPES_FLAGS.has(t)) flags.push(t);
    }
    return flags;
  }
  return undefined;
}

const tsCapable = (flags: readonly string[]): boolean =>
  flags.some((f) => STRIP_TYPES_FLAGS.has(f) || TS_LOADER_RE.test(f));

/** A TypeScript loader the package declares as a dependency, as node flags. */
function dependencyLoader(pkg: PackageJson): string[] | undefined {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const esm = pkg.type === "module";
  if ("tsx" in deps) return ["--import", "tsx"];
  if ("ts-node" in deps)
    return esm ? ["--loader", "ts-node/esm"] : ["--require", "ts-node/register"];
  if ("@swc-node/register" in deps)
    return esm
      ? ["--import", "@swc-node/register/esm-register"]
      : ["--require", "@swc-node/register"];
  if ("esbuild-register" in deps)
    return esm
      ? ["--loader", "esbuild-register/loader", "--require", "esbuild-register"]
      : ["--require", "esbuild-register"];
  return undefined;
}

interface NodeDetection {
  kind: TestRunnerKind;
  install: { dir: string; command: string } | null;
  pkg: PackageJson;
  script: string;
}

async function detectNode(
  input: DetectTestRunnerInput,
  pathSet: ReadonlySet<string>,
  moduleDir: string,
  testFiles: readonly string[],
): Promise<NodeDetection | { reason: string }> {
  const pkgPath = inDir(moduleDir, "package.json");
  const pkg = parsePackageJson(await input.read(pkgPath));
  if (!pkg)
    return {
      reason:
        moduleDir === "." ? "no readable package.json at the repo root" : `no readable ${pkgPath}`,
    };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  // digest.test_commands are the repo root's: a hint for the root module only.
  const hints = moduleDir === "." ? (input.testCommands ?? []) : [];
  const script = `${pkg.scripts?.test ?? ""} ${hints.join(" ")}`;
  const has = (name: string): boolean =>
    name in deps || new RegExp(`(^|[\\s/;&|(])${name}(\\s|$|[;&|)])`).test(script);
  const install = nodeInstall(pathSet, moduleDir, pkg);
  const found = (kind: TestRunnerKind): NodeDetection => ({ kind, install, pkg, script });
  if (has("vitest")) return found("vitest");
  if (has("jest")) return found("jest");
  if (has("mocha")) return found("mocha");
  if (NODE_TEST_SCRIPT_RE.test(script)) return found("node-test");
  for (const t of testFiles) {
    const text = await input.readTest(t);
    if (text && /["']node:test["']/.test(text)) return found("node-test");
  }
  const other = UNSUPPORTED_NODE.find(has);
  if (other) return { reason: `test runner ${other} is not supported yet` };
  return {
    reason: `${pkgPath} names no supported test runner (node --test, vitest, jest, mocha)`,
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

const langOf = (p: string): Lang | undefined =>
  /\.[cm]?[jt]sx?$/.test(p)
    ? "node"
    : p.endsWith(".py")
      ? "python"
      : p.endsWith(".go")
        ? "go"
        : p.endsWith(".rs")
          ? "rust"
          : undefined;

/** Where and how a runner runs inside the repo. */
export interface RunnerLayout {
  /** The module the tests run from (repo-relative; "." = the root). Default ".". */
  moduleDir?: string;
  /** Where the install runs (the lockfile's dir for node workspaces). Default `moduleDir`. */
  installDir?: string;
  /** node --test only: the loader flags placed before `--test` (e.g. ["--import", "tsx"]). */
  nodeFlags?: readonly string[];
}

/** The test command, run from the module dir; `targets` are relative to it. */
function testCommand(
  kind: TestRunnerKind,
  targets: readonly string[],
  moduleDir: string,
  nodeFlags: readonly string[],
): string {
  const files = targets.map(shQuote).join(" ");
  switch (kind) {
    case "node-test": {
      const node = ["node", ...nodeFlags.map(shQuote), "--test", "--test-reporter=tap"].join(" ");
      // One process per file, so every test id carries its file (node's TAP does not). The
      // marker names the file from the repo root, the same ids as the other runners.
      const label = moduleDir === "." ? '"$f"' : `${shQuote(`${moduleDir}/`)}"$f"`;
      return targets.length === 0
        ? node
        : `rc=0; for f in ${files}; do printf '# anybench-file: %s\\n' ${label}; ${node} "$f" || rc=$?; done; exit $rc`;
    }
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

/**
 * Build the runner spec for a kind, install and targets (repo-relative). With a `layout` whose
 * module is not the root, both commands `cd` into their dir first, so they still run from the
 * workspace root exactly as recorded.
 */
export function makeRunnerSpec(
  kind: TestRunnerKind,
  install: string | null,
  targets: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
  layout: RunnerLayout = {},
): MineRunnerSpec {
  const moduleDir = layout.moduleDir ?? ".";
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
  const rel = targets.map((t) => (isUnder(moduleDir, t) ? relToDir(moduleDir, t) : t));
  return MineRunnerSpecSchema.parse({
    kind,
    install_command: install === null ? null : inModule(layout.installDir ?? moduleDir, install),
    test_command: inModule(moduleDir, testCommand(kind, rel, moduleDir, layout.nodeFlags ?? [])),
    targets: [...targets],
    module_dir: moduleDir,
    env,
  });
}

/** Pick the runner for one candidate from the parent tree, or refuse with a reason. */
export async function detectTestRunner(
  input: DetectTestRunnerInput,
): Promise<DetectTestRunnerResult> {
  const pathSet = new Set(input.paths);
  const refuse = (reason: string): DetectTestRunnerResult => ({
    ok: false,
    code: "no_runner",
    reason,
  });
  const dataFiles = input.testFiles.filter((t) => langOf(t) === undefined);
  const lang: Lang | undefined = input.force
    ? FORCE_LANG[input.force]
    : (input.testFiles.map(langOf).find((l) => l !== undefined) ?? dataLang(dataFiles, pathSet));
  if (!lang)
    return refuse(
      "no supported language/manifest (package.json, pyproject.toml/setup.py, go.mod, Cargo.toml)",
    );

  // The module: nearest manifest of the changed test files (their code files, else their data).
  const code = input.testFiles.filter((t) => langOf(t) === lang);
  const anchors = code.length > 0 ? code : dataFiles;
  const modules = new Map<string, string[]>();
  for (const t of anchors) {
    const m = await moduleOf(lang, t, pathSet, input.read);
    if (m === undefined) {
      const kindName = lang === "go" ? "Go" : "Rust";
      return refuse(`${kindName} test file ${t} has no enclosing ${MANIFESTS[lang].join(" / ")}`);
    }
    (modules.get(m) ?? modules.set(m, []).get(m))?.push(t);
  }
  if (modules.size > 1) {
    const list = [...modules.keys()].sort().join(", ");
    return refuse(
      `the changed tests span ${modules.size} modules (${list}); a mined task verifies one module`,
    );
  }
  const moduleDir = [...modules.keys()][0] ?? ".";
  const moduleCode = code.filter((t) => isUnder(moduleDir, t));

  let kind: TestRunnerKind;
  let install: string | null;
  let installDir = moduleDir;
  let nodeFlags: string[] = [];
  const extraEnv: Record<string, string> = {};
  switch (lang) {
    case "node": {
      const d = await detectNode(input, pathSet, moduleDir, moduleCode);
      if ("reason" in d) return refuse(d.reason);
      kind = input.force ?? d.kind;
      install = d.install?.command ?? null;
      installDir = d.install?.dir ?? moduleDir;
      if (kind === "node-test") {
        const ts = moduleCode.some((t) => TS_RE.test(t) && !DTS_RE.test(t));
        const declared = scriptNodeTestFlags(d.script) ?? [];
        if (tsCapable(declared)) nodeFlags = declared;
        else if (ts) {
          const dep = dependencyLoader(d.pkg);
          if (!dep)
            return refuse(
              `node --test on TypeScript test files needs a loader, and ${inDir(moduleDir, "package.json")} declares none ` +
                "(tsx / ts-node / @swc-node/register / esbuild-register, or --experimental-strip-types in its test script)",
            );
          nodeFlags = [...declared, ...dep];
        } else nodeFlags = declared;
      }
      break;
    }
    case "python": {
      kind = "pytest";
      const local = new Set(
        input.paths.filter((p) => isUnder(moduleDir, p)).map((p) => relToDir(moduleDir, p)),
      );
      install = pythonInstall(local);
      // src layout: importable even when the editable install fails (old build backends).
      if ([...local].some((p) => /^src\/[^/]+\/__init__\.py$/.test(p))) extraEnv.PYTHONPATH = "src";
      break;
    }
    case "go":
      if (!pathSet.has(inDir(moduleDir, "go.mod")))
        return refuse("Go tests without an enclosing go.mod");
      kind = "go";
      install = "go mod download";
      break;
    case "rust":
      if (!pathSet.has(inDir(moduleDir, "Cargo.toml")))
        return refuse("Rust tests without an enclosing Cargo.toml");
      kind = "cargo";
      install = "cargo fetch";
      break;
  }
  const inModuleDir = (t: string) => isUnder(moduleDir, t);
  let targets = input.testFiles.filter((t) => inModuleDir(t) && isRunnableTestFile(kind, t));
  // Changed test DATA (fixtures, expected outputs) is read by tests the commit did not touch:
  // run the whole suite (of the module) so those tests are graded too.
  const data = dataFiles.filter((t) => inModuleDir(t) && !isRunnableTestFile(kind, t));
  if (data.length > 0 && input.suiteFallback !== false) targets = [];
  if (targets.length === 0 && input.suiteFallback === false) {
    return {
      ok: false,
      code: "no_runnable_tests",
      reason: `no changed test file is a ${kind} test file (${input.testFiles.join(", ")})`,
    };
  }
  if (targets.length === 0 && kind === "node-test" && tsCapable(nodeFlags)) {
    // node's own discovery skips .ts files: list the module's test files instead.
    const all = new Set([...input.paths, ...input.testFiles]);
    targets = [...all]
      .filter((t) => inModuleDir(t) && isRunnableTestFile(kind, t) && !t.includes("node_modules/"))
      .sort();
  }
  return {
    ok: true,
    runner: makeRunnerSpec(kind, install, targets, extraEnv, { moduleDir, installDir, nodeFlags }),
  };
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

/**
 * TDM-60: the parser internals the generated mined-task gate embeds (as their compiled source),
 * so the scoring computer grades with exactly the parsers the miner verified the task with.
 */
export const MINE_PARSER_INTERNALS = { relTo, yamlMessage, TAP_SUMMARY_RE, MESSAGE_CAP } as const;
