#!/usr/bin/env node
// Hidden-tests gate (L5) for tandem-long-horizon, copied from kits/tandem-vs-claude-code and
// extended with partial credit (TDM-209 [18.2]). Runs on the scoring computer only, under the
// gate runner's calling convention (packages/bench gate.ts, TDM-51):
//
//   check.sh <frozen-out> <workload-id> <gate.json>
//   → node grade.mjs --workload <id> --run-dir "$AB_RUN_DIR" --out <frozen-out> --verdict <gate.json>
//
// The check runs as its own uid. Contender code runs ONLY through "$AB_RUN" (another uid, clean
// env), in "$AB_RUN_DIR", the contender's own writable copy of the outputs. So:
// 1. BEFORE any contender code runs, replace <run-dir>/workspace/.hidden-tests/ (the contender may
//    have planted a file, a symlink or decoy tests there) with gates/hidden-tests/<workload>/*.ts,
//    its fixtures/ (the gate's own copy of tracker-v1.json: the contender can edit the workspace's)
//    and the reporter, readable by the contender uid. Nothing is written into <run-dir> after that
//    (contender code could plant symlinks there).
// 2. Run `node --test` on them through "$AB_RUN", offline. The reporter's lines go to stdout, which
//    this process redirects into <frozen-out>/ (its own private copy): the contender uid can't
//    write there.
// 3. Score every test listed in <workload>/tests.json. A test that never reported (crash, timeout,
//    missing module) counts as failed, so a broken workspace can't shrink the total.
// 4. Write the verdict {pass, reason, evidence[]} to <gate.json>, and <frozen-out>/hidden-tests.json
//    (per-test and per-area results), hidden-tests.log (spec output) and
//    hidden-tests.metrics.jsonl: `hidden_test_fraction` (passed / total, 0..1, the partial-credit
//    correctness metric of TDM-210), `hidden_tests_passed`, `hidden_tests_total`, and one
//    `area_pass.<area>` (that area's passed / total, 0..1) per feature area of tests.json.
//
// The gate passes only when every hidden test passes (partial credit is a metric, never a pass). Exit 0 whenever a verdict was written: once
// the outputs are involved, whatever goes wrong is a FAIL verdict, never a verdict-less exit.
// Exit 2 means the kit itself is broken (no tests for the workload, bad arguments).
//
// Known limit: the tests run in the same process as contender code, so that code could patch
// node:assert or print fake reporter lines. Out-of-process hidden tests are [16.1] (TDM-172).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));

/** A kit problem (exit 2), as opposed to a contender failure (a FAIL verdict). */
export class KitError extends Error {}

