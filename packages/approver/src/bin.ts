#!/usr/bin/env node
// Entry point for `eval-approver` (TDM-52 [5.7]). All logic lives in cli.ts.
import { main } from "./cli.js";

const stop = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.abort());

process.exitCode = await main(process.argv.slice(2), {
  stdout: (l) => process.stdout.write(l + "\n"),
  stderr: (l) => process.stderr.write(l + "\n"),
  env: process.env,
  stopSignal: stop.signal,
});
