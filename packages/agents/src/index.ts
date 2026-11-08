// @anybench/agents: prompt.md + output.schema.json + config.json per Naive role.
// TDM-55 [6.1]: the generic role registry and the deploy sync.
export * from "./registry.js";
export * from "./sync.js";
export { syncMain, type SyncCliIo } from "./sync-cli.js";
// TDM-56 [6.2]: the understander role's input, output schema and code-enforced verdict.
export * from "./understander.js";
