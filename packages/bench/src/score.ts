// TDM-53 [5.8], v2 in TDM-174 [16.3]: weighted 0–100 score over gated metrics (plan.md P2 "The
// core rule in code", 17.2 rule 1).
//
// The core rule: no speed or quality number without a correctness gate. Here that means
// - a measured value counts only from a trial whose gate (`requirement.gate_id`) passed, or, for
//   cost and time-to-solve, a failed trial counts against the contender (see "Aggregates");
// - a contender with an in-scope trial that has no result for the gate gets
//   `{scored: false, reason: "no score: gate missing"}` for the requirement and NO total (a
//   partial total would hide it);
// - a contender that solves nothing on a workload gets a 0 cell for it, never a cell that
//   disappears: a contender that fails a workload never ranks above an equally fast one that
//   solves it;
// - a contender with NO trials on a workload the requirement covers (our infra failed, or it was
//   never run) is not given a 0 either: the requirement is unscored, `incomplete`, and blocks
//   the total until the run is complete.
//
// Scope. A requirement covers `requirement.workloads` (default: all). Applicability belongs to
// the gate × workload, not to the contender: a gate applies on a workload when any scored trial
// there says it does (`applicable` not false). On such a workload a trial that says
// `applicable: false` counts as FAILED, so a contender cannot hide its own failures. On a
// workload where the gate applies to nobody, its trials leave the requirement and the gate's
// tally (`gatesNotApplicable`): they neither pass nor fail.
//
// Cells. For each requirement, every contender gets one cell per workload in the requirement's
// COMMON workload set, so all contenders are averaged over the same workloads:
// - `gate_pass_rate`: every in-scope workload with an applicable trial;
// - everything else: every in-scope workload at least one contender solved (a workload nobody
//   solved says nothing about speed or cost, so it is left out for everyone).
// A cell is `measured` (it has a value) or `unsolved` (trials ran, none passed: fraction 0).
// Cells keep the raw per-trial `samples` and counts; the stats layer (TDM-175, decide.ts) puts
// a CI on every measured cell and compares each contender with the baseline (see "Verdicts"). `survivorship: true` marks a requirement whose value is a median over solved
// trials only (`median`, and gated reviews), so the report can warn that failures are not in it.
//
// Aggregates (per measured requirement; `requirement.aggregate`, or picked by metric):
// - `median` (default): median of the metric over the gate-passing trials.
// - `per_solved` (default for `cost_micro_usd`): all spend ÷ solved tasks, i.e. the metric
//   summed over every applicable trial, passing or not, divided by the passing count. Integer
//   inputs give an integer result (micro-USD stays integer).
// - `censored` (default for `wall_s` when a cap is known): time-to-solve, the median over every
//   applicable trial with each failed trial counted at the cap (`requirement.cap`, else the
//   workload's `timeout_s`, else the largest contender `wall_clock_cap_s`, in seconds converted
//   to the requirement's unit, or the metric's when it has none). Agent and harness kits must
//   make the cap findable (KitSpecSchema); without one `wall_s` is a `median` with
//   `survivorship: true`.
// - `gate_pass_rate`: the share of applicable trials whose gate passed. Reviewed requirements:
//   the median review over the solved trials (all trials when ungated).
//
// Fractions. Each measured cell becomes a fraction in [0, 1]:
// - a bound `target` in the requirement's unit ("under 120 ms", "under 2 min" on seconds; a
//   `gate_pass_rate` target is always a ratio, "at least 90%" is 0.9):
//   meeting it is 1, missing it is the ratio to it (T/v when lower is better, v/T when higher);
// - no usable target: relative to the best measured contender on that workload (min/v when lower
//   is better, v/max when higher); values below zero switch to min–max scaling;
// - `gate_pass_rate` and reviewed requirements are absolute: the rate, and
//   (median review − scale.min) / (scale.max − scale.min).
// The requirement's fraction is the mean over the common set (0 when the set is empty), times
// its weight. The contender total is the sum of points; weights sum to 100.
//
// Declared scope (TDM-175). When a requirement names its `workloads`, its gate applies on each of
// them by declaration: a trial there that says `applicable: false` is a FAILURE, even when every
// contender says so (otherwise a lone contender could dodge the gate by declaring it N/A).
//
// Verdicts (TDM-175, plan.md 17.2 rules 2 and 3; the rule itself is in decide.ts). Each scored
// requirement of each contender is compared with the baseline's (`opts.baseline`, else the kit's
// first `role: baseline` contender): `verdict`, `effect`, `ci` (of the difference), `n` and the
// full `comparison`. Agent and harness kits compare once per requirement with tasks as the unit
// (task bootstrap); software kits compare per workload cell (`byWorkload[i].comparison`) and the
// requirement's verdict combines them. Holm runs across every comparison in the KitScore.
// Measured cells get a CI of their own value, labelled with its method: exact Clopper–Pearson for
// a rate under 30 trials (Wilson above), the order-statistic interval for a median (at the level
// it can attain), a seeded bootstrap for spend ÷ solves.
//
// `ranking` is the order by weighted total. It is NOT a verdict (plan.md 17.2 rule 7): reports
// lead with the per-requirement verdicts (`stats.headline`, `verdictTable`), and a composite
// rank is shown only next to them.
import {
  GateResultSchema,
  convertUnit,
  lookupUnit,
  metricUnit,
  parseRequirementTarget,
  type KitSpec,
  type MeasuredAggregate,
  type Requirement,
} from "@anybench/core";
import { z } from "zod";
import {
  combineVerdicts,
  compareArms,
  decide,
  DECISION_RULE,
  minTasksForSignificance,
  seedFor,
  type ArmCell,
  type Comparison,
  type ComparisonKind,
  type DiffInterval,
  type Effect,
  type RawComparison,
  type Verdict,
} from "./decide.js";
import { clopperPearsonCi, median, medianCi, mulberry32, SMALL_N_RATE, wilsonCi } from "./stats.js";

