// TDM-186 [16.15]: write verified mined tasks as kit files.
//
//   workloads/<id>/input/**             the parent tree (what the repo looked like before the fix)
//   workloads/<id>/instruction.md       a placeholder; the kit designer (TDM-60) writes the real one
//   workloads/<id>/setup.sh             input → EVAL_WS as a ONE-commit git repo (no history), + install
//   gates/<gate>/<id>/tests.json        runner, FAIL_TO_PASS, PASS_TO_PASS, hidden test paths
//   gates/<gate>/<id>/files/**          the hidden test files, at their repo paths
//   proof/oracle/<id>/**                the fix files, at their repo paths (an overlay on the workspace)
//   mined/<id>.json                     the task record (designer material; never shipped to a computer)
//
// Nothing answer-bearing lands under workloads/: after writing, `checkMinedTaskLeaks` re-reads the
// workload dir and refuses (MineLeakError) if it holds a hidden test file, a fix file, a `.git`, the
// upstream commit id, a FAIL_TO_PASS test name or a line the fix added.
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { CLI_SCRIPT_SHEBANG, shQuote } from "../drivers/cli/shell.js";
import { readTreeFiles, type TreeFile } from "./git.js";
import { MineReportSchema, MinedTaskSchema, type MineReport, type MinedTask } from "./schema.js";

export class MineLeakError extends Error {
  override readonly name = "MineLeakError";
  constructor(
    readonly taskId: string,
    readonly issues: readonly string[],
  ) {
    super(`mined task ${taskId} would leak answers into workloads/: ${issues.join("; ")}`);
  }
}

export const MINED_GATE_RECORD_VERSION = "anybench.mined-gate/v1";
export const MINED_DIR = "mined";

export interface MaterializeMinedTaskOptions {
  /** The hidden-tests gate id. Default "hidden-tests". */
  gateId?: string;
  /** Put the runner's dependency install into setup.sh. Default true. */
  installInSetup?: boolean;
  maxTreeBytes?: number;
}

export interface MinedTaskPaths {
  workload: string;
  input: string;
  instruction: string;
  setup: string;
  gate: string;
  gateTests: string;
  gateFiles: string;
  oracle: string;
  record: string;
}

export function minedTaskPaths(id: string, gateId = "hidden-tests"): MinedTaskPaths {
  return {
    workload: `workloads/${id}`,
    input: `workloads/${id}/input`,
    instruction: `workloads/${id}/instruction.md`,
    setup: `workloads/${id}/setup.sh`,
    gate: `gates/${gateId}/${id}`,
    gateTests: `gates/${gateId}/${id}/tests.json`,
    gateFiles: `gates/${gateId}/${id}/files`,
    oracle: `proof/oracle/${id}`,
    record: `${MINED_DIR}/${id}.json`,
  };
}

