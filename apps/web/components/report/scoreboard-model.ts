// The scoreboard: each setup's raw numbers side by side, as bars. Success rate (hidden tests
// passed over graded trials), average time and average cost, overall and per task. Plain counts,
// no verdict: the statistics live in the table under it, and the reader draws the conclusion.
import type { RunTraceSummary, Trial } from "@anybench/core";

export type Setup = { id: string; name: string; baseline: boolean };

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

const GRADED = new Set(["done", "failed_subject"]);

type Tally = { graded: number; passed: number; cost: number };

function tally(trials: Trial[], setupId: string, task?: string): Tally {
  const t: Tally = { graded: 0, passed: 0, cost: 0 };
  for (const x of trials) {
    if (x.contender_id !== setupId || !GRADED.has(x.state)) continue;
    if (task && x.workload_id !== task) continue;
    t.graded++;
    if (x.state === "done" && !x.failure_class) t.passed++;
    t.cost += Number(x.cost_micro_usd);
  }
  return t;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function fmtUsd(micro: number): string {
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

function rateGroup(setups: Setup[], trials: Trial[], key: string, title: string, task?: string) {
  const ts = setups.map((s) => tally(trials, s.id, task));
  return {
    key,
    title,
    hint: "hidden tests passed",
    bars: scaled(
      setups,
      ts.map((t) => (t.graded ? t.passed / t.graded : null)),
      (v) => `${Math.round(v * 100)}%`,
      (i) => `${ts[i]!.passed}/${ts[i]!.graded}`,
      { lowerIsBetter: false, max: 1 },
    ),
  };
}

export function scoreboard(
  setups: Setup[],
  trials: Trial[],
  trace: RunTraceSummary | null,
): { headline: BarGroup[]; tasks: { task: string; groups: BarGroup[] }[] } | null {
  if (!setups.length || !trials.some((t) => GRADED.has(t.state))) return null;
  const tasks = [...new Set(trials.map((t) => t.workload_id))].sort();
  const traceOf = (id: string) => trace?.setups.find((s) => s.contender_id === id) ?? null;

  const timeGroup = (key: string, task?: string): BarGroup | null => {
    if (!trace) return null;
    const cells = setups.map((s) => {
      const t = traceOf(s.id);
      const c = task ? t?.by_task.find((b) => b.workload_id === task) : t?.all;
      return c && c.n > 0 ? c : null;
    });
    if (cells.every((c) => !c)) return null;
    return {
      key,
      title: "Avg time per trial",
      hint: "wall clock, start to finish",
      bars: scaled(
        setups,
        cells.map((c) => (c ? c.duration_ms : null)),
        fmtDuration,
        (i) => (cells[i] ? `n=${cells[i]!.n}` : ""),
        { lowerIsBetter: true },
      ),
    };
  };

  const costGroup = (key: string, task?: string): BarGroup => {
    const ts = setups.map((s) => tally(trials, s.id, task));
    return {
      key,
      title: "Avg cost per trial",
      hint: "model tokens at list price",
      bars: scaled(
        setups,
        ts.map((t) => (t.graded ? t.cost / t.graded : null)),
        fmtUsd,
        (i) => `n=${ts[i]!.graded}`,
        { lowerIsBetter: true },
      ),
    };
  };

  const headline = [
    rateGroup(setups, trials, "rate", "Success rate"),
    timeGroup("time"),
    costGroup("cost"),
  ].filter((g): g is BarGroup => g !== null);

  return {
    headline,
    tasks:
      tasks.length > 1
        ? tasks.map((task) => ({
            task,
            groups: [
              rateGroup(setups, trials, `rate:${task}`, "Success rate", task),
              timeGroup(`time:${task}`, task),
              costGroup(`cost:${task}`, task),
            ].filter((g): g is BarGroup => g !== null),
          }))
        : [],
  };
}