/** The tests.json manifest of a workload, or a KitError. */
export function manifestOf(workload) {
  const manifestPath = join(here, workload, "tests.json");
  if (!existsSync(manifestPath)) throw new KitError(`no hidden tests for workload '${workload}'`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const areas = manifest.areas;
  if (!Array.isArray(areas) || areas.length === 0 || !areas.every((a) => typeof a === "string" && AREA_ID.test(a))) {
    throw new KitError(`${workload}/tests.json: 'areas' must list the feature area ids`);
  }
  if (!Array.isArray(manifest.tests) || manifest.tests.length === 0) throw new KitError(`${workload}/tests.json lists no tests`);
  const seen = new Set();
  for (const t of manifest.tests) {
    if (typeof t?.file !== "string" || typeof t?.name !== "string") throw new KitError(`${workload}/tests.json: a test without file or name`);
    if (!areas.includes(t.area)) throw new KitError(`${workload}/tests.json: '${t.name}' has area '${t.area}', not one of 'areas'`);
    const key = `${t.file}::${t.name}`;
    if (seen.has(key)) throw new KitError(`${workload}/tests.json: '${key}' is listed twice`);
    seen.add(key);
  }
  return manifest;
}

/** Area ids become metric names (`area_pass.<area>`), so they must be metric-name safe. */
const AREA_ID = /^[a-z][a-z0-9_]{0,63}$/;

/** `<run-dir>/workspace`, or null when the outputs have none (or it is a symlink). */
export function workspaceOf(runDir) {
  const ws = join(runDir, "workspace");
  try {
    const st = lstatSync(ws);
    return st.isDirectory() && !st.isSymbolicLink() ? ws : null;
  } catch {
    return null;
  }
}

function chmodReadable(p) {
  const st = lstatSync(p);
  if (st.isDirectory()) {
    chmodSync(p, 0o755);
    for (const f of readdirSync(p)) chmodReadable(join(p, f));
  } else if (st.isFile()) {
    chmodSync(p, 0o644);
  }
}

/**
 * Step 1: put the hidden tests, the reporter and `extra` kit files ({from, as}) into
 * <ws>/.hidden-tests/. Call it before any contender code runs in <ws>.
 */
export function prepareHiddenTests({ workload, ws, extra = [] }) {
  const testsDir = join(here, workload);
  const hiddenDir = join(ws, ".hidden-tests");
  // rmSync never follows a symlink: a planted link is removed, not its target.
  rmSync(hiddenDir, { recursive: true, force: true });
  mkdirSync(hiddenDir);
  for (const f of readdirSync(testsDir)) {
    if (f.endsWith(".ts")) cpSync(join(testsDir, f), join(hiddenDir, f));
  }
  // The workload's own fixtures (never the workspace's copy, which the contender can edit).
  if (existsSync(join(testsDir, "fixtures"))) cpSync(join(testsDir, "fixtures"), join(hiddenDir, "fixtures"), { recursive: true });
  cpSync(join(here, "reporter.mjs"), join(hiddenDir, "reporter.mjs"));
  for (const { from, as } of extra) cpSync(from, join(hiddenDir, as));
  // Kit files are readable by the check uid only; the contender uid must read the copies.
  chmodReadable(hiddenDir);
}

/**
 * Step 2 and 3: run the prepared hidden tests through `abRun` in <ws> and score them. Writes
 * <out>/hidden-tests.json, hidden-tests.log and hidden-tests.metrics.jsonl. Returns the summary.
 */
export function runHiddenTests({ workload, ws, out, abRun, timeoutS = 600 }) {
  const manifest = manifestOf(workload);
  mkdirSync(out, { recursive: true });
  const files = [...new Set(manifest.tests.map((t) => t.file))].map((f) => join(".hidden-tests", f));
  const rawPath = join(out, "hidden-tests.raw.jsonl");
  const logPath = join(out, "hidden-tests.log");
  const rawFd = openSync(rawPath, "w");
  const logFd = openSync(logPath, "w");
  const started = Date.now();
  let proc;
  try {
    proc = spawnSync(
      abRun,
      [
        "env",
        "NODE_ENV=test",
        "NO_COLOR=1",
        // `timeout` runs as the contender uid too, so it can kill what the tests leave behind.
        "timeout",
        "-k",
        "5",
        String(timeoutS),
        "node",
        "--test",
        "--test-timeout=30000",
        `--test-reporter=${join(ws, ".hidden-tests", "reporter.mjs")}`,
        "--test-reporter-destination=stdout",
        "--test-reporter=spec",
        "--test-reporter-destination=stderr",
        ...files,
      ],
      {
        cwd: ws,
        stdio: ["ignore", rawFd, logFd],
        // Backstop only: SIGTERM reaches `su`, which passes it on to the contender's processes.
        timeout: (timeoutS + 30) * 1000,
        killSignal: "SIGTERM",
      },
    );
  } finally {
    closeSync(rawFd);
    closeSync(logFd);
  }
  const durationS = (Date.now() - started) / 1000;

  const reported = new Map();
  for (const line of readFileSync(rawPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // contender output on stdout: not a reporter line
    }
    if (typeof r?.name !== "string" || (r.status !== "pass" && r.status !== "fail")) continue;
    const key = `${typeof r.file === "string" ? basename(r.file) : ""}::${r.name}`;
    // A failure wins over a pass for the same name (e.g. a retried or duplicated test).
    if (reported.get(key)?.status !== "fail") reported.set(key, r);
  }
  const timedOut = proc.status === 124 || proc.status === 137 || proc.error?.code === "ETIMEDOUT";
  const tests = manifest.tests.map((t) => {
    const r = reported.get(`${t.file}::${t.name}`);
    if (r === undefined) {
      return { file: t.file, name: t.name, area: t.area, status: "fail", error: timedOut ? "timed out" : "did not report (crashed or missing)" };
    }
    return { file: t.file, name: t.name, area: t.area, status: r.status, ...(r.error ? { error: String(r.error).slice(0, 2000) } : {}) };
  });
  const summary = summarize({ workload, areas: manifest.areas, tests, durationS, timedOut, exitCode: proc.status });
  writeFileSync(join(out, "hidden-tests.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(out, "hidden-tests.metrics.jsonl"), hiddenTestsMetricsJsonl(summary));
  return summary;
}

/**
 * Totals and per-area counts for scored tests ({area, status}[]), in the manifest's area order.
 * Only areas that have tests are scored (TDM-236): a manifest written in halves may list an area
 * before its tests land, and an empty area must not read as area_pass 0.
 */
export function summarize({ workload, areas, tests, durationS = 0, timedOut = false, exitCode = null }) {
  const passed = tests.filter((t) => t.status === "pass").length;
  const total = tests.length;
  const byArea = {};
  for (const a of areas) {
    const inArea = tests.filter((t) => t.area === a);
    if (inArea.length === 0) continue;
    byArea[a] = { passed: inArea.filter((t) => t.status === "pass").length, total: inArea.length };
  }
  return { workload, total, passed, failed: total - passed, fraction: total === 0 ? 0 : passed / total, areas: byArea, duration_s: durationS, timed_out: timedOut, exit_code: exitCode, tests };
}

/** Metric names, the exact strings packages/core exports (HIDDEN_TEST_FRACTION_METRIC etc., TDM-210). */
export const HIDDEN_TEST_FRACTION_METRIC = "hidden_test_fraction";
export const HIDDEN_TESTS_PASSED_METRIC = "hidden_tests_passed";
export const HIDDEN_TESTS_TOTAL_METRIC = "hidden_tests_total";
export const AREA_PASS_PREFIX = "area_pass.";

/** The metric rows of a summary: fraction, passed, total, then area_pass.<area> per area. */
export function hiddenTestsMetrics(summary) {
  const ratio = (passed, total) => (total === 0 ? 0 : passed / total);
  return [
    { metric: HIDDEN_TEST_FRACTION_METRIC, value: ratio(summary.passed, summary.total), unit: "ratio" },
    { metric: HIDDEN_TESTS_PASSED_METRIC, value: summary.passed, unit: "count" },
    { metric: HIDDEN_TESTS_TOTAL_METRIC, value: summary.total, unit: "count" },
    ...Object.entries(summary.areas).map(([area, { passed, total }]) => ({
      metric: `${AREA_PASS_PREFIX}${area}`,
      value: ratio(passed, total),
      unit: "ratio",
    })),
  ];
}

/** hidden-tests.metrics.jsonl text: one JSON row per metric. */
export function hiddenTestsMetricsJsonl(summary) {
  return hiddenTestsMetrics(summary)
    .map((m) => `${JSON.stringify({ ...m, source: "gate:hidden-tests" })}\n`)
    .join("");
}

/** The verdict for a summary from runHiddenTests. `prefix` is where its files sit under <out>. */
export function hiddenTestsVerdict(summary, prefix = "") {
  const failures = summary.tests.filter((t) => t.status !== "pass");
  const pass = summary.passed === summary.total && summary.total > 0;
  const first = failures[0];
  const reason = pass
    ? `${summary.passed}/${summary.total} hidden tests passed`
    : first === undefined
      ? `${summary.passed}/${summary.total} hidden tests passed: no hidden tests were scored`
      : `${summary.passed}/${summary.total} hidden tests passed (${weakestAreas(summary)}); first failure: ${first.file} › ${first.name}: ${first.error ?? "failed"}`.slice(0, 1000);
  return { pass, reason, evidence: [`${prefix}hidden-tests.json`, `${prefix}hidden-tests.log`] };
}

/** "cards 3/15, search 0/12" for the areas with a failure, weakest share first. */
function weakestAreas(summary) {
  return Object.entries(summary.areas ?? {})
    .filter(([, a]) => a.passed < a.total)
    .sort(([, x], [, y]) => x.passed / x.total - y.passed / y.total)
    .map(([id, a]) => `${id} ${a.passed}/${a.total}`)
    .join(", ");
}

export function writeVerdict(verdict, gate) {
  writeFileSync(verdict, `${JSON.stringify(gate, null, 2)}\n`);
}

/** The whole gate: prepare, run, score, write the verdict. Returns {gate, summary?}. */
export function gradeHiddenTests({ workload, runDir, out, verdict, abRun, timeoutS = 600 }) {
  manifestOf(workload); // a KitError before the outputs are touched
  const ws = workspaceOf(runDir);
  if (ws === null) {
    const gate = { pass: false, reason: "the outputs have no workspace/", evidence: [] };
    writeVerdict(verdict, gate);
    return { gate };
  }
  prepareHiddenTests({ workload, ws });
  const summary = runHiddenTests({ workload, ws, out, abRun, timeoutS });
  const gate = hiddenTestsVerdict(summary);
  writeVerdict(verdict, gate);
  return { gate, summary };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      workload: { type: "string" },
      "run-dir": { type: "string" },
      out: { type: "string" },
      verdict: { type: "string" },
      "timeout-s": { type: "string" },
    },
  });
  const abRun = process.env.AB_RUN;
  if (!values.workload || !values["run-dir"] || !values.out || !values.verdict || !abRun) {
    console.error("usage: AB_RUN=<cmd> grade.mjs --workload <id> --run-dir <AB_RUN_DIR> --out <frozen-out> --verdict <gate.json>");
    process.exit(2);
  }
  const verdict = resolve(values.verdict);
  try {
    manifestOf(values.workload);
  } catch (err) {
    console.error(`hidden-tests grader error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  try {
    const { gate } = gradeHiddenTests({
      workload: values.workload,
      runDir: resolve(values["run-dir"]),
      out: resolve(values.out),
      verdict,
      abRun,
      timeoutS: Number(values["timeout-s"] ?? 600),
    });
    console.log(`hidden-tests ${values.workload}: ${gate.pass ? "pass" : "fail"}: ${gate.reason}`);
  } catch (err) {
    // The outputs are involved: a FAIL verdict, not a broken check.
    const msg = err instanceof Error ? err.message : String(err);
    writeVerdict(verdict, { pass: false, reason: `hidden tests could not run on these outputs: ${msg}`.slice(0, 1000), evidence: [] });
    console.log(`hidden-tests ${values.workload}: fail: ${msg}`);
  }
}
