// TDM-174 [16.3]: unit-aware parsing of a measured requirement's `target` (plan.md 17.1, 17.2).
//
// A target is human-readable ("under 120 ms", "at least 90%", "under $5 per task"). When it is a
// simple bound, the scorer measures each contender against it; anything else ("all pass", "lower
// is better") is not a bound and the requirement is scored relative to the best contender.
//
// Units matter: "under 2 min" on a metric in seconds is a bound of 120, and "under 120 ms" on a
// metric in bytes is a mistake the kit must not carry. Conversions are exact within a dimension
// (time, data size, ratio, money). Anything that could be mis-scored is rejected instead of
// guessed: a unit from another dimension, a word that is not a known unit, a unit on a requirement
// whose own unit is unknown, an ambiguous number ("1,5", "1,0000"), or a pass-rate bound above 1.
// Pure, no I/O; the core package is browser-safe, so this file imports nothing.

export interface TargetBound {
  op: "le" | "ge";
  /** The bound, converted into the requirement's unit (or as written when it has none). */
  value: number;
}

export type TargetParseResult =
  { ok: true; bound: TargetBound | undefined } | { ok: false; error: string };

type Dimension = "time" | "data" | "ratio" | "money";

interface UnitDef {
  dim: Dimension;
  /** Integer factor to the dimension's base unit (ns, byte, percent point, micro-USD). */
  factor: number;
}

/** Matched case-insensitively. */
const UNIT_GROUPS: [Dimension, number, string[]][] = [
  ["time", 1, ["ns", "nanosecond", "nanoseconds"]],
  ["time", 1e3, ["us", "µs", "μs", "microsecond", "microseconds"]],
  ["time", 1e6, ["ms", "millisecond", "milliseconds", "msec"]],
  ["time", 1e9, ["s", "sec", "secs", "second", "seconds"]],
  ["time", 6e10, ["min", "mins", "minute", "minutes"]],
  ["time", 3.6e12, ["h", "hr", "hrs", "hour", "hours"]],
  ["data", 1, ["byte", "bytes"]],
  ["data", 1e3, ["kilobyte", "kilobytes"]],
  ["data", 1e6, ["megabyte", "megabytes"]],
  ["data", 1e9, ["gigabyte", "gigabytes"]],
  ["ratio", 1, ["%", "percent", "pct"]],
  ["ratio", 100, ["ratio", "fraction"]],
  ["money", 1, ["micro-usd", "micro_usd", "microusd", "µusd", "μusd", "µ$", "μ$"]],
  ["money", 1e4, ["cent", "cents"]],
  ["money", 1e6, ["usd", "$", "dollar", "dollars"]],
];

/** Matched exactly: `Mb` (megabit) and `mB` are not `MB`. */
const CASED_UNIT_GROUPS: [Dimension, number, string[]][] = [
  ["data", 1, ["B"]],
  ["data", 1e3, ["KB", "kB"]],
  ["data", 1e6, ["MB"]],
  ["data", 1e9, ["GB"]],
  ["data", 1024, ["KiB", "kbytes"]],
  ["data", 1024 ** 2, ["MiB"]],
  ["data", 1024 ** 3, ["GiB"]],
];

const UNITS = new Map<string, UnitDef>();
for (const [dim, factor, names] of UNIT_GROUPS) {
  for (const n of names) UNITS.set(n.toLowerCase(), { dim, factor });
}
const CASED_UNITS = new Map<string, UnitDef>();
for (const [dim, factor, names] of CASED_UNIT_GROUPS) {
  for (const n of names) CASED_UNITS.set(n, { dim, factor });
}

/** Words that may follow the number without being a unit ("at least 0.9 of trials"). */
const STOPWORDS = new Set([
  "per",
  "for",
  "on",
  "in",
  "at",
  "of",
  "and",
  "or",
  "with",
  "across",
  "each",
  "every",
  "all",
  "when",
]);

const norm = (u: string) => u.trim().toLowerCase();

/** The known unit a requirement's `unit` names, if any (`ms`, `micro-USD`, `ratio`, `MB`). */
export function lookupUnit(unit: string | undefined): UnitDef | undefined {
  if (unit === undefined) return undefined;
  const u = unit.trim();
  return CASED_UNITS.get(u) ?? UNITS.get(u.toLowerCase());
}

/**
 * Convert `value` from unit `from` into unit `to`. Undefined when either unit is unknown or they
 * measure different things.
 */
export function convertUnit(value: number, from: string, to: string): number | undefined {
  if (from.trim() === to.trim()) return value;
  const a = lookupUnit(from);
  const b = lookupUnit(to);
  // Two units we don't know ("requests", "Requests") match only by name.
  if (a === undefined && b === undefined && norm(from) === norm(to)) return value;
  if (a === undefined || b === undefined || a.dim !== b.dim) return undefined;
  return (value * a.factor) / b.factor;
}

/** Mirrors `GATE_PASS_RATE_METRIC` in @anybench/bench (core cannot import bench). */
export const GATE_PASS_RATE_METRIC_NAME = "gate_pass_rate";

/**
 * Units of the metrics our collectors (packages/bench/src/collectors) and the scorer emit, by
 * name. TDM-175: a unit is inferred ONLY for these. Guessing from a suffix misread kit metrics
 * (`throughput_ops_s` is a rate, not seconds; `bonus_us` is not microseconds), so any other
 * metric takes the requirement's declared `unit`, or has none.
 */
