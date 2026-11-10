// TDM-251 [21.11]: a single-task kit's report leads with WITHIN-task verdicts. Harness league
// run 1 (run 01a1c202, one task) compared setups only task_paired over tasks, so its answer said
// "the exact test over 1 task can't go below p=1.000" for every setup. Now each setup vs solo is
// the exact two-sample permutation test on the task's trials, Holm across the family, with the
// floor at these n's and "on this task only; no general claim from 1 task". These are that run's
// per-trial values (docs/findings/harness-league-run-1.md); B's 3 trials are infra-lost (TDM-248)
// and stay out.
import path from "node:path";
import { ReportSchema, type FrozenWorkspace, type KitSpec } from "@anybench/core";
import { loadKit } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import {
  CURATED_HARNESS_LEAGUE_KIT,
  defaultKitsDir,
  LEAGUE_V1_WORKLOAD,
  leagueProfile,
} from "../src/orchestrator/curated.js";
import type { StageTrial } from "../src/orchestrator/ports.js";
import { buildSummary, storedScoreOf } from "../src/orchestrator/proof-score.js";

/** [wall_s, cost micro-USD (compute share + metered tokens)] per trial, run 01a1c202. */
const RUN_01A1C202: Record<string, [number, number][]> = {
  "claude-code-solo": [
    [642.446, 2625662],
    [630.258, 2657213],
    [701.467, 2939402],
    [652.07, 2513841],
  ],
  gstack: [
    [664.573, 2788141],
    [653.856, 2798629],
    [720.227, 2696436],
    [625.482, 2421832],
    [695.648, 2986190],
  ],
  superpowers: [
    [646.02, 2857636],
    [704.697, 2944093],
    [622.406, 2694169],
    [651.233, 2581673],
  ],
  tandem: [
    [1267.814, 17135140],
    [1615.147, 21390834],
    [1337.608, 13712507],
  ],
};

/** TDM-248: B's trials, stopped by the stale runner's meter with no workspace frozen. */
const LOST_TDM251: FrozenWorkspace = {
  present: false,
  manifest: true,
  files: 6,
  workspace_files: 0,
  frozen_at: "2026-11-09T21:32:05.343Z",
  grading: "none",
  reason: "the manifest lists no workspace/ files",
};

const idOf251 = (kit: KitSpec, c: string) =>
  `0190f5a0-0000-7000-8000-0000002510${kit.contenders.findIndex((k) => k.id === c)}0`;

function trials251(kit: KitSpec): StageTrial[] {
  const out: StageTrial[] = [];
  for (const [c, rows] of Object.entries(RUN_01A1C202)) {
    rows.forEach(([wall, cost], repeat) =>
      out.push({
        id: `${c}-${repeat}`,
        contender: c,
        contender_id: idOf251(kit, c),
        workload_id: LEAGUE_V1_WORKLOAD,
        repeat,
        state: "done",
        attempt: 1,
        metrics: {
          wall_s: wall,
          // The league's cost basis (TDM-246): compute + the attempt's metered model tokens.
          byok_token_cost_micro_usd: cost,
          hidden_test_fraction: 1,
          hidden_tests_passed: 120,
          hidden_tests_total: 120,
        },
        gate: { "hidden-tests": { pass: true, reason: "120/120 hidden tests pass", evidence: [] } },
        cost_micro_usd: 0n,
        failure_class: null,
        frozen_workspace: null,
      }),
    );
  }
  for (let repeat = 0; repeat < 3; repeat++)
    out.push({
      id: `claude-code-subagents-${repeat}`,
      contender: "claude-code-subagents",
      contender_id: idOf251(kit, "claude-code-subagents"),
      workload_id: LEAGUE_V1_WORKLOAD,
      repeat,
      state: "failed_subject",
      attempt: 1,
      metrics: { wall_s: 900 },
      gate: null,
      cost_micro_usd: 0n,
      failure_class: "budget",
      frozen_workspace: LOST_TDM251,
    });
  return out;
}

async function league251(requirements?: string[]): Promise<KitSpec> {
  const full = (await loadKit(path.join(defaultKitsDir(), CURATED_HARNESS_LEAGUE_KIT))).spec;
  const r = leagueProfile(full, { workloads: [LEAGUE_V1_WORKLOAD], repeats: 5 });
  if (!r.ok) throw new Error(r.reason);
  if (!requirements) return r.spec;
  const reqs = r.spec.requirements.filter((q) => requirements.includes(q.id));
  return {
    ...r.spec,
    requirements: reqs,
    scoring: {
      ...r.spec.scoring,
      primary: reqs[0]!.id,
      weights: Object.fromEntries(reqs.map((q) => [q.id, 100 / reqs.length])),
    },
  };
}

async function summary251(requirements?: string[]) {
  const kit = await league251(requirements);
  const trials = trials251(kit);
  const score = storedScoreOf(kit, trials);
  const r = buildSummary({ kit, score, proof: [], trials });
  if (!r.ok) throw new Error(r.reason);
  return { kit, score, ...r.analysis };
}

