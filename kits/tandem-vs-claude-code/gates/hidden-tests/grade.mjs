#!/usr/bin/env node
// Hidden-tests gate (L5) for tandem-vs-claude-code. Runs on the scoring computer only.
//
//   node grade.mjs --workload <id> --workspace <frozen EVAL_WS> --out <dir>
//
// 1. Copies the frozen workspace to a fresh sandbox (the original is never modified) and drops
//    any `.hidden-tests/` the contender may have planted.
// 2. Copies gates/hidden-tests/<workload>/*.ts into <sandbox>/.hidden-tests/ and runs them with
//    `node --test`, offline, with a scrubbed env (no secrets reach contender code).
// 3. Scores every test listed in <workload>/tests.json. A test that never reported (crash,
//    timeout, missing module) counts as failed, so a broken workspace can't shrink the total.
// 4. Writes <out>/gate.json {pass, reason, evidence[]}, <out>/metrics.jsonl,
//    <out>/hidden-tests.json (per-test results) and <out>/hidden-tests.log (spec output).
//
// The gate passes only when every hidden test passes. Exit 0 whenever a verdict was written;
// exit 2 means the grader itself is broken (a kit failure, not a contender failure).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));

export function gradeHiddenTests({ workload, workspace, out, timeoutS = 600 }) {
  const testsDir = join(here, workload);
  const manifestPath = join(testsDir, "tests.json");
  if (!existsSync(manifestPath)) throw new Error(`no hidden tests for workload '${workload}'`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!existsSync(workspace)) throw new Error(`workspace ${workspace} does not exist`);
  mkdirSync(out, { recursive: true });

  const sandbox = mkdtempSync(join(tmpdir(), `hidden-${workload}-`));
  try {
    cpSync(workspace, sandbox, {
      recursive: true,
      filter: (src) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(src.slice(workspace.length)),
    });
    const hiddenDir = join(sandbox, ".hidden-tests");
    rmSync(hiddenDir, { recursive: true, force: true });
    mkdirSync(hiddenDir);
    for (const f of readdirSync(testsDir)) {
      if (f.endsWith(".ts")) cpSync(join(testsDir, f), join(hiddenDir, f));
    }

    const files = [...new Set(manifest.tests.map((t) => t.file))].map((f) => join(".hidden-tests", f));
    const rawPath = join(out, "hidden-tests.raw.jsonl");
    const logPath = join(out, "hidden-tests.log");
    const started = Date.now();
    const proc = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-timeout=30000",
        `--test-reporter=${join(here, "reporter.mjs")}`,
        `--test-reporter-destination=${rawPath}`,
        "--test-reporter=spec",
        `--test-reporter-destination=${logPath}`,
        ...files,
      ],
      {
        cwd: sandbox,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sandbox, TMPDIR: tmpdir(), NODE_ENV: "test", NO_COLOR: "1" },
        encoding: "utf8",
        timeout: timeoutS * 1000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const durationS = (Date.now() - started) / 1000;

    const reported = new Map();
    if (existsSync(rawPath)) {
      for (const line of readFileSync(rawPath, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const r = JSON.parse(line);
        const key = `${r.file === null ? "" : basename(r.file)}::${r.name}`;
        // A failure wins over a pass for the same name (e.g. a retried or duplicated test).
        if (reported.get(key)?.status !== "fail") reported.set(key, r);
      }
    }
    const timedOut = proc.error?.code === "ETIMEDOUT" || proc.signal === "SIGKILL";
    const tests = manifest.tests.map((t) => {
      const r = reported.get(`${t.file}::${t.name}`);
      if (r === undefined) {
        return { file: t.file, name: t.name, status: "fail", error: timedOut ? "timed out" : "did not report (crashed or missing)" };
      }
      return { file: t.file, name: t.name, status: r.status, ...(r.error ? { error: r.error } : {}) };
    });
    const passed = tests.filter((t) => t.status === "pass").length;
    const total = tests.length;
    const summary = { workload, total, passed, failed: total - passed, duration_s: durationS, timed_out: timedOut, exit_code: proc.status, tests };
    writeFileSync(join(out, "hidden-tests.json"), `${JSON.stringify(summary, null, 2)}\n`);

    const failures = tests.filter((t) => t.status !== "pass");
    const pass = passed === total && total > 0;
    const reason = pass
      ? `${passed}/${total} hidden tests passed`
      : `${passed}/${total} hidden tests passed; first failure: ${failures[0].file} › ${failures[0].name}: ${failures[0].error ?? "failed"}`.slice(0, 1000);
    const gate = { pass, reason, evidence: ["hidden-tests.json", "hidden-tests.log"] };
    writeFileSync(join(out, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
    const metrics = [
      { metric: "hidden_tests_passed", value: passed, unit: "count" },
      { metric: "hidden_tests_total", value: total, unit: "count" },
      { metric: "hidden_tests_passed_ratio", value: total === 0 ? 0 : passed / total, unit: "ratio" },
    ];
    writeFileSync(join(out, "metrics.jsonl"), metrics.map((m) => `${JSON.stringify({ ...m, source: "gate:hidden-tests" })}\n`).join(""));
    return summary;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { workload: { type: "string" }, workspace: { type: "string" }, out: { type: "string" }, "timeout-s": { type: "string" } },
  });
  if (!values.workload || !values.workspace || !values.out) {
    console.error("usage: grade.mjs --workload <id> --workspace <dir> --out <dir> [--timeout-s 600]");
    process.exit(2);
  }
  try {
    const s = gradeHiddenTests({
      workload: values.workload,
      workspace: resolve(values.workspace),
      out: resolve(values.out),
      timeoutS: Number(values["timeout-s"] ?? 600),
    });
    console.log(`hidden-tests ${s.workload}: ${s.passed}/${s.total} passed (${s.duration_s.toFixed(1)}s)`);
  } catch (err) {
    console.error(`hidden-tests grader error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
