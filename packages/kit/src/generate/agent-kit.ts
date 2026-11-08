// TDM-60 [6.6] step 6: a generated kit for a coding-agent or harness repo, from tasks MINED from
// its own history (TDM-186) and issue text written from their symptoms.
//
//   materializeAgentKit({repoDir, tasks, template, ...})
//     workloads/<id>/{input,setup.sh}   materializeMinedTask (the parent tree, a one-commit repo)
//     workloads/<id>/instruction.md     the issue text (written from the failing tests' SYMPTOMS
//                                       by a Naïve session, screened by checkMinedTaskLeaks + the
//                                       no-leak lint; never the diff)
//     gates/hidden-tests/<id>/          tests.json (runner, FAIL_TO_PASS, PASS_TO_PASS) + files/**
//     gates/hidden-tests/check.sh       renderMinedGateScript: the hidden test files over a copy of
//                                       the frozen workspace, the runner as the contender uid
//                                       ($AB_RUN, out of process), graded by the SAME parsers the
//                                       miner verified with; pass = every FAIL_TO_PASS and every
//                                       PASS_TO_PASS test passes
//     proof/oracle/<id>/                the upstream fix (the oracle); proof/oracle/driver.sh
//                                       applies an overlay dir and freezes the workspace
//     proof/do_less/no-op/              noop: freezes the untouched workspace
//     proof/do_less/partial-fix/<id>/   partial-oracle: the fix with ONE hunk dropped
//     adapters/, contenders, env        copied from a template kit (kits/tandem-vs-claude-code):
//                                       the subject + plain Claude Code, pinned exactly like it
//     design/tasks.json                 provenance: commit dates vs the model cutoff, held-out
//                                       tasks, backlogs (groupMinedTasks) for harnesses
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import type { KitSpec } from "@anybench/core";
import { CLI_SCRIPT_SHEBANG } from "../drivers/cli/shell.js";
import { CODING_AGENT_OUTPUT_PATHS } from "../drivers/coding-agent/outputs.js";
import { loadKit } from "../load.js";
import { readTreeFiles } from "../mine/git.js";
import { groupMinedTasks } from "../mine/group.js";
import { checkMinedTaskLeaks, materializeMinedTask } from "../mine/materialize.js";
import {
  cleanMessage,
  MINE_PARSER_INTERNALS,
  parseCargo,
  parseGoJson,
  parseJestJson,
  parseMochaJson,
  parseNodeTap,
  parsePytest,
  parseTestRun,
  stripAnsi,
} from "../mine/runners.js";
import type { MinedTask } from "../mine/schema.js";
import { GENERATED_MARKER, MaterializeError } from "./materialize-cli.js";

const pexec = promisify(execFile);

export const MINED_GATE_ID = "hidden-tests";
export const NOOP_ID = "no-op";
export const PARTIAL_FIX_ID = "partial-fix";
/** 17.2 rule 3: an agent "beats" claim needs ≥20 tasks, else "on these N tasks". */
export const AGENT_CLAIM_MIN_TASKS = 20;
/** 17.2 rule 3: agents ≥10 repeats per cell. */
export const AGENT_DEFAULT_REPEATS = 10;

// ---------- the gate ----------

