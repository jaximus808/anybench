// @anybench/agents: prompt.md + output.schema.json + config.json per Naive role.
// TDM-55 [6.1]: the generic role registry and the deploy sync.
export * from "./registry.js";
export * from "./sync.js";
export { syncMain, type SyncCliIo } from "./sync-cli.js";
// TDM-56 [6.2]: the understander role's input, output schema and code-enforced verdict.
export * from "./understander.js";
// TDM-60 [6.6]: the kit designer role: design / fix / repair inputs, the structured draft.
export * from "./kit-designer.js";
// TDM-187 [16.16]: the skeptic role's input (no score field), output, verification and model rule.
export * from "./skeptic.js";
