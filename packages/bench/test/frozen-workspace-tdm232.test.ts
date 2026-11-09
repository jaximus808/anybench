// TDM-232 [18.11]: a failed_subject trial (stopped at a cap, or its driver exited non-zero) whose
// attempt froze a workspace is graded on it. The frozen-workspace fact comes from the runner's
// manifest.json, and the scorer counts such a trial as FAILED for every gate (gate_pass_rate,
// wall at the cap, cost against the solves) while its graded hidden-test fraction counts as
// partial work. A subject failure with nothing graded is a fail, never "gate missing". Infra
// failures never reach the scorer (left out upstream), unchanged.
import { RequirementSchema, subjectFailureNote, subjectStopWords } from "@anybench/core";
import { describe, expect, it } from "vitest";
import {
  frozenWorkspaceFromManifest,
  gradesFrozenWorkspace,
  scoreKit,
  type ScoreKitInput,
  type ScoredRequirement,
  type TrialResult,
} from "../src/index.js";

const req = (r: unknown) => RequirementSchema.parse(r);

const REQS_TDM232 = [
  req({
    id: "tests-fraction",
    type: "measured",
    title: "share of hidden tests passed",
    metric: "hidden_test_fraction",
    better: "higher",
    gate_id: "hidden-tests",
  }),
  req({
    id: "tests-pass",
    type: "measured",
    title: "every hidden test passed",
    metric: "gate_pass_rate",
    better: "higher",
    gate_id: "hidden-tests",
  }),
  req({
    id: "wall",
    type: "measured",
    title: "time to solve",
    metric: "wall_s",
    unit: "s",
    better: "lower",
    gate_id: "hidden-tests",
    cap: 10_800,
  }),
  req({
    id: "cost",
    type: "measured",
    title: "cost per solved task",
    metric: "cost_micro_usd",
    better: "lower",
    gate_id: "hidden-tests",
  }),
];

const KIT_TDM232: ScoreKitInput = {
  requirements: REQS_TDM232,
  scoring: {
    weights: { "tests-fraction": 40, "tests-pass": 30, wall: 20, cost: 10 },
    primary: "tests-fraction",
  },
  subject: { kind: "harness" },
};

let repeatTdm232 = 0;
function trialTdm232(
  c: string,
  o: {
    passed?: number;
    wall?: number;
    cost?: number;
    failedSubject?: boolean;
    ungraded?: boolean;
    gatePass?: boolean;
  },
): TrialResult {
  const total = 120;
  const passed = o.passed ?? total;
  const pass = o.gatePass ?? passed === total;
  return {
    contenderId: c,
    workloadId: "project-tracker",
    repeat: repeatTdm232++,
    metrics: {
      wall_s: o.wall ?? 3600,
      cost_micro_usd: o.cost ?? 10_000_000,
      ...(o.ungraded
        ? {}
        : {
            hidden_test_fraction: passed / total,
            hidden_tests_passed: passed,
            hidden_tests_total: total,
          }),
    },
    gates: o.ungraded
      ? {}
      : {
          "hidden-tests": { pass, reason: `${passed}/${total}`, evidence: [] },
        },
    ...(o.failedSubject ? { failedSubject: true as const } : {}),
  };
}

const scored = (s: ReturnType<typeof scoreKit>, c: string, id: string): ScoredRequirement => {
  const r = s.contenders
    .find((x) => x.contenderId === c)!
    .requirements.find((x) => x.requirementId === id)!;
  if (!r.scored) throw new Error(`${c}/${id} unscored: ${r.reason}`);
  return r;
};

