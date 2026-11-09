// TDM-239 [18.18]: one calibration trial's row from the out dir run-docker-local.ts wrote.
//
//   node --import tsx scripts/spikes/long-horizon-calibration/analyze.ts <out-dir> [...]
//
// Per trial: the gate (hidden_test_fraction, passed/total, area_pass), wall, and per session
// (Claude Code's own result line): cost, tokens, turns, peak context (the largest
// input + cache read + cache write of any one model call) and compactions (system
// compact_boundary lines). Then the trial trace the server builds (apps/server trial-trace
// buildTrialTrace) for the wall split and the board-only model time. Prints JSON.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildTrialTrace, isTraceSource } from "../../../apps/server/src/lib/trial-trace/parse.js";

type Json = Record<string, unknown>;

function lines(file: string): Json[] {
  const out: Json[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as Json);
    } catch {
      /* partial line */
    }
  }
  return out;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

function session(file: string) {
  let peak = 0;
  let compactions = 0;
  let result: Json | null = null;
  let results = 0;
  // One `claude -p` session can write several results (TDM-239): `usage` covers the turns since
  // the previous one, `total_cost_usd` is the running total. Sum the usage, keep the last total.
  const sumTokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const ids = new Set<string>();
  for (const e of lines(file)) {
    if (e.type === "assistant") {
      const m = e.message as { id?: string; usage?: Record<string, number> } | undefined;
      const u = m?.usage;
      if (m?.id) ids.add(m.id);
      if (u) {
        const ctx =
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
        peak = Math.max(peak, ctx);
      }
    }
    if (e.type === "system" && e.subtype === "compact_boundary") compactions++;
    if (e.type === "result") {
      result = e;
      results++;
      const u = (e.usage ?? {}) as Record<string, number>;
      sumTokens.input += u.input_tokens ?? 0;
      sumTokens.output += u.output_tokens ?? 0;
      sumTokens.cache_read += u.cache_read_input_tokens ?? 0;
      sumTokens.cache_write += u.cache_creation_input_tokens ?? 0;
    }
  }
  return {
    file: path.basename(file),
    messages: ids.size,
    results,
    peak_context: peak,
    compactions,
    outcome: (result?.subtype as string | undefined) ?? null,
    num_turns: (result?.num_turns as number | undefined) ?? null,
    duration_ms: (result?.duration_ms as number | undefined) ?? null,
    cost_usd: (result?.total_cost_usd as number | undefined) ?? null,
    tokens: results > 0 ? sumTokens : null,
  };
}

function analyze(dir: string) {
  const out = path.join(dir, "out");
  const summary = existsSync(path.join(dir, "summary.json"))
    ? (JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")) as Json)
    : null;
  const gate = existsSync(path.join(dir, "gate", "gate.json"))
    ? (JSON.parse(readFileSync(path.join(dir, "gate", "gate.json"), "utf8")) as Json)
    : null;
  const metricsFile = path.join(dir, "gate", "frozen", "hidden-tests.metrics.jsonl");
  const metrics: Record<string, number> = {};
  const areaPass: Record<string, number> = {};
  if (existsSync(metricsFile)) {
    for (const m of lines(metricsFile)) {
      const name = String(m.metric ?? m.name ?? "");
      const v = Number(m.value);
      if (name.startsWith("area_pass.")) areaPass[name.slice(10)] = v;
      else if (name) metrics[name] = v;
    }
  }
  const streams = [
    ...(existsSync(path.join(out, "stream.jsonl")) ? [path.join(out, "stream.jsonl")] : []),
    ...(existsSync(path.join(out, "tandem", "streams"))
      ? readdirSync(path.join(out, "tandem", "streams"))
          .filter((n) => n.endsWith(".jsonl"))
          .sort()
          .map((n) => path.join(out, "tandem", "streams", n))
      : []),
  ];
  const sessions = streams.map(session);
  const sum = (f: (s: (typeof sessions)[number]) => number) =>
    sessions.reduce((a, s) => a + f(s), 0);
  const costUsd = sum((s) => s.cost_usd ?? 0);

  // The trace the server would store for this trial.
  let trace: Json | null = null;
  try {
    const entries = walk(out)
      .filter((n) => isTraceSource(n))
      .map((name) => ({ name, data: new Uint8Array(readFileSync(path.join(out, name))) }));
    const t = buildTrialTrace({
      trialId: randomUUID(),
      entries: entries as never,
      gate: gate ?? null,
    });
    const board = t.actors.reduce((a, x) => a + x.totals.model_board_ms, 0);
    const model = t.actors.reduce((a, x) => a + x.totals.model_ms, 0);
    trace = {
      duration_ms: t.duration_ms,
      wall: t.wall,
      phases: t.phases,
      sessions: t.actors.length,
      model_ms_summed: model,
      model_board_ms_summed: board,
      board_share_of_model: model > 0 ? Math.round((board / model) * 1000) / 1000 : null,
      wait_ms_summed: t.actors.reduce((a, x) => a + x.totals.wait_ms, 0),
      board_calls: t.actors.reduce((a, x) => a + x.totals.board_calls, 0),
      test_runs: t.actors.reduce((a, x) => a + x.totals.test_runs, 0),
      coordination_events: t.coordination.length,
      notes: t.notes,
    };
  } catch (e) {
    trace = { error: e instanceof Error ? e.message : String(e) };
  }

  const runJson = path.join(out, "tandem", "run.json");
  return {
    dir,
    contender: summary?.contender ?? null,
    workload: summary?.workload ?? null,
    wall_s: summary?.wall_s ?? null,
    runner: summary?.runner ?? null,
    workspace_frozen_by: summary?.workspace_frozen_by ?? null,
    gate_pass: (gate as { pass?: boolean } | null)?.pass ?? null,
    hidden_test_fraction: metrics.hidden_test_fraction ?? null,
    hidden_tests_passed: metrics.hidden_tests_passed ?? null,
    hidden_tests_total: metrics.hidden_tests_total ?? null,
    area_pass: areaPass,
    cost_usd: Math.round(costUsd * 1e6) / 1e6,
    cost_micro_usd: Math.round(costUsd * 1e6),
    sessions_with_result: sessions.filter((s) => s.cost_usd !== null).length,
    sessions: sessions.length,
    peak_context: Math.max(0, ...sessions.map((s) => s.peak_context)),
    compactions: sum((s) => s.compactions),
    tokens: {
      input: sum((s) => s.tokens?.input ?? 0),
      output: sum((s) => s.tokens?.output ?? 0),
      cache_read: sum((s) => s.tokens?.cache_read ?? 0),
      cache_write: sum((s) => s.tokens?.cache_write ?? 0),
    },
    per_session: sessions,
    tandem_run: existsSync(runJson) ? JSON.parse(readFileSync(runJson, "utf8")) : null,
    key_leaks: summary?.key_leaks ?? null,
    trace,
  };
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: analyze.ts <out-dir> [...]");
  process.exit(2);
}
console.log(
  JSON.stringify(
    dirs.map((d) => analyze(path.resolve(d))),
    null,
    2,
  ),
);