/** The grading program embedded in check.sh: the miner's own parsers, as compiled source. */
export function minedVerdictProgram(): string {
  const fns = [
    stripAnsi,
    cleanMessage,
    MINE_PARSER_INTERNALS.relTo,
    MINE_PARSER_INTERNALS.yamlMessage,
    parseNodeTap,
    parseJestJson,
    parseMochaJson,
    parsePytest,
    parseGoJson,
    parseCargo,
    parseTestRun,
  ].map((f) => f.toString());
  return [
    '"use strict";',
    'const fs = require("node:fs");',
    `const MESSAGE_CAP = ${MINE_PARSER_INTERNALS.MESSAGE_CAP};`,
    `const TAP_SUMMARY_RE = ${MINE_PARSER_INTERNALS.TAP_SUMMARY_RE.toString()};`,
    ...fns,
    "const [specFile, logFile, resultFile, ws, verdictFile, gateId, workload] = process.argv.slice(-7);",
    'const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return undefined; } };',
    "const spec = JSON.parse(read(specFile));",
    'const run = parseTestRun(spec.runner.kind, { log: read(logFile) ?? "", result: read(resultFile), workspace: ws });',
    "const ok = (id) => run.tests.get(id)?.outcome === 'pass';",
    "const f2p = spec.fail_to_pass, p2p = spec.pass_to_pass;",
    "const f2pOk = f2p.filter(ok).length, p2pOk = p2p.filter(ok).length;",
    "const pass = f2p.length > 0 && f2pOk === f2p.length && p2pOk === p2p.length;",
    "const failing = [...f2p, ...p2p].filter((id) => !ok(id)).slice(0, 3);",
    "const reason = `${gateId}: ${f2pOk}/${f2p.length} FAIL_TO_PASS and ${p2pOk}/${p2p.length} PASS_TO_PASS tests pass on ${workload}` + (failing.length ? ` (not passing: ${failing.join('; ')})` : '');",
    'fs.writeFileSync(verdictFile + ".tmp", JSON.stringify({ pass, reason: reason.slice(0, 1500), evidence: [gateId + ".log"] }) + "\\n");',
    'fs.renameSync(verdictFile + ".tmp", verdictFile);',
  ].join("\n");
}

const GATE_BODY = String.raw`usage() { echo "check.sh: $*" >&2; exit 2; }
[ "$#" -eq 3 ] || usage "usage: check.sh <frozen-out> <workload-id> <gate.json>"
out="$1" workload="$2" verdict="$3"
printf '%s' "$workload" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,63}$' || usage "bad workload id: $workload"
[ -d "$out" ] || usage "frozen outputs not found: $out"
here="$(cd "$(dirname "$\{BASH_SOURCE[0]}")" && pwd)"
spec="$here/$workload/tests.json"
[ -f "$spec" ] || usage "no hidden tests for workload $workload"
[ -n "$\{AB_RUN:-}" ] || usage "AB_RUN is not set: contender code would run as the check's uid"
[ -n "$\{AB_RUN_DIR:-}" ] && [ -d "$AB_RUN_DIR" ] || usage "AB_RUN_DIR is not a directory"
log="$out/$gate_id.log"
write_fail() { printf '{"pass":false,"reason":"%s","evidence":[]}\n' "$1" > "$verdict"; }
AB_STOP_ALL='me=$$ uid=$(id -u)
[ "$uid" != "$1" ] && [ "$uid" != 0 ] || exit 0
alive() {
  left=""
  for p in /proc/[0-9]*; do
    [ "$\{p#/proc/}" != "$me" ] && [ -O "$p" ] || continue
    st=""; { read -r st < "$p/stat"; } 2>/dev/null || continue
    set -- $\{st##*\)}
    case "$\{1:-}" in Z|X|"") continue ;; esac
    [ "$\{4:-}" != "$me" ] || continue
    c="$\{st#*\(}"; left="$left $\{p#/proc/}:$\{c%\)*}"
  done
}
alive; [ -z "$left" ] || echo "stopping contender processes:$left"
kill -TERM -1 2>/dev/null
i=0; while alive; [ -n "$left" ] && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done
kill -KILL -1 2>/dev/null
i=0; while alive; [ -n "$left" ] && [ "$i" -lt 20 ]; do sleep 0.1; kill -KILL -1 2>/dev/null; i=$((i + 1)); done
[ -z "$left" ] || { echo "still running after KILL:$left"; exit 1; }'
stop_contender() {
  [ -n "$\{AB_RUN:-}" ] && [ -d "$\{AB_RUN_DIR:-}" ] || return 0
  (cd "$AB_RUN_DIR" && "$AB_RUN" bash -c "$AB_STOP_ALL" ab-stop "$(id -u)" < /dev/null) >&2 || true
}
fail_closed() {
  local rc=$?
  stop_contender
  [ -s "$verdict" ] || write_fail "$gate_id: the hidden tests could not run on these outputs (exit $rc)"
  exit 0
}
trap fail_closed EXIT

ws="$AB_RUN_DIR/$workspace_dir"
if [ -L "$ws" ] || [ ! -d "$ws" ]; then
  write_fail "$gate_id: the outputs have no $workspace_dir/ (the driver did not freeze one)"
  exit 0
fi
# The hidden tests go over the contender's copy at their repo paths (its own versions replaced).
cp -R "$here/$workload/files/." "$ws/"
chmod -R a+rX "$ws"
# The runner's commands and env, from tests.json (export lines, single-quoted by node).
abenv="$(mktemp)"
cat > "$abenv" <<'ABENV'
const r = JSON.parse(require("fs").readFileSync(process.argv[process.argv.length - 1], "utf8")).runner;
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const lines = Object.entries(r.env).map(([k, v]) => "export " + k + "=" + q(v));
lines.push("export AB_INSTALL=" + q(r.install_command ?? ""));
lines.push("export AB_TEST=" + q(r.test_command));
console.log(lines.join("\n"));
ABENV
runner_env="$(node "$abenv" "$spec")"
rm -f "$abenv"
result="$ws/.ab-result.json"
rm -f "$result"
script="$runner_env
export AB_RESULT='$result'
if [ -n \"\$AB_INSTALL\" ]; then bash -c \"\$AB_INSTALL\"; fi
bash -c \"\$AB_TEST\""
rc=0
(cd "$ws" && timeout -k 10 "$test_timeout_s" "$AB_RUN" bash -c "$script" < /dev/null > "$log" 2>&1) || rc=$?
echo "exit $rc" >> "$log"
node - "$spec" "$log" "$result" "$ws" "$verdict" "$gate_id" "$workload" <<'ABJS'
__PROGRAM__
ABJS
`;

