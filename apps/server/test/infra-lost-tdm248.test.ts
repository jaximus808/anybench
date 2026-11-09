// TDM-248 [21.8]: a failed_subject trial whose workspace OUR runner lost (it stopped the subject at
// the token cap, the run's budget or the wall-clock cap, and nothing was frozen) is "not graded
// (infra)": left out of every requirement like failed_infra, never scored as 0, and the report and
// the trial view say so. Harness league run 1 (run 01a1c202) scored "Claude Code + subagents" 0%
// this way. A trial the runner froze (even empty), or one the subject ended itself, still counts.
import path from "node:path";
import type { FrozenWorkspace, KitSpec } from "@anybench/core";
import type { TrialGateRecord } from "@anybench/bench";
import { loadKit } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import { defaultKitsDir } from "../src/orchestrator/curated.js";
import type { StageTrial } from "../src/orchestrator/ports.js";
import { buildSummary, storedScoreOf, trialResultOf } from "../src/orchestrator/proof-score.js";
import { outcomeNoteOf } from "../src/routes/trials.js";

function recordTdm248(
  trialId: string,
  result: { pass: boolean; reason: string },
  metrics?: Record<string, number>,
): TrialGateRecord {
  return {
    version: 1,
    trial_id: trialId,
    workload_id: "project-tracker",
    scored_at: "2026-11-09T04:10:00.000Z",
    scoring_computer: null,
    sandbox: "uid",
    outputs_sha256: null,
    gates: {
      "hidden-tests": {
        result: { ...result, evidence: [], applicable: true },
        status: "verdict",
        exit_code: 0,
        timed_out: false,
        duration_ms: 1100,
        log_tail: "",
        kit_suspect: false,
        ...(metrics ? { metrics } : {}),
      },
    },
  };
}

const passTdm248 = (id: string) =>
  recordTdm248(
    id,
    { pass: true, reason: "120/120 hidden tests pass" },
    { hidden_test_fraction: 1, hidden_tests_passed: 120, hidden_tests_total: 120 },
  );

/** Run 01a1c202's B trials: the stale manifest counted the driver's 3 logs as the workspace. */
const LEGACY_GRADED_TDM248: FrozenWorkspace = {
  present: true,
  manifest: true,
  files: 6,
  workspace_files: 3,
  frozen_at: "2026-11-08T21:32:05.343Z",
  grading: "graded",
};
/** After TDM-248's frozen.ts: no workspace/ in the manifest, nothing to grade. */
const NONE_TDM248: FrozenWorkspace = {
  present: false,
  manifest: true,
  files: 6,
  workspace_files: 0,
  frozen_at: "2026-11-08T21:32:05.343Z",
  grading: "none",
  reason: "the manifest lists no workspace/ files",
};
/** The runner froze the workspace after its stop, and the subject had left it empty. */
const RUNNER_EMPTY_TDM248: FrozenWorkspace = { ...NONE_TDM248, runner_froze: true };

const NO_WS = { pass: false, reason: "the outputs have no workspace/" };