async function writeTree(root: string, files: readonly TreeFile[]): Promise<void> {
  const abs = resolve(root);
  for (const f of files) {
    const target = resolve(abs, f.path);
    if (target !== abs && !target.startsWith(abs + sep)) {
      throw new Error(`refusing to write outside ${root}: ${f.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    if (f.mode === "120000") {
      await rm(target, { force: true });
      await symlink(f.content.toString("utf8"), target);
    } else {
      await writeFile(target, f.content, { mode: f.mode === "100755" ? 0o755 : 0o644 });
    }
  }
}

export function renderMinedInstruction(id: string): string {
  return [
    `# Task ${id}`,
    "",
    "PLACEHOLDER. The kit designer replaces this file with an issue written from the user-visible",
    "symptoms in the task record, screened for underspecification. Until then this workload must",
    "not be run.",
    "",
  ].join("\n");
}

export function renderMinedSetupScript(task: MinedTask, installInSetup: boolean): string {
  const env = Object.entries(task.runner.env).map(([k, v]) => `export ${k}=${shQuote(v)}`);
  const install =
    installInSetup && task.runner.install_command ? task.runner.install_command : null;
  return [
    CLI_SCRIPT_SHEBANG,
    `# Builds EVAL_WS for mined workload ${task.id}: the repo as it was before the change, as a`,
    "# ONE-commit git repo with a fixed author and dates (no upstream history to read the fix from).",
    "# Rendered by @anybench/kit materializeMinedTask (TDM-186); regenerate it, do not edit by hand.",
    "set -euo pipefail",
    'in="${EVAL_IN:?EVAL_IN is not set}"',
    'ws="${1:-${EVAL_WS:?EVAL_WS is not set}}"',
    'mkdir -p "$ws"',
    'cp -R "$in/." "$ws/"',
    'rm -rf "$ws/.git"',
    "if command -v git > /dev/null; then",
    "  export GIT_AUTHOR_NAME=anybench GIT_AUTHOR_EMAIL=kit@anybench.dev GIT_COMMITTER_NAME=anybench \\",
    "    GIT_COMMITTER_EMAIL=kit@anybench.dev GIT_AUTHOR_DATE=2026-01-01T00:00:00Z \\",
    "    GIT_COMMITTER_DATE=2026-01-01T00:00:00Z",
    '  git -C "$ws" init -q -b main',
    '  git -C "$ws" add -A',
    '  git -C "$ws" -c commit.gpgsign=false commit -q -m "starting repo"',
    "fi",
    ...(install ? [...env, `(cd "$ws" && ${install})`] : []),
    "",
  ].join("\n");
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(p + "/", ...(await walk(root, p)));
    else out.push(p);
  }
  return out;
}

function addedLines(before: string | undefined, after: string): string[] {
  const old = new Set((before ?? "").split("\n").map((l) => l.trim()));
  return after
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 20 && !old.has(l));
}

/**
 * What in `workloads/<id>/` would hand a contender the answer. Empty = clean. Reads the hidden
 * tests and the fix from the clone, so it checks bytes, not just names.
 */
