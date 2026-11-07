#!/usr/bin/env node
// anybench: anybench CLI + /anybench Claude Code skill.
// Minimal dispatch from TDM-33 [4.1] so `anybench kit validate` runs; TDM-107 replaces it with the full CLI.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runKitValidate } from "./commands/kit-validate.js";

export { runKitValidate } from "./commands/kit-validate.js";

export async function main(argv: readonly string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === "kit" && command === "validate") return runKitValidate(rest);
  process.stderr.write("Usage: anybench kit validate [dir] [--json] [--quiet]\n");
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
