// Metric rows: what every collector emits and what `EVAL_OUT/metrics.jsonl` holds (plan.md P2 L4).
//
// One row is one number. `level` says whether it describes the whole trial (`wall_s` from
// `/usr/bin/time -v`) or one sample inside it (one hyperfine run, one proxied call). Money rows
// use unit `micro_usd` and hold a bigint; every other unit holds a finite JS number. A row that
// feeds a measured requirement carries that requirement's `gate_id` (see `linkGates`), because
// `Score` only counts a number whose gate passed. No speed or quality number without a gate.
//
// `@anybench/core` exports no Metric schema (checked at TDM-50), so it lives here.
import { z } from "zod";
import {
  CollectorNameSchema,
  KitSlugSchema,
  MicroUsdSchema,
  type MicroUsd,
  type Requirement,
} from "@anybench/core";

/** Canonical units. Collectors normalize into these (kbytes -> bytes, "1.2ms" -> ms). */
export const MetricUnitSchema = z.enum([
  "s",
  "ms",
  "bytes",
  "count",
  "tokens",
  "percent",
  "per_s",
  "ratio",
  "micro_usd",
]);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

export const MetricLevelSchema = z.enum(["trial", "sample"]);
export type MetricLevel = z.infer<typeof MetricLevelSchema>;

/** snake_case, dots allowed for namespacing: `wall_s`, `p95_ms`, `cost_micro_usd`. */
export const MetricNameSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/, {
  error:
    "metric name must be lowercase snake_case (letters, digits, '_' or '.'), at most 128 chars",
});

const FiniteNumberSchema = z.number().refine(Number.isFinite, { error: "must be a finite number" });

/**
 * A metric row. JSON form: `value` is a number, or for `micro_usd` a base-10 integer string
 * (bigint does not survive JSON). Parsed form: number, or bigint for `micro_usd`.
 */
export const MetricSchema = z
  .strictObject({
    name: MetricNameSchema,
    value: z.union([FiniteNumberSchema, MicroUsdSchema]),
    unit: MetricUnitSchema,
    level: MetricLevelSchema,
    /** 0-based sample index inside the trial. Required for `sample`, absent for `trial`. */
    sample: z.int().nonnegative().optional(),
    collector: CollectorNameSchema,
    /** Gate whose pass makes this number count. Required when the row feeds a measured requirement. */
    gate_id: KitSlugSchema.optional(),
    /** Dimensions that split one name into several series (hyperfine command, model, tool). */
    labels: z.record(z.string().min(1), z.string()).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.unit === "micro_usd" && typeof m.value !== "bigint") {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message:
          "micro_usd metrics hold integer micro-USD (bigint or decimal string), never a float",
      });
    }
    if (m.unit !== "micro_usd" && typeof m.value === "bigint") {
      ctx.addIssue({ code: "custom", path: ["value"], message: `unit ${m.unit} takes a number` });
    }
    if (m.level === "sample" && m.sample === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["sample"],
        message: "sample-level metrics need a sample index",
      });
    }
    if (m.level === "trial" && m.sample !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["sample"],
        message: "trial-level metrics have no sample index",
      });
    }
  });
export type Metric = z.infer<typeof MetricSchema>;

/** A metric that feeds a measured requirement: `gate_id` is mandatory. */
export type GatedMetric = Metric & { gate_id: string };

/** Build-time helper for collectors: validates the row so a bad parser fails loudly. */
export function metric(row: z.input<typeof MetricSchema>): Metric {
  return MetricSchema.parse(row);
}

