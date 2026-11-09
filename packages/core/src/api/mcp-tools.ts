// The Anybench MCP server's tools (TDM-220 [19.4]), as one catalog: packages/mcp registers exactly
// these (its test fails on a tool missing here or extra there) and apps/web/app/docs/mcp renders
// this table, so the docs list exactly the tools that exist.
//
// `scope` is the API key scope a tool needs; `local` tools run on your machine and need no key.

export type McpToolGroup = "author" | "observe";

export interface McpToolInfo {
  readonly name: string;
  readonly group: McpToolGroup;
  /** The arguments, in the docs' short form: `{dir, template?}`. Empty for none. */
  readonly args: string;
  /** One sentence: what it does. Also the start of the tool's MCP description. */
  readonly does: string;
  /** `local`, or the API key scope the tool needs. */
  readonly scope: "local" | "runs:read" | "runs:write";
}

export const MCP_SERVER_NAME = "anybench";

export const MCP_TOOLS = [
  {
    name: "get_kit_guide",
    group: "author",
    args: "",
    does: "How to write an eval kit: the KitSpec v2 layout, the fairness rules, the six proof checks, partial-credit hidden tests, the task-horizon rule, contract and fixtures declarations, and the commands in order.",
    scope: "local",
  },
  {
    name: "scaffold_kit",
    group: "author",
    args: "{dir, template?, force?}",
    does: "Write a new kit folder from a shipped example (coding-agent, cli, harness, http-agent) and validate it.",
    scope: "local",
  },
  {
    name: "validate_kit",
    group: "author",
    args: "{dir}",
    does: "Validate anybench.yaml against KitSpec v2 and every file it references; returns each error as file:line:col: field: message.",
    scope: "local",
  },
  {
    name: "run_local_proof",
    group: "author",
    args: "{dir, image?, network?, timeout_s?}",
    does: "Run the kit's oracle and a do-nothing contender on every workload, locally in Docker. Free: no agent, no tokens, no API call.",
    scope: "local",
  },
  {
    name: "push_kit",
    group: "author",
    args: "{dir}",
    does: "Validate the kit locally, pack it and upload it; returns the kit_id. Never uploads an invalid kit. Anybench reruns the proof on its own computers.",
    scope: "runs:write",
  },
  {
    name: "start_run",
    group: "author",
    args: "{kit_id, question, budget_micro_usd | budget_usd, auto_go?}",
    does: "Start a run from a pushed kit. The budget is integer micro-USD, or US dollars as a decimal string. Nothing is billed until Go.",
    scope: "runs:write",
  },
  {
    name: "list_runs",
    group: "observe",
    args: "{state?, limit?, cursor?}",
    does: "Your runs, newest first.",
    scope: "runs:read",
  },
  {
    name: "get_run",
    group: "observe",
    args: "{run_id}",
    does: "A run with its counters, open alerts and agent sessions.",
    scope: "runs:read",
  },
  {
    name: "watch_run",
    group: "observe",
    args: "{run_id, until?, timeout_s?}",
    does: "Wait until the run reaches one of the given states (default: one that needs you, or the end) or the timeout passes.",
    scope: "runs:read",
  },
  {
    name: "list_trials",
    group: "observe",
    args: "{run_id, state?, limit?, cursor?}",
    does: "A run's trials (contender × workload × repeat) with their state and failure class.",
    scope: "runs:read",
  },
  {
    name: "get_trial",
    group: "observe",
    args: "{trial_id}",
    does: "One trial: phases, metrics, gate result and outcome.",
    scope: "runs:read",
  },
  {
    name: "get_report",
    group: "observe",
    args: "{run_id, format?}",
    does: "The run's report as JSON or Markdown.",
    scope: "runs:read",
  },
] as const satisfies readonly McpToolInfo[];

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];

export const MCP_TOOL_NAMES: readonly McpToolName[] = MCP_TOOLS.map((t) => t.name);

/** The npm package and its one-line install (registers it with Claude Code, user scope). */
export const MCP_PACKAGE = "@anybench/mcp";
export const MCP_SETUP_COMMAND = `npx -y ${MCP_PACKAGE} setup`;
