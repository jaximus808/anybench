#!/usr/bin/env node
// anybench: anybench CLI + /anybench Claude Code skill.
// Minimal dispatch from TDM-33 [4.1] so `anybench kit validate` runs; TDM-107 replaces it with the full CLI.
// TDM-219 [19.3]: `kit init | proof | push` and `run --kit` (bring your own kit).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runKitInit } from "./commands/kit-init.js";
import { runKitProof } from "./commands/kit-proof.js";
import { runKitPush } from "./commands/kit-push.js";
import { runKitValidate } from "./commands/kit-validate.js";
import { runRun } from "./commands/run.js";
import { runOutreach } from "./commands/outreach.js";
import { runOutreachScout } from "./commands/outreach-scout.js";
import { runOutreachDraft, runOutreachReview } from "./commands/outreach-review.js";
import { runOutreachSend } from "./commands/outreach-send.js";

export { runKitValidate } from "./commands/kit-validate.js";
export { runKitInit } from "./commands/kit-init.js";
export { runKitProof } from "./commands/kit-proof.js";
export { runKitPush } from "./commands/kit-push.js";
export { runRun, parseUsdBudget } from "./commands/run.js";
export { runOutreach } from "./commands/outreach.js";
export { runOutreachScout } from "./commands/outreach-scout.js";
export { runOutreachDraft, runOutreachReview } from "./commands/outreach-review.js";
export { runOutreachSend } from "./commands/outreach-send.js";

export async function main(argv: readonly string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === "kit" && command === "validate") return runKitValidate(rest);
  if (group === "kit" && command === "init") return runKitInit(rest);
  if (group === "kit" && command === "proof") return runKitProof(rest);
  if (group === "kit" && command === "push") return runKitPush(rest);
  if (group === "run") return runRun(argv.slice(1));
  // `outreach scout` before the `outreach` catch-all (TDM-163), which would reject it as unknown.
  if (group === "outreach" && command === "scout") return runOutreachScout(rest);
  if (group === "outreach" && command === "draft") return runOutreachDraft(rest);
  if (group === "outreach" && command === "review") return runOutreachReview(rest);
  if (group === "outreach" && (command === "send" || command === "send-test")) {
    return runOutreachSend(command, rest);
  }
  if (group === "outreach") return runOutreach(argv.slice(1));
  process.stderr.write(
    "Usage: anybench kit init [dir] [--template <name>] [--force]\n" +
      "       anybench kit validate [dir] [--json] [--quiet]\n" +
      "       anybench kit proof [dir] [--image <image>] [--json]\n" +
      "       anybench kit push [dir] [--json]\n" +
      "       anybench run --kit <kit_id> --question <text> --budget <usd>\n" +
      "       anybench outreach <queries|source|import|scout|draft|review|send|send-test|poll|stats> --help\n",
  );
  return 2;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) process.exitCode = await main(process.argv.slice(2));
