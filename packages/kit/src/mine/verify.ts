// TDM-186 [16.15]: verify one candidate on an eval computer, through the ComputeProvider port
// (docker-local in tests, Naïve in production).
//
// The workspace is the PARENT tree extracted from a tar built from git objects: no `.git` at all,
// so no history can leak the upstream fix (the SWE-bench `git log` leak). Then:
//   before: the commit's test files applied, the targeted tests run `runs` times;
//   after:  the fix applied on top, the same tests run `runs` times.
// FAIL_TO_PASS = tests that fail (or do not exist yet) in every before-run and pass in every
// after-run. PASS_TO_PASS = tests that pass in every run of both states. A test that flips between
// runs of one state is flaky: when it is one of the tests the commit is about, the candidate is
// dropped; otherwise it is kept out of PASS_TO_PASS.
import { createHash } from "node:crypto";
import type { ComputeProvider } from "@anybench/providers";
import { shQuote } from "../drivers/cli/shell.js";
import { readTreeFiles, type TreeFile } from "./git.js";
import { detectTestRunner, parseTestRun, stripAnsi, type ParsedRun } from "./runners.js";
import { isLockfilePath } from "./select.js";
import {
  MINED_TASK_RECORD_VERSION,
  MinedTaskSchema,
  type MineCandidate,
  type MineDrop,
  type MineDropCode,
  type MinedTask,
  type MineRunnerSpec,
  type MineRunSummary,
  type MineSymptom,
  type TestRunnerKind,
} from "./schema.js";
import { buildTar } from "./tar.js";

export interface VerifyMineCandidateOptions {
  provider: ComputeProvider;
  /** A running computer this verification may use (the caller creates and destroys it). */
  computerId: string;
  /** Runs per state. Default 3 (the ticket's 3/3). */
  runs?: number;
  /** Per test run. Default 300 s, clamped to the provider's exec cap. */
  testTimeoutMs?: number;
  /** Per dependency install. Default 600 s, clamped to the provider's exec cap. */
  installTimeoutMs?: number;
  /** digest.test_commands, a runner-detection hint. */
  testCommands?: readonly string[];
  /** Force a runner instead of detecting one. */
  runner?: TestRunnerKind;
  /** Run the whole suite when no changed test file is directly runnable. Default true. */
  suiteFallback?: boolean;
  /** Cap on the parent tree's bytes. Default 200 MiB. */
  maxTreeBytes?: number;
  /** The repo's GitHub URL, recorded on the task. */
  repoUrl?: string;
  /** YYYY-MM-DD: record the commit date relative to this model cutoff. */
  modelCutoff?: string;
  log?: (line: string) => void;
}

export type VerifyMineCandidateResult =
  { ok: true; task: MinedTask } | { ok: false; drop: MineDrop };

const EXCERPT_CAP = 6000;

/** The workload id for a commit: a hash, so the id itself does not name the upstream commit. */
export function minedTaskId(sha: string): string {
  return `mined-${createHash("sha256").update(`anybench-mine:${sha}`).digest("hex").slice(0, 10)}`;
}

/** The fix's module: the common directory of the fix files, at most two levels deep. */
export function minedTaskArea(fixPaths: readonly string[]): string {
  const dirs = fixPaths.map((p) => p.split("/").slice(0, -1));
  const first = dirs[0] ?? [];
  let n = 0;
  while (n < Math.min(2, first.length) && dirs.every((d) => d[n] === first[n])) n++;
  return n === 0 ? "." : first.slice(0, n).join("/");
}

function excerpt(log: string): string {
  const text = stripAnsi(log).trimEnd();
  if (text.length <= EXCERPT_CAP) return text;
  return `…${text.slice(text.length - EXCERPT_CAP)}`;
}

function cutoffOf(date: string, cutoff: string | undefined): MinedTask["cutoff"] {
  if (!cutoff) return undefined;
  const days = Math.floor((Date.parse(date) - Date.parse(`${cutoff}T00:00:00Z`)) / 86_400_000);
  return { model_cutoff: cutoff, after_cutoff: days >= 0, days_after_cutoff: days };
}

