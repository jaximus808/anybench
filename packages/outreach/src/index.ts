// @anybench/outreach (E15): the Monid client (inspect, run with a mandatory maxCost, wallet balance,
// spend cap) and AgentMail-through-Monid wrappers. Money is integer micro-USD (bigint); Monid's float
// USD is converted at the boundary in ./money.ts. `FakeAgentMail` is also at `@anybench/outreach/fake`.

export * from "./money.js";
export * from "./monid.js";
export * from "./agentmail.js";
export { FakeAgentMail } from "./fake.js";
// 15.2a sourcing + opt-in import (TDM-163).
export * from "./context-dev.js";
export * from "./github-signals.js";
export * from "./email-finder.js";
export * from "./store.js";
export * from "./source.js";
export * from "./import.js";
// 15.3a scout: fit score + cited claim brief per lead (TDM-164).
export * from "./scout.js";
// Plan 17.2 rule 10 wording filter, shared by the scout and the writer (TDM-165).
export * from "./rule10.js";
