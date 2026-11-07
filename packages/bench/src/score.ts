// TDM-53 [5.8]: weighted 0–100 score over gated metrics (plan.md P2 "The core rule in code", P3).
//
// The core rule: no speed or quality number without a correctness gate. Here that means
// - a measured value counts only from a trial whose gate (`requirement.gate_id`) passed;
// - a contender with a trial that has no result for that gate, or whose gate never passed,
//   gets `{scored: false, reason: "no score: gate failed" | "no score: gate missing"}` for
//   the requirement, and then gets NO total score at all (a partial total would hide it).
//
// How a requirement becomes 0..weight points, per contender:
// 1. Per workload, take the median of the metric over the contender's gate-passing trials.
// 2. Turn each workload median into a fraction in [0, 1]:
//    - `target` parsed as a threshold in the metric's unit ("under 120 ms" → ≤ 120, "at least
//      0.9" → ≥ 0.9): meeting it is 1, missing it is the ratio to it (T/v when lower is
//      better, v/T when higher is better).
//    - no usable target: relative to the best gated contender on that workload (min/v when
//      lower is better, v/max when higher). Values below zero switch to min–max scaling.
//    - the reserved metric `gate_pass_rate` (share of the contender's trials whose gate passed,
//      failed trials included as 0) and reviewed requirements are absolute: the rate itself,
//      and (median review − scale.min) / (scale.max − scale.min).
// 3. Average the fractions over the workloads the contender has a value on, times the weight.
// The contender total is the sum of points; weights sum to 100 (KitSpecSchema checks it).
import { GateResultSchema, type KitSpec, type Requirement } from "@anybench/core";
import { z } from "zod";
import { median } from "./stats.js";

/** Reserved metric: fraction of a contender's trials whose gate passed. Always gated. */
export const GATE_PASS_RATE_METRIC = "gate_pass_rate";

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
  gate_failed: "no score: gate failed",
  gate_missing: "no score: gate missing",
  metric_missing: "no score: metric missing",
  not_reviewed: "no score: not reviewed",
  no_trials: "no score: no trials",
} as const;
export type NoScoreCode = keyof typeof NO_SCORE_REASONS;
export type NoScoreReason = (typeof NO_SCORE_REASONS)[NoScoreCode];

export interface WorkloadCell {
  workloadId: string;
  /** Median over gated trials (or the pass rate, or the median review). */
  value: number;
  fraction: number;
  /** Trials behind `value`. */
  n: number;
}

interface RequirementScoreBase {
  requirementId: string;
  type: Requirement["type"];
  weight: number;
}
export interface ScoredRequirement extends RequirementScoreBase {
  scored: true;
  /** Mean of the per-workload fractions, in [0, 1]. */
  fraction: number;
  /** fraction × weight, in [0, weight]. */
  points: number;
  byWorkload: WorkloadCell[];
}
export interface UnscoredRequirement extends RequirementScoreBase {
  scored: false;
  code: NoScoreCode;
  reason: NoScoreReason;
  points: null;
}
export type RequirementScore = ScoredRequirement | UnscoredRequirement;

export interface GateTally {
  passed: number;
  failed: number;
  missing: number;
  total: number;
}

interface ContenderScoreBase {
  contenderId: string;
  trials: number;
  /** gate id → pass/fail counts over the contender's trials ("tasks solved 11/15"). */
  gates: Record<string, GateTally>;
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
}

export interface ScoreOptions {
  /** Contenders to score, in display order. Default: contender ids in trial order. */
  contenders?: readonly string[];
}