describe("a workspace our infra lost is not graded, never 0 (TDM-248)", async () => {
  const kit: KitSpec = (await loadKit(path.join(defaultKitsDir(), "tandem-long-horizon"))).spec;
  const w = kit.workloads[0]!.id;
  const [solo, other] = kit.contenders.map((c) => c.id) as [string, string];

  function trialTdm248(
    contender: string,
    repeat: number,
    over: Partial<StageTrial> = {},
  ): StageTrial {
    const id = `${contender}-${repeat}`;
    return {
      id,
      contender,
      contender_id: `0190f5a0-0000-7000-8000-0000002480${kit.contenders.findIndex((c) => c.id === contender)}`,
      workload_id: w,
      repeat,
      state: "done",
      attempt: 1,
      metrics: {
        wall_s: 3000,
        hidden_test_fraction: 1,
        hidden_tests_passed: 120,
        hidden_tests_total: 120,
      },
      gate: passTdm248(id),
      cost_micro_usd: 5_000_000n,
      failure_class: null,
      frozen_workspace: null,
      ...over,
    };
  }

  const lostLegacy = trialTdm248(other, 0, {
    state: "failed_subject",
    failure_class: "budget",
    metrics: { wall_s: 1100 },
    gate: recordTdm248(`${other}-0`, NO_WS),
    frozen_workspace: LEGACY_GRADED_TDM248,
  });
  const lostNone = trialTdm248(other, 1, {
    state: "failed_subject",
    failure_class: "wall_clock_exceeded",
    metrics: { wall_s: 1200 },
    gate: null,
    frozen_workspace: NONE_TDM248,
  });
  const frozenEmpty = trialTdm248(other, 2, {
    state: "failed_subject",
    failure_class: "budget",
    metrics: { wall_s: 1300 },
    gate: null,
    frozen_workspace: RUNNER_EMPTY_TDM248,
  });
  /** The subject's own driver exited non-zero and froze nothing: its fail, as before. */
  const subjectNone = trialTdm248(other, 3, {
    state: "failed_subject",
    failure_class: "run_failed",
    metrics: { wall_s: 1400 },
    gate: null,
    frozen_workspace: NONE_TDM248,
  });
  const trialsIn: StageTrial[] = [
    ...[0, 1, 2, 3].map((r) => trialTdm248(solo, r)),
    lostLegacy,
    lostNone,
    frozenEmpty,
    subjectNone,
    trialTdm248(other, 4),
  ];

  it("the scorer leaves an infra-lost trial out, like failed_infra", () => {
    expect(trialResultOf(lostLegacy)).toEqual({ ok: false, why: "infra_lost" });
    expect(trialResultOf(lostNone)).toEqual({ ok: false, why: "infra_lost" });
    expect(trialResultOf(frozenEmpty).ok).toBe(true);
    expect(trialResultOf(subjectNone).ok).toBe(true);

    const score = storedScoreOf(kit, trialsIn);
    expect(score.trials).toMatchObject({ scored: 7, infra: 0, infra_lost: 2 });
    const c = score.kit_score.contenders.find((x) => x.contenderId === other)!;
    const frac = c.requirements.find((r) => r.requirementId === "tests-fraction")!;
    if (!frac.scored) throw new Error(frac.reason);
    // The two lost trials are not zeros; the empty runner freeze and the driver's own fail are.
    expect(frac.byWorkload[0]!.samples).toEqual([0, 0, 1]);
    expect(c.gates["hidden-tests"]).toMatchObject({ failed: 2, total: 3 });
  });

  it("the report names each not-graded trial and why; the trial view says it too", () => {
    const score = storedScoreOf(kit, trialsIn);
    const built = buildSummary({ kit, score, proof: [], trials: trialsIn });
    if (!built.ok) throw new Error(built.reason);
    const { md, report } = built.analysis;
    const name = kit.contenders.find((x) => x.id === other)!.name;
    expect(md).toContain(
      "Left out of scoring: 0 warm-ups, 0 infra failures (ours), 2 not graded (infra: our runner lost the workspace), 0 cancelled.",
    );
    expect(md).toContain(
      "Not graded (infra) (2; left out of every requirement, never counted as 0, to run again):",
    );
    expect(md).toContain(
      `- ${name}, ${w} #1: stopped at the token cap; not graded (infra): our runner stopped it before its workspace was saved, so it is left out of scoring (not counted as 0) and has to run again`,
    );
    expect(md).toContain(`- ${name}, ${w} #2: stopped at the wall-clock cap; not graded (infra)`);
    // Still scored as failed trials.
    expect(md).toContain(
      `- ${name}, ${w} #3: stopped at the token cap; its workspace was frozen empty, counted as a fail`,
    );
    expect(md).toContain(
      `- ${name}, ${w} #4: its driver exited non-zero; no frozen workspace to grade, counted as a fail`,
    );
    expect(md).toMatch(/Stopped early \(2, scored as failed trials/);
    expect(report.failures.infra).toBe(2);
    expect(report.failures.subject).toBe(2);

    const row = {
      state: "failed_subject",
      metrics: { wall_s: 1100 },
      failureClass: "budget",
      frozenWorkspace: LEGACY_GRADED_TDM248,
      gate: lostLegacy.gate,
    } as unknown as Parameters<typeof outcomeNoteOf>[0];
    expect(outcomeNoteOf(row)).toMatch(/^stopped at the token cap; not graded \(infra\)/);
  });

  it("a score stored before TDM-248 (no infra_lost) still reads", () => {
    const score = storedScoreOf(
      kit,
      trialsIn.filter((t) => t.state === "done"),
    );
    const { infra_lost: _drop, ...old } = score.trials;
    const built = buildSummary({
      kit,
      score: { ...score, trials: old },
      proof: [],
      trials: trialsIn.filter((t) => t.state === "done"),
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.analysis.md).toContain(
      "Left out of scoring: 0 warm-ups, 0 infra failures (ours), 0 cancelled.",
    );
  });
});