describe("single-task report: within-task verdicts lead (TDM-251)", () => {
  it("wall + cost (TDM-229's family of 6): Tandem p=0.029, Holm 0.171; the answer leads with it", async () => {
    const { report, md, score } = await summary251(["wall", "cost"]);
    expect(score.trials).toMatchObject({ scored: 16, infra_lost: 3 });
    expect(score.kit_score.stats.singleTask).toBe(true);
    expect(report.answer).toMatch(
      /^Within this task \(project-tracker\), each setup vs A · Claude Code solo by exact two-sample tests on the trials' values, Holm-corrected across 6 tests: /,
    );
    expect(report.answer).toContain(
      "D · Tandem ×3: no detectable difference at n=3 vs 4 (closest: wall, exact permutation p=0.029, Holm p=0.171; no result at these n's could pass Holm: its floor here is p=0.114)",
    );
    expect(report.answer).toContain(
      "G · Claude Code + gstack: no detectable difference at n=5 vs 4 (closest: wall, exact permutation p=0.508, Holm p=1.000)",
    );
    expect(report.answer).toContain(
      "S · Claude Code + Superpowers: no detectable difference at n=4 vs 4 (closest: cost, exact permutation p=0.543, Holm p=1.000;",
    );
    expect(report.answer).toMatch(
      /On this task only \(project-tracker\); no general claim from 1 task: ≥\d+ tasks needed for one\./,
    );
    expect(report.answer).not.toMatch(/can't go below p=1\.000|insufficient tasks|over 1 task/);

    const tandem = report.contenders.find((c) => c.name === "D · Tandem ×3")!;
    for (const id of ["wall", "cost"]) {
      const cmp = tandem.requirements.find((r) => r.requirement_id === id)!.comparison!;
      expect(cmp).toMatchObject({ test: "permutation_exact", claim: "these_tasks", family: 6 });
      expect(cmp.p).toBeCloseTo(0.0286, 4);
      expect(cmp.p_adjusted).toBeCloseTo(0.1714, 4);
      expect(cmp.p_floor).toBeCloseTo(1 / 35, 12);
      expect(cmp.p_adjusted_floor).toBeCloseTo(4 / 35, 12);
      expect(cmp.effect.value).toBe(-1);
    }
    const wall = tandem.requirements.find((r) => r.requirement_id === "wall")!.comparison!;
    expect(wall.effect.candidate_mean! / wall.effect.baseline_mean!).toBeCloseTo(2.143, 3);
    expect(report.per_task).toMatchObject({ tasks: ["project-tracker"], family: 6, headline: [] });
    // The markdown: the verdict lines are the task's; no task-paired line, no second copy.
    expect(md).toContain(
      "Verdict on project-tracker only, tandem vs claude-code-solo: no detectable difference at n=3 vs 4",
    );
    expect(md).not.toContain("Per task (");
    expect(
      ReportSchema.safeParse({
        ...report,
        run_id: "0190f5a0-0000-7000-8000-000000025101",
        kit_id: null,
        comped: true,
      }).success,
    ).toBe(true);
  });

  it("the league kit as preregistered: every requirement within the task, Holm across 15", async () => {
    const { report } = await summary251();
    // tests-pass, tests-fraction, wall, cost, cost-per-test × G, S, D (quality has no reviews).
    expect(report.per_task!.family).toBe(15);
    expect(report.answer).toMatch(/^Within this task \(project-tracker\)/);
    expect(report.answer).toContain("Holm-corrected across 15 tests");
    expect(report.answer).toContain(
      "D · Tandem ×3: no detectable difference at n=3 vs 4 (closest: wall",
    );
    expect(report.answer).toContain("On this task only (project-tracker)");
    expect(report.answer).not.toMatch(/can't go below p=1\.000|insufficient tasks|over 1 task/);
    for (const c of report.contenders) {
      for (const r of c.requirements) {
        if (r.comparison) expect(r.comparison.test, r.requirement_id).not.toBe("task_paired");
      }
    }
    // Every trial passed 120/120: Fisher on full passes and the fraction's permutation are p=1.
    const tandem = report.contenders.find((c) => c.name === "D · Tandem ×3")!;
    const pass = tandem.requirements.find((r) => r.requirement_id === "tests-pass")!.comparison!;
    expect(pass).toMatchObject({ test: "fisher_exact", p: 1 });
  });

  it("a planted 2× slowdown at 5 vs 5 is a verdict on this task, named in the answer", async () => {
    const kit = await league251(["wall", "cost"]);
    const two: KitSpec = {
      ...kit,
      contenders: kit.contenders.filter((c) => c.id === "claude-code-solo" || c.id === "tandem"),
    };
    const trials: StageTrial[] = [];
    for (const c of ["claude-code-solo", "tandem"]) {
      for (let repeat = 0; repeat < 5; repeat++) {
        const k = c === "tandem" ? 2 : 1;
        trials.push({
          id: `${c}-${repeat}`,
          contender: c,
          contender_id: idOf251(two, c),
          workload_id: LEAGUE_V1_WORKLOAD,
          repeat,
          state: "done",
          attempt: 1,
          metrics: {
            wall_s: (640 + 10 * repeat) * k,
            byok_token_cost_micro_usd: (2_600_000 + 50_000 * repeat) * k,
            hidden_test_fraction: 1,
          },
          gate: { "hidden-tests": { pass: true, reason: "120/120", evidence: [] } },
          cost_micro_usd: 0n,
          failure_class: null,
          frozen_workspace: null,
        });
      }
    }
    const r = buildSummary({ kit: two, score: storedScoreOf(two, trials), proof: [], trials });
    if (!r.ok) throw new Error(r.reason);
    expect(r.analysis.report.answer).toContain(
      "D · Tandem ×3 was slower and more expensive (wall Holm p=0.016, cost Holm p=0.016)",
    );
    const tandem = r.analysis.report.contenders.find((c) => c.name === "D · Tandem ×3")!;
    expect(tandem.losses).toEqual(["wall", "cost"]);
    expect(r.analysis.md).toMatch(
      /Verdict on project-tracker only, tandem vs claude-code-solo: worse on this task: Cliff's δ −1\.00, mean 1320 s vs 660 s \(2\.00×\)/,
    );
  });
});