export async function checkMinedTaskLeaks(
  repo: string,
  kitDir: string,
  task: MinedTask,
  opts: { maxTreeBytes?: number } = {},
): Promise<string[]> {
  const maxBytes = opts.maxTreeBytes ?? 200 * 1024 * 1024;
  const paths = minedTaskPaths(task.id);
  const wl = join(kitDir, paths.workload);
  const issues: string[] = [];
  const tests = await readTreeFiles(repo, task.source.commit, {
    paths: task.files.test_files.map((f) => f.path),
    maxBytes,
  });
  const fix = await readTreeFiles(repo, task.source.commit, {
    paths: task.files.fix_files.map((f) => f.path),
    maxBytes,
  });
  const parentFix = new Map(
    (
      await readTreeFiles(repo, task.source.parent, {
        paths: task.files.fix_files.map((f) => f.path),
        maxBytes,
      })
    ).map((f) => [f.path, f.content.toString("utf8")]),
  );
  const answers = [...tests, ...fix].filter((f) => f.content.length >= 32);
  const answerBytes = new Map(answers.map((f) => [f.content.toString("base64"), f.path]));

  const files = await walk(wl);
  for (const f of files) {
    if (f === ".git/" || f.endsWith("/.git/") || f === ".git" || f.endsWith("/.git")) {
      issues.push(`${paths.workload}/${f} is git metadata`);
      continue;
    }
    if (f.endsWith("/")) continue;
    const st = await lstat(join(wl, f));
    if (!st.isFile()) continue;
    const bytes = await readFile(join(wl, f));
    const hit = answerBytes.get(bytes.toString("base64"));
    if (hit) issues.push(`${paths.workload}/${f} is the post-change ${hit}`);
  }

  const prose: Array<[string, string]> = [];
  for (const p of [paths.instruction, paths.setup]) {
    try {
      prose.push([p, await readFile(join(kitDir, p), "utf8")]);
    } catch {
      // absent is fine
    }
  }
  const needles: Array<[string, string]> = [
    [task.source.commit, "the upstream commit id"],
    [task.source.commit.slice(0, 7), "the upstream commit id"],
    ...task.fail_to_pass
      .map((t) => t.split(/ > |::|\//).pop() ?? t)
      .filter((n) => n.length >= 6)
      .map((n): [string, string] => [n, "a FAIL_TO_PASS test name"]),
    ...task.files.test_files
      .filter((f) => f.status === "added")
      .map((f): [string, string] => [f.path, "a hidden test file path"]),
    ...fix.flatMap((f) =>
      addedLines(parentFix.get(f.path), f.content.toString("utf8")).map((l): [string, string] => [
        l,
        `a line the fix adds to ${f.path}`,
      ]),
    ),
  ];
  for (const [p, text] of prose) {
    for (const [needle, what] of needles) {
      if (text.includes(needle)) issues.push(`${p} contains ${what}`);
    }
  }
  return [...new Set(issues)];
}

/** Write one verified task into `kitDir` (replacing its previous files). Returns kit-relative paths. */
export async function materializeMinedTask(
  repo: string,
  rawTask: MinedTask,
  kitDir: string,
  opts: MaterializeMinedTaskOptions = {},
): Promise<{ paths: MinedTaskPaths; written: string[] }> {
  const task = MinedTaskSchema.parse(rawTask);
  const gateId = opts.gateId ?? "hidden-tests";
  const maxBytes = opts.maxTreeBytes ?? 200 * 1024 * 1024;
  const paths = minedTaskPaths(task.id, gateId);
  const kit = resolve(kitDir);
  for (const p of [paths.workload, paths.gate, paths.oracle, paths.record]) {
    await rm(join(kit, p), { recursive: true, force: true });
  }

  const parent = await readTreeFiles(repo, task.source.parent, { maxBytes });
  const tests = await readTreeFiles(repo, task.source.commit, {
    paths: task.files.test_files.map((f) => f.path),
    maxBytes,
  });
  const fix = await readTreeFiles(repo, task.source.commit, {
    paths: task.files.fix_files.map((f) => f.path),
    maxBytes,
  });

  await writeTree(join(kit, paths.input), parent);
  await writeFile(join(kit, paths.instruction), renderMinedInstruction(task.id));
  await writeFile(
    join(kit, paths.setup),
    renderMinedSetupScript(task, opts.installInSetup ?? true),
    {
      mode: 0o755,
    },
  );
  await writeTree(join(kit, paths.gateFiles), tests);
  await mkdir(join(kit, paths.gate), { recursive: true });
  await writeFile(
    join(kit, paths.gateTests),
    JSON.stringify(
      {
        record: MINED_GATE_RECORD_VERSION,
        task: task.id,
        runner: task.runner,
        test_files: tests.map((f) => f.path),
        fail_to_pass: task.fail_to_pass,
        pass_to_pass: task.pass_to_pass,
      },
      null,
      2,
    ) + "\n",
  );
  await writeTree(join(kit, paths.oracle), fix);
  await mkdir(join(kit, MINED_DIR), { recursive: true });
  await writeFile(join(kit, paths.record), JSON.stringify(task, null, 2) + "\n");

  const issues = await checkMinedTaskLeaks(repo, kit, task, { maxTreeBytes: maxBytes });
  if (issues.length > 0) {
    await rm(join(kit, paths.workload), { recursive: true, force: true });
    throw new MineLeakError(task.id, issues);
  }
  const written: string[] = [];
  for (const base of [paths.workload, paths.gate, paths.oracle]) {
    for (const f of await walk(join(kit, base))) if (!f.endsWith("/")) written.push(`${base}/${f}`);
  }
  written.push(paths.record);
  return { paths, written: written.sort() };
}

export async function writeMineReport(kitDir: string, report: MineReport): Promise<string> {
  const r = MineReportSchema.parse(report);
  const path = join(kitDir, MINED_DIR, "report.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(r, null, 2) + "\n");
  return path;
}
