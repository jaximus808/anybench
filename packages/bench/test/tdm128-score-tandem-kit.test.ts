// TDM-128 [14.2]: the real kits/tandem-vs-claude-code requirements and weights, scored by
// scoreKit (TDM-53) on a small synthetic run shaped like the product page: 4 setups × 3 tasks × 5.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeParseKitSpec, type KitSpec } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { scoreKit, type ScoredContender, type TrialResult } from "../src/index.js";

const KIT_YAML_TDM128 = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../kits/tandem-vs-claude-code/anybench.yaml",
);

function kitTdm128(): KitSpec {
  const r = safeParseKitSpec(parse(readFileSync(KIT_YAML_TDM128, "utf8")));
  if (!r.success) throw new Error(r.errors.join("\n"));
  return r.data;
}

const WORKLOADS = ["todo-api", "auth-refactor", "bug-hunt"] as const;
type Workload = (typeof WORKLOADS)[number];

interface SetupTdm128 {
  id: string;
  /** Passing runs out of 5, per workload. */
  passes: Record<Workload, number>;
  wall_s: number;
  cost_micro_usd: number;
  api_p95_ms: number;
  quality: number;
}

/** Gate results the way gates/hidden-tests and gates/api-load write them. */
function trialsTdm128(s: SetupTdm128): TrialResult[] {
  const out: TrialResult[] = [];
  for (const w of WORKLOADS) {
    for (let repeat = 0; repeat < 5; repeat++) {
      const pass = repeat < s.passes[w];
      const api = w === "todo-api" && pass;
      const metrics: Record<string, number> = {
        wall_s: s.wall_s + repeat * 10,
        cost_micro_usd: s.cost_micro_usd + repeat * 1000,
        hidden_tests_passed: pass ? 1 : 0,
      };
      if (api) metrics.api_p95_ms = s.api_p95_ms + repeat;
      out.push({
        contenderId: s.id,
        workloadId: w,
        repeat,
        metrics,
        gates: {
          "hidden-tests": {
            pass,
            reason: pass ? "all hidden tests passed" : "some hidden tests failed",
            evidence: ["hidden-tests.json"],
          },
          "api-load": {
            pass: api,
            reason:
              w !== "todo-api"
                ? "not applicable"
                : api
                  ? "p95 measured"
                  : "no latency without correctness",
            evidence: [],
          },
        },
        reviews: pass ? { quality: s.quality } : {},
      });
    }
  }
  return out;
}

const A: SetupTdm128 = {
  id: "claude-code-solo",
  passes: { "todo-api": 3, "auth-refactor": 3, "bug-hunt": 4 },
  wall_s: 1500,
  cost_micro_usd: 3_900_000,
  api_p95_ms: 140,
  quality: 3,
};
const B: SetupTdm128 = {
  id: "claude-code-subagents",
  passes: { "todo-api": 3, "auth-refactor": 3, "bug-hunt": 4 },
  wall_s: 1320,
  cost_micro_usd: 5_200_000,
  api_p95_ms: 130,
  quality: 3,
};
const C: SetupTdm128 = {
  id: "tandem@TANDEM_WORKERS=3",
  passes: { "todo-api": 5, "auth-refactor": 2, "bug-hunt": 4 },
  wall_s: 780,
  cost_micro_usd: 4_900_000,
  api_p95_ms: 96,
  quality: 3,
};
const D: SetupTdm128 = {
  id: "tandem@TANDEM_WORKERS=5",
  passes: { "todo-api": 4, "auth-refactor": 1, "bug-hunt": 3 },
  wall_s: 720,
  cost_micro_usd: 7_100_000,
  api_p95_ms: 101,
  quality: 2,
};

