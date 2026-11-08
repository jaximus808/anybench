// E18: fixed-task inference. Each task's repeats are the unit (exact Mann–Whitney, Fisher for
// pass rates), Holm across every task × requirement test; results speak for their task only.
// A/A data (both arms from one generator) must call a per-task winner in at most α of runs, and
// a planted difference must be found. Kit: the real curated Tandem kit, cut to solo vs Tandem.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeParseKitSpec, type KitSpec } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DECISION_RULE,
  fisherExact,
  minRepeatsForPerTask,
  mulberry32,
  scoreKit,
  type KitScore,
  type TrialResult,
} from "../src/index.js";

const KIT_YAML_PT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../kits/tandem-vs-claude-code/anybench.yaml",
);
const BASE_PT = "claude-code-solo";
const CAND_PT = "tandem";

function kitPt(): KitSpec {
  const r = safeParseKitSpec(parse(readFileSync(KIT_YAML_PT, "utf8")));
  if (!r.success) throw new Error(r.errors.join("\n"));
  return {
    ...r.data,
    contenders: r.data.contenders.filter((c) => c.id === BASE_PT || c.id === CAND_PT),
    vary: { TANDEM_WORKERS: [3] },
  };
}

interface LiftPt {
  pass: number;
  /** Multiplies the candidate's wall time and cost. */
  speed: number;
}
const NONE_PT: LiftPt = { pass: 0, speed: 1 };

/** One run: per-task difficulty shared by both arms; gates as the kit's checks write them. */
function runPt(kit: KitSpec, repeats: number, seed: number, lift: LiftPt = NONE_PT): TrialResult[] {
  const rand = mulberry32(seed);
  const normal = () =>
    Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const out: TrialResult[] = [];
  for (const w of kit.workloads) {
    const p = 0.6 + 0.38 * rand();
    const wall = 600 + 1500 * rand();
    const cost = 500_000 + 1_500_000 * rand();
    for (const c of [BASE_PT, CAND_PT]) {
      const cand = c === CAND_PT;
      for (let repeat = 0; repeat < repeats; repeat++) {
        const pass = rand() < Math.min(0.99, p + (cand ? lift.pass : 0));
        const k = cand ? lift.speed : 1;
        const api = w.id === "todo-api";
        const metrics: Record<string, number> = {
          wall_s: Math.min(3600, wall * k * Math.exp(0.3 * normal())),
          cost_micro_usd: Math.round(cost * k * Math.exp(0.3 * normal())),
        };
        if (api && pass) metrics.api_p95_ms = 80 + 30 * rand();
        out.push({
          contenderId: c,
          workloadId: w.id,
          repeat,
          metrics,
          gates: {
            "hidden-tests": { pass, reason: pass ? "pass" : "fail", evidence: [] },
            "api-load": api
              ? { pass, reason: pass ? "p95 measured" : "tests failed", evidence: [] }
              : { pass: false, applicable: false, reason: "not applicable", evidence: [] },
          },
          reviews: pass ? { quality: 2 + Math.floor(2 * rand()) } : {},
        });
      }
    }
  }
  return out;
}

function taskVerdictsPt(ks: KitScore) {
  const cand = ks.contenders.find((c) => c.contenderId === CAND_PT)!;
  return cand.requirements.flatMap((q) =>
    q.scored ? q.byWorkload.flatMap((c) => (c.taskComparison ? [c.taskComparison] : [])) : [],
  );
}

describe("fisherExact", () => {
  it("matches R's fisher.test", () => {
    expect(fisherExact(5, 5, 0, 5)).toBeCloseTo(0.007937, 6); // fisher.test(matrix(c(5,0,0,5),2))
    expect(fisherExact(3, 4, 1, 4)).toBeCloseTo(0.4857, 4);
    expect(fisherExact(6, 6, 6, 6)).toBe(1);
    expect(fisherExact(7, 10, 2, 10)).toBeCloseTo(0.06978, 4);
  });
});

