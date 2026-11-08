// TDM-39 [4.7]: driver.type coding-agent (headless Claude Code): the driver.sh template and its
// do-less variant, the hidden-tests gate template, the collector output paths and pin checks, a
// runner stub, and the Claude Code bash blocks the harness driver (TDM-41) shares.
export * from "./claude-code.js";
export * from "./options.js";
export * from "./outputs.js";
export * from "./driver-template.js";
export * from "./gate-template.js";
export * from "./stub.js";
export * from "./proxy-key-guard.js";
