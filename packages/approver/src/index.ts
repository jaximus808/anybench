// @anybench/approver: the Tandem and Naïve human stand-ins (TDM-52 [5.7]).
// Every decision is a simulated, timed event in EVAL_OUT/approvals.jsonl; reports print
// "simulated approvals: N, latency", never human minutes (plan.md 17.2 rule 10).

export * from "./events.js";
export * from "./config.js";
export * from "./leak-guard.js";
export * from "./reviewer.js";
export * from "./tandem-client.js";
export * from "./tandem-auto.js";
export * from "./tandem-human-sim.js";
export * from "./tandem-peer.js";
export * from "./tandem.js";
export * from "./naive.js";
