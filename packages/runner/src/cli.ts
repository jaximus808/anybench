#!/usr/bin/env node
// `runner --trial <id> [--home <dir>]`: the entry point compiled into the in-VM binary.
// Launch it detached so it outlives the exec that started it:
//   setsid nohup ~/.anybench/bin/runner --trial <id> >> ~/eval/runner.log 2>&1 &

import { parseArgs, type CliArgs } from "./args.js";
import { RUNNER_EXIT, runTrial } from "./runner.js";
import { RUNNER_VERSION_LINE } from "./version.js";

const USAGE = `usage: runner --trial <id> [--home <dir>]

Reads ~/.anybench/trial.json and ~/.anybench/env, runs the trial, writes ~/eval/out/
(status.json, events.jsonl, machine.json, ...) and pushes events to the ingest API.`;

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return RUNNER_EXIT.usage;
  }
  if (args.version) {
    process.stdout.write(`${RUNNER_VERSION_LINE}\n`);
    return RUNNER_EXIT.ok;
  }
  if (args.help || !args.trial) {
    process.stderr.write(`${USAGE}\n`);
    return args.help ? RUNNER_EXIT.ok : RUNNER_EXIT.usage;
  }
  // setsid + nohup already detach us; ignore a stray hangup anyway.
  process.on("SIGHUP", () => undefined);
  const result = await runTrial({
    trialId: args.trial,
    ...(args.home ? { home: args.home } : {}),
    handleSignals: true,
  });
  return result.exitCode;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`runner: fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(RUNNER_EXIT.failed_infra);
  },
);
