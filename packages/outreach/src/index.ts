// @anybench/outreach (E15): the Monid client (inspect, run with a mandatory maxCost, wallet balance,
// spend cap) and AgentMail-through-Monid wrappers. Money is integer micro-USD (bigint); Monid's float
// USD is converted at the boundary in ./money.ts. `FakeAgentMail` is also at `@anybench/outreach/fake`.

export * from "./money.js";
export * from "./monid.js";
export * from "./agentmail.js";
export { FakeAgentMail } from "./fake.js";
