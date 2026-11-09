// Within-task statistics for one league run, for the record (TDM-229). The report compares
// setups task_paired over the tasks, so with one task every p is 1 by construction. Here, on the
// one task, each setup's trials vs the baseline's: the exact two-sample permutation test on the
// mean (bench permutationMeanTest), Mann-Whitney as a check (bench mannWhitney), Holm across the
// family (bench holmAdjust), and the smallest p each pair of n's can reach (bench minMannWhitneyP).
// Only setups whose every trial passed the correctness gate enter (plan.md: no speed or cost
// number without a correctness gate).
//
//   pnpm exec tsx scripts/spikes/harness-league/within-task-stats.ts <stats-input.json> [baseline]
//
// Input: { "<setup>": { "solved": bool[], "wall_s": number[], "cost_reported_micro_usd": int[],
//          "cost_claude_code_micro_usd": int[] } }
import { readFileSync } from "node:fs";
import {
  holmAdjust,
  mannWhitney,
  minMannWhitneyP,
  permutationMeanTest,
} from "../../../packages/bench/src/stats.js";

type Arm = {
  solved: boolean[];
  wall_s: number[];
  cost_reported_micro_usd: number[];
  cost_claude_code_micro_usd: number[];
};
const [file, baseline = "A solo"] = process.argv.slice(2);
if (!file) throw new Error("usage: within-task-stats.ts <stats-input.json> [baseline]");
const arms = JSON.parse(readFileSync(file, "utf8")) as Record<string, Arm>;
const base = arms[baseline];
if (!base) throw new Error(`no baseline '${baseline}'`);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

for (const family of [
  ["wall_s", "cost_reported_micro_usd"],
  ["wall_s", "cost_claude_code_micro_usd"],
] as const) {
  const rows: { setup: string; metric: string; n: string; ratio: number; p: number; mw: number; floor: number }[] = [];
  for (const [setup, arm] of Object.entries(arms)) {
    if (setup === baseline) continue;
    if (!arm.solved.every(Boolean)) {
      console.log(`skip ${setup}: ${arm.solved.filter((s) => !s).length} of ${arm.solved.length} trials have no passing gate`);
      continue;
    }
    for (const metric of family) {
      const x = arm[metric];
      const y = base[metric];
      rows.push({
        setup,
        metric,
        n: `${x.length} vs ${y.length}`,
        ratio: mean(x) / mean(y),
        p: permutationMeanTest(x, y).p,
        mw: mannWhitney(x, y).p,
        floor: minMannWhitneyP(x.length, y.length),
      });
    }
  }
  const holm = holmAdjust(rows.map((r) => r.p));
  console.log(`\nfamily: ${family.join(" + ")} (${rows.length} comparisons vs ${baseline}, Holm)`);
  console.log("setup          metric                        n       mean ratio  perm p   MW p     floor    Holm p");
  rows.forEach((r, i) =>
    console.log(
      `${r.setup.padEnd(14)} ${r.metric.padEnd(29)} ${r.n.padEnd(7)} ${r.ratio.toFixed(3).padStart(10)}  ` +
        `${r.p.toFixed(4)}   ${r.mw.toFixed(4)}   ${r.floor.toFixed(4)}   ${holm[i]!.toFixed(4)}`,
    ),
  );
}
