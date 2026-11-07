#!/usr/bin/env node
// L5 gate `api-load` for tandem-vs-claude-code: API p95 latency at a fixed request rate.
//
//   node load.mjs --workload <id> --workspace <frozen EVAL_WS> --out <dir>
//
// No speed number without a correctness gate: this first runs the hidden-tests gate on the same
// workspace (into <out>/hidden-tests/). Only if every hidden test passes does it start the app
// and drive load, so a fast but wrong API never gets a latency number.
//
// Workloads without an API (not in workloads.json) get pass:false with a "not applicable" reason:
// the scorer only counts metrics from trials whose gate passed, so api-p95 is scored on todo-api
// trials only.
//
// Load: the app runs in its own process (`load.mjs serve <sandbox>`); this process seeds a user
// with N todos, sends warm-up requests, then fires requests on a fixed open-loop schedule
// (rps, duration_s) alternating the `mix`. Latency is send → full body read. Any non-2xx or
// network error fails the gate. Overrides for quick local runs: LOAD_DURATION_S, LOAD_RPS.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gradeHiddenTests } from "../hidden-tests/grade.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function writeGate(out, gate, metrics = []) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
  writeFileSync(join(out, "metrics.jsonl"), metrics.map((m) => `${JSON.stringify({ ...m, source: "gate:api-load" })}\n`).join(""));
}

/** Nearest-rank percentile. */
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function startServer(sandbox) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", sandbox], {
    cwd: sandbox,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sandbox, NODE_ENV: "production", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolvePort, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("app did not start within 20 s")), 20_000);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const m = /^PORT (\d+)$/m.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolvePort(Number(m[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`app exited early with code ${code}`)));
  });
  return { port, stop: () => child.kill("SIGKILL") };
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

export async function runApiLoad({ workload, workspace, out }) {
  const profiles = JSON.parse(readFileSync(join(here, "workloads.json"), "utf8"));
  const base = profiles[workload];
  if (base === undefined) {
    writeGate(out, {
      pass: false,
      reason: `not applicable: workload '${workload}' has no API under load (api-p95 is scored on ${Object.keys(profiles).join(", ")} only)`,
      evidence: [],
    });
    return { applicable: false };
  }
  const profile = {
    ...base,
    duration_s: Number(process.env.LOAD_DURATION_S ?? base.duration_s),
    rps: Number(process.env.LOAD_RPS ?? base.rps),
  };

  const hidden = gradeHiddenTests({ workload, workspace, out: join(out, "hidden-tests") });
  if (hidden.passed !== hidden.total) {
    writeGate(out, {
      pass: false,
      reason: `no latency without correctness: ${hidden.passed}/${hidden.total} hidden tests passed, so the API was not load tested`,
      evidence: ["hidden-tests/gate.json", "hidden-tests/hidden-tests.json"],
    });
    return { applicable: true, hidden };
  }

  const sandbox = mkdtempSync(join(tmpdir(), `api-load-${workload}-`));
  let server;
  try {
    cpSync(workspace, sandbox, { recursive: true, filter: (src) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(src.slice(workspace.length)) });
    server = await startServer(sandbox);
    const result = { workload, profile, ...(await drive(`http://127.0.0.1:${server.port}`, profile)) };
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "api-load.json"), `${JSON.stringify(result, null, 2)}\n`);
    const pass = result.errors === 0;
    writeGate(
      out,
      {
        pass,
        reason: pass
          ? `p95 ${result.p95_ms.toFixed(1)} ms at ${profile.rps} req/s over ${result.requests} requests, 0 errors`
          : `${result.errors}/${result.requests} requests failed under load; first: ${result.first_error}`,
        evidence: ["api-load.json", "hidden-tests/gate.json"],
      },
      pass
        ? [
            { metric: "api_p95_ms", value: Number(result.p95_ms.toFixed(3)), unit: "ms" },
            { metric: "api_p50_ms", value: Number(result.p50_ms.toFixed(3)), unit: "ms" },
            { metric: "api_p99_ms", value: Number(result.p99_ms.toFixed(3)), unit: "ms" },
            { metric: "api_requests", value: result.requests, unit: "count" },
          ]
        : [],
    );
    return { applicable: true, hidden, result };
  } catch (err) {
    writeGate(out, { pass: false, reason: `load run failed: ${err instanceof Error ? err.message : String(err)}`, evidence: [] });
    return { applicable: true, hidden, error: String(err) };
  } finally {
    server?.stop();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv[2] === "serve") {
  // Child mode: start the contender's app and report the port.
  const sandbox = process.argv[3];
  const { createApp } = await import(pathToFileURL(join(sandbox, "src/app.ts")).href);
  const server = createApp({});
  server.listen(0, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));
} else if (isMain) {
  const { values } = parseArgs({ options: { workload: { type: "string" }, workspace: { type: "string" }, out: { type: "string" } } });
  if (!values.workload || !values.workspace || !values.out) {
    console.error("usage: load.mjs --workload <id> --workspace <dir> --out <dir>");
    process.exit(2);
  }
  const r = await runApiLoad({ workload: values.workload, workspace: resolve(values.workspace), out: resolve(values.out) });
  const gate = JSON.parse(readFileSync(join(resolve(values.out), "gate.json"), "utf8"));
  console.log(`api-load ${values.workload}: ${gate.pass ? "pass" : "fail"}: ${gate.reason}`);
  if (r.error !== undefined && r.hidden === undefined) process.exit(2);
}