describe("frozen workspace fact (TDM-232)", () => {
  it("a manifest with workspace files is present and pending; runner-only files or none are not", () => {
    const manifest = {
      trial_id: "t",
      attempt: 2,
      frozen_at: "2026-11-09T04:00:00.000Z",
      files: [
        { path: "stdout.log" },
        { path: "stderr.log" },
        { path: "machine.json" },
        { path: "workspace/src/app.ts" },
        { path: "stream.jsonl" },
      ],
    };
    expect(frozenWorkspaceFromManifest(manifest, 2)).toEqual({
      present: true,
      manifest: true,
      files: 5,
      workspace_files: 2,
      frozen_at: "2026-11-09T04:00:00.000Z",
      grading: "pending",
    });
    const runnerOnly = { ...manifest, files: manifest.files.slice(0, 3) };
    expect(frozenWorkspaceFromManifest(runnerOnly, 2)).toMatchObject({
      present: false,
      manifest: true,
      files: 3,
      workspace_files: 0,
      grading: "none",
    });
    expect(frozenWorkspaceFromManifest(null, 1)).toMatchObject({
      present: false,
      manifest: false,
      grading: "none",
      reason: "no manifest.json for this attempt",
    });
    // Another attempt's manifest is not this attempt's freeze.
    expect(frozenWorkspaceFromManifest(manifest, 3)).toMatchObject({
      present: false,
      grading: "none",
    });
    expect(frozenWorkspaceFromManifest({ files: "nope" }, 1).present).toBe(false);
  });

  it("only a failed_subject trial with a pending frozen workspace is graded after it ends", () => {
    const pending = frozenWorkspaceFromManifest({ files: [{ path: "workspace/a" }] }, 1);
    expect(gradesFrozenWorkspace({ state: "failed_subject", frozen_workspace: pending })).toBe(
      true,
    );
    expect(
      gradesFrozenWorkspace({
        state: "failed_subject",
        frozen_workspace: { ...pending, grading: "graded" },
      }),
    ).toBe(false);
    expect(
      gradesFrozenWorkspace({
        state: "failed_subject",
        frozen_workspace: frozenWorkspaceFromManifest(null, 1),
      }),
    ).toBe(false);
    expect(gradesFrozenWorkspace({ state: "failed_subject", frozen_workspace: null })).toBe(false);
    expect(gradesFrozenWorkspace({ state: "failed_infra", frozen_workspace: pending })).toBe(false);
    expect(gradesFrozenWorkspace({ state: "done", frozen_workspace: pending })).toBe(false);
  });

  it("says what happened in words", () => {
    const fw = frozenWorkspaceFromManifest({ files: [{ path: "workspace/a" }] }, 1);
    expect(
      subjectFailureNote({
        failureClass: "budget",
        frozen: { ...fw, grading: "graded" },
        hiddenTestsPassed: 87,
        hiddenTestsTotal: 120,
      }),
    ).toBe("stopped at the token cap; graded on its frozen workspace (87 of 120 hidden tests)");
    expect(
      subjectFailureNote({
        failureClass: "wall_clock_exceeded",
        frozen: { ...fw, grading: "graded" },
        hiddenTestFraction: 0.5,
      }),
    ).toBe("stopped at the wall-clock cap; graded on its frozen workspace (hidden tests 50%)");
    expect(subjectFailureNote({ failureClass: "run_failed", frozen: fw })).toBe(
      "its driver exited non-zero; grading its frozen workspace",
    );
    expect(subjectFailureNote({ failureClass: "healthcheck_failed", frozen: null })).toBe(
      "its healthcheck failed; no frozen workspace to grade, counted as a fail",
    );
    expect(
      subjectFailureNote({
        failureClass: "budget",
        frozen: { ...fw, grading: "unavailable", reason: "no frozen outputs" },
      }),
    ).toContain("could not be graded (our scoring failed: no frozen outputs)");
    expect(subjectStopWords("something_new")).toBe("failed (something_new)");
  });
});

