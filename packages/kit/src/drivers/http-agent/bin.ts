#!/usr/bin/env node
// Entry point for `anybench-http-agent` (TDM-40 [4.8]). All logic lives in cli.ts.
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2), {
  stdout: (l) => process.stdout.write(l + "\n"),
  stderr: (l) => process.stderr.write(l + "\n"),
  env: process.env,
});