/** Reserved metric: fraction of a contender's trials whose gate passed. Always gated. */
export const GATE_PASS_RATE_METRIC = "gate_pass_rate";
/** Metric scored as all spend ÷ solved tasks unless the requirement says otherwise. */
export const COST_METRIC = "cost_micro_usd";
/** Metric scored as time-to-solve (failures at the cap) when a cap is known. */
export const WALL_METRIC = "wall_s";

/**
 * One finished trial as the scorer sees it: collector metrics plus gate results. Defined here
 * because collectors (TDM-50) land in parallel; they should produce this shape.
 */
export const TrialResultSchema = z.strictObject({
  trialId: z.string().min(1).optional(),
  /** Contender id, or the contender × vary setup id (e.g. `tandem@WORKERS=3`). */
  contenderId: z.string().min(1),
  workloadId: z.string().min(1),
  repeat: z.int().min(0),
  /** metric name (as in `metrics.jsonl`) → value. */
  metrics: z.record(z.string(), z.number()),
  /** gate id → `gate.json`. A gate with no entry here did not run for this trial. */
  gates: z.record(z.string(), GateResultSchema),
  /** reviewed requirement id → reviewer score on the requirement's scale. */
  reviews: z.record(z.string(), z.number()).default({}),
});
export type TrialResult = z.input<typeof TrialResultSchema>;
type ParsedTrial = z.output<typeof TrialResultSchema>;

export const NO_SCORE_REASONS = {
  gate_missing: "no score: gate missing",
  metric_missing: "no score: metric missing",
  not_reviewed: "no score: not reviewed",
  no_trials: "no score: no trials",
  no_cap: "no score: no cap to count failed trials at",
  /** Followed by the workload: `no score: no trials on todo-api`. */
  incomplete: "no score: no trials on",
} as const;
export type NoScoreCode = keyof typeof NO_SCORE_REASONS;
export type NoScoreReason =
  | (typeof NO_SCORE_REASONS)[Exclude<NoScoreCode, "incomplete">]
  | `${(typeof NO_SCORE_REASONS)["incomplete"]} ${string}`;

function noScoreReason(code: NoScoreCode, workloadId?: string): NoScoreReason {
  return code === "incomplete"
    ? `${NO_SCORE_REASONS.incomplete} ${workloadId ?? "?"}`
    : NO_SCORE_REASONS[code];
}

/** How a requirement's cell value was computed. */
export type RequirementAggregate = MeasuredAggregate | "rate" | "review";

/**
 * - `measured`: the cell has a value.
 * - `unsolved`: the contender ran applicable trials here and none passed the gate (fraction 0).
 * (A contender with no trials on a covered workload gets no cell: the requirement is
 * `incomplete`.)
 */
export type CellStatus = "measured" | "unsolved";

/** One requirement × workload × contender cell. */
export interface WorkloadCell {
  workloadId: string;
  status: CellStatus;
  /** The aggregate (median, spend per solve, censored median, rate, median review); null unless measured. */
  value: number | null;
  /** In [0, 1]; 0 unless measured. */
  fraction: number;
  /** `samples.length`. */
  n: number;
  /**
   * Raw per-trial values behind `value`, in trial order: the passing trials' metric (`median`),
   * every applicable trial's metric with failures at the cap (`censored`), every applicable
   * trial's metric (`per_solved`), 1/0 per applicable trial (`rate`), the solved trials'
   * reviews (`review`).
   */
  samples: number[];
  /** Applicable trials of this contender on this workload. */
  trials: number;
  /** Of which passed the gate (all of them when the requirement has no gate). */
  solved: number;
  /** `censored` only: the value a failed trial counts as. */
  cap?: number;
  /** CI of `value` (null when unsolved, or when it has no finite bound). */
  ci: CellInterval | null;
  /** Software kits: this cell vs the baseline's (null for the baseline and in agent kits). */
  comparison: Comparison | null;
  /**
   * Agent and harness kits (E18): this task alone vs the baseline's, with its repeats as the
   * unit (exact Mann–Whitney, Fisher for pass rates), Holm across every task × requirement test
   * (`stats.perTask.family`). It speaks for this task only (`claim: these_tasks`). Absent for
   * the baseline, for software kits and for scores stored before E18.
   */
  taskComparison?: Comparison | null;
}

/** A measured cell's own interval: `level` is the coverage it attains (see `attained`). */
export interface CellInterval {
  lo: number;
  hi: number;
  level: number;
  requestedLevel: number;
  attained: boolean;
  /**
   * `clopper_pearson` (exact, pass rates under 30 trials), `wilson` (score, 30+), the
   * distribution-free `order_statistic` interval for a median, or a seeded `bootstrap`.
   */
  method: "clopper_pearson" | "wilson" | "order_statistic" | "bootstrap";
}

interface RequirementScoreBase {
  requirementId: string;
  type: Requirement["type"];
  weight: number;
}
export interface ScoredRequirement extends RequirementScoreBase {
  scored: true;
  aggregate: RequirementAggregate;
  /**
   * True when the value is a median over solved trials only (`median`, gated `review`): failed
   * trials are not in it, so a contender that solves 1/5 fast can look better than one that
   * solves 5/5. Reports should warn next to it.
   */
  survivorship: boolean;
  /** The common workload set, in kit order: the same for every contender. */
  workloads: string[];
  /** Mean of the per-workload fractions, in [0, 1]. */
  fraction: number;
  /** fraction × weight, in [0, weight]. */
  points: number;
  /** One cell per workload in `workloads`, same order. */
  byWorkload: WorkloadCell[];
  /** Applicable trials behind the requirement: Σ `byWorkload[].trials`. */
  n: number;
  /** vs the baseline (null for the baseline itself, or with no baseline or nothing to compare). */
  verdict: Verdict | null;
  /** The comparison's effect, oriented so positive is better (null as `verdict`). */
  effect: Effect | null;
  /** CI of the difference vs the baseline (null as `verdict`, or software with several cells). */
  ci: DiffInterval | null;
  /** The whole comparison, or, for software with several cells, the per-cell ones combined. */
  comparison: Comparison | null;
}
export interface UnscoredRequirement extends RequirementScoreBase {
  scored: false;
  code: NoScoreCode;
  reason: NoScoreReason;
  /** `incomplete` only: the first covered workload this contender has no trials on. */
  workloadId?: string;
  points: null;
}
export type RequirementScore = ScoredRequirement | UnscoredRequirement;

