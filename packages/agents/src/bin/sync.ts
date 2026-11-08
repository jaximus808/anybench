#!/usr/bin/env node
// Entry point for `pnpm --filter @anybench/agents sync` (TDM-55 [6.1]). Logic lives in sync-cli.ts.
import { syncMain } from "../sync-cli.js";

process.exitCode = await syncMain(process.argv.slice(2), {
  stdout: (l) => process.stdout.write(l + "\n"),
  stderr: (l) => process.stderr.write(l + "\n"),
  env: process.env,
});