/** `gates/hidden-tests/check.sh` for mined tasks (FAIL_TO_PASS + PASS_TO_PASS, out of process). */
export function renderMinedGateScript(
  opts: { gateId?: string; testTimeoutS?: number } = {},
): string {
  const gateId = opts.gateId ?? MINED_GATE_ID;
  return [
    CLI_SCRIPT_SHEBANG,
    `# L5 gate '${gateId}' (kind: hidden-tests) for tasks mined from the repo's history.`,
    `# ${GENERATED_MARKER} renderMinedGateScript: regenerate it, do not edit by hand.`,
    "#",
    "# Usage: check.sh <frozen-out> <workload-id> <gate.json>. Runs only on the scoring computer.",
    "# The hidden test files (gates/<gate>/<workload>/files/**) are copied over the frozen workspace,",
    "# the task's test command runs as the contender uid ($AB_RUN), and the verdict is computed by",
    "# the same parsers the miner verified the task with: pass only when every FAIL_TO_PASS and",
    "# every PASS_TO_PASS test passes. Exit 0 = verdict written; 2 = usage or kit error.",
    "set -euo pipefail",
    `gate_id='${gateId}'`,
    `workspace_dir='${CODING_AGENT_OUTPUT_PATHS.workspace}'`,
    `test_timeout_s=${opts.testTimeoutS ?? 900}`,
    "",
    GATE_BODY.replaceAll("$\\{", "${").replace("__PROGRAM__", () => minedVerdictProgram()),
  ].join("\n");
}

// ---------- proof overlays ----------

export function renderOverlayDriver(): string {
  return [
    CLI_SCRIPT_SHEBANG,
    "# L7 overlay driver for mined tasks: instead of running an agent, applies an overlay dir",
    "# (AB_OVERLAY_DIR, default proof/oracle: the upstream fix) for the workload onto the",
    "# workspace and freezes it. The partial-oracle do-less points it at proof/do_less/partial-fix.",
    `# ${GENERATED_MARKER}.`,
    "set -euo pipefail",
    'case "${1:-}" in',
    "  start | ready | stop) exit 0 ;;",
    "  run) ;;",
    '  *) echo "usage: driver.sh start | ready | run <task> <workspace> | stop" >&2; exit 2 ;;',
    "esac",
    'kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"',
    'ws="${3:-${EVAL_WS:?EVAL_WS is not set}}"',
    'out="${EVAL_OUT:?EVAL_OUT is not set}"',
    'workload="${WORKLOAD:-${EVAL_WORKLOAD:?WORKLOAD is not set}}"',
    'overlay="$kit/${AB_OVERLAY_DIR:-proof/oracle}/$workload"',
    '[ -d "$overlay" ] || { echo "no overlay for workload $workload" >&2; exit 2; }',
    'cp -R "$overlay/." "$ws/"',
    `rm -rf "$out/${CODING_AGENT_OUTPUT_PATHS.workspace}"`,
    `mkdir -p "$out/${CODING_AGENT_OUTPUT_PATHS.workspace}"`,
    `cp -R "$ws/." "$out/${CODING_AGENT_OUTPUT_PATHS.workspace}/"`,
    "",
  ].join("\n");
}

