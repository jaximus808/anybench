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
// TDM-60 [6.6] step 6: the issue writer (mined tasks → user-style issues from symptoms only).
export * from "./issue-writer.js";
// TDM-164 [15.3a]: the outreach scout.
export * from "./scout.js";
// TDM-167 [15.8a]: the outreach account manager (reply classifier).
export * from "./account-manager.js";
// TDM-165 [15.5a]: the outreach writer (subject + personal opening of a draft).
export * from "./writer.js";