describe("per-task verdicts (E18)", () => {
  const kit = kitPt();

  it("5 repeats can't produce a per-task verdict across 13 tests; 6 can", () => {
    expect(minRepeatsForPerTask(13)).toBe(6);
    const ks = scoreKit(kit, runPt(kit, 5, 7, { pass: 0, speed: 0.3 }), { seed: 7 });
    expect(ks.stats.perTask!.family).toBe(13);
    expect(taskVerdictsPt(ks).every((c) => c.verdict === "indistinguishable")).toBe(true);
  });

  it("A/A at the head-to-head shape (3 tasks × 6 repeats): per-task FPR ≤ α", () => {
    let positives = 0;
    const seeds = 300;
    for (let s = 1; s <= seeds; s++) {
      const ks = scoreKit(kit, runPt(kit, 6, 0xe18 + s), { seed: s, iterations: 200 });
      if (taskVerdictsPt(ks).some((c) => c.verdict !== "indistinguishable")) positives++;
    }
    expect(positives / seeds).toBeLessThanOrEqual(DECISION_RULE.alpha);
  }, 120_000);

  it("A/A at the null pilot's shape (3 tasks × 10 repeats): per-task FPR ≤ α", () => {
    let positives = 0;
    const seeds = 200;
    for (let s = 1; s <= seeds; s++) {
      const ks = scoreKit(kit, runPt(kit, 10, 0x18a + s), { seed: s, iterations: 200 });
      if (taskVerdictsPt(ks).some((c) => c.verdict !== "indistinguishable")) positives++;
      expect(ks.stats.perTask!.headline).toEqual([]);
    }
    expect(positives / seeds).toBeLessThanOrEqual(DECISION_RULE.alpha);
  }, 120_000);

  it("control: a planted 2.5× speed-up (that also solves more) is found per task, and 'faster on all 3 tasks tested' leads", () => {
    let anyBetter = 0;
    let allTasks = 0;
    let example: KitScore | null = null;
    const seeds = 30;
    for (let s = 1; s <= seeds; s++) {
      const ks = scoreKit(kit, runPt(kit, 10, s, { pass: 0.3, speed: 0.4 }), {
        seed: s,
        iterations: 200,
      });
      if (taskVerdictsPt(ks).some((c) => c.verdict === "better")) anyBetter++;
      if (ks.stats.perTask!.headline.some((h) => h.requirementId === "wall")) {
        allTasks++;
        example ??= ks;
      }
      expect(taskVerdictsPt(ks).some((c) => c.verdict === "worse")).toBe(false);
    }
    expect(anyBetter / seeds).toBeGreaterThan(0.9);
    expect(allTasks / seeds).toBeGreaterThan(0.7);
    const pt = example!.stats.perTask!;
    expect(pt.headline.find((h) => h.requirementId === "wall")!.statement).toBe(
      "tandem was faster on all 3 tasks tested",
    );
    expect(pt.scope).toBe(
      "3 tasks: this doesn't generalise to other tasks; ≥8 tasks needed for a general claim.",
    );
    // Every per-task result speaks for its task only, with a CI and an MDE.
    for (const c of taskVerdictsPt(example!)) {
      expect(c.claim).toBe("these_tasks");
      expect(c.n.tasks).toBe(1);
      expect(c.test).not.toBe("task_paired");
    }
    // The general claim stays task-paired, and says why it can't conclude.
    const wall = example!.contenders
      .find((c) => c.contenderId === CAND_PT)!
      .requirements.find((q) => q.requirementId === "wall")!;
    expect(wall.scored && wall.comparison!.test).toBe("task_paired");
    expect(wall.scored && wall.verdict).toBe("indistinguishable");
    expect(wall.scored && wall.comparison!.statement).toMatch(
      /insufficient tasks for a general claim: the exact test over 3 tasks can't go below p=0\.250, ≥8 tasks needed/,
    );
  }, 120_000);

  it("software kits have no per-task section (their per-workload comparisons already are)", () => {
    const ks = scoreKit(
      { ...kit, subject: { ...kit.subject, kind: "software" } },
      runPt(kit, 6, 3),
    );
    expect(ks.stats.perTask ?? null).toBeNull();
  });
});
