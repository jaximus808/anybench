// Trace view model (pure): sentences and numbers for the Trace view and the run's "where the time
// went" panel. Every sentence is arithmetic on the trace; nothing is inferred beyond it.
import type { RunTraceSummary, TraceAverage, TraceStep, TrialTrace } from "@anybench/core";

export const KIND_WORD: Record<TraceStep["kind"], string> = {
  model: "Model turn",
  tool: "Tool call",
  board: "Board call",
  wait: "Waiting on the board",
};

/** "1m 05s" / "12.4s" / "340ms". */
export function dur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** "1.98M" / "36.4k" / "94". */
export function tok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** Axis ticks: a round step giving 4–8 ticks. */
export function ticks(durationMs: number): number[] {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800].map((s) => s * 1000);
  const step = steps.find((s) => durationMs / s <= 8) ?? 3_600_000;
  const out: number[] = [];
  for (let t = 0; t <= durationMs; t += step) out.push(t);
  return out;
}

export function tickLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface TraceTotals {
  sessions: number;
  turns: number;
  toolCalls: number;
  boardCalls: number;
  modelMs: number;
  modelBoardMs: number;
  waitMs: number;
  lostClaims: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  /** Sessions that reported tokens / all sessions. */
  tokenSessions: number;
  costMicroUsd: bigint | null;
}

export function traceTotals(trace: TrialTrace): TraceTotals {
  const main = trace.actors.filter((a) => a.role !== "subagent");
  const withTok = main.filter((a) => a.totals.tokens);
  const costs = main.map((a) => a.totals.cost_micro_usd);
  return {
    sessions: main.length,
    turns: trace.actors.reduce((n, a) => n + a.totals.turns, 0),
    toolCalls: trace.actors.reduce((n, a) => n + a.totals.tool_calls, 0),
    boardCalls: trace.actors.reduce((n, a) => n + a.totals.board_calls, 0),
    modelMs: trace.actors.reduce((n, a) => n + a.totals.model_ms, 0),
    modelBoardMs: trace.actors.reduce((n, a) => n + a.totals.model_board_ms, 0),
    waitMs: trace.actors.reduce((n, a) => n + a.totals.wait_ms, 0),
    lostClaims: trace.coordination.filter((c) => c.kind === "lost_claim").length,
    tokens: withTok.length
      ? {
          input: withTok.reduce((n, a) => n + a.totals.tokens!.input, 0),
          output: withTok.reduce((n, a) => n + a.totals.tokens!.output, 0),
          cacheRead: withTok.reduce((n, a) => n + a.totals.tokens!.cache_read, 0),
          cacheWrite: withTok.reduce((n, a) => n + a.totals.tokens!.cache_write, 0),
        }
      : null,
    tokenSessions: withTok.length,
    costMicroUsd: costs.every((c) => c !== null)
      ? costs.reduce<bigint>((n, c) => n + (c ?? 0n), 0n)
      : null,
  };
}

/** The Trace view's lead: what the wall time was spent on, then what the sessions did. */
export function traceSentences(trace: TrialTrace): string[] {
  const t = traceTotals(trace);
  const w = trace.wall;
  const d = trace.duration_ms;
  const out = [
    `${dur(d)} from start to finish. A model call was in flight for ${pct(w.model_ms, d)}% of it, tools ran for ${pct(w.tool_ms, d)}%` +
      (w.coordination_ms > 0
        ? `, only board calls or waits for ${pct(w.coordination_ms, d)}%`
        : "") +
      `, and nothing the transcripts show for ${pct(w.idle_ms, d)}% (startup, teardown).`,
  ];
  if (t.sessions > 1) {
    const planning = trace.phases.find((p) => p.name === "planning");
    out.push(
      `${t.sessions} sessions made ${t.turns} model turns. ${pct(t.modelBoardMs, t.modelMs)}% of their model time was turns whose only calls went to the board` +
        (t.waitMs > 0 ? `, and they spent ${dur(t.waitMs)} blocked waiting on it` : "") +
        (t.lostClaims > 0
          ? `. ${t.lostClaims} claim${t.lostClaims === 1 ? " was" : "s were"} lost to another worker`
          : "") +
        ".",
    );
    if (planning) {
      out.push(
        `Workers started ${dur(planning.end_ms)} in, after the planner's ${dur(planning.end_ms - planning.start_ms)} of planning.`,
      );
    }
  } else if (t.sessions === 1) {
    out.push(`One session, ${t.turns} model turns and ${t.toolCalls} tool calls.`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Run summary

export interface SetupRow {
  contenderId: string;
  name: string;
  avg: TraceAverage;
  missing: number;
}

export function setupRows(summary: RunTraceSummary, names: Record<string, string>): SetupRow[] {
  return summary.setups
    .filter((s) => s.all.n > 0)
    .map((s) => ({
      contenderId: s.contender_id,
      name: names[s.contender_id] ?? s.setup ?? s.contender_id.slice(0, 8),
      avg: s.all,
      missing: s.missing,
    }));
}

/**
 * "tandem took 3.3× as long per trial as claude-code-solo (3m 57s vs 1m 11s, n=18 and n=18). Of
 * the 2m 46s difference: model in flight 1m 57s, coordination only 33s, ..." — the wall-split
 * difference, bucket by bucket. Null without two setups.
 */
export function differenceSentence(rows: SetupRow[]): string | null {
  if (rows.length < 2) return null;
  const sorted = [...rows].sort((a, b) => b.avg.duration_ms - a.avg.duration_ms);
  const slow = sorted[0]!;
  const fast = sorted[sorted.length - 1]!;
  if (fast.avg.duration_ms <= 0) return null;
  const ratio = slow.avg.duration_ms / fast.avg.duration_ms;
  const diff = slow.avg.duration_ms - fast.avg.duration_ms;
  const parts = (
    [
      ["model calls in flight", slow.avg.wall.model_ms - fast.avg.wall.model_ms],
      ["only board calls or waits", slow.avg.wall.coordination_ms - fast.avg.wall.coordination_ms],
      ["nothing running (startup, teardown)", slow.avg.wall.idle_ms - fast.avg.wall.idle_ms],
      ["tools", slow.avg.wall.tool_ms - fast.avg.wall.tool_ms],
    ] as const
  )
    .filter(([, v]) => Math.abs(v) >= 1000)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v < 0 ? "−" : ""}${dur(Math.abs(v))} ${k}`);
  return (
    `${slow.name} took ${ratio.toFixed(1)}× as long per trial as ${fast.name} ` +
    `(${dur(slow.avg.duration_ms)} vs ${dur(fast.avg.duration_ms)}, n=${slow.avg.n} and n=${fast.avg.n}). ` +
    `The ${dur(diff)} difference is ${parts.join(", ")}.`
  );
}