/** Applicable trials only: `total = passed + failed + missing`. */
export interface GateTally {
  passed: number;
  failed: number;
  missing: number;
  total: number;
}

interface ContenderScoreBase {
  contenderId: string;
  trials: number;
  /** gate id → pass/fail counts over the contender's applicable trials ("tasks solved 11/15"). */
  gates: Record<string, GateTally>;
  /**
   * gate id → trials the gate does not apply to (`applicable: false`, or a workload outside every
   * requirement that uses the gate). They are not in `gates`.
   */
  gatesNotApplicable: Record<string, number>;
  requirements: RequirementScore[];
}
export interface ScoredContender extends ContenderScoreBase {
  scored: true;
  total: number;
  totalRounded: number;
}
export interface UnscoredContender extends ContenderScoreBase {
  scored: false;
  total: null;
  /** The first blocking requirement's reason. */
  reason: NoScoreReason;
  /** Requirement ids (weight > 0) without a score. */
  blockedBy: string[];
}
export type ContenderScore = ScoredContender | UnscoredContender;

export interface KitScore {
  contenders: ContenderScore[];
  /** Scored contender ids, best total first. Unscored contenders are never ranked. */
  ranking: string[];
  /** How the verdicts were reached. */
  stats: KitStats;
}

export interface KitStats {
  /** The contender everyone is compared with; null when there is none (no verdicts). */
  baseline: string | null;
  /** Agent/harness kit: tasks are the unit (task bootstrap). */
  clustered: boolean;
  alpha: number;
  /** Comparisons in the Holm family. */
  family: number;
  seed: number;
  /** `scoring.primary`, else the highest-weight requirement. */
  primary: string | null;
  /** The primary requirement's verdict per compared contender: the report's headline. */
  headline: { contenderId: string; verdict: Verdict; statement: string }[];
  /** Agent and harness kits: the per-task results (E18). Null for software kits. */
  perTask?: PerTaskStats | null;
}

/**
 * Fixed-task inference (E18). With few tasks the task-paired verdict can't say anything general
 * (3 tasks can't get below p = 0.25), but each task's own repeats can say what happened ON THAT
 * TASK. These results are scoped to the tasks tested and never replace the general verdict.
 */
export interface PerTaskStats {
  alpha: number;
  /** Task × requirement × contender tests in this Holm family. */
  family: number;
  /** Tasks compared, in kit order. */
  tasks: string[];
  /** Always shown next to a per-task result: what it does not cover. */
  scope: string;
  /** Requirements where every task it covers agrees in direction and is significant. */
  headline: PerTaskFinding[];
}

export interface PerTaskFinding {
  contenderId: string;
  requirementId: string;
  verdict: "better" | "worse";
  /** "faster", "cheaper", "solved more often", … */
  adjective: string;
  tasks: string[];
  /** "<contender> was faster on all 3 tasks tested". Reports swap in the display name. */
  statement: string;
}

export interface ScoreOptions {
  /** Contenders to score, in display order. Default: contender ids in trial order. */
  contenders?: readonly string[];
  /** Contender every other one is compared with. Default: the kit's first `role: baseline`. */
  baseline?: string;
  /** Bootstrap seed. Default DECISION_RULE.seed. */
  seed?: number;
  /** Family-wise α. Default 0.05. */
  alpha?: number;
  /** Bootstrap resamples. Default 2000. */
  iterations?: number;
  /** Force task clustering on or off. Default: on for agent and harness kits. */
  clustered?: boolean;
}

/**
 * The parts of a kit the scorer reads. `workloads` (order, `timeout_s`) and `contenders`
 * (`wall_clock_cap_s`) are optional; without them there is no cap, so `wall_s` falls back to
 * `median` and an explicit `censored` needs `requirement.cap`.
 */
export type ScoreKitInput = Pick<KitSpec, "requirements" | "scoring"> &
  Partial<Pick<KitSpec, "workloads" | "contenders">> & {
    /** Agent and harness kits compare with tasks as the unit. */
    subject?: Pick<KitSpec["subject"], "kind">;
  };

export interface TargetThreshold {
  op: "le" | "ge";
  /** In the requirement's unit. */
  value: number;
}

/**
 * Parse a requirement's human-readable `target` into a threshold in `unit` (or, without one, the
 * unit `metric`'s name implies), when it is a simple bound ("under 120 ms", "at least 90%",
 * "≤ 30"; "under 2 min" on unit `s` is 120; "at least 90%" on `gate_pass_rate` is 0.9). Anything
 * else ("all pass", "$5 per task" without a bound word) returns undefined and the requirement is
 * scored relative to the best contender. Throws a RangeError when the bound can't be read safely
 * (a unit that does not convert, an ambiguous number like "1,5"); KitSpecSchema rejects such kits.
 */
