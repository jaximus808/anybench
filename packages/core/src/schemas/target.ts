// TDM-174 [16.3]: unit-aware parsing of a measured requirement's `target` (plan.md 17.1, 17.2).
//
// A target is human-readable ("under 120 ms", "at least 90%", "under $5 per task"). When it is a
// simple bound, the scorer measures each contender against it; anything else ("all pass", "lower
// is better") is not a bound and the requirement is scored relative to the best contender.
//
// Units matter: "under 2 min" on a metric in seconds is a bound of 120, and "under 120 ms" on a
// metric in bytes is a mistake the kit must not carry. Conversions are exact within a dimension
// (time, data size, ratio, money); a unit from another dimension, or a word that is neither a
// known unit nor the requirement's own unit, is rejected. Pure, no I/O; the core package is
// browser-safe, so this file imports nothing.

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

const UNIT_GROUPS: [Dimension, number, string[]][] = [
  ["time", 1, ["ns", "nanosecond", "nanoseconds"]],
  ["time", 1e3, ["us", "µs", "μs", "microsecond", "microseconds"]],
  ["time", 1e6, ["ms", "millisecond", "milliseconds", "msec"]],
  ["time", 1e9, ["s", "sec", "secs", "second", "seconds"]],
  ["time", 6e10, ["min", "mins", "minute", "minutes"]],
  ["time", 3.6e12, ["h", "hr", "hrs", "hour", "hours"]],
  ["data", 1, ["b", "byte", "bytes"]],
  ["data", 1e3, ["kb", "kilobyte", "kilobytes"]],
  ["data", 1e6, ["mb", "megabyte", "megabytes"]],
  ["data", 1e9, ["gb", "gigabyte", "gigabytes"]],
  ["data", 1024, ["kib", "kbytes"]],
  ["data", 1024 ** 2, ["mib"]],
  ["data", 1024 ** 3, ["gib"]],
  ["ratio", 1, ["%", "percent", "pct"]],
  ["ratio", 100, ["ratio", "fraction"]],
  ["money", 1, ["micro-usd", "micro_usd", "microusd", "µusd", "μusd"]],
  ["money", 1e4, ["cent", "cents"]],
  ["money", 1e6, ["usd", "$", "dollar", "dollars"]],
];

const UNITS = new Map<string, UnitDef>();
for (const [dim, factor, names] of UNIT_GROUPS) {
  for (const n of names) UNITS.set(n, { dim, factor });
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

/** The known unit a requirement's `unit` names, if any (`ms`, `micro-USD`, `ratio`). */
export function lookupUnit(unit: string | undefined): UnitDef | undefined {
  return unit === undefined ? undefined : UNITS.get(norm(unit));
}

/**
 * Convert `value` from unit `from` into unit `to`. Undefined when either unit is unknown or they
 * measure different things.
 */
export function convertUnit(value: number, from: string, to: string): number | undefined {
  if (norm(from) === norm(to)) return value;
  const a = lookupUnit(from);
  const b = lookupUnit(to);
  if (a === undefined || b === undefined || a.dim !== b.dim) return undefined;
  return (value * a.factor) / b.factor;
}

const BOUND_RE = new RegExp(
  String.raw`^\s*(?:(?<le>under|below|less than|at most|no more than|<=|≤|<)|(?<ge>over|above|more than|at least|no less than|>=|≥|>))` +
    String.raw`\s*(?<dollar>\$)?\s*(?<num>-?\d+(?:\.\d+)?)\s*(?<unit>%|[A-Za-zµμ$][A-Za-z0-9µμ_$-]*)?`,
  "i",
);

/**
 * Parse `target` as a bound in the requirement's `unit`. Returns `{ok: true, bound: undefined}`
 * when the target is not a simple bound, and `{ok: false}` when it is one in a unit that does
 * not match (e.g. "under 120 ms" on a requirement in bytes).
 */
export function parseRequirementTarget(
  target: string | undefined,
  unit: string | undefined,
): TargetParseResult {
  if (target === undefined) return { ok: true, bound: undefined };
  const m = BOUND_RE.exec(target);
  if (!m?.groups) return { ok: true, bound: undefined };
  const op = m.groups.le !== undefined ? "le" : "ge";
  const num = Number(m.groups.num);
  let written: string | undefined = m.groups.dollar !== undefined ? "usd" : undefined;
  const token = m.groups.unit;
  if (token !== undefined && !STOPWORDS.has(norm(token))) {
    if (written !== undefined) {
      // "$5 usd" is redundant but fine; "$5 ms" is not.
      if (lookupUnit(token)?.dim !== "money") {
        return { ok: false, error: `target '${target}': '$' and '${token}' disagree` };
      }
      written = token;
    } else {
      written = token;
    }
  }

  if (written === undefined || unit === undefined) return { ok: true, bound: { op, value: num } };
  if (norm(written) === norm(unit)) return { ok: true, bound: { op, value: num } };
  const converted = convertUnit(num, written, unit);
  if (converted === undefined) {
    return {
      ok: false,
      error: `target '${target}' is in '${written}', which does not convert to the requirement's unit '${unit}'`,
    };
  }
  return { ok: true, bound: { op, value: converted } };
}