export interface TargetThreshold {
  op: "le" | "ge";
  value: number;
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const LE_RE = new RegExp(
  String.raw`^\s*(?:under|below|less than|at most|no more than|<=|≤|<)\s*${NUM}`,
  "i",
);
const GE_RE = new RegExp(
  String.raw`^\s*(?:over|above|more than|at least|no less than|>=|≥|>)\s*${NUM}`,
  "i",
);

/**
 * Parse a requirement's human-readable `target` into a threshold, when it is a simple bound in
 * the metric's own unit ("under 120 ms", "at least 0.9", "≤ 30"). Anything else ("all pass",
 * "$5 per task") returns undefined and the requirement is scored relative to the best contender.
 */
export function parseTarget(target: string | undefined): TargetThreshold | undefined {
  if (target === undefined) return undefined;
  const le = LE_RE.exec(target);
  if (le) return { op: "le", value: Number(le[1]) };
  const ge = GE_RE.exec(target);
  if (ge) return { op: "ge", value: Number(ge[1]) };
  return undefined;
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

/** Per-contender, per-workload raw values for one requirement, before normalization. */
type RawCells =
  { ok: true; cells: Map<string, { value: number; n: number }> } | { ok: false; code: NoScoreCode };

function gatedTrials(
  trials: readonly ParsedTrial[],
  gateId: string,
): { ok: true; passing: ParsedTrial[] } | { ok: false; code: NoScoreCode } {
  if (trials.length === 0) return { ok: false, code: "no_trials" };
  if (trials.some((t) => t.gates[gateId] === undefined)) return { ok: false, code: "gate_missing" };
  const passing = trials.filter((t) => t.gates[gateId]!.pass);
  if (passing.length === 0) return { ok: false, code: "gate_failed" };
  return { ok: true, passing };
}

function byWorkload(trials: readonly ParsedTrial[]): Map<string, ParsedTrial[]> {
  const m = new Map<string, ParsedTrial[]>();
  for (const t of trials) {
    const list = m.get(t.workloadId);
    if (list) list.push(t);
    else m.set(t.workloadId, [t]);
  }
  return m;
}

function rawCells(req: Requirement, trials: readonly ParsedTrial[]): RawCells {
  if (req.type === "measured") {
    if (req.metric === GATE_PASS_RATE_METRIC) {
      if (trials.length === 0) return { ok: false, code: "no_trials" };
      if (trials.some((t) => t.gates[req.gate_id] === undefined))
        return { ok: false, code: "gate_missing" };
      const cells = new Map<string, { value: number; n: number }>();
      for (const [w, ts] of byWorkload(trials)) {
        const passed = ts.filter((t) => t.gates[req.gate_id]!.pass).length;
        cells.set(w, { value: passed / ts.length, n: ts.length });
      }
      return { ok: true, cells };
    }
    const g = gatedTrials(trials, req.gate_id);
    if (!g.ok) return g;
    if (g.passing.some((t) => t.metrics[req.metric] === undefined))
      return { ok: false, code: "metric_missing" };
    const cells = new Map<string, { value: number; n: number }>();
    for (const [w, ts] of byWorkload(g.passing)) {
      cells.set(w, { value: median(ts.map((t) => t.metrics[req.metric]!)), n: ts.length });
    }
    return { ok: true, cells };
  }

  // reviewed
  let eligible: readonly ParsedTrial[] = trials;
  if (trials.length === 0) return { ok: false, code: "no_trials" };
  if (req.gate_id !== undefined) {
    const g = gatedTrials(trials, req.gate_id);
    if (!g.ok) return g;
    eligible = g.passing;
  }
  const reviewed = eligible.filter((t) => t.reviews[req.id] !== undefined);
  if (reviewed.length === 0) return { ok: false, code: "not_reviewed" };
  const cells = new Map<string, { value: number; n: number }>();
  for (const [w, ts] of byWorkload(reviewed)) {
    cells.set(w, { value: median(ts.map((t) => t.reviews[req.id]!)), n: ts.length });
  }
  return { ok: true, cells };
}

function cellFraction(req: Requirement, value: number, pool: readonly number[]): number {
  if (req.type === "reviewed") {
    return clamp01((value - req.scale.min) / (req.scale.max - req.scale.min));
  }
  const target = parseTarget(req.target);
  const usable = target && (target.op === "le") === (req.better === "lower") ? target : undefined;
  if (usable) return thresholdFraction(value, usable);
  if (req.metric === GATE_PASS_RATE_METRIC) return clamp01(value);
  return relativeFraction(value, pool, req.better);
}

/**
 * Score every contender over the kit's requirements. Pure: same kit and trials, same scores.
 * Throws a ZodError if a trial result is malformed.
 */
export function scoreKit(
  kit: Pick<KitSpec, "requirements" | "scoring">,
  trialResults: readonly TrialResult[],
  opts: ScoreOptions = {},
): KitScore {
  const trials = z.array(TrialResultSchema).parse(trialResults);
  const contenderIds = opts.contenders
    ? [...opts.contenders]
    : [...new Set(trials.map((t) => t.contenderId))];
  const trialsOf = new Map<string, ParsedTrial[]>(contenderIds.map((c) => [c, []]));
  for (const t of trials) trialsOf.get(t.contenderId)?.push(t);

  // Phase 1: raw per-workload values per requirement per contender.
  const raw = new Map<string, Map<string, RawCells>>(); // requirement → contender → cells
  for (const req of kit.requirements) {
    const perContender = new Map<string, RawCells>();
    for (const c of contenderIds) perContender.set(c, rawCells(req, trialsOf.get(c)!));
    raw.set(req.id, perContender);
  }

  // Phase 2: normalize each cell against the gated contenders on the same workload.
  const scores: ContenderScore[] = contenderIds.map((c) => {
    const ts = trialsOf.get(c)!;
    const requirements: RequirementScore[] = kit.requirements.map((req) => {
      const weight = kit.scoring.weights[req.id] ?? 0;
      const mine = raw.get(req.id)!.get(c)!;
      if (!mine.ok) {
        return {
          requirementId: req.id,
          type: req.type,
          weight,
          scored: false,
          code: mine.code,
          reason: NO_SCORE_REASONS[mine.code],
          points: null,
        };
      }
      const cells: WorkloadCell[] = [];
      for (const [workloadId, { value, n }] of mine.cells) {
        const pool: number[] = [];
        for (const other of raw.get(req.id)!.values()) {
          const cell = other.ok ? other.cells.get(workloadId) : undefined;
          if (cell) pool.push(cell.value);
        }
        cells.push({ workloadId, value, n, fraction: cellFraction(req, value, pool) });
      }
      const fraction = cells.reduce((s, x) => s + x.fraction, 0) / cells.length;
      return {
        requirementId: req.id,
        type: req.type,
        weight,
        scored: true,
        fraction,
        points: fraction * weight,
        byWorkload: cells,
      };
    });

    const gates: Record<string, GateTally> = {};
    const gateIds = new Set<string>();
    for (const req of kit.requirements) if (req.gate_id !== undefined) gateIds.add(req.gate_id);
    for (const g of gateIds) {
      const tally: GateTally = { passed: 0, failed: 0, missing: 0, total: ts.length };
      for (const t of ts) {
        const r = t.gates[g];
        if (r === undefined) tally.missing++;
        else if (r.pass) tally.passed++;
        else tally.failed++;
      }
      gates[g] = tally;
    }

    const blocking = requirements.filter(
      (r): r is UnscoredRequirement => !r.scored && r.weight > 0,
    );
    const base = { contenderId: c, trials: ts.length, gates, requirements };
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
  return { contenders: scores, ranking };
}