export function parseTarget(
  target: string | undefined,
  unit?: string,
  metric?: string,
): TargetThreshold | undefined {
  const r = parseRequirementTarget(target, unit, metric);
  if (!r.ok) throw new RangeError(r.error);
  return r.bound;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function thresholdFraction(v: number, t: TargetThreshold): number {
  if (t.op === "le") {
    if (v <= t.value) return 1;
    return t.value > 0 ? clamp01(t.value / v) : 0;
  }
  if (v >= t.value) return 1;
  return t.value > 0 ? clamp01(v / t.value) : 0;
}

function relativeFraction(v: number, pool: readonly number[], better: "higher" | "lower"): number {
  const min = Math.min(...pool);
  const max = Math.max(...pool);
  if (min < 0) {
    if (max === min) return 1;
    return clamp01(better === "higher" ? (v - min) / (max - min) : (max - v) / (max - min));
  }
  if (better === "higher") return max === 0 ? 1 : clamp01(v / max);
  return v === 0 ? 1 : clamp01(min / v);
}

/** Σ samples ÷ solved. Integer samples give an integer, rounded half away from zero. */
function perSolved(samples: readonly number[], solved: number): number {
  if (samples.every((x) => Number.isSafeInteger(x))) {
    const sum = samples.reduce((s, x) => s + BigInt(x), 0n);
    const d = BigInt(solved);
    const abs = sum < 0n ? -sum : sum;
    const q = (2n * abs + d) / (2n * d);
    return Number(sum < 0n ? -q : q);
  }
  return samples.reduce((s, x) => s + x, 0) / solved;
}

// ---------------------------------------------------------------------------------------------
// Per-requirement plan: scope, aggregate, cap, target.

interface Plan {
  req: Requirement;
  aggregate: RequirementAggregate;
  inScope: (workloadId: string) => boolean;
  capFor: (workloadId: string) => number | undefined;
  target: TargetThreshold | undefined;
}

/** Where each gate applies: gate id → workloads on which any scored trial says it applies. */
type Applicability = Map<string, Set<string>>;

function applicability(
  trials: readonly ParsedTrial[],
  requirements: readonly Requirement[],
): Applicability {
  const m: Applicability = new Map();
  const add = (g: string, w: string) => {
    const set = m.get(g);
    if (set) set.add(w);
    else m.set(g, new Set([w]));
  };
  for (const t of trials) {
    for (const [g, r] of Object.entries(t.gates)) {
      if (r.applicable !== false) add(g, t.workloadId);
    }
  }
  // A requirement that names its workloads declares its gate applies there: N/A is a failure.
  for (const r of requirements) {
    if (r.gate_id === undefined || r.workloads === undefined) continue;
    for (const w of r.workloads) add(r.gate_id, w);
  }
  return m;
}

type GateState = "pass" | "fail" | "missing" | "na";

/** A trial's result for a gate, with applicability decided per gate × workload. */
function gateState(t: ParsedTrial, gateId: string, applies: Applicability): GateState {
  const r = t.gates[gateId];
  if (r === undefined) return "missing";
  if (!applies.get(gateId)?.has(t.workloadId)) return "na";
  // Applies here (to someone): a trial that claims otherwise counts as a failure.
  return r.pass && r.applicable !== false ? "pass" : "fail";
}

/** A cap in seconds, in `unit` (undefined when `unit` is unknown or not a time). */
function seconds(unit: string | undefined, valueS: number): number | undefined {
  if (unit === undefined || lookupUnit(unit)?.dim !== "time") return undefined;
  return convertUnit(valueS, "s", unit);
}

function planFor(req: Requirement, kit: ScoreKitInput, workloadIds: readonly string[]): Plan {
  const scope = req.workloads ? new Set(req.workloads) : undefined;
  const inScope = (w: string) => scope === undefined || scope.has(w);
  if (req.type === "reviewed") {
    return { req, aggregate: "review", inScope, capFor: () => undefined, target: undefined };
  }
  const timeouts = new Map((kit.workloads ?? []).map((w) => [w.id, w.timeout_s]));
  const contenderCaps = (kit.contenders ?? [])
    .map((c) => c.driver.wall_clock_cap_s)
    .filter((x): x is number => x !== undefined);
  const contenderCap = contenderCaps.length > 0 ? Math.max(...contenderCaps) : undefined;
  const capFor = (w: string): number | undefined => {
    if (req.cap !== undefined) return req.cap;
    const s = timeouts.get(w) ?? contenderCap;
    return s === undefined ? undefined : seconds(req.unit ?? metricUnit(req.metric), s);
  };

  let aggregate: RequirementAggregate;
  if (req.metric === GATE_PASS_RATE_METRIC) aggregate = "rate";
  else if (req.aggregate !== undefined) aggregate = req.aggregate;
  else if (req.metric === COST_METRIC) aggregate = "per_solved";
  else if (req.metric === WALL_METRIC) {
    const scoped = workloadIds.filter(inScope);
    aggregate =
      scoped.length > 0 && scoped.every((w) => capFor(w) !== undefined) ? "censored" : "median";
  } else aggregate = "median";

  const target = parseTarget(req.target, req.unit, req.metric);
  const usable = target && (target.op === "le") === (req.better === "lower") ? target : undefined;
  return { req, aggregate, inScope, capFor, target: usable };
}

// ---------------------------------------------------------------------------------------------
// Phase 1: one contender's raw cells for one requirement.

interface RawCell {
  status: CellStatus;
  value: number | null;
  samples: number[];
  trials: number;
  solved: number;
  cap?: number;
  /** Internal: pass/fail of each applicable trial, in trial order (not on WorkloadCell). */
  passed: boolean[];
}
type RawCells =
  { ok: true; cells: Map<string, RawCell> } | { ok: false; code: NoScoreCode; workloadId?: string };

function byWorkload<T extends { trial: ParsedTrial }>(items: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) {
    const list = m.get(x.trial.workloadId);
    if (list) list.push(x);
    else m.set(x.trial.workloadId, [x]);
  }
  return m;
}

interface Judged {
  trial: ParsedTrial;
  passed: boolean;
}

/** In-scope trials the requirement applies to, each with its pass/fail, or why it can't score. */
function judgedTrials(
  plan: Plan,
  trials: readonly ParsedTrial[],
  applies: Applicability,
): { ok: true; trials: Judged[] } | { ok: false; code: NoScoreCode } {
  const scoped = trials.filter((t) => plan.inScope(t.workloadId));
  const gateId = plan.req.gate_id;
  if (gateId === undefined)
    return { ok: true, trials: scoped.map((t) => ({ trial: t, passed: true })) };
  const out: Judged[] = [];
  for (const t of scoped) {
    const st = gateState(t, gateId, applies);
    if (st === "missing") return { ok: false, code: "gate_missing" };
    if (st !== "na") out.push({ trial: t, passed: st === "pass" });
  }
  return { ok: true, trials: out };
}

