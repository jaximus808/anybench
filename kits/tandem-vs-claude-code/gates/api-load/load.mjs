#!/usr/bin/env node
// L5 gate `api-load` for tandem-vs-claude-code: API p95 latency at a fixed request rate.
//
//   check.sh <frozen-out> <workload-id> <gate.json>
//   → node load.mjs --workload <id> --run-dir "$AB_RUN_DIR" --out <frozen-out> --verdict <gate.json>
//
// The gate runner's calling convention (packages/bench gate.ts, TDM-51): contender code runs ONLY
// through "$AB_RUN" in "$AB_RUN_DIR"; this process writes only under <frozen-out> and <gate.json>.
//
// No speed number without a correctness gate: this first runs the hidden tests on the same
// workspace (into <frozen-out>/api-load-hidden/). Only if every hidden test passes does it start the
// app and drive load, so a fast but wrong API never gets a latency number.
//
// Workloads without an API (not in workloads.json) answer {pass: false, applicable: false}: the
// trial leaves the gate's tally and api-p95 (which is also scoped to `workloads: [todo-api]`).
//
// Load: the app runs as the contender uid (`"$AB_RUN" node .hidden-tests/serve.ts`, copied in with
// the hidden tests before any contender code runs); it prints its port and exits when its stdin
// closes. This process seeds a user with N todos, sends warm-up requests, then fires requests on a
// fixed open-loop schedule (rps, duration_s) alternating the `mix`. Latency is send → full body
// read. Any non-2xx or network error fails the gate. Overrides for quick local runs:
// LOAD_DURATION_S, LOAD_RPS.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  hiddenTestsVerdict,
  manifestOf,
  prepareHiddenTests,
  runHiddenTests,
  workspaceOf,
  writeVerdict,
} from "../hidden-tests/grade.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function writeMetrics(out, metrics) {
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "api-load.metrics.jsonl"),
    metrics.map((m) => `${JSON.stringify({ ...m, source: "gate:api-load" })}\n`).join(""),
  );
}

/** Nearest-rank percentile. */
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Starts the contender's app as the contender uid. `stop()` closes its stdin and waits for exit. */
async function startServer(ws, abRun, deadlineS) {
  const child = spawn(
    abRun,
    ["env", "NODE_ENV=production", "NO_COLOR=1", "timeout", "-k", "5", String(deadlineS), "node", ".hidden-tests/serve.ts"],
    { cwd: ws, stdio: ["pipe", "pipe", "inherit"] },
  );
  child.stdin.on("error", () => {}); // EPIPE once the app is gone: nothing left to close
  const exited = new Promise((r) => child.on("exit", r));
  const port = await new Promise((resolvePort, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.stdin.end(); // serve.ts exits when its stdin closes; check.sh stops whatever is left
      reject(new Error("app did not start within 20 s"));
    }, 20_000);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const m = /^PORT (\d+)$/m.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolvePort(Number(m[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`app exited early with code ${code}`));
    });
  });
  const stop = async () => {
    child.stdin.end();
    const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 10_000))]);
    if (!done) {
      child.kill("SIGTERM"); // reaches `su`, which passes it on
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    }
  };
  return { port, stop };
}

async function drive(base, profile) {
  const call = async (method, path, body, token) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const t0 = performance.now();
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, ms: performance.now() - t0, text };
  };
  const email = `load-${process.pid}@example.test`;
  const reg = await call("POST", "/auth/register", { email, password: "load-test-password" });
  if (reg.status !== 201) throw new Error(`register answered ${reg.status}`);
  const login = await call("POST", "/auth/login", { email, password: "load-test-password" });
  if (login.status !== 200) throw new Error(`login answered ${login.status}`);
  const token = JSON.parse(login.text).token;
  for (let i = 0; i < profile.seed_todos; i++) {
    const r = await call("POST", "/todos", { title: `seed ${i}` }, token);
    if (r.status !== 201) throw new Error(`seeding answered ${r.status}`);
  }

  const one = (i) => (i % 2 === 0 ? call("GET", "/todos?limit=20", undefined, token) : call("POST", "/todos", { title: `load ${i}` }, token));
  for (let i = 0; i < profile.warmup_requests; i++) await one(i);

  const total = Math.round(profile.rps * profile.duration_s);
  const interval = 1000 / profile.rps;
  const start = performance.now();
  const pending = [];
  const latencies = [];
  let errors = 0;
  let firstError;
  for (let i = 0; i < total; i++) {
    const due = start + i * interval;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    pending.push(
      one(i).then(
        (r) => {
          latencies.push(r.ms);
          if (r.status < 200 || r.status >= 300) {
            errors += 1;
            firstError ??= `HTTP ${r.status}: ${r.text.slice(0, 200)}`;
          }
        },
        (err) => {
          errors += 1;
          firstError ??= String(err);
        },
      ),
    );
  }
  await Promise.all(pending);
  const elapsedS = (performance.now() - start) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    requests: total,
    errors,
    first_error: firstError ?? null,
    achieved_rps: total / elapsedS,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p99_ms: percentile(latencies, 99),
    max_ms: latencies[latencies.length - 1] ?? NaN,
  };
}

