#!/usr/bin/env node
// `npx -y @anybench/mcp`: the Anybench MCP server on stdio (TDM-220 [19.4]).
// `npx -y @anybench/mcp setup`: register it with Claude Code (setup.ts).
//
// stdout is the MCP channel; anything for a human goes to stderr. The API key is never printed.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCP_PACKAGE } from "@anybench/core";
import { MCP_SERVER_VERSION, createAnybenchMcpServer } from "./server.js";
import { runSetup } from "./setup.js";

export const BIN_USAGE = `Usage: npx -y ${MCP_PACKAGE}            run the Anybench MCP server on stdio
       npx -y ${MCP_PACKAGE} setup      register it with Claude Code (see setup --help)
       npx -y ${MCP_PACKAGE} --version

Env: ANYBENCH_API_KEY (for push_kit, start_run and the run tools), ANYBENCH_API_URL,
ANYBENCH_WEB_URL, ANYBENCH_PROOF_IMAGE.`;

export async function main(argv: readonly string[]): Promise<number | "serving"> {
  const [cmd, ...rest] = argv;
  if (cmd === "setup") return runSetup(rest);
  if (cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${BIN_USAGE}\n`);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${MCP_SERVER_VERSION}\n`);
    return 0;
  }
  if (cmd !== undefined) {
    process.stderr.write(`unknown argument: ${cmd}\n${BIN_USAGE}\n`);
    return 2;
  }
  const server = createAnybenchMcpServer();
  await server.connect(new StdioServerTransport());
  return "serving";
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

if (isMain) {
  const r = await main(process.argv.slice(2));
  if (r !== "serving") process.exitCode = r;
}