function rawCells(
  plan: Plan,
  trials: readonly ParsedTrial[],
  applies: Applicability,
  covered: readonly string[],
): RawCells {
  if (trials.length === 0) return { ok: false, code: "no_trials" };
  const judged = judgedTrials(plan, trials, applies);
  if (!judged.ok) return judged;
  const groups = byWorkload(judged.trials);
  // Our infra failing (or a workload never run) is not the contender's 0: refuse to score.
  const gap = covered.find((w) => !groups.has(w));
  if (gap !== undefined) return { ok: false, code: "incomplete", workloadId: gap };

  const { req, aggregate } = plan;
  const metricOf = (t: ParsedTrial) =>
    req.type === "measured" ? t.metrics[req.metric] : undefined;

  const cells = new Map<string, RawCell>();
  for (const [w, js] of groups) {
    const solvedTs = js.filter((j) => j.passed).map((j) => j.trial);
    const base = { trials: js.length, solved: solvedTs.length, passed: js.map((j) => j.passed) };
    const unsolved = (samples: number[], extra: { cap?: number } = {}): RawCell => ({
      status: "unsolved",
      value: null,
      samples,
      ...base,
      ...extra,
    });

    switch (aggregate) {
      case "rate": {
        const samples = js.map((j) => (j.passed ? 1 : 0));
        cells.set(w, { status: "measured", value: base.solved / base.trials, samples, ...base });
        break;
      }
      case "median": {
        if (base.solved === 0) {
          cells.set(w, unsolved([]));
          break;
        }
        const samples: number[] = [];
        for (const t of solvedTs) {
          const v = metricOf(t);
          if (v === undefined) return { ok: false, code: "metric_missing" };
          samples.push(v);
        }
        cells.set(w, { status: "measured", value: median(samples), samples, ...base });
        break;
      }
      case "censored": {
        const cap = plan.capFor(w);
        if (cap === undefined) return { ok: false, code: "no_cap" };
        const samples: number[] = [];
        for (const j of js) {
          if (!j.passed) {
            samples.push(cap);
            continue;
          }
          const v = metricOf(j.trial);
          if (v === undefined) return { ok: false, code: "metric_missing" };
          samples.push(v);
        }
        cells.set(
          w,
          base.solved === 0
            ? unsolved(samples, { cap })
            : { status: "measured", value: median(samples), samples, ...base, cap },
        );
        break;
      }
      case "per_solved": {
        const samples: number[] = [];
        for (const j of js) {
          const v = metricOf(j.trial);
          if (v === undefined) return { ok: false, code: "metric_missing" };
          samples.push(v);
        }
        cells.set(
          w,
          base.solved === 0
            ? unsolved(samples)
            : { status: "measured", value: perSolved(samples, base.solved), samples, ...base },
        );
        break;
      }
      case "review": {
        if (base.solved === 0) {
          cells.set(w, unsolved([]));
          break;
        }
        const samples = solvedTs.flatMap((t) => {
          const r = t.reviews[req.id];
          return r === undefined ? [] : [r];
        });
        if (samples.length === 0) return { ok: false, code: "not_reviewed" };
        cells.set(w, { status: "measured", value: median(samples), samples, ...base });
        break;
      }
    }
  }
  return { ok: true, cells };
}

function cellFraction(plan: Plan, value: number, pool: readonly number[]): number {
  const { req } = plan;
  if (req.type === "reviewed") {
    return clamp01((value - req.scale.min) / (req.scale.max - req.scale.min));
  }
  if (plan.target) return thresholdFraction(value, plan.target);
  if (plan.aggregate === "rate") return clamp01(value);
  return relativeFraction(value, pool, req.better);
}

/** Workload ids in kit order, then any others in the order trials first mention them. */
function workloadOrder(kit: ScoreKitInput, trials: readonly ParsedTrial[]): string[] {
  const ids = new Set((kit.workloads ?? []).map((w) => w.id));
  for (const t of trials) ids.add(t.workloadId);
  return [...ids];
}

/**
 * Workloads every contender must have trials on for this requirement: the in-scope workloads
 * where it applies (the gate applies there for someone; any trial when ungated), plus scoped
 * workloads nobody ran at all.
 */
function coveredWorkloads(
  plan: Plan,
  order: readonly string[],
  trials: readonly ParsedTrial[],
  applies: Applicability,
): string[] {
  const gateId = plan.req.gate_id;
  const ran = new Set(trials.map((t) => t.workloadId));
  const all = [...order, ...(plan.req.workloads ?? []).filter((w) => !order.includes(w))];
  const keep = new Set<string>();
  for (const w of all) {
    if (!plan.inScope(w)) continue;
    if (!ran.has(w)) {
      if (plan.req.workloads?.includes(w)) keep.add(w);
      continue;
    }
    if (gateId === undefined || applies.get(gateId)?.has(w)) keep.add(w);
  }
  return all.filter((w) => keep.has(w));
}

/** The workloads every contender is averaged over (see the header). */
function commonWorkloads(
  plan: Plan,
  covered: readonly string[],
  raws: Iterable<RawCells>,
): string[] {
  if (plan.aggregate === "rate") return [...covered];
  const keep = new Set<string>();
  for (const r of raws) {
    if (!r.ok) continue;
    for (const [w, c] of r.cells) if (c.status === "measured") keep.add(w);
  }
  return covered.filter((w) => keep.has(w));
}

/**
 * Score every contender over the kit's requirements. Pure: same kit and trials, same scores.
 * Throws a ZodError if a trial result is malformed, and a RangeError if a requirement's target
 * can't be read safely in its unit.
 */