interface RunRecord {
  summary: MineRunSummary;
  parsed: ParsedRun;
  log: string;
}

type Status = "pass" | "fail" | "skip" | "missing";

const MANIFEST_RE =
  /(^|\/)(package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|go\.mod|Cargo\.toml)$/;

/** Verify one candidate. Never throws for a candidate-level problem: it returns a drop. */
export async function verifyMineCandidate(
  repo: string,
  candidate: MineCandidate,
  opts: VerifyMineCandidateOptions,
): Promise<VerifyMineCandidateResult> {
  const drop = (code: MineDropCode, detail: string): VerifyMineCandidateResult => ({
    ok: false,
    drop: { sha: candidate.sha, stage: "verify", code, detail: detail.slice(0, 2000) },
  });
  const p = opts.provider;
  const id = opts.computerId;
  const runs = opts.runs ?? 3;
  const cap = p.capabilities.maxExecTimeoutMs;
  const testTimeout = Math.min(opts.testTimeoutMs ?? 300_000, cap);
  const installTimeout = Math.min(opts.installTimeoutMs ?? 600_000, cap);
  const say = opts.log ?? (() => {});
  const maxBytes = opts.maxTreeBytes ?? 200 * 1024 * 1024;

  let parentFiles: TreeFile[];
  let testFiles: TreeFile[];
  let fixFiles: TreeFile[];
  try {
    parentFiles = await readTreeFiles(repo, candidate.parent, { maxBytes });
    testFiles = await readTreeFiles(repo, candidate.sha, {
      paths: candidate.test_files.map((f) => f.path),
      maxBytes,
    });
    fixFiles = await readTreeFiles(repo, candidate.sha, {
      paths: candidate.fix_files.map((f) => f.path),
      maxBytes,
    });
  } catch (e) {
    return drop("verify_error", `reading the commit: ${(e as Error).message}`);
  }
  const parentByPath = new Map(parentFiles.map((f) => [f.path, f]));
  const testByPath = new Map(testFiles.map((f) => [f.path, f]));

  const detected = await detectTestRunner({
    paths: parentFiles.map((f) => f.path),
    read: async (path) => parentByPath.get(path)?.content.toString("utf8"),
    testFiles: candidate.test_files.map((f) => f.path),
    readTest: async (path) => testByPath.get(path)?.content.toString("utf8"),
    ...(opts.testCommands ? { testCommands: opts.testCommands } : {}),
    ...(opts.runner ? { force: opts.runner } : {}),
    ...(opts.suiteFallback !== undefined ? { suiteFallback: opts.suiteFallback } : {}),
  });
  if (!detected.ok) return drop(detected.code, detected.reason);
  const runner: MineRunnerSpec = detected.runner;

  let home: string;
  try {
    home = (await p.inspect(id)).home;
  } catch (e) {
    return drop("verify_error", `computer ${id}: ${(e as Error).message}`);
  }
  // Named by the opaque task id, never the commit: paths end up in failure text (symptoms).
  const dir = `${home}/anybench-mine/${minedTaskId(candidate.sha)}`;
  const ws = `${dir}/ws`;
  const sh = async (cmd: string, timeoutMs: number) => p.exec(id, cmd, { timeoutMs });
  try {
    await sh(`rm -rf ${shQuote(dir)} && mkdir -p ${shQuote(dir)}`, 60_000);
    await p.putFile(id, `${dir}/parent.tar`, buildTar(parentFiles));
    await p.putFile(id, `${dir}/tests.tar`, buildTar(testFiles));
    await p.putFile(id, `${dir}/fix.tar`, buildTar(fixFiles));
    const envSh = Object.entries(runner.env)
      .map(([k, v]) => `export ${k}=${shQuote(v)}`)
      .join("\n");
    await p.putFile(id, `${dir}/env.sh`, `${envSh}\n`);

    const unpack = await sh(
      `set -e; mkdir -p ${shQuote(ws)}; tar -xf ${shQuote(`${dir}/parent.tar`)} -C ${shQuote(ws)} -m --no-same-owner; ` +
        `find ${shQuote(ws)} -name .git | head -n 5`,
      120_000,
    );
    if (unpack.exitCode !== 0) return drop("verify_error", `unpacking: ${unpack.stderr.trim()}`);
    if (unpack.stdout.trim() !== "") {
      return drop("history_leak", `the snapshot holds git metadata: ${unpack.stdout.trim()}`);
    }

    const install = async (tag: string): Promise<string | undefined> => {
      if (!runner.install_command) return undefined;
      const r = await sh(
        `cd ${shQuote(ws)} && . ${shQuote(`${dir}/env.sh`)} && ( ${runner.install_command} ) > ${shQuote(`${dir}/${tag}.log`)} 2>&1 < /dev/null; echo $?`,
        installTimeout,
      );
      if (r.timedOut) return `install timed out after ${installTimeout} ms`;
      if (r.stdout.trim() !== "0") {
        const log = await readText(`${dir}/${tag}.log`);
        return `install exited ${r.stdout.trim() || r.exitCode}: ${excerpt(log ?? r.stderr).slice(-1500)}`;
      }
      return undefined;
    };
    const readText = async (path: string): Promise<string | undefined> => {
      try {
        return Buffer.from(await p.getFile(id, path)).toString("utf8");
      } catch {
        return undefined;
      }
    };
    const runOnce = async (tag: string): Promise<RunRecord> => {
      const result = `${dir}/${tag}.json`;
      const log = `${dir}/${tag}.log`;
      const r = await sh(
        `cd ${shQuote(ws)} && . ${shQuote(`${dir}/env.sh`)} && export AB_RESULT=${shQuote(result)} && rm -f "$AB_RESULT" && ` +
          `( ${runner.test_command} ) > ${shQuote(log)} 2>&1 < /dev/null; echo "exit=$?"`,
        testTimeout,
      );
      const exitM = /exit=(\d+)/.exec(r.stdout);
      const exit_code = r.timedOut ? 124 : exitM ? Number(exitM[1]) : r.exitCode;
      // Workspace-relative paths in everything we keep (symptoms, excerpts).
      const rel = (t: string) => t.split(`${ws}/`).join("").split(ws).join(".");
      const text = rel((await readText(log)) ?? "");
      const rawJson = await readText(result);
      const json = rawJson === undefined ? undefined : rel(rawJson);
      const parsed = parseTestRun(runner.kind, {
        log: text,
        ...(json !== undefined ? { result: json } : {}),
        workspace: ws,
      });
      const outcomes = [...parsed.tests.values()].map((t) => t.outcome);
      return {
        summary: {
          exit_code,
          passed: outcomes.filter((o) => o === "pass").length,
          failed: outcomes.filter((o) => o === "fail").length,
          skipped: outcomes.filter((o) => o === "skip").length,
          duration_ms: r.durationMs,
        },
        parsed,
        log: text,
      };
    };

    const installErr = await install("install");
    if (installErr) return drop("install_failed", installErr);

    const tarX = (name: string) =>
      sh(`tar -xf ${shQuote(`${dir}/${name}`)} -C ${shQuote(ws)} -m --no-same-owner`, 120_000);
    await tarX("tests.tar");
    const before: RunRecord[] = [];
    for (let i = 1; i <= runs; i++) {
      before.push(await runOnce(`before-${i}`));
      say(
        `${candidate.sha.slice(0, 8)} before ${i}/${runs}: exit ${before.at(-1)?.summary.exit_code}`,
      );
    }
    await tarX("fix.tar");
    if (candidate.fix_files.some((f) => MANIFEST_RE.test(f.path) || isLockfilePath(f.path))) {
      const err = await install("reinstall");
      if (err) return drop("install_failed", `after the fix: ${err}`);
    }
    const after: RunRecord[] = [];
    for (let i = 1; i <= runs; i++) {
      after.push(await runOnce(`after-${i}`));
      say(
        `${candidate.sha.slice(0, 8)} after ${i}/${runs}: exit ${after.at(-1)?.summary.exit_code}`,
      );
    }

    // --- per-test outcomes across runs
    const ids = new Set<string>();
    for (const r of [...before, ...after]) for (const k of r.parsed.tests.keys()) ids.add(k);
    const statusIn = (r: RunRecord, t: string): Status =>
      r.parsed.tests.get(t)?.outcome ?? "missing";
    const failish = (s: Status) => s === "fail" || s === "missing";
    const f2p: string[] = [];
    const p2p: string[] = [];
    const p2f: string[] = [];
    const flakyTarget: string[] = [];
    const flakyOther: string[] = [];
    for (const t of [...ids].sort()) {
      const a = before.map((r) => statusIn(r, t));
      const b = after.map((r) => statusIn(r, t));
      const same = (xs: Status[]) => xs.every((x) => x === xs[0]);
      const aFail = a.every(failish);
      const aPass = a.every((x) => x === "pass");
      const bPass = b.every((x) => x === "pass");
      const bFail = b.every(failish);
      if (aFail && bPass) f2p.push(t);
      else if (aPass && bPass) p2p.push(t);
      else if (aPass && bFail) p2f.push(t);
      else if (!same(a) || !same(b)) {
        // flipped within one state: is it one of the tests this commit is about?
        if (a.some(failish) && b.some((x) => x === "pass")) flakyTarget.push(t);
        else flakyOther.push(t);
      }
    }
    if (flakyTarget.length > 0) {
      const t = flakyTarget[0] ?? "";
      const a = before.filter((r) => statusIn(r, t) === "pass").length;
      const b = after.filter((r) => statusIn(r, t) === "pass").length;
      return drop(
        "flaky",
        `${flakyTarget.length} test(s) flip between runs; ${t} passed ${a}/${runs} before and ${b}/${runs} after the fix`,
      );
    }
    if (f2p.length === 0) {
      if (after.every((r) => r.parsed.tests.size === 0)) {
        return drop(
          "no_tests_ran",
          `no test result parsed after the fix: ${excerpt(after[0]?.log ?? "").slice(-1500)}`,
        );
      }
      const passBefore = before.every((r) =>
        [...r.parsed.tests.values()].every((x) => x.outcome !== "fail"),
      );
      return passBefore
        ? drop("passes_before_fix", "every targeted test already passes before the fix")
        : drop("fails_after_fix", `no test goes from failing to passing (${p2f.length} pass→fail)`);
    }

    const symptoms: MineSymptom[] = f2p.map((t) => {
      for (const r of before) {
        const m = r.parsed.tests.get(t)?.message;
        if (m) return { test: t, message: m };
      }
      for (const r of before) {
        for (const [file, err] of r.parsed.fileErrors) {
          if (
            file === "" ||
            t === file ||
            t.startsWith(`${file} > `) ||
            t.startsWith(`${file}::`) ||
            t.startsWith(`${file}/`)
          ) {
            return { test: t, message: err };
          }
        }
      }
      return { test: t, message: "" };
    });

    const task = MinedTaskSchema.parse({
      record: MINED_TASK_RECORD_VERSION,
      id: minedTaskId(candidate.sha),
      source: {
        ...(opts.repoUrl ? { repo: opts.repoUrl } : {}),
        commit: candidate.sha,
        parent: candidate.parent,
        author_date: candidate.author_date,
        commit_date: candidate.commit_date,
      },
      ...(opts.modelCutoff ? { cutoff: cutoffOf(candidate.author_date, opts.modelCutoff) } : {}),
      held_out: false,
      area: minedTaskArea(candidate.fix_files.map((f) => f.path)),
      files: {
        test_files: candidate.test_files,
        fix_files: candidate.fix_files,
        ignored_files: candidate.ignored_files,
      },
      diff_stats: candidate.stats,
      runner,
      fail_to_pass: f2p,
      pass_to_pass: p2p,
      flaky_excluded: flakyOther,
      pass_to_fail: p2f,
      runs: { before: before.map((r) => r.summary), after: after.map((r) => r.summary) },
      symptoms,
      before_output_excerpt: excerpt(before[0]?.log ?? ""),
    });
    return { ok: true, task };
  } catch (e) {
    return drop("verify_error", (e as Error).message);
  } finally {
    await sh(`rm -rf ${shQuote(dir)}`, 60_000).catch(() => {});
  }
}