export function renderNoopDriver(): string {
  return [
    CLI_SCRIPT_SHEBANG,
    "# L7 do-less (noop): does nothing and freezes the untouched workspace. Must fail every task.",
    `# ${GENERATED_MARKER}.`,
    "set -euo pipefail",
    'case "${1:-}" in',
    "  start | ready | stop) exit 0 ;;",
    "  run) ;;",
    '  *) echo "usage: driver.sh start | ready | run <task> <workspace> | stop" >&2; exit 2 ;;',
    "esac",
    'ws="${3:-${EVAL_WS:?EVAL_WS is not set}}"',
    'out="${EVAL_OUT:?EVAL_OUT is not set}"',
    `rm -rf "$out/${CODING_AGENT_OUTPUT_PATHS.workspace}"`,
    `mkdir -p "$out/${CODING_AGENT_OUTPUT_PATHS.workspace}"`,
    `cp -R "$ws/." "$out/${CODING_AGENT_OUTPUT_PATHS.workspace}/"`,
    "",
  ].join("\n");
}

/** Hunks of `git diff --no-index -U0 before after`: [oldStart, oldCount, newLines]. */
async function hunks(
  before: string,
  after: string,
): Promise<{ at: number; n: number; add: string[]; newAt: number }[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "ab-hunks-"));
  try {
    await writeFile(path.join(dir, "a"), before);
    await writeFile(path.join(dir, "b"), after);
    let diff = "";
    try {
      await pexec("git", ["diff", "--no-index", "-U0", "--no-color", "a", "b"], { cwd: dir });
    } catch (err) {
      diff = (err as { stdout?: string }).stdout ?? ""; // exit 1 = differences
    }
    const out: { at: number; n: number; add: string[]; newAt: number }[] = [];
    let cur: { at: number; n: number; add: string[]; newAt: number } | null = null;
    for (const line of diff.split("\n")) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) {
        const n = h[2] === undefined ? 1 : Number(h[2]);
        cur = { at: n === 0 ? Number(h[1]) : Number(h[1]) - 1, n, add: [], newAt: Number(h[3]) };
        out.push(cur);
      } else if (cur && line.startsWith("+") && !line.startsWith("+++"))
        cur.add.push(line.slice(1));
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The fix with ONE hunk dropped (partial-oracle): in the fix file with the most hunks, every hunk
 * is applied except the largest one; several one-hunk files: one file's change is dropped; one
 * file with one hunk: one of its added lines is dropped. A one-line fix has no partial (null).
 */
