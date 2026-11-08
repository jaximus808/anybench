// The scoreboard: each setup's raw numbers side by side, as bars. Success rate (hidden tests
// passed over graded trials), average time and average cost, overall and per task. Plain counts,
// no verdict: the statistics live in the table under it, and the reader draws the conclusion.
// One builder over plain cells; the live page makes cells from trials + the trace summary, the
// public page reads them from the signed snapshot.
import type { PublicationScoreCell, RunTraceSummary, Trial } from "@anybench/core";

export type Setup = { id: string; name: string; baseline: boolean };

/** One setup's numbers, overall (`task` null) or for one task. */
export type ScoreCell = {
  setupId: string;
  task: string | null;
  graded: number;
  passed: number;
  costMicro: number;
  timeMs: number | null;
  timeN: number;
};

export type Bar = {
  setupId: string;
  name: string;
  baseline: boolean;
  /** Bar height, 0–1 of the group's max (or of 100% for rates). */
  frac: number;
  label: string;
  sub: string;
  best: boolean;
};

export type BarGroup = { key: string; title: string; hint: string; bars: Bar[] };

export type Board = { headline: BarGroup[]; tasks: { task: string; groups: BarGroup[] }[] };

const GRADED = new Set(["done", "failed_subject"]);

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

export function fmtUsd(micro: number): string {
  const d = micro / 1e6;
  return d >= 10 ? `$${d.toFixed(1)}` : `$${d.toFixed(2)}`;
}

/** Bars scaled to the group max; `lowerIsBetter` marks the smallest as best. */
function scaled(
  setups: Setup[],
  values: (number | null)[],
  label: (v: number) => string,
  sub: (i: number) => string,
  opts: { lowerIsBetter: boolean; max?: number },
): Bar[] {
  const present = values.filter((v): v is number => v !== null);
  const max = opts.max ?? Math.max(...present, 0);
  const bestV = present.length
    ? opts.lowerIsBetter
      ? Math.min(...present)
      : Math.max(...present)
    : null;
  const winners = values.filter((v) => v === bestV).length;
  return setups.map((s, i) => {
    const v = values[i] ?? null;
    return {
      setupId: s.id,
      name: s.name,
      baseline: s.baseline,
      frac: v === null || max <= 0 ? 0 : Math.max(v / max, 0.02),
      label: v === null ? "–" : label(v),
      sub: sub(i),
      best: v !== null && v === bestV && winners < setups.length,
    };
  });
}

export function buildBoard(
  setups: Setup[],
  cells: ScoreCell[],
  timeHint = "wall clock, start to finish",
): Board | null {
  if (!setups.length || !cells.some((c) => c.graded > 0)) return null;
  const at = (task: string | null) =>
    setups.map((s) => cells.find((c) => c.setupId === s.id && c.task === task) ?? null);

  const groups = (task: string | null, keyTail: string): BarGroup[] => {
    const cs = at(task);
    const out: BarGroup[] = [
      {
        key: `rate${keyTail}`,
        title: "Success rate",
        hint: "hidden tests passed",
        bars: scaled(
          setups,
          cs.map((c) => (c && c.graded ? c.passed / c.graded : null)),
          (v) => `${Math.round(v * 100)}%`,
          (i) => (cs[i] ? `${cs[i]!.passed}/${cs[i]!.graded}` : ""),
          { lowerIsBetter: false, max: 1 },
        ),
      },
    ];
    if (cs.some((c) => c && c.timeMs !== null))
      out.push({
        key: `time${keyTail}`,
        title: "Avg time per trial",
        hint: timeHint,
        bars: scaled(
          setups,
          cs.map((c) => c?.timeMs ?? null),
          fmtDuration,
          (i) => (cs[i]?.timeN ? `n=${cs[i]!.timeN}` : ""),
          { lowerIsBetter: true },
        ),
      });
    out.push({
      key: `cost${keyTail}`,
      title: "Avg cost per trial",
      hint: "model tokens at list price",
      bars: scaled(
        setups,
        cs.map((c) => (c && c.graded ? c.costMicro / c.graded : null)),
        fmtUsd,
        (i) => (cs[i] ? `n=${cs[i]!.graded}` : ""),
        { lowerIsBetter: true },
      ),
    });
    return out;
  };

  const tasks = [
    ...new Set(cells.map((c) => c.task).filter((t): t is string => t !== null)),
  ].sort();
  return {
    headline: groups(null, ""),
    tasks:
      tasks.length > 1 ? tasks.map((task) => ({ task, groups: groups(task, `:${task}`) })) : [],
  };
}

/** Live page: cells from the run's trials (success, cost) and its trace summary (time). */
export function cellsFromTrials(
  setups: Setup[],
  trials: Trial[],
  trace: RunTraceSummary | null,
): ScoreCell[] {
  const tasks = [...new Set(trials.map((t) => t.workload_id))].sort();
  const out: ScoreCell[] = [];
  for (const s of setups) {
    const tr = trace?.setups.find((x) => x.contender_id === s.id) ?? null;
    for (const task of [null, ...tasks]) {
      const ts = trials.filter(
        (x) =>
          x.contender_id === s.id &&
          GRADED.has(x.state) &&
          (task === null || x.workload_id === task),
      );
      const avg = task === null ? tr?.all : tr?.by_task.find((b) => b.workload_id === task);
      out.push({
        setupId: s.id,
        task,
        graded: ts.length,
        passed: ts.filter((x) => x.state === "done" && !x.failure_class).length,
        costMicro: ts.reduce((a, x) => a + Number(x.cost_micro_usd), 0),
        timeMs: avg && avg.n > 0 ? avg.duration_ms : null,
        timeN: avg?.n ?? 0,
      });
    }
  }
  return out;
}

/** Public page: cells straight from the signed snapshot. */
export function cellsFromPublication(cells: PublicationScoreCell[]): ScoreCell[] {
  return cells.map((c) => ({
    setupId: c.contender_id,
    task: c.workload_id,
    graded: c.graded,
    passed: c.passed,
    costMicro: c.cost_micro_usd,
    timeMs: c.wall_s_mean === null ? null : c.wall_s_mean * 1000,
    timeN: c.wall_n,
  }));
}

/** Kept for the live page and its test. */
export function scoreboard(
  setups: Setup[],
  trials: Trial[],
  trace: RunTraceSummary | null,
): Board | null {
  if (!trials.some((t) => GRADED.has(t.state))) return null;
  return buildBoard(setups, cellsFromTrials(setups, trials, trace));
}

/** "Tandem ×3: 89% success, $2.32 per trial · Claude Code solo: 94% success, $0.31 per trial". */
export function numbersLine(setups: Setup[], cells: ScoreCell[]): string | null {
  const parts = setups.flatMap((s) => {
    const c = cells.find((x) => x.setupId === s.id && x.task === null);
    if (!c || !c.graded) return [];
    return [
      `${s.name} ${Math.round((c.passed / c.graded) * 100)}% success, ${fmtUsd(c.costMicro / c.graded)}/trial`,
    ];
  });
  return parts.length ? parts.join(" · ") : null;
}