export function scoreKit(
  kit: ScoreKitInput,
  trialResults: readonly TrialResult[],
  opts: ScoreOptions = {},
): KitScore {
  const trials = z.array(TrialResultSchema).parse(trialResults);
  const seed = opts.seed ?? DECISION_RULE.seed;
  const iterations = opts.iterations ?? DECISION_RULE.bootstrapIterations;
  const contenderIds = opts.contenders
    ? [...opts.contenders]
    : [...new Set(trials.map((t) => t.contenderId))];
  const trialsOf = new Map<string, ParsedTrial[]>(contenderIds.map((c) => [c, []]));
  for (const t of trials) trialsOf.get(t.contenderId)?.push(t);
  const scoredTrials = trials.filter((t) => trialsOf.has(t.contenderId));
  const order = workloadOrder(kit, scoredTrials);
  const applies = applicability(scoredTrials, kit.requirements);

  // Phase 1: plan, covered workloads, raw cells per contender, and the common set.
  const perReq = kit.requirements.map((req) => {
    const plan = planFor(req, kit, order);
    const covered = coveredWorkloads(plan, order, scoredTrials, applies);
    const raw = new Map(
      contenderIds.map((c) => [c, rawCells(plan, trialsOf.get(c)!, applies, covered)]),
    );
    const common = commonWorkloads(plan, covered, raw.values());
    const pools = new Map<string, number[]>();
    for (const w of common) {
      const pool: number[] = [];
      for (const r of raw.values()) {
        const cell = r.ok ? r.cells.get(w) : undefined;
        if (cell?.status === "measured") pool.push(cell.value!);
      }
      pools.set(w, pool);
    }
    return { plan, raw, common, pools };
  });

  // Gate scope: the union of the scopes of the requirements that use the gate.
  const gateScope = new Map<string, (w: string) => boolean>();
  for (const { plan } of perReq) {
    const g = plan.req.gate_id;
    if (g === undefined) continue;
    const prev = gateScope.get(g);
    gateScope.set(g, prev ? (w) => prev(w) || plan.inScope(w) : plan.inScope);
  }

  // Phase 2: cells, fractions, points, totals.
  const scores: ContenderScore[] = contenderIds.map((c) => {
    const ts = trialsOf.get(c)!;
    const requirements: RequirementScore[] = perReq.map(({ plan, raw, common, pools }) => {
      const req = plan.req;
      const weight = kit.scoring.weights[req.id] ?? 0;
      const mine = raw.get(c)!;
      if (!mine.ok) {
        return {
          requirementId: req.id,
          type: req.type,
          weight,
          scored: false,
          code: mine.code,
          reason: noScoreReason(mine.code, mine.workloadId),
          ...(mine.workloadId === undefined ? {} : { workloadId: mine.workloadId }),
          points: null,
        };
      }
      const cells: WorkloadCell[] = common.map((workloadId) => {
        // Every covered workload has a cell (else the requirement is incomplete).
        const { passed, ...cell } = mine.cells.get(workloadId)!;
        const fraction =
          cell.status === "measured" ? cellFraction(plan, cell.value!, pools.get(workloadId)!) : 0;
        const ci = cellInterval(
          plan.aggregate,
          cell,
          passed,
          seedFor(seed, "cell", req.id, c, workloadId),
          iterations,
        );
        return { workloadId, ...cell, fraction, n: cell.samples.length, ci, comparison: null };
      });
      const fraction =
        cells.length === 0 ? 0 : cells.reduce((s, x) => s + x.fraction, 0) / cells.length;
      return {
        requirementId: req.id,
        type: req.type,
        weight,
        scored: true,
        aggregate: plan.aggregate,
        survivorship:
          (req.type === "measured" && plan.aggregate === "median") ||
          (plan.aggregate === "review" && req.gate_id !== undefined),
        workloads: [...common],
        fraction,
        points: fraction * weight,
        byWorkload: cells,
        n: cells.reduce((s, x) => s + x.trials, 0),
        verdict: null,
        effect: null,
        ci: null,
        comparison: null,
      };
    });

    const gates: Record<string, GateTally> = {};
    const gatesNotApplicable: Record<string, number> = {};
    for (const [g, inScope] of gateScope) {
      const tally: GateTally = { passed: 0, failed: 0, missing: 0, total: 0 };
      let na = 0;
      for (const t of ts) {
        const st = inScope(t.workloadId) ? gateState(t, g, applies) : "na";
        if (st === "na") na++;
        else if (st === "missing") tally.missing++;
        else if (st === "pass") tally.passed++;
        else tally.failed++;
      }
      tally.total = tally.passed + tally.failed + tally.missing;
      gates[g] = tally;
      gatesNotApplicable[g] = na;
    }

    const blocking = requirements.filter(
      (r): r is UnscoredRequirement => !r.scored && r.weight > 0,
    );
    const base = { contenderId: c, trials: ts.length, gates, gatesNotApplicable, requirements };
    if (blocking.length > 0) {
      return {
        ...base,
        scored: false,
        total: null,
        reason: blocking[0]!.reason,
        blockedBy: blocking.map((r) => r.requirementId),
      };
    }
    const total = requirements.reduce((s, r) => s + (r.points ?? 0), 0);
    return { ...base, scored: true, total, totalRounded: Math.round(total) };
  });

  const ranking = scores
    .filter((s): s is ScoredContender => s.scored)
    .sort((a, b) => b.total - a.total)
    .map((s) => s.contenderId);
  const stats = attachVerdicts(kit, scores, perReq, { ...opts, seed, iterations });
  return { contenders: scores, ranking, stats };
}

// ---------------------------------------------------------------------------------------------
// Stats: cell intervals and verdicts vs the baseline (TDM-175).