describe("scoreKit on the tandem-vs-claude-code kit", () => {
  const kit = kitTdm128();
  const result = scoreKit(kit, [A, B, C, D].flatMap(trialsTdm128));
  const byId = (id: string) => result.contenders.find((c) => c.contenderId === id)!;

  it("scores all four setups between 0 and 100 and ranks Tandem ×3 first", () => {
    for (const c of result.contenders) {
      expect(c.scored, c.contenderId).toBe(true);
      const total = (c as ScoredContender).total;
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(100);
    }
    expect(result.ranking[0]).toBe("tandem@TANDEM_WORKERS=3");
    expect(result.ranking.indexOf("tandem@TANDEM_WORKERS=5")).toBeGreaterThan(0);
  });

  it("tests-pass is the share of passing trials (gate_pass_rate), averaged over the tasks", () => {
    const req = byId(C.id).requirements.find((r) => r.requirementId === "tests-pass")!;
    if (!req.scored) throw new Error("tests-pass should be scored");
    expect(req.byWorkload.map((w) => [w.workloadId, w.value])).toEqual([
      ["todo-api", 1],
      ["auth-refactor", 0.4],
      ["bug-hunt", 0.8],
    ]);
    expect(req.points).toBeCloseTo(50 * ((1 + 0.4 + 0.8) / 3), 6);
    expect(byId(C.id).gates["hidden-tests"]).toEqual({
      passed: 11,
      failed: 4,
      missing: 0,
      total: 15,
    });
  });

  it("api-p95 is scored on todo-api only, against the 'under 120 ms' target", () => {
    for (const c of result.contenders) {
      const req = c.requirements.find((r) => r.requirementId === "api-p95")!;
      if (!req.scored) throw new Error(`${c.contenderId}: api-p95 should be scored`);
      expect(req.byWorkload.map((w) => w.workloadId)).toEqual(["todo-api"]);
    }
    const c = byId(C.id).requirements.find((r) => r.requirementId === "api-p95")!;
    const a = byId(A.id).requirements.find((r) => r.requirementId === "api-p95")!;
    expect(c.points).toBe(10); // 96–100 ms meets the target
    expect(a.points).toBeLessThan(10); // ~141 ms misses it: 120 / 141 of the weight
    expect(a.points).toBeCloseTo(10 * (120 / 141), 6);
    // TDM-174: api-p95 is scoped to todo-api, so the other tasks' "not applicable" answers leave
    // the api-load tally instead of counting as 10 failures.
    expect(byId(C.id).gates["api-load"]).toEqual({ passed: 5, failed: 0, missing: 0, total: 5 });
    expect(byId(C.id).gatesNotApplicable["api-load"]).toBe(10);
  });

  it("cost is all spend ÷ solved tasks and wall time counts failures at the task's timeout", () => {
    const cost = byId(C.id).requirements.find((r) => r.requirementId === "cost")!;
    const wall = byId(C.id).requirements.find((r) => r.requirementId === "wall")!;
    if (!cost.scored || !wall.scored) throw new Error("cost and wall should be scored");
    expect(cost.aggregate).toBe("per_solved");
    expect(wall.aggregate).toBe("censored");
    // auth-refactor: C solves 2 of 5 and pays for all 5.
    const spend = [0, 1, 2, 3, 4].reduce((s, r) => s + C.cost_micro_usd + r * 1000, 0);
    const authCost = cost.byWorkload.find((w) => w.workloadId === "auth-refactor")!;
    expect(authCost).toMatchObject({ value: spend / 2, trials: 5, solved: 2, n: 5 });
    const authWall = wall.byWorkload.find((w) => w.workloadId === "auth-refactor")!;
    expect(authWall).toMatchObject({ cap: 3600, value: 3600, solved: 2 }); // 3 of 5 at the cap
  });

  it("a do-nothing setup scores 0 and ranks last (TDM-174: 0 cells, not a missing total)", () => {
    const noop: SetupTdm128 = {
      id: "do-nothing",
      passes: { "todo-api": 0, "auth-refactor": 0, "bug-hunt": 0 },
      wall_s: 1,
      cost_micro_usd: 0,
      api_p95_ms: 1,
      quality: 1,
    };
    const r = scoreKit(kit, [A, noop].flatMap(trialsTdm128));
    const c = r.contenders.find((x) => x.contenderId === "do-nothing")!;
    expect(c).toMatchObject({ scored: true, total: 0 });
    expect(r.ranking).toEqual(["claude-code-solo", "do-nothing"]);
  });
});