describe("scoring a run with a graded failed_subject trial (TDM-232)", () => {
  it("is a valid score with no 'gate missing': the capped trial's fraction counts, it fails the gate", () => {
    const trials = [
      trialTdm232("solo", { wall: 1000, cost: 3_000_000 }),
      trialTdm232("solo", { wall: 1200, cost: 3_000_000 }),
      // Stopped at the token cap at 2 h with 87/120 hidden tests passing on its frozen workspace.
      trialTdm232("solo", { passed: 87, wall: 7200, cost: 25_000_000, failedSubject: true }),
      trialTdm232("tandem", { wall: 2000, cost: 9_000_000 }),
      trialTdm232("tandem", { wall: 2200, cost: 9_000_000 }),
      trialTdm232("tandem", { passed: 110, wall: 4000, cost: 9_000_000 }),
    ];
    const s = scoreKit(KIT_TDM232, trials);
    for (const c of s.contenders) {
      expect(c.scored, `${c.contenderId}: ${c.scored ? "" : c.reason}`).toBe(true);
      for (const r of c.requirements) expect(r.scored).toBe(true);
    }
    expect(s.contenders.find((c) => c.contenderId === "solo")!.gates["hidden-tests"]).toEqual({
      passed: 2,
      failed: 1,
      missing: 0,
      total: 3,
    });
    // Partial work counts: (1 + 1 + 87/120) / 3.
    const frac = scored(s, "solo", "tests-fraction").byWorkload[0]!;
    expect(frac.samples).toEqual([1, 1, 87 / 120]);
    expect(frac.value).toBeCloseTo((2 + 87 / 120) / 3, 10);
    // gate_pass_rate counts it as a fail.
    expect(scored(s, "solo", "tests-pass").byWorkload[0]!.value).toBeCloseTo(2 / 3, 10);
    // Wall: the failed trial at the cap, never its own 7200 s.
    expect(scored(s, "solo", "wall").byWorkload[0]!.samples).toEqual([1000, 1200, 10_800]);
    // Cost: all spend ÷ solves (31 M over 2 solves), integer micro-USD.
    expect(scored(s, "solo", "cost").byWorkload[0]!.value).toBe(15_500_000);
  });

  it("a failed_subject trial is a fail even when its frozen workspace passed every hidden test", () => {
    const trials = [
      trialTdm232("solo", { passed: 120, gatePass: true, failedSubject: true, wall: 900 }),
      trialTdm232("solo", { wall: 1000 }),
    ];
    const s = scoreKit({ ...KIT_TDM232, subject: { kind: "software" } }, trials);
    expect(scored(s, "solo", "tests-pass").byWorkload[0]!.value).toBe(0.5);
    expect(scored(s, "solo", "tests-fraction").byWorkload[0]!.samples).toEqual([1, 1]);
    expect(scored(s, "solo", "wall").byWorkload[0]!.samples).toEqual([10_800, 1000]);
  });

  it("a subject failure with nothing graded is a fail with no partial credit, never 'gate missing'", () => {
    const trials = [
      trialTdm232("solo", { wall: 1000 }),
      trialTdm232("solo", { ungraded: true, failedSubject: true }),
      trialTdm232("tandem", { wall: 2000 }),
    ];
    const s = scoreKit(KIT_TDM232, trials);
    for (const c of s.contenders) expect(c.scored).toBe(true);
    expect(scored(s, "solo", "tests-fraction").byWorkload[0]!.samples).toEqual([1, 0]);
    expect(s.contenders.find((c) => c.contenderId === "solo")!.gates["hidden-tests"]).toEqual({
      passed: 1,
      failed: 1,
      missing: 0,
      total: 2,
    });
    // Alone on its workload it still makes the gate apply (no graded evidence says otherwise).
    const alone = scoreKit(KIT_TDM232, [
      trialTdm232("solo", { ungraded: true, failedSubject: true }),
    ]);
    expect(alone.contenders[0]!.scored).toBe(true);
    expect(scored(alone, "solo", "tests-pass").byWorkload[0]!.value).toBe(0);
  });

  it("unchanged: a trial without the gate's result that is not a subject failure is still 'gate missing'", () => {
    const trials = [trialTdm232("solo", { wall: 1000 }), trialTdm232("solo", { ungraded: true })];
    const s = scoreKit(KIT_TDM232, trials);
    const solo = s.contenders[0]!;
    expect(solo.scored).toBe(false);
    expect(solo.scored ? null : solo.reason).toBe("no score: gate missing");
  });
});