function cellInterval(
  aggregate: RequirementAggregate,
  cell: Omit<RawCell, "passed">,
  passed: readonly boolean[],
  seed: number,
  iterations: number,
): CellInterval | null {
  if (cell.status !== "measured" || cell.samples.length === 0) return null;
  const level = DECISION_RULE.level;
  switch (aggregate) {
    case "rate": {
      // Small n: the exact interval, not a score approximation (Bowyer et al. 2025).
      const exact = cell.trials < SMALL_N_RATE;
      const w = (exact ? clopperPearsonCi : wilsonCi)(cell.solved, cell.trials, level);
      return {
        lo: w.lo,
        hi: w.hi,
        level,
        requestedLevel: level,
        attained: true,
        method: exact ? "clopper_pearson" : "wilson",
      };
    }
    case "median":
    case "censored":
    case "review": {
      const m = medianCi(cell.samples, level);
      return {
        lo: m.lo,
        hi: m.hi,
        level: m.level,
        requestedLevel: level,
        attained: m.attained,
        method: "order_statistic",
      };
    }
    case "per_solved": {
      // Spend ÷ solves over trials resampled with replacement; a resample with no solve has no
      // finite value, and then the interval has no finite upper bound: report none.
      const rand = mulberry32(seed);
      const n = cell.samples.length;
      const stats: number[] = [];
      for (let i = 0; i < iterations; i++) {
        let spend = 0;
        let solved = 0;
        for (let j = 0; j < n; j++) {
          const k = Math.floor(rand() * n);
          spend += cell.samples[k]!;
          if (passed[k]) solved++;
        }
        stats.push(solved === 0 ? Infinity : spend / solved);
      }
      stats.sort((a, b) => a - b);
      const at = (p: number) => {
        const h = (stats.length - 1) * p;
        const lo = stats[Math.floor(h)]!;
        const hi = stats[Math.ceil(h)]!;
        return lo === hi ? lo : lo + (h - Math.floor(h)) * (hi - lo);
      };
      const lo = at((1 - level) / 2);
      const hi = at(1 - (1 - level) / 2);
      if (!Number.isFinite(hi)) return null;
      return { lo, hi, level, requestedLevel: level, attained: true, method: "bootstrap" };
    }
  }
}

function isClustered(kit: ScoreKitInput, opts: ScoreOptions): boolean {
  if (opts.clustered !== undefined) return opts.clustered;
  if (kit.subject) return kit.subject.kind === "agent" || kit.subject.kind === "harness";
  return (kit.contenders ?? []).some(
    (c) => c.driver.type === "coding-agent" || c.driver.type === "harness",
  );
}

function comparisonKind(aggregate: RequirementAggregate): ComparisonKind {
  return aggregate === "rate" ? "rate" : "continuous";
}

/**
 * The per-trial values a comparison ranks: the cell's samples, except spend ÷ solves, where a
 * failed trial bought nothing and counts as infinitely expensive (worse than any solved trial).
 */
function armCell(aggregate: RequirementAggregate, cell: WorkloadCell, passed: boolean[]): ArmCell {
  const samples =
    aggregate === "per_solved"
      ? cell.samples.map((v, i) => (passed[i] ? v : Infinity))
      : cell.samples;
  return { workloadId: cell.workloadId, samples, trials: cell.trials, solved: cell.solved };
}

interface PendingComparison {
  raw: RawComparison;
  target: ScoredRequirement;
  /** Software: the cell it belongs to. */
  cell?: WorkloadCell;
}

