#!/usr/bin/env node
// A stand-in for Claude Code 2.1.319 in the TDM-228 tests: `--version` prints the version; any
// other call appends its argv and stdin (one JSON line) to $FAKE_CLAUDE_LOG and replays the next recorded
// stream-json transcript of $FAKE_CLAUDE_FIXTURES (comma-separated paths; the last one repeats).
// FAKE_CLAUDE_HANG=1: after the transcript, wait until killed (a session still running).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import process from "node:process";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("2.1.319 (Claude Code)\n");
  process.exit(0);
}
const log = process.env.FAKE_CLAUDE_LOG;
const fixtures = (process.env.FAKE_CLAUDE_FIXTURES ?? "").split(",").filter(Boolean);
if (!log || fixtures.length === 0) {
  process.stderr.write("fake claude: FAKE_CLAUDE_LOG and FAKE_CLAUDE_FIXTURES are required\n");
  process.exit(2);
}
const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
// The prompt: on stdin when the driver gives none on argv (TDM-239), "" for /dev/null.
const stdin = readFileSync(0, "utf8");
appendFileSync(log, `${JSON.stringify({ argv, stdin, home: process.env.HOME })}\n`);
process.stdout.write(readFileSync(fixtures[Math.min(calls, fixtures.length - 1)], "utf8"));
if (process.env.FAKE_CLAUDE_HANG === "1") setInterval(() => undefined, 1000);