export const KNOWN_METRIC_UNITS: Readonly<Record<string, string>> = {
  [GATE_PASS_RATE_METRIC_NAME]: "ratio",
  // hidden-tests gate (TDM-210): share of hidden tests passed, and the counts behind it
  hidden_test_fraction: "ratio",
  // time -v
  wall_s: "s",
  cpu_s: "s",
  user_cpu_s: "s",
  sys_cpu_s: "s",
  peak_rss_bytes: "bytes",
  cpu_percent: "%",
  // hyperfine
  hyperfine_mean_s: "s",
  hyperfine_median_s: "s",
  hyperfine_min_s: "s",
  hyperfine_max_s: "s",
  hyperfine_stddev_s: "s",
  hyperfine_user_s: "s",
  hyperfine_system_s: "s",
  // hey / k6 (percentiles are p50_ms, p95_ms, p99_ms, p99_9_ms)
  latency_mean_ms: "ms",
  latency_min_ms: "ms",
  latency_max_ms: "ms",
  load_duration_s: "s",
  error_rate: "ratio",
  checks_pass_rate: "ratio",
  http_data_bytes: "bytes",
  http_data_sent_bytes: "bytes",
  p50_ms: "ms",
  p75_ms: "ms",
  p90_ms: "ms",
  p95_ms: "ms",
  p99_ms: "ms",
  p99_9_ms: "ms",
  // stream-json / Naïve proxy
  cost_micro_usd: "micro-USD",
  model_cost_micro_usd: "micro-USD",
  proxy_billed_micro_usd: "micro-USD",
  proxy_vendor_cost_micro_usd: "micro-USD",
  agent_duration_ms: "ms",
  agent_api_duration_ms: "ms",
  // machine
  mem_available_bytes: "bytes",
  mem_total_bytes: "bytes",
  steal_pct: "%",
};

/**
 * The unit a known collector metric is in (`wall_s` → s, `cost_micro_usd` → micro-USD,
 * `p95_ms` → ms, `gate_pass_rate` → ratio). Undefined for any other name: declare `unit`.
 */
export function metricUnit(metric: string): string | undefined {
  return Object.hasOwn(KNOWN_METRIC_UNITS, metric) ? KNOWN_METRIC_UNITS[metric] : undefined;
}

const BOUND_RE = new RegExp(
  String.raw`^\s*(?:(?<le>under|below|less than|at most|no more than|<=|≤|<)|(?<ge>over|above|more than|at least|no less than|>=|≥|>))` +
    String.raw`\s*(?<dollar>\$)?\s*(?<num>-?(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?)(?<bad>[,.]\d)?` +
    String.raw`\s*(?<unit>%|[A-Za-zµμ$][A-Za-z0-9µμ_$-]*)?`,
  "i",
);

/**
 * Parse `target` as a bound in the requirement's unit. `unit` is the requirement's declared unit;
 * `metric`, when given, supplies the unit when none is declared (`wall_s` is in s) and is checked
 * against the declared one. `gate_pass_rate` targets are always ratios ("at least 90%" is 0.9).
 *
 * Returns `{ok: true, bound: undefined}` when the target is not a simple bound, and `{ok: false}`
 * when it is one that cannot be read safely.
 */
export function parseRequirementTarget(
  target: string | undefined,
  unit: string | undefined,
  metric?: string,
): TargetParseResult {
  const fail = (error: string): TargetParseResult => ({ ok: false, error });
  const isRate = metric === GATE_PASS_RATE_METRIC_NAME;

  // The unit the metric's values are in.
  let effective = unit;
  const implied = metric === undefined ? undefined : metricUnit(metric);
  if (isRate) {
    if (unit !== undefined && lookupUnit(unit)?.dim !== "ratio") {
      return fail(`${GATE_PASS_RATE_METRIC_NAME} is a ratio in [0, 1]: unit must be ratio`);
    }
    effective = "ratio";
  } else if (implied !== undefined) {
    if (unit !== undefined && convertUnit(1, implied, unit) !== 1) {
      return fail(`metric '${metric}' is in '${implied}', but unit says '${unit}'`);
    }
    effective = unit ?? implied;
  }

  if (target === undefined) return { ok: true, bound: undefined };
  const m = BOUND_RE.exec(target);
  if (!m?.groups) return { ok: true, bound: undefined };
  if (m.groups.bad !== undefined) {
    return fail(`target '${target}': ambiguous number (write 1000 or 1,000, and 1.5 not 1,5)`);
  }
  const op = m.groups.le !== undefined ? "le" : "ge";
  const num = Number(m.groups.num!.replaceAll(",", ""));
  let written: string | undefined = m.groups.dollar !== undefined ? "usd" : undefined;
  const token = m.groups.unit;
  if (token !== undefined && !STOPWORDS.has(norm(token))) {
    if (written !== undefined && lookupUnit(token)?.dim !== "money") {
      // "$5 usd" is redundant but fine; "$5 ms" is not.
      return fail(`target '${target}': '$' and '${token}' disagree`);
    }
    written = token;
  }

  if (written === undefined) {
    if (isRate && num > 1) {
      return fail(
        `target '${target}': a pass rate is in [0, 1]; write ${num / 100} or ${num}% instead`,
      );
    }
    return { ok: true, bound: { op, value: num } };
  }
  if (effective === undefined) {
    return fail(
      `target '${target}' is in '${written}', but the requirement has no unit: set unit so it can be converted`,
    );
  }
  const converted = convertUnit(num, written, effective);
  if (converted === undefined) {
    return fail(
      `target '${target}' is in '${written}', which does not convert to the requirement's unit '${effective}'`,
    );
  }
  return { ok: true, bound: { op, value: converted } };
}
