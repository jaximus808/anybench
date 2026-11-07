// Collector registry: kit collector name -> parser of that collector's raw output -> Metric rows.
// `collect()` parses, then `linkGates()` stamps the gate_id of every measured requirement that
// reads a row, so `Score` can refuse numbers whose gate did not pass.
import type { CollectorName, Requirement } from "@anybench/core";
import { linkGates, type LinkGatesResult, type Metric } from "../metric.js";
import { collectHey } from "./hey.js";
import { collectHyperfine } from "./hyperfine.js";
import { collectK6 } from "./k6.js";
import { collectMachine } from "./machine.js";
import { collectNaiveProxy, type NaiveProxyOptions } from "./naive-proxy.js";
import { collectStreamJson } from "./stream-json.js";
import { collectTime } from "./time.js";

export * from "./hey.js";
export * from "./hyperfine.js";
export * from "./k6.js";
export * from "./machine.js";
export * from "./naive-proxy.js";
export * from "./stream-json.js";
export * from "./time.js";

/** Collectors with a parser in this package. The rest (screenshot, playwright, ...) come later. */
export const PARSED_COLLECTORS = [
  "time",
  "hyperfine",
  "hey",
  "k6",
  "stream-json",
  "proxy-calls",
  "machine",
] as const satisfies readonly CollectorName[];
export type ParsedCollectorName = (typeof PARSED_COLLECTORS)[number];

/** Where each collector's raw output lives under EVAL_OUT (runner convention). */
export const COLLECTOR_OUTPUT_FILES: Readonly<Record<ParsedCollectorName, string>> = {
  time: "time.txt",
  hyperfine: "hyperfine.json",
  hey: "hey.txt",
  k6: "k6-summary.json",
  "stream-json": "stream.jsonl",
  "proxy-calls": "proxy-calls.json",
  machine: "machine.json",
};

export type CollectorInput =
  | { collector: "time" | "hey" | "stream-json"; raw: string }
  | { collector: "hyperfine" | "k6" | "machine"; raw: string | unknown }
  | { collector: "proxy-calls"; raw: string | unknown; options?: NaiveProxyOptions };

export function isParsedCollector(name: string): name is ParsedCollectorName {
  return (PARSED_COLLECTORS as readonly string[]).includes(name);
}

/** Parse one collector's raw output into Metric rows. Throws on output it cannot read. */
export function collectorMetrics(input: CollectorInput): Metric[] {
  switch (input.collector) {
    case "time":
      return collectTime(input.raw);
    case "hyperfine":
      return collectHyperfine(input.raw);
    case "hey":
      return collectHey(input.raw);
    case "k6":
      return collectK6(input.raw);
    case "stream-json":
      return collectStreamJson(input.raw);
    case "proxy-calls":
      return collectNaiveProxy(input.raw, input.options);
    case "machine":
      return collectMachine(input.raw);
  }
}

export interface CollectResult extends LinkGatesResult {
  /** `collector: message` for each input that failed to parse. Its rows are absent, never guessed. */
  errors: string[];
}

/** Parse every collector output of a trial and link the rows to the kit's measured requirements. */
export function collect(
  inputs: readonly CollectorInput[],
  requirements: readonly Requirement[] = [],
): CollectResult {
  const rows: Metric[] = [];
  const errors: string[] = [];
  for (const input of inputs) {
    try {
      rows.push(...collectorMetrics(input));
    } catch (e) {
      errors.push(`${input.collector}: ${(e as Error).message}`);
    }
  }
  return { ...linkGates(rows, requirements), errors };
}
