# The Anybench MCP server in Claude Code (`packages/mcp`, TDM-220)

`packages/mcp` is a stdio MCP server on `@modelcontextprotocol/sdk` 1.32.2 (pinned exactly;
published 2026-10-23, `npm view @modelcontextprotocol/sdk time`). Its tools are exactly
`MCP_TOOLS` in `packages/core/src/api/mcp-tools.ts`, which `apps/web/app/docs/mcp` renders.

## Registering it in a scratch project (local scope, 2026-11-08, Claude Code 2.1.319, macOS)

Local scope so the founder's user-scope config is untouched; removed again afterwards.

```
$ pnpm --filter "@anybench/mcp..." --workspace-concurrency=1 build
$ cd <scratch dir> && git init -q
$ claude mcp add --scope local anybench -- node <worktree>/packages/mcp/dist/bin.js
Added stdio MCP server anybench with command: node <worktree>/packages/mcp/dist/bin.js to local config
File modified: /Users/jaxon/.claude.json [project: <scratch dir>]

$ claude mcp list
Checking MCP server health…
...
tandem: npx -y @jaximus/tandem-mcp - ✔ Connected
anybench: node <worktree>/packages/mcp/dist/bin.js - ✔ Connected

$ claude mcp get anybench
anybench:
  Scope: Local config (private to you in this project)
  Status: ✔ Connected
  Type: stdio
  Command: node
  Args: <worktree>/packages/mcp/dist/bin.js
  Environment:

$ claude -p --model haiku "List the names of the tools available to you whose names start with mcp__anybench__, one per line, nothing else. Do not call any tool."
mcp__anybench__get_kit_guide
mcp__anybench__get_report
mcp__anybench__get_run
mcp__anybench__get_trial
mcp__anybench__list_runs
mcp__anybench__list_trials
mcp__anybench__push_kit
mcp__anybench__run_local_proof
mcp__anybench__scaffold_kit
mcp__anybench__start_run
mcp__anybench__validate_kit
mcp__anybench__watch_run

$ claude mcp remove anybench -s local
Removed MCP server anybench from local config
```

## Calling tools over the real stdio bin (an SDK `StdioClientTransport`, no model)

```
server: {"name":"anybench","version":"0.1.0"}
tools: get_kit_guide, scaffold_kit, validate_kit, run_local_proof, push_kit, start_run, list_runs, get_run, watch_run, list_trials, get_trial, get_report
scaffold_kit: true <scratch dir>/bench
validate_kit: {"ok":true,"dir":"<scratch dir>/bench","errors":[],"warnings":[],"kit":{"subject":"claude-code",...
push_kit (no key): true ANYBENCH_API_KEY is not set: create an API key (scope runs:write) and export ANYBENCH_API_KEY=ab_live_…
```

## What to know

- Relative `dir` arguments resolve against the server's working directory, which is the project
  Claude Code was started in (the stdio check above passed `cwd` and `bench` landed there).
- The server starts without `ANYBENCH_API_KEY`: the kit-authoring tools work, the API tools
  answer a tool error saying the key is missing. Claude Code passes its own environment to a
  stdio server, so a key exported in the shell that runs `claude` reaches it.
  `setup --with-key` stores it in the config instead (`claude mcp add -e`).
- Invalid tool input is answered by the SDK as a tool result with `isError: true` and
  `MCP error -32602: Input validation error: ...` (not a thrown JSON-RPC error), before the
  handler runs.
- `run_local_proof` on a fresh coding-agent scaffold through the MCP tool, Docker 29.4.3: pass in
  about 1 s with a warm `node:22` image (the vitest Docker test).
- `npx -y @anybench/mcp setup` cannot be tried end to end until the package is on npm (it is
  `private` for now); `setup --print` shows the command it runs:
  `claude mcp add --scope user anybench -- npx -y @anybench/mcp`.