export async function partialFix(
  repoDir: string,
  task: MinedTask,
): Promise<{ files: { path: string; content: Buffer }[]; dropped: string } | null> {
  const paths = task.files.fix_files.map((f) => f.path);
  const after = await readTreeFiles(repoDir, task.source.commit, {
    paths,
    maxBytes: 64 * 1024 * 1024,
  });
  const before = await readTreeFiles(repoDir, task.source.parent, {
    paths,
    maxBytes: 64 * 1024 * 1024,
  });
  const beforeOf = new Map(before.map((f) => [f.path, f.content.toString("utf8")]));
  let best: { path: string; hs: Awaited<ReturnType<typeof hunks>> } | null = null;
  for (const f of after) {
    const hs = await hunks(beforeOf.get(f.path) ?? "", f.content.toString("utf8"));
    if (!best || hs.length > best.hs.length) best = { path: f.path, hs };
  }
  if (!best) return null;
  const files = after.map((f) => ({ path: f.path, content: f.content }));
  if (best.hs.length === 1 && after.length <= 1) {
    // One file, one hunk: drop ONE of its added lines (the middle one) when it adds two or more.
    const h = best.hs[0]!;
    if (h.add.length < 2) return null;
    const mid = Math.floor(h.add.length / 2);
    const lines = (beforeOf.get(best.path) ?? "").split("\n");
    lines.splice(h.at, h.n, ...h.add.filter((_, k) => k !== mid));
    files[0] = { path: best.path, content: Buffer.from(lines.join("\n")) };
    return { files, dropped: `${best.path} line ${mid + 1}/${h.add.length} of its only hunk` };
  }
  if (best.hs.length <= 1) {
    // Several files, one hunk each: drop the change to this file entirely.
    const i = files.findIndex((f) => f.path === best!.path);
    files[i] = { path: best.path, content: Buffer.from(beforeOf.get(best.path) ?? "") };
    return { files, dropped: `${best.path} (its only hunk)` };
  }
  const drop = best.hs.reduce(
    (a, h, i, all) => (h.n + h.add.length > all[a]!.n + all[a]!.add.length ? i : a),
    0,
  );
  const lines = (beforeOf.get(best.path) ?? "").split("\n");
  for (let i = best.hs.length - 1; i >= 0; i--) {
    if (i === drop) continue;
    const h = best.hs[i]!;
    lines.splice(h.at, h.n, ...h.add);
  }
  const i = files.findIndex((f) => f.path === best!.path);
  files[i] = { path: best.path, content: Buffer.from(lines.join("\n")) };
  return { files, dropped: `${best.path} hunk ${drop + 1}/${best.hs.length}` };
}

/** 1-based lines of each fix file that the fix added or changed (the mutation targets). */
export async function fixChangedLines(
  repoDir: string,
  task: MinedTask,
): Promise<Record<string, number[]>> {
  const paths = task.files.fix_files.map((f) => f.path);
  const after = await readTreeFiles(repoDir, task.source.commit, {
    paths,
    maxBytes: 64 * 1024 * 1024,
  });
  const before = await readTreeFiles(repoDir, task.source.parent, {
    paths,
    maxBytes: 64 * 1024 * 1024,
  });
  const beforeOf = new Map(before.map((f) => [f.path, f.content.toString("utf8")]));
  const out: Record<string, number[]> = {};
  for (const f of after) {
    const lines: number[] = [];
    for (const h of await hunks(beforeOf.get(f.path) ?? "", f.content.toString("utf8")))
      for (let k = 0; k < h.add.length; k++) lines.push(h.newAt + k);
    if (lines.length > 0) out[f.path] = lines;
  }
  return out;
}

// ---------- the kit ----------

export interface AgentKitTask {
  task: MinedTask;
  /** The screened issue text (instruction.md). */
  instruction: string;
}

export interface MaterializeAgentKitInput {
  repoDir: string;
  dir: string;
  subject: { kind: "harness" | "agent"; name: string; summary: string; better_means: string[] };
  tasks: AgentKitTask[];
  /** A kit whose adapters + contender entries are copied (pinned exactly like it). */
  template: { dir: string; contenders: string[]; subject: string };
  repeats?: number;
  orderSeed?: number;
  provenance?: Record<string, unknown>;
}

export interface MaterializedAgentKit {
  dir: string;
  spec: Record<string, unknown>;
  workloads: string[];
  /** Tasks with no partial-oracle (one hunk, one file): they still get the noop do-less. */
  noPartial: string[];
}

async function put(dir: string, rel: string, content: string | Buffer, mode = 0o644) {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, { mode });
}

/** One value per vary key (the middle one): the generated kit compares setups, not a sweep. */
function narrowVary(vary: KitSpec["vary"]): Record<string, (string | number | boolean)[]> {
  return Object.fromEntries(
    Object.entries(vary).map(([k, v]) => [k, [v[Math.floor((v.length - 1) / 2)]!]]),
  );
}

