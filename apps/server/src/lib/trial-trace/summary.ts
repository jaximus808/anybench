// Run-level "where the time went" (pure): averages of trial traces per setup and per task. Only
// what the traces carry; every cell says how many trials it averages (n), and token averages only
// count trials whose every session reported tokens.
import type { RunTraceSummary, TraceAverage, TrialTrace } from "@anybench/core";

export interface TracedTrial {
  contenderId: string;
  workloadId: string;
  /** The gate passed (every applicable gate). */
  passed: boolean;
  trace: TrialTrace | null;
}

function average(rows: { trace: TrialTrace; passed: boolean }[]): TraceAverage {
  const n = rows.length;
  const avg = (f: (t: TrialTrace) => number) =>
    n ? rows.reduce((s, r) => s + f(r.trace), 0) / n : 0;
  const sumActors = (t: TrialTrace, f: (a: TrialTrace["actors"][number]) => number) =>
    t.actors.reduce((s, a) => s + f(a), 0);
  const main = (t: TrialTrace) => t.actors.filter((a) => a.role !== "subagent");
  const withTokens = rows.filter(
    (r) => main(r.trace).length > 0 && main(r.trace).every((a) => a.totals.tokens !== null),
  );
  const tokAvg = (k: "input" | "output" | "cache_read" | "cache_write") =>
    withTokens.reduce(
      (s, r) => s + main(r.trace).reduce((x, a) => x + (a.totals.tokens?.[k] ?? 0), 0),
      0,
    ) / (withTokens.length || 1);
  return {
    n,
    passed: rows.filter((r) => r.passed).length,
    duration_ms: avg((t) => t.duration_ms),
    wall: {
      model_ms: avg((t) => t.wall.model_ms),
      tool_ms: avg((t) => t.wall.tool_ms),
      coordination_ms: avg((t) => t.wall.coordination_ms),
      idle_ms: avg((t) => t.wall.idle_ms),
    },
    agent_ms: {
      model_ms: avg((t) => sumActors(t, (a) => a.totals.model_ms)),
      model_board_ms: avg((t) => sumActors(t, (a) => a.totals.model_board_ms)),
      tool_ms: avg((t) => sumActors(t, (a) => a.totals.tool_ms)),
      board_ms: avg((t) => sumActors(t, (a) => a.totals.board_ms)),
      wait_ms: avg((t) => sumActors(t, (a) => a.totals.wait_ms)),
    },
    sessions: avg((t) => main(t).length),
    turns: avg((t) => sumActors(t, (a) => a.totals.turns)),
    tool_calls: avg((t) => sumActors(t, (a) => a.totals.tool_calls)),
    board_calls: avg((t) => sumActors(t, (a) => a.totals.board_calls)),
    lost_claims: avg((t) => t.coordination.filter((c) => c.kind === "lost_claim").length),
    tokens: withTokens.length
      ? {
          n: withTokens.length,
          input: tokAvg("input"),
          output: tokAvg("output"),
          cache_read: tokAvg("cache_read"),
          cache_write: tokAvg("cache_write"),
        }
      : null,
  };
}

export function summarizeRunTraces(runId: string, trials: TracedTrial[]): RunTraceSummary {
  const setups = new Map<string, TracedTrial[]>();
  for (const t of trials) {
    const list = setups.get(t.contenderId) ?? [];
    list.push(t);
    setups.set(t.contenderId, list);
  }
  return {
    run_id: runId as RunTraceSummary["run_id"],
    setups: [...setups.entries()].map(([contenderId, list]) => {
      const traced = list.flatMap((t) => (t.trace ? [{ ...t, trace: t.trace }] : []));
      const tasks = [...new Set(traced.map((t) => t.workloadId))].sort();
      const names = traced.map((t) => t.trace.setup).filter((s): s is string => !!s);
      return {
        contender_id: contenderId as RunTraceSummary["setups"][number]["contender_id"],
        setup: names[0] ?? null,
        missing: list.length - traced.length,
        all: average(traced),
        by_task: tasks.map((w) => ({
          workload_id: w,
          ...average(traced.filter((t) => t.workloadId === w)),
        })),
      };
    }),
  };
}
