import { describe, expect, it } from "vitest";
import {
  RUN_MAX_PROOF_REPAIRS,
  RUN_STATES,
  RUN_TRANSITIONS,
  RunCommandSchema,
  isLegalRunEdge,
  transitionRun,
  type RunCommand,
  type RunCommandType,
  type RunState,
} from "../src/index.js";

// A passing instance of each command, for walking the table.
function tdm8RunCommand(type: RunCommandType, to?: RunState): RunCommand {
  switch (type) {
    case "advance":
      return { type };
    case "go":
      return { type, estimate_fits_budget: true, billing_gate_passed: true };
    case "repair":
      return { type, repairs_so_far: 0 };
    case "needs_human":
      return { type, reason: "stuck" };
    case "pause_budget":
      return { type };
    case "resume":
      return { type, to: to ?? "intake" };
    case "fail":
      return { type, reason: "boom" };
    case "cancel":
      return { type };
  }
}

function expectTo(from: RunState, cmd: RunCommand, to: RunState) {
  const r = transitionRun(from, cmd);
  expect(r, `${from} --${cmd.type}--> ${to}`).toEqual({ ok: true, from, to, command: cmd });
}

function expectError(from: RunState, cmd: RunCommand, code: string) {
  const r = transitionRun(from, cmd);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.code).toBe(code);
    expect(r.error.from).toBe(from);
    expect(r.error.command).toBe(cmd.type);
  }
}

const happyPath: [RunState, RunCommand, RunState][] = [
  ["intake", { type: "advance" }, "understand"],
  ["understand", { type: "advance" }, "research"],
  ["research", { type: "advance" }, "kit_draft"],
  ["kit_draft", { type: "advance" }, "env_build"],
  ["env_build", { type: "advance" }, "proof"],
  ["proof", { type: "advance" }, "awaiting_go"],
  ["awaiting_go", { type: "go", estimate_fits_budget: true, billing_gate_passed: true }, "running"],
  ["running", { type: "advance" }, "scoring"],
  ["scoring", { type: "advance" }, "analyzing"],
  ["analyzing", { type: "advance" }, "delivered"],
];

const nonTerminal: RunState[] = RUN_STATES.filter(
  (s) => !["delivered", "failed", "cancelled"].includes(s),
);
const needsHumanFrom: RunState[] = [
  "intake",
  "understand",
  "research",
  "kit_draft",
  "env_build",
  "proof",
  "running",
  "scoring",
  "analyzing",
];
const pauseFrom: RunState[] = needsHumanFrom.filter((s) => s !== "intake");

describe("run state machine: legal transitions", () => {
  it.each(happyPath)("%s --%o--> %s", (from, cmd, to) => expectTo(from, cmd, to));

  it("proof repair goes back to kit_draft while repairs remain", () => {
    for (let n = 0; n < RUN_MAX_PROOF_REPAIRS; n++)
      expectTo("proof", { type: "repair", repairs_so_far: n }, "kit_draft");
  });

  it.each(nonTerminal)("%s can fail and be cancelled", (s) => {
    expectTo(s, { type: "fail", reason: "x" }, "failed");
    expectTo(s, { type: "cancel" }, "cancelled");
    expectTo(s, { type: "cancel", reason: "user" }, "cancelled");
  });

  it.each(needsHumanFrom)("%s can go to needs_human and resume back", (s) => {
    expectTo(s, { type: "needs_human", reason: "proof failed after 2 repairs" }, "needs_human");
    expectTo("needs_human", { type: "resume", to: s }, s);
  });

  it.each(pauseFrom)("%s can pause on budget and resume back", (s) => {
    expectTo(s, { type: "pause_budget", reason: "cap" }, "paused_budget");
    expectTo("paused_budget", { type: "resume", to: s }, s);
  });

  it("every edge in RUN_TRANSITIONS is reachable through transitionRun", () => {
    let edges = 0;
    for (const from of RUN_STATES) {
      for (const [type, targets] of Object.entries(RUN_TRANSITIONS[from])) {
        for (const to of targets) {
          expectTo(from, tdm8RunCommand(type as RunCommandType, to), to);
          expect(isLegalRunEdge(from, to)).toBe(true);
          edges++;
        }
      }
    }
    // 10 forward + 1 repair + 9 needs_human + 8 pause + 9 + 8 resumes + 2×12 fail/cancel
    expect(edges).toBe(10 + 1 + 9 + 8 + 9 + 8 + 2 * 12);
  });
});