function attachVerdicts(
  kit: ScoreKitInput,
  scores: ContenderScore[],
  perReq: { plan: Plan; raw: Map<string, RawCells> }[],
  opts: ScoreOptions & { seed: number; iterations: number },
): KitStats {
  const alpha = opts.alpha ?? DECISION_RULE.alpha;
  const clustered = isClustered(kit, opts);
  const ids = scores.map((s) => s.contenderId);
  const baseline =
    opts.baseline ??
    (kit.contenders ?? []).find((c) => c.role === "baseline" && ids.includes(c.id))?.id ??
    null;
  if (opts.baseline !== undefined && !ids.includes(opts.baseline))
    throw new RangeError(`baseline '${opts.baseline}' is not a scored contender`);
  const primary =
    kit.scoring.primary ??
    [...kit.requirements].sort(
      (a, b) => (kit.scoring.weights[b.id] ?? 0) - (kit.scoring.weights[a.id] ?? 0),
    )[0]?.id ??
    null;
  const stats: KitStats = {
    baseline,
    clustered,
    alpha,
    family: 0,
    seed: opts.seed,
    primary,
    headline: [],
  };
  if (baseline === null) return stats;
  const base = scores.find((s) => s.contenderId === baseline)!;

  const pending: PendingComparison[] = [];
  perReq.forEach(({ plan, raw }, ri) => {
    const baseReq = base.requirements[ri]!;
    if (!baseReq.scored) return;
    const baseRaw = raw.get(baseline)!;
    if (!baseRaw.ok) return;
    const req = plan.req;
    const kind = comparisonKind(plan.aggregate);
    const better = req.type === "measured" ? req.better : "higher";
    const unit = req.type === "measured" ? (req.unit ?? metricUnit(req.metric)) : undefined;
    for (const s of scores) {
      if (s.contenderId === baseline) continue;
      const mine = s.requirements[ri]!;
      const mineRaw = raw.get(s.contenderId)!;
      if (!mine.scored || !mineRaw.ok) continue;
      const arms = (cells: WorkloadCell[], r: { cells: Map<string, RawCell> }) =>
        cells.map((cell) => armCell(plan.aggregate, cell, r.cells.get(cell.workloadId)!.passed));
      const common = {
        kind,
        better,
        survivorship: mine.survivorship,
        unit,
        iterations: opts.iterations,
      } as const;
      if (clustered) {
        const rc = compareArms({
          ...common,
          candidate: arms(mine.byWorkload, mineRaw),
          baseline: arms(baseReq.byWorkload, baseRaw),
          clustered: true,
          seed: seedFor(opts.seed, "cmp", req.id, s.contenderId, baseline),
        });
        if (rc) pending.push({ raw: rc, target: mine });
        continue;
      }
      mine.byWorkload.forEach((cell, wi) => {
        const rc = compareArms({
          ...common,
          candidate: arms([cell], mineRaw),
          baseline: arms([baseReq.byWorkload[wi]!], baseRaw),
          clustered: false,
          seed: seedFor(opts.seed, "cmp", req.id, s.contenderId, baseline, cell.workloadId),
        });
        if (rc) pending.push({ raw: rc, target: mine, cell });
      });
    }
  });

  const decided = decide(
    pending.map((p) => p.raw),
    { alpha, baseline },
  );
  stats.family = decided.length;
  const perTarget = new Map<ScoredRequirement, Comparison[]>();
  decided.forEach((d, i) => {
    const p = pending[i]!;
    if (p.cell) p.cell.comparison = d;
    const list = perTarget.get(p.target);
    if (list) list.push(d);
    else perTarget.set(p.target, [d]);
  });
  for (const [target, list] of perTarget) {
    if (list.length === 1) {
      const d = list[0]!;
      target.comparison = d;
      target.verdict = d.verdict;
      target.effect = d.effect;
      target.ci = d.ci;
    } else {
      // Software, several workloads: the cells carry the comparisons; the requirement combines.
      target.verdict = combineVerdicts(list.map((d) => d.verdict));
    }
  }

  if (clustered)
    stats.perTask = perTaskVerdicts(kit, scores, perReq, baseline, alpha, stats.family, opts);

  if (primary !== null) {
    const ri = kit.requirements.findIndex((r) => r.id === primary);
    for (const s of scores) {
      if (s.contenderId === baseline) continue;
      const r = s.requirements[ri];
      if (!r?.scored || r.verdict === null) continue;
      const statement =
        r.comparison?.statement ??
        r.byWorkload
          .filter((c) => c.comparison !== null)
          .map((c) => `${c.workloadId}: ${c.comparison!.statement}`)
          .join("; ");
      stats.headline.push({ contenderId: s.contenderId, verdict: r.verdict, statement });
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------------------------
// Per-task results (E18): one task's repeats as the unit, Holm across task × requirement.

/** How a per-task win reads for a requirement: "faster", "cheaper", … */
export function perTaskAdjective(req: Requirement, verdict: "better" | "worse"): string {
  const good = verdict === "better";
  if (req.type === "reviewed") return `${good ? "better" : "worse"} on ${req.id}`;
  if (req.metric === WALL_METRIC) return good ? "faster" : "slower";
  if (req.metric === COST_METRIC) return good ? "cheaper" : "more expensive";
  if (req.metric === GATE_PASS_RATE_METRIC) return good ? "solved more often" : "solved less often";
  const higher = (req.better === "higher") === good;
  return `${higher ? "higher" : "lower"} on ${req.id}`;
}

function perTaskVerdicts(
  kit: ScoreKitInput,
  scores: ContenderScore[],
  perReq: { plan: Plan; raw: Map<string, RawCells> }[],
  baseline: string,
  alpha: number,
  /** The task-paired (general) family size, for how many tasks a general claim needs. */
  generalFamily: number,
  opts: ScoreOptions & { seed: number; iterations: number },
): PerTaskStats {
  const base = scores.find((s) => s.contenderId === baseline)!;
  const pending: { raw: RawComparison; cell: WorkloadCell; contenderId: string; ri: number }[] = [];
  const taskSet = new Set<string>();
  perReq.forEach(({ plan, raw }, ri) => {
    const baseReq = base.requirements[ri]!;
    const baseRaw = raw.get(baseline)!;
    if (!baseReq.scored || !baseRaw.ok) return;
    const req = plan.req;
    const better = req.type === "measured" ? req.better : "higher";
    const unit = req.type === "measured" ? (req.unit ?? metricUnit(req.metric)) : undefined;
    for (const s of scores) {
      if (s.contenderId === baseline) continue;
      const mine = s.requirements[ri]!;
      const mineRaw = raw.get(s.contenderId)!;
      if (!mine.scored || !mineRaw.ok) continue;
      mine.byWorkload.forEach((cell, wi) => {
        const baseCell = baseReq.byWorkload[wi]!;
        const rc = compareArms({
          kind: comparisonKind(plan.aggregate),
          better,
          survivorship: mine.survivorship,
          unit,
          iterations: opts.iterations,
          rateTest: "fisher_exact",
          candidate: [armCell(plan.aggregate, cell, mineRaw.cells.get(cell.workloadId)!.passed)],
          baseline: [
            armCell(plan.aggregate, baseCell, baseRaw.cells.get(baseCell.workloadId)!.passed),
          ],
          clustered: false,
          seed: seedFor(opts.seed, "task", req.id, s.contenderId, baseline, cell.workloadId),
        });
        cell.taskComparison = null;
        if (!rc) return;
        taskSet.add(cell.workloadId);
        pending.push({ raw: rc, cell, contenderId: s.contenderId, ri });
      });
    }
  });
  const decided = decide(
    pending.map((p) => p.raw),
    { alpha, baseline },
  );
  decided.forEach((d, i) => {
    // One task's repeats speak for that task only.
    pending[i]!.cell.taskComparison = { ...d, claim: "these_tasks" };
  });

  const order = [...(kit.workloads ?? []).map((w) => w.id), ...taskSet];
  const tasks = [...new Set(order)].filter((w) => taskSet.has(w));
  const general = minTasksForSignificance(alpha / Math.max(1, generalFamily));
  const T = tasks.length;
  const scope =
    T < general
      ? `${T} task${T === 1 ? "" : "s"}: this doesn't generalise to other tasks; ≥${general} tasks needed for a general claim.`
      : `${T} tasks: per-task results speak for these tasks only; the general claim is the task-paired verdict.`;

  const headline: PerTaskFinding[] = [];
  for (const s of scores) {
    if (s.contenderId === baseline) continue;
    kit.requirements.forEach((req, ri) => {
      const r = s.requirements[ri];
      if (!r?.scored || r.byWorkload.length === 0) return;
      const vs = r.byWorkload.map((c) => c.taskComparison?.verdict ?? null);
      const first = vs[0];
      if ((first !== "better" && first !== "worse") || !vs.every((v) => v === first)) return;
      const ids = r.byWorkload.map((c) => c.workloadId);
      const adjective = perTaskAdjective(req, first);
      const where =
        ids.length === T && T > 1
          ? `on all ${T} tasks tested`
          : `on the ${ids.length} task${ids.length === 1 ? "" : "s"} it covers (${ids.join(", ")})`;
      headline.push({
        contenderId: s.contenderId,
        requirementId: req.id,
        verdict: first,
        adjective,
        tasks: ids,
        statement: `${s.contenderId} was ${adjective} ${where}`,
      });
    });
  }
  return { alpha, family: decided.length, tasks, scope, headline };
}