export async function runApiLoad({ workload, runDir, out, verdict, abRun }) {
  const profiles = JSON.parse(readFileSync(join(here, "workloads.json"), "utf8"));
  const base = profiles[workload];
  if (base === undefined) {
    const gate = {
      pass: false,
      applicable: false,
      reason: `not applicable: workload '${workload}' has no API under load (api-p95 is scored on ${Object.keys(profiles).join(", ")} only)`,
      evidence: [],
    };
    writeVerdict(verdict, gate);
    return { applicable: false, gate };
  }
  manifestOf(workload); // a KitError before the outputs are touched
  const profile = {
    ...base,
    duration_s: Number(process.env.LOAD_DURATION_S ?? base.duration_s),
    rps: Number(process.env.LOAD_RPS ?? base.rps),
  };
  mkdirSync(out, { recursive: true });
  const ws = workspaceOf(runDir);
  if (ws === null) {
    const gate = { pass: false, reason: "the outputs have no workspace/", evidence: [] };
    writeVerdict(verdict, gate);
    return { applicable: true, gate };
  }
  // Everything the contender uid runs is copied in now, before any contender code runs.
  prepareHiddenTests({ workload, ws, extra: [{ from: join(here, "serve.ts"), as: "serve.ts" }] });

  const hidden = runHiddenTests({ workload, ws, out: join(out, "api-load-hidden"), abRun });
  if (hidden.passed !== hidden.total) {
    const gate = {
      pass: false,
      reason: `no latency without correctness: ${hidden.passed}/${hidden.total} hidden tests passed, so the API was not load tested`,
      evidence: hiddenTestsVerdict(hidden, "api-load-hidden/").evidence,
    };
    writeVerdict(verdict, gate);
    return { applicable: true, hidden, gate };
  }

  let server;
  try {
    const deadlineS = Math.ceil(profile.duration_s + 300);
    server = await startServer(ws, abRun, deadlineS);
    const result = { workload, profile, ...(await drive(`http://127.0.0.1:${server.port}`, profile)) };
    writeFileSync(join(out, "api-load.json"), `${JSON.stringify(result, null, 2)}\n`);
    const pass = result.errors === 0;
    const gate = {
      pass,
      reason: pass
        ? `p95 ${result.p95_ms.toFixed(1)} ms at ${profile.rps} req/s over ${result.requests} requests, 0 errors`
        : `${result.errors}/${result.requests} requests failed under load; first: ${result.first_error}`,
      evidence: ["api-load.json", "api-load-hidden/hidden-tests.json"],
    };
    writeMetrics(
      out,
      pass
        ? [
            { metric: "api_p95_ms", value: Number(result.p95_ms.toFixed(3)), unit: "ms" },
            { metric: "api_p50_ms", value: Number(result.p50_ms.toFixed(3)), unit: "ms" },
            { metric: "api_p99_ms", value: Number(result.p99_ms.toFixed(3)), unit: "ms" },
            { metric: "api_requests", value: result.requests, unit: "count" },
          ]
        : [],
    );
    writeVerdict(verdict, gate);
    return { applicable: true, hidden, result, gate };
  } catch (err) {
    const gate = { pass: false, reason: `load run failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000), evidence: [] };
    writeVerdict(verdict, gate);
    return { applicable: true, hidden, error: String(err), gate };
  } finally {
    await server?.stop();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      workload: { type: "string" },
      "run-dir": { type: "string" },
      out: { type: "string" },
      verdict: { type: "string" },
    },
  });
  const abRun = process.env.AB_RUN;
  if (!values.workload || !values["run-dir"] || !values.out || !values.verdict || !abRun) {
    console.error("usage: AB_RUN=<cmd> load.mjs --workload <id> --run-dir <AB_RUN_DIR> --out <frozen-out> --verdict <gate.json>");
    process.exit(2);
  }
  const verdict = resolve(values.verdict);
  try {
    JSON.parse(readFileSync(join(here, "workloads.json"), "utf8"));
  } catch (err) {
    console.error(`api-load grader error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  try {
    const { gate } = await runApiLoad({
      workload: values.workload,
      runDir: resolve(values["run-dir"]),
      out: resolve(values.out),
      verdict,
      abRun,
    });
    console.log(`api-load ${values.workload}: ${gate.pass ? "pass" : "fail"}: ${gate.reason}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err?.constructor?.name === "KitError") {
      console.error(`api-load grader error: ${msg}`);
      process.exit(2);
    }
    writeVerdict(verdict, { pass: false, reason: `api-load could not run on these outputs: ${msg}`.slice(0, 1000), evidence: [] });
    console.log(`api-load ${values.workload}: fail: ${msg}`);
  }
}