describe("run state machine: illegal transitions", () => {
  it.each(["delivered", "failed", "cancelled"] as RunState[])("%s is terminal", (s) => {
    for (const type of ["advance", "fail", "cancel", "resume"] as RunCommandType[]) {
      expectError(s, tdm8RunCommand(type), "terminal_state");
    }
  });

  it("awaiting_go does not advance, only go", () => {
    expectError("awaiting_go", { type: "advance" }, "illegal_transition");
  });

  it("go is blocked unless the estimate fits and the billing gate passes", () => {
    expectError(
      "awaiting_go",
      { type: "go", estimate_fits_budget: false, billing_gate_passed: true },
      "gate_blocked",
    );
    expectError(
      "awaiting_go",
      { type: "go", estimate_fits_budget: true, billing_gate_passed: false },
      "gate_blocked",
    );
    const r = transitionRun("awaiting_go", {
      type: "go",
      estimate_fits_budget: false,
      billing_gate_passed: false,
    });
    expect(!r.ok && r.error.message).toMatch(/budget.*billing/);
  });

  it("repair is exhausted after the max", () => {
    expectError(
      "proof",
      { type: "repair", repairs_so_far: RUN_MAX_PROOF_REPAIRS },
      "repair_exhausted",
    );
  });

  it.each<[RunState, RunCommand]>([
    ["running", { type: "go", estimate_fits_budget: true, billing_gate_passed: true }],
    ["running", { type: "repair", repairs_so_far: 0 }],
    ["kit_draft", { type: "repair", repairs_so_far: 0 }],
    ["running", { type: "resume", to: "scoring" }],
    ["intake", { type: "pause_budget" }],
    ["awaiting_go", { type: "pause_budget" }],
    ["awaiting_go", { type: "needs_human", reason: "x" }],
    ["needs_human", { type: "advance" }],
    ["paused_budget", { type: "advance" }],
    ["needs_human", { type: "needs_human", reason: "again" }],
    ["paused_budget", { type: "pause_budget" }],
  ])("%s rejects %o", (s, cmd) => expectError(s, cmd, "illegal_transition"));

  it.each<[RunState, RunState]>([
    ["needs_human", "delivered"],
    ["needs_human", "awaiting_go"],
    ["needs_human", "paused_budget"],
    ["paused_budget", "intake"],
    ["paused_budget", "awaiting_go"],
    ["paused_budget", "failed"],
  ])("%s cannot resume into %s", (s, to) =>
    expectError(s, { type: "resume", to }, "invalid_resume_target"),
  );

  it("isLegalRunEdge rejects skipped stages", () => {
    expect(isLegalRunEdge("intake", "running")).toBe(false);
    expect(isLegalRunEdge("delivered", "intake")).toBe(false);
  });
});

describe("RunCommandSchema", () => {
  it("validates commands at the API boundary", () => {
    expect(
      RunCommandSchema.parse({ type: "go", estimate_fits_budget: true, billing_gate_passed: true }),
    ).toEqual({
      type: "go",
      estimate_fits_budget: true,
      billing_gate_passed: true,
    });
    expect(RunCommandSchema.safeParse({ type: "teleport" }).success).toBe(false);
    expect(RunCommandSchema.safeParse({ type: "go" }).success).toBe(false);
    expect(RunCommandSchema.safeParse({ type: "repair", repairs_so_far: -1 }).success).toBe(false);
    expect(RunCommandSchema.safeParse({ type: "resume", to: "nowhere" }).success).toBe(false);
    expect(RunCommandSchema.safeParse({ type: "fail", reason: "" }).success).toBe(false);
  });
});
