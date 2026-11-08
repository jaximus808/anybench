// What a cli trial leaves in EVAL_OUT, and how it reaches the collectors and the score (TDM-36).
//
// The driver writes raw collector output at the paths `@anybench/bench` reads them from
// (COLLECTOR_OUTPUT_FILES: `time.txt`, `hyperfine.json`). `readCliCollectorOutputs` returns
// them in bench's `CollectorInput` shape, so a trial's rows are
//   collect(await readCliCollectorOutputs(out), kit.requirements)
// and every row a measured requirement reads comes back stamped with that requirement's
// gate_id; `scoreKit` then counts it only from trials whose `gate.json` passed. (`@anybench/kit`
// cannot import bench, which depends on it, so the shape is matched structurally here and pinned
// by bench's TDM-36 test.)
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { GateResultSchema, type GateResult } from "@anybench/core";
import type { CliCollector } from "./options.js";

/** Paths under EVAL_OUT written by the cli driver, relative to it. */
export const CLI_OUTPUT_PATHS = {
  /** The gated run's stdout: what the output-diff gate compares. */
  stdout: "cli/stdout.txt",
  stderr: "cli/stderr.txt",
  /** The gated run's exit status, one integer and a newline. */
  exitCode: "cli/exit_code",
  /** `$CLI_FILES_OUT` of the gated run: output files the gate compares. */
  filesDir: "cli/files",
  /** hyperfine's own progress output. */
  hyperfineLog: "cli/hyperfine.txt",
  /** Collector `time`: GNU `time -v -o` report of the gated run. */
  time: "time.txt",
  /** Collector `hyperfine`: `--export-json` of the timed runs. */
  hyperfine: "hyperfine.json",
} as const;

/** Raw collector output in the shape bench's `collect()` takes. */
export interface CliCollectorOutput {
  collector: CliCollector;
  raw: string;
}

/**
 * Read the collector files a cli trial wrote. A collector whose file is missing is reported in
 * `missing`, never invented: bench then lists the requirement as `metric missing`.
 */
export async function readCliCollectorOutputs(
  outDir: string,
  collectors: readonly CliCollector[] = ["time", "hyperfine"],
): Promise<{ inputs: CliCollectorOutput[]; missing: CliCollector[] }> {
  const inputs: CliCollectorOutput[] = [];
  const missing: CliCollector[] = [];
  for (const collector of collectors) {
    const file = join(outDir, CLI_OUTPUT_PATHS[collector]);
    const st = await lstat(file).catch(() => undefined);
    if (!st?.isFile()) {
      missing.push(collector);
      continue;
    }
    inputs.push({ collector, raw: await readFile(file, "utf8") });
  }
  return { inputs, missing };
}

/** Parse a `gate.json` written by a gate's check.sh. Throws on anything off-contract. */
export function parseGateResult(text: string): GateResult {
  return GateResultSchema.parse(JSON.parse(text));
}
