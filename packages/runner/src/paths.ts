// Where the runner reads and writes. Everything lives under the HOME of the user running it
// (Naïve fs ops are confined to /home/naive), so nothing here hardcodes a home directory.

import { homedir } from "node:os";
import { join } from "node:path";

export interface RunnerPaths {
  home: string;
  /** ~/.anybench: inputs the worker writes with fs.write before launching the runner. */
  configDir: string;
  /** ~/.anybench/trial.json: the TrialJob. */
  trialJson: string;
  /** ~/.anybench/env: KEY=VALUE secrets, given to the driver only (EVAL_SECRETS points here). */
  envFile: string;
  /** ~/.anybench/cancel: the worker writes this file to cancel; checked at phase boundaries and heartbeats. */
  cancelFile: string;
  /** ~/eval */
  evalDir: string;
  /** ~/eval/in (EVAL_IN): the workload input. */
  inDir: string;
  /** ~/eval/ws (EVAL_WS): the driver's workspace; `collect` globs are relative to it. */
  wsDir: string;
  /** ~/eval/out (EVAL_OUT): everything the trial produces. */
  outDir: string;
  /** ~/eval/out/status.json: current runner phase, rewritten atomically. */
  statusJson: string;
  /** ~/eval/out/events.jsonl: every AnybenchEvent the runner emitted, one JSON line each. */
  eventsJsonl: string;
  /** ~/eval/out/machine.json: the machine probe, written right before `run`. */
  machineJson: string;
  /** ~/eval/out/network.json: the network probe, written right before `run` when trial.json asks. */
  networkJson: string;
  /** ~/eval/chunks: scratch for live log segments while they upload (never bundled). */
  chunksDir: string;
  /** ~/eval/out/stdout.log / stderr.log: the driver's redacted output (all verbs). */
  stdoutLog: string;
  stderrLog: string;
  /** ~/eval/out/manifest.json: sha256 of every frozen file. */
  manifestJson: string;
  /** ~/eval/out/artifacts: files copied by the `collect` globs. */
  artifactsDir: string;
  /** ~/eval/warmup/<i>: warm-up outputs, discarded (never uploaded). */
  warmupDir: string;
  /** ~/eval/out.tar.gz: the frozen bundle that is uploaded (kept outside out/). */
  bundle: string;
  /** ~/eval/runner.log: where the launch command sends the runner's own stdout/stderr. */
  runnerLog: string;
}

export function runnerPaths(home: string = homedir()): RunnerPaths {
  const configDir = join(home, ".anybench");
  const evalDir = join(home, "eval");
  const outDir = join(evalDir, "out");
  return {
    home,
    configDir,
    trialJson: join(configDir, "trial.json"),
    envFile: join(configDir, "env"),
    cancelFile: join(configDir, "cancel"),
    evalDir,
    inDir: join(evalDir, "in"),
    wsDir: join(evalDir, "ws"),
    outDir,
    statusJson: join(outDir, "status.json"),
    eventsJsonl: join(outDir, "events.jsonl"),
    machineJson: join(outDir, "machine.json"),
    networkJson: join(outDir, "network.json"),
    chunksDir: join(evalDir, "chunks"),
    stdoutLog: join(outDir, "stdout.log"),
    stderrLog: join(outDir, "stderr.log"),
    manifestJson: join(outDir, "manifest.json"),
    artifactsDir: join(outDir, "artifacts"),
    warmupDir: join(evalDir, "warmup"),
    bundle: join(evalDir, "out.tar.gz"),
    runnerLog: join(evalDir, "runner.log"),
  };
}