export async function materializeAgentKit(
  input: MaterializeAgentKitInput,
): Promise<MaterializedAgentKit> {
  if (input.tasks.length === 0) throw new MaterializeError("no mined tasks to build a kit from");
  const template = await loadKit(input.template.dir);
  const tSpec = template.spec;
  const contenders = input.template.contenders.map((id) => {
    const c = tSpec.contenders.find((x) => x.id === id);
    if (!c) throw new MaterializeError(`template kit has no contender '${id}'`);
    return c;
  });
  if (!contenders.some((c) => c.id === input.template.subject))
    throw new MaterializeError(
      `the subject '${input.template.subject}' is not among the contenders`,
    );

  const dir = path.resolve(input.dir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // Template files the contenders run with (adapters/, scripts/); nothing scoring-only.
  for (const sub of ["adapters", "scripts"]) {
    await cp(path.join(template.dir, sub), path.join(dir, sub), { recursive: true }).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      },
    );
  }

  const noPartial: string[] = [];
  const workloads: Record<string, unknown>[] = [];
  for (const { task, instruction } of input.tasks) {
    await materializeMinedTask(input.repoDir, task, dir, { gateId: MINED_GATE_ID });
    await put(dir, `workloads/${task.id}/instruction.md`, instruction);
    const leaks = await checkMinedTaskLeaks(input.repoDir, dir, task);
    if (leaks.length > 0)
      throw new MaterializeError(
        `task ${task.id}: the instruction leaks the answer: ${leaks.join("; ")}`,
      );
    await put(
      dir,
      `proof/mutation/${task.id}.json`,
      `${JSON.stringify({ files: await fixChangedLines(input.repoDir, task) }, null, 2)}\n`,
    );
    const partial = await partialFix(input.repoDir, task);
    if (partial) {
      for (const f of partial.files)
        await put(dir, `proof/do_less/${PARTIAL_FIX_ID}/${task.id}/${f.path}`, f.content);
    } else noPartial.push(task.id);
    workloads.push({
      id: task.id,
      title: `Issue ${task.id} (${task.area})`,
      instruction: `workloads/${task.id}/instruction.md`,
      setup: `workloads/${task.id}/setup.sh`,
      timeout_s: 3600,
      params: {
        held_out: task.held_out,
        commit_date: task.source.commit_date.slice(0, 10),
        ...(task.cutoff
          ? {
              after_cutoff: task.cutoff.after_cutoff,
              days_after_cutoff: task.cutoff.days_after_cutoff,
            }
          : {}),
        fail_to_pass: task.fail_to_pass.length,
        pass_to_pass: task.pass_to_pass.length,
      },
    });
  }

  await put(dir, `gates/${MINED_GATE_ID}/check.sh`, renderMinedGateScript(), 0o755);
  await put(dir, "proof/oracle/driver.sh", renderOverlayDriver(), 0o755);
  await put(dir, "proof/oracle/README.md", "# Oracle: the upstream fix of each mined task\n");
  await put(dir, `proof/do_less/${NOOP_ID}/driver.sh`, renderNoopDriver(), 0o755);
  await put(
    dir,
    `proof/do_less/${PARTIAL_FIX_ID}/README.md`,
    "# Partial oracle: each fix with one hunk dropped\n",
  );

  const n = input.tasks.length;
  const scope =
    n < AGENT_CLAIM_MIN_TASKS
      ? ` Results hold on these ${n} tasks only (fewer than ${AGENT_CLAIM_MIN_TASKS}).`
      : "";
  const subjectId = input.template.subject;
  const spec: Record<string, unknown> = {
    schema_version: 2,
    subject: { ...input.subject, summary: `${input.subject.summary}${scope}` },
    contenders: contenders.map((c) => ({ ...c })),
    workloads,
    gates: [
      {
        id: MINED_GATE_ID,
        kind: "hidden-tests",
        check: `gates/${MINED_GATE_ID}/check.sh`,
        reference: `gates/${MINED_GATE_ID}/`,
        description:
          "The task's hidden tests (added by the upstream fix, never in the workspace) run as the contender uid against a copy of the frozen workspace; pass only when every FAIL_TO_PASS and every PASS_TO_PASS test passes.",
        timeout_s: 1200,
      },
    ],
    requirements: [
      {
        id: "tests-pass",
        type: "measured",
        title: "Solves the issue (FAIL_TO_PASS + PASS_TO_PASS)",
        metric: "gate_pass_rate",
        unit: "ratio",
        better: "higher",
        gate_id: MINED_GATE_ID,
      },
      {
        id: "wall",
        type: "measured",
        title: "Time to solve",
        metric: "wall_s",
        unit: "s",
        better: "lower",
        gate_id: MINED_GATE_ID,
      },
      {
        id: "cost",
        type: "measured",
        title: "Cost per task",
        metric: "cost_micro_usd",
        unit: "micro-USD",
        better: "lower",
        gate_id: MINED_GATE_ID,
      },
    ],
    proof: {
      oracle: {
        id: "upstream-fix",
        dir: "proof/oracle/",
        contender: subjectId,
        driver_patch: "proof/oracle/driver.sh",
        gates: [MINED_GATE_ID],
        description: "Applies the upstream fix of each mined task instead of running the harness.",
      },
      do_less: [
        {
          id: NOOP_ID,
          dir: `proof/do_less/${NOOP_ID}/`,
          contender: subjectId,
          driver_patch: `proof/do_less/${NOOP_ID}/driver.sh`,
          kind: "noop",
          description: "Leaves the workspace untouched; must fail every task.",
        },
        ...(noPartial.length < n
          ? [
              {
                id: PARTIAL_FIX_ID,
                dir: `proof/do_less/${PARTIAL_FIX_ID}/`,
                contender: subjectId,
                driver_patch: "proof/oracle/driver.sh",
                env: { AB_OVERLAY_DIR: `proof/do_less/${PARTIAL_FIX_ID}` },
                kind: "partial-oracle",
                description: "The upstream fix with one hunk dropped; must fail the hidden tests.",
              },
            ]
          : []),
      ],
      ...(tSpec.proof.regression &&
      contenders.some((c) => c.id === tSpec.proof.regression!.contender)
        ? { regression: tSpec.proof.regression }
        : {}),
    },
    vary: narrowVary(tSpec.vary),
    ...(tSpec.human_in_loop ? { human_in_loop: tSpec.human_in_loop } : {}),
    secrets: tSpec.secrets,
    collect: tSpec.collect,
    transfer: tSpec.transfer,
    scoring: { weights: { "tests-pass": 60, wall: 20, cost: 20 }, primary: "tests-pass" },
    repeats: input.repeats ?? AGENT_DEFAULT_REPEATS,
    schedule: { warmups: 0, order_seed: input.orderSeed ?? 60 },
    ...(tSpec.env ? { env: tSpec.env } : {}),
  };
  if (tSpec.proof.regression) {
    const rdir = tSpec.proof.regression.dir;
    await cp(path.join(template.dir, rdir), path.join(dir, rdir), { recursive: true });
  }
  const groups = groupMinedTasks(input.tasks.map((t) => t.task));
  await put(
    dir,
    "design/tasks.json",
    `${JSON.stringify(
      {
        tasks: input.tasks.map(({ task }) => ({
          id: task.id,
          area: task.area,
          held_out: task.held_out,
          commit_date: task.source.commit_date,
          cutoff: task.cutoff ?? null,
          fail_to_pass: task.fail_to_pass.length,
          pass_to_pass: task.pass_to_pass.length,
          partial_oracle: !noPartial.includes(task.id),
        })),
        backlogs: groups.groups,
        ungrouped: groups.ungrouped,
        claim_scope: n < AGENT_CLAIM_MIN_TASKS ? `on these ${n} tasks` : "general",
        ...(input.provenance ? { provenance: input.provenance } : {}),
      },
      null,
      2,
    )}\n`,
  );
  await put(
    dir,
    "anybench.yaml",
    [
      `# ${GENERATED_MARKER} (materializeAgentKit): tasks mined from the repo's history (TDM-186),`,
      "# issue text from their symptoms, contenders pinned exactly like the template kit.",
      stringify(spec, { lineWidth: 100 }),
    ].join("\n"),
  );
  return { dir, spec, workloads: input.tasks.map((t) => t.task.id), noPartial };
}
