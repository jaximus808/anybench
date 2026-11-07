import { describe, expect, it } from "vitest";
import {
  TRIAL_MAX_INFRA_RETRIES,
  TRIAL_STATES,
  TRIAL_TRANSITIONS,
  TrialCommandSchema,
  isBillableTrialState,
  isLegalTrialEdge,
  transitionTrial,
  trialRetryDelayMs,
  type TrialCommand,
  type TrialCommandType,
  type TrialState,
} from "../src/index.js";

function tdm8TrialCommand(type: TrialCommandType): TrialCommand {
  switch (type) {
    case "advance":
    case "skip_review":
    case "cancel":
      return { type };
    case "fail_infra":
    case "fail_subject":
      return { type, reason: "x" };
    case "retry":
      return { type, attempt: 1 };
  }
}

function expectTo(from: TrialState, cmd: TrialCommand, to: TrialState) {
  expect(transitionTrial(from, cmd), `${from} --${cmd.type}--> ${to}`).toEqual({
    ok: true,
    from,
    to,
    command: cmd,
  });
}

function expectError(from: TrialState, cmd: TrialCommand, code: string) {
  const r = transitionTrial(from, cmd);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatchObject({ code, from, command: cmd.type });
}

const happyPath: [TrialState, TrialState][] = [
  ["queued", "forking"],
  ["forking", "installing"],
  ["installing", "warming"],
  ["warming", "running"],
  ["running", "collecting"],
  ["collecting", "gating"],
  ["gating", "reviewing"],
  ["reviewing", "done"],
];
const live: TrialState[] = happyPath.map(([from]) => from);
const subjectOnMachine: TrialState[] = [
  "installing",
  "warming",
  "running",
  "collecting",
  "gating",
  "reviewing",
];

describe("trial state machine: legal transitions", () => {
  it.each(happyPath)("%s --advance--> %s", (from, to) => expectTo(from, { type: "advance" }, to));

  it("gating can skip review", () => expectTo("gating", { type: "skip_review" }, "done"));

  it.each(live)("%s can fail_infra and be cancelled", (s) => {
    expectTo(
      s,
      { type: "fail_infra", reason: "lease expired", failure_class: "lease" },
      "failed_infra",
    );
    expectTo(s, { type: "cancel" }, "cancelled");
  });

  it.each(subjectOnMachine)("%s can fail_subject", (s) => {
    expectTo(s, { type: "fail_subject", reason: "exit 1" }, "failed_subject");
  });

  it("failed_infra retries back to queued for attempts 1..max", () => {
    for (let attempt = 1; attempt <= TRIAL_MAX_INFRA_RETRIES; attempt++) {
      expectTo("failed_infra", { type: "retry", attempt }, "queued");
    }
  });

  it("failed_infra can be cancelled while waiting to retry", () => {
    expectTo("failed_infra", { type: "cancel", reason: "run cancelled" }, "cancelled");
  });

  it("every edge in TRIAL_TRANSITIONS is reachable through transitionTrial", () => {
    let edges = 0;
    for (const from of TRIAL_STATES) {
      for (const [type, to] of Object.entries(TRIAL_TRANSITIONS[from])) {
        expectTo(from, tdm8TrialCommand(type as TrialCommandType), to);
        expect(isLegalTrialEdge(from, to)).toBe(true);
        edges++;
      }
    }
    // 8 advance + 1 skip_review + 6 fail_subject + 8 fail_infra + 8 cancel + retry + cancel from failed_infra
    expect(edges).toBe(8 + 1 + 6 + 8 + 8 + 1 + 1);
  });
});

describe("trial state machine: illegal transitions", () => {
  it.each(["done", "failed_subject", "cancelled"] as TrialState[])("%s is terminal", (s) => {
    for (const type of ["advance", "retry", "cancel", "fail_infra"] as TrialCommandType[]) {
      expectError(s, tdm8TrialCommand(type), "terminal_state");
    }
  });

  it("only failed_infra retries, and only up to the max", () => {
    expectError(
      "failed_infra",
      { type: "retry", attempt: TRIAL_MAX_INFRA_RETRIES + 1 },
      "retry_exhausted",
    );
    expectError("running", { type: "retry", attempt: 1 }, "illegal_transition");
  });

  it.each<[TrialState, TrialCommand]>([
    ["queued", { type: "fail_subject", reason: "x" }],
    ["forking", { type: "fail_subject", reason: "x" }],
    ["running", { type: "skip_review" }],
    ["reviewing", { type: "skip_review" }],
    ["failed_infra", { type: "advance" }],
    ["failed_infra", { type: "fail_infra", reason: "again" }],
  ])("%s rejects %o", (s, cmd) => expectError(s, cmd, "illegal_transition"));

  it("isLegalTrialEdge rejects skipped phases", () => {
    expect(isLegalTrialEdge("queued", "running")).toBe(false);
    expect(isLegalTrialEdge("done", "queued")).toBe(false);
  });
});

describe("trial helpers", () => {
  it("bills done and failed_subject only", () => {
    expect(TRIAL_STATES.filter(isBillableTrialState)).toEqual(["done", "failed_subject"]);
  });

  it("backs off exponentially", () => {
    expect([1, 2, 3].map(trialRetryDelayMs)).toEqual([30_000, 60_000, 120_000]);
  });

  it("TrialCommandSchema validates commands", () => {
    expect(TrialCommandSchema.parse({ type: "retry", attempt: 2 })).toEqual({
      type: "retry",
      attempt: 2,
    });
    expect(TrialCommandSchema.safeParse({ type: "retry", attempt: 0 }).success).toBe(false);
    expect(TrialCommandSchema.safeParse({ type: "fail_infra" }).success).toBe(false);
    expect(TrialCommandSchema.safeParse({ type: "explode" }).success).toBe(false);
  });
});