/** One `metrics.jsonl` line. micro-USD values are written as decimal strings. */
export function encodeMetric(m: Metric): string {
  return JSON.stringify(MetricSchema.parse(m), (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

/** Encode many rows as JSONL (trailing newline). */
export function encodeMetricsJsonl(rows: readonly Metric[]): string {
  return rows.map((r) => encodeMetric(r) + "\n").join("");
}

export interface MetricsParseResult {
  metrics: Metric[];
  /** `line N: path: message` for every line that did not validate. */
  errors: string[];
}

/** Parse `metrics.jsonl`. Bad lines are reported, never silently dropped into the score. */
export function parseMetricsJsonl(text: string): MetricsParseResult {
  const metrics: Metric[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      errors.push(`line ${i + 1}: invalid JSON (${(e as Error).message})`);
      return;
    }
    const r = MetricSchema.safeParse(raw);
    if (r.success) metrics.push(r.data);
    else
      for (const iss of r.error.issues)
        errors.push(`line ${i + 1}: ${iss.path.join(".") || "(root)"}: ${iss.message}`);
  });
  return { metrics, errors };
}

export interface LinkGatesResult {
  metrics: Metric[];
  /** Measured requirements whose metric no collector produced. */
  missing: { requirement_id: string; metric: string; gate_id: string }[];
}

/**
 * Stamp `gate_id` on every row whose name a measured requirement reads. A row that already
 * names a different gate is an error: one number cannot be vouched for by two gates.
 */
export function linkGates(
  rows: readonly Metric[],
  requirements: readonly Requirement[],
): LinkGatesResult {
  const gateByMetric = new Map<string, string>();
  const missing: LinkGatesResult["missing"] = [];
  for (const req of requirements) {
    if (req.type !== "measured") continue;
    const prev = gateByMetric.get(req.metric);
    if (prev !== undefined && prev !== req.gate_id) {
      throw new Error(
        `metric ${req.metric} is read by requirements gated on ${prev} and ${req.gate_id}`,
      );
    }
    gateByMetric.set(req.metric, req.gate_id);
  }
  const metrics = rows.map((m) => {
    const gate = gateByMetric.get(m.name);
    if (gate === undefined) return m;
    if (m.gate_id !== undefined && m.gate_id !== gate) {
      throw new Error(
        `metric ${m.name} already names gate ${m.gate_id}, requirement wants ${gate}`,
      );
    }
    return { ...m, gate_id: gate };
  });
  const produced = new Set(rows.map((m) => m.name));
  for (const req of requirements) {
    if (req.type === "measured" && !produced.has(req.metric)) {
      missing.push({ requirement_id: req.id, metric: req.metric, gate_id: req.gate_id });
    }
  }
  return { metrics, missing };
}

/** The rows a measured requirement may score: only those carrying a `gate_id`. */
export function gatedMetrics(rows: readonly Metric[]): GatedMetric[] {
  return rows.filter((m): m is GatedMetric => m.gate_id !== undefined);
}

/**
 * Rows -> the `name -> number` record the scorer reads (`TrialResult.metrics`, score.ts).
 * Only trial-level rows without labels: samples and per-model/per-tool splits are drill-down,
 * not scored. micro-USD goes in as an exact integer (refused past 2^53). Two collectors writing
 * the same name with different values is an error, not a silent pick.
 */
export function trialMetricRecord(rows: readonly Metric[]): Record<string, number> {
  const out: Record<string, number> = {};
  const from: Record<string, string> = {};
  for (const m of rows) {
    if (m.level !== "trial" || (m.labels && Object.keys(m.labels).length > 0)) continue;
    let v: number;
    if (typeof m.value === "bigint") {
      if (m.value > BigInt(Number.MAX_SAFE_INTEGER) || m.value < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new RangeError(`${m.name} = ${m.value} micro-USD does not fit a safe integer`);
      }
      v = Number(m.value);
    } else v = m.value;
    const prev = out[m.name];
    if (prev !== undefined && prev !== v) {
      throw new Error(`${m.name} written by ${from[m.name]} (${prev}) and ${m.collector} (${v})`);
    }
    out[m.name] = v;
    from[m.name] = m.collector;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// USD decimal text -> micro-USD, with no float on the path.

const USD_DECIMAL = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parse a USD amount written as JSON number text ("0.0123", "1.5e-3", "12") into integer
 * micro-USD. Digits past the sixth decimal are rounded half away from zero. Pure string and
 * bigint arithmetic: never `Number(text) * 1e6`.
 */
export function usdTextToMicro(text: string): MicroUsd {
  const m = USD_DECIMAL.exec(text.trim());
  if (!m) throw new RangeError(`not a USD decimal: ${JSON.stringify(text)}`);
  const [, sign, whole = "0", frac = "", exp = "0"] = m;
  const digits = (whole + frac).replace(/^0+(?=\d)/, "");
  // value = digits x 10^(scale) where scale = exp - frac.length; micro = value x 10^6.
  const shift = Number(exp) - frac.length + 6;
  if (Math.abs(shift) > 60)
    throw new RangeError(`USD amount out of range: ${JSON.stringify(text)}`);
  let micro: bigint;
  if (shift >= 0) {
    micro = BigInt(digits) * 10n ** BigInt(shift);
  } else {
    const div = 10n ** BigInt(-shift);
    const n = BigInt(digits);
    micro = n / div;
    if ((n % div) * 2n >= div) micro += 1n;
  }
  return sign && micro !== 0n ? -micro : micro;
}

/**
 * `JSON.parse` that keeps the source text of number values (Node >= 22 passes it to the
 * reviver as `context.source`), so money can be read exactly. `keys` are the property names
 * whose numbers are returned as their raw text instead of a float.
 */
export function parseJsonKeepingNumberText(text: string, keys: ReadonlySet<string>): unknown {
  return JSON.parse(text, function (
    this: unknown,
    key: string,
    value: unknown,
    ...rest: unknown[]
  ) {
    if (typeof value === "number" && keys.has(key)) {
      const ctx = rest[0] as { source?: string } | undefined;
      if (typeof ctx?.source === "string") return { $number: ctx.source };
      throw new Error("JSON.parse source text access is unavailable (needs Node >= 22)");
    }
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown);
}

/** A number kept as its JSON text by `parseJsonKeepingNumberText`. */
export const NumberTextSchema = z.strictObject({ $number: z.string() });
