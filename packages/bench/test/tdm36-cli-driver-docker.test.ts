// TDM-36 [4.4] done condition: the cli example kit (packages/kit/examples/cli) runs on
// docker-local through the runner stub. The honest contender and the oracle pass the
// output-diff gate; both do-less variants fail it with a clear reason. Collector rows come back
// stamped with the gate, and scoreKit (v2) counts the cheats' failed trials against them: 0/2 on
// the gate tally, wall_s at the cap, ranked below both honest contenders.
//
// Two computers, as in production: the subject computer gets the contender's adapter and the
// workload input only; a separate scoring computer gets the gate, its reference and the frozen
// outputs, and runs check.sh as its own process. Needs network on first run (apt for GNU time,
// GitHub for hyperfine and ripgrep). Skips cleanly when no Docker daemon answers. Containers carry
// a per-run label and are removed in afterAll, which fails the file if anything leaked.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRecipes } from "@anybench/envs";
import {
  CLI_OUTPUT_PATHS,
  loadKit,
  parseGateResult,
  planCliStubGate,
  planCliStubTrial,
  readCliCollectorOutputs,
  type CliStubFile,
  type LoadedKit,
} from "@anybench/kit";
import { DockerLocalProvider, dockerLocalAvailable, trialTag } from "@anybench/providers";
import type { GateResult } from "@anybench/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COLLECTOR_OUTPUT_FILES,
  collect,
  scoreKit,
  trialMetricRecord,
  type Metric,
  type TrialResult,
} from "../src/index.js";

const available = await dockerLocalAvailable();
const NS_LABEL = "anybench.test-tdm36";
const ns = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const EXAMPLE_TDM36 = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../kit/examples/cli",
);

/** One stub trial: a contender, optionally under a proof overlay, on one workload. */
interface CaseTdm36 {
  label: string;
  contender: string;
  overlay?: string;
}
const CASES_TDM36: CaseTdm36[] = [
  { label: "gnu-grep", contender: "gnu-grep", overlay: "grep-reference" },
  { label: "ripgrep", contender: "ripgrep" },
  { label: "ripgrep+truncated-output", contender: "ripgrep", overlay: "truncated-output" },
  { label: "ripgrep+first-match-only", contender: "ripgrep", overlay: "first-match-only" },
];

interface OutcomeTdm36 {
  label: string;
  workload: string;
  runExit: number;
  runStderr: string;
  gate: GateResult;
  gateDiff: string;
  metrics: Metric[];
  collectErrors: string[];
}

it("cli collector paths match the ones bench reads", () => {
  expect(CLI_OUTPUT_PATHS.time).toBe(COLLECTOR_OUTPUT_FILES.time);
  expect(CLI_OUTPUT_PATHS.hyperfine).toBe(COLLECTOR_OUTPUT_FILES.hyperfine);
});

describe.skipIf(!available)("examples/cli on docker-local (runner stub)", () => {
  const p = new DockerLocalProvider({ labels: { [NS_LABEL]: ns } });
  let kit: LoadedKit;
  let subjectId = "";
  let scoringId = "";
  let home = "";
  let recipeEnv: Record<string, string> = {};
  let localDir = "";
  const outcomes: OutcomeTdm36[] = [];

  const put = async (id: string, root: string, files: readonly CliStubFile[]) => {
    for (const f of files) await p.putFile(id, `${root}/${f.to}`, f.content, { mode: f.mode });
  };
  const sh = async (id: string, cmd: string, timeoutMs = 600_000) => {
    const r = await p.exec(id, cmd, { timeoutMs });
    return r;
  };

  beforeAll(async () => {
    kit = await loadKit(EXAMPLE_TDM36);
    localDir = await mkdtemp(path.join(tmpdir(), "tdm36-docker-"));
    const [s, g] = await Promise.all([
      p.create({ vcpu: 2, memoryMb: 2048, tags: [trialTag(ns, "subject")] }),
      p.create({ vcpu: 1, memoryMb: 512, tags: [trialTag(ns, "scoring")] }),
    ]);
    const [si, gi] = await Promise.all([
      p.waitReady(s.id, { timeoutMs: 600_000, intervalMs: 500 }),
      p.waitReady(g.id, { timeoutMs: 600_000, intervalMs: 500 }),
    ]);
    subjectId = si.id;
    scoringId = gi.id;
    home = si.home;

    // Snapshot build on the subject computer: the base profile's cli collectors, then L1 install.
    recipeEnv = (await runRecipes(p, subjectId, ["git-time", "hyperfine"])).env;
    for (const c of kit.contenders) {
      const dir = `${home}/install/${c.id}`;
      const plan = await planCliStubTrial(kit, c.id, kit.workloads[0]!.id, { root: dir });
      await put(subjectId, dir, plan.files);
      const inst = await sh(subjectId, `cd ${dir}/kit && bash ${c.install}`);
      expect(inst.exitCode, `${c.id} install: ${inst.stderr}`).toBe(0);
      if (c.healthcheck) {
        const hc = await sh(subjectId, `cd ${dir}/kit && bash ${c.healthcheck}`);
        expect(hc.exitCode, `${c.id} healthcheck: ${hc.stdout}${hc.stderr}`).toBe(0);
      }
    }

    // Every case on every workload: run on the subject computer, gate on the scoring computer.
    for (const c of CASES_TDM36) {
      for (const w of kit.workloads) {
        const name = `${c.label}.${w.id}`.replace(/[^a-z0-9.-]/g, "-");
        const root = `${home}/trials/${name}`;
        const trial = await planCliStubTrial(kit, c.contender, w.id, {
          root,
          ...(c.overlay ? { overlay: c.overlay } : {}),
          env: recipeEnv,
        });
        await put(subjectId, root, trial.files);
        const run = await sh(subjectId, `runuser -u naive -- ${trial.command}`, 300_000);
        const tar = await p.getFile(subjectId, trial.frozenTar);

        const local = path.join(localDir, name);
        await mkdir(local, { recursive: true });
        await writeFile(path.join(local, "frozen.tar"), tar);
        const x = spawnSync("tar", ["-xf", "frozen.tar"], { cwd: local, encoding: "utf8" });
        expect(x.status, x.stderr).toBe(0);
        const { inputs } = await readCliCollectorOutputs(local);
        const collected = collect(inputs, kit.spec.requirements);

        const sroot = `${home}/scoring/${name}`;
        const gate = await planCliStubGate(kit, "same-matches", w.id, { root: sroot });
        await put(scoringId, sroot, gate.files);
        await p.putFile(scoringId, gate.frozenTar, tar);
        const check = await sh(scoringId, gate.command, 120_000);
        expect(check.exitCode, `gate ${name}: ${check.stderr}`).toBe(0);
        const verdict = parseGateResult(
          new TextDecoder().decode(await p.getFile(scoringId, gate.gateJson)),
        );
        const diff = await p
          .getFile(scoringId, gate.gateDiff)
          .then((b) => new TextDecoder().decode(b))
          .catch(() => "");
        outcomes.push({
          label: c.label,
          workload: w.id,
          runExit: run.exitCode,
          runStderr: run.stderr,
          gate: verdict,
          gateDiff: diff,
          metrics: collected.metrics,
          collectErrors: collected.errors,
        });
      }
    }
    if (process.env.TDM36_DOCKER_LOG) {
      await writeFile(
        process.env.TDM36_DOCKER_LOG,
        JSON.stringify(
          outcomes.map((o) => ({
            label: o.label,
            workload: o.workload,
            runExit: o.runExit,
            gate: o.gate,
            wall_s: o.metrics.find((m) => m.name === "wall_s")?.value,
            peak_rss_bytes: o.metrics.find((m) => m.name === "peak_rss_bytes")?.value,
            hyperfine_median_s: o.metrics.find((m) => m.name === "hyperfine_median_s")?.value,
          })),
          null,
          2,
        ),
      );
    }
  }, 1_500_000);

  afterAll(async () => {
    await Promise.all([subjectId, scoringId].filter(Boolean).map((id) => p.destroy(id)));
    await p.dispose();
    if (localDir) await rm(localDir, { recursive: true, force: true });
    const left = spawnSync("docker", ["ps", "-a", "-q", "--filter", `label=${NS_LABEL}=${ns}`], {
      encoding: "utf8",
    }).stdout.trim();
    if (left) spawnSync("docker", ["rm", "-f", "-v", ...left.split("\n")]);
    expect(left, "the suite leaked containers").toBe("");
  }, 120_000);

  const of = (label: string) => outcomes.filter((o) => o.label === label);

  it("every run verb exits 0 and leaves both collector outputs", () => {
    expect(outcomes).toHaveLength(CASES_TDM36.length * 2);
    for (const o of outcomes) {
      expect(o.runExit, `${o.label}/${o.workload}: ${o.runStderr}`).toBe(0);
      expect(o.collectErrors, `${o.label}/${o.workload}`).toEqual([]);
      expect(o.metrics.some((m) => m.collector === "time")).toBe(true);
      expect(o.metrics.some((m) => m.collector === "hyperfine")).toBe(true);
    }
  });

  it("the oracle and the honest contender pass same-matches on every workload", () => {
    for (const o of [...of("gnu-grep"), ...of("ripgrep")]) {
      expect(o.gate, `${o.label}/${o.workload}: ${o.gateDiff}`).toEqual({
        pass: true,
        reason: `same-matches: exit code and stdout equal the reference for ${o.workload}`,
        evidence: ["cli/exit_code", "cli/stdout.txt"],
      });
    }
  });

  it("the truncating do-less variant fails with a clear reason and a diff", () => {
    const lit = of("ripgrep+truncated-output").find((o) => o.workload === "literal-search")!;
    expect(lit.gate.pass).toBe(false);
    expect(lit.gate.reason).toBe(
      "same-matches: literal-search failed: cli/stdout.txt differs from the reference: got 1 line(s), expected 4; 3 expected line(s) missing and none extra (output truncated?)",
    );
    expect(lit.gateDiff).toContain("--- reference/cli/stdout.txt");
    const uni = of("ripgrep+truncated-output").find((o) => o.workload === "unicode-regex")!;
    expect(uni.gate.pass).toBe(false);
    expect(uni.gate.reason).toContain(
      "expected line(s) missing and none extra (output truncated?)",
    );
  });

  it("the first-match-only do-less variant fails too", () => {
    for (const o of of("ripgrep+first-match-only")) {
      expect(o.gate.pass, o.workload).toBe(false);
      expect(o.gate.reason).toContain("cli/stdout.txt differs from the reference");
    }
  });

  it("measured rows carry gate_id; failed trials count against the cheats (scorer v2)", () => {
    for (const o of outcomes) {
      for (const name of ["wall_s", "peak_rss_bytes"]) {
        const row = o.metrics.find((m) => m.name === name && m.level === "trial");
        expect(row, `${o.label}/${o.workload} ${name}`).toMatchObject({ gate_id: "same-matches" });
      }
      // hyperfine rows are drill-down: no measured requirement reads them, so no gate on them.
      expect(o.metrics.find((m) => m.name === "hyperfine_median_s")?.gate_id).toBeUndefined();
    }
    const trials: TrialResult[] = outcomes.map((o) => ({
      contenderId: o.label,
      workloadId: o.workload,
      repeat: 0,
      metrics: trialMetricRecord(o.metrics),
      gates: { "same-matches": o.gate },
    }));
    const score = scoreKit(kit.spec, trials);
    const by = Object.fromEntries(score.contenders.map((c) => [c.contenderId, c]));
    for (const honest of ["gnu-grep", "ripgrep"]) {
      expect(by[honest]).toMatchObject({ scored: true });
      expect(by[honest]?.gates["same-matches"]).toMatchObject({ passed: 2, failed: 0, total: 2 });
    }
    // wall_s is time-to-solve: every failed trial counts at the cap. The cap is the workload's
    // timeout_s (unicode-regex: 120 s), else the largest wall_clock_cap_s (ripgrep: 300 s).
    const capOf: Record<string, number> = { "literal-search": 300, "unicode-regex": 120 };
    for (const cheat of ["ripgrep+truncated-output", "ripgrep+first-match-only"]) {
      const c = by[cheat]!;
      expect(c.gates["same-matches"], cheat).toMatchObject({ passed: 0, failed: 2, total: 2 });
      const wall = c.requirements.find((r) => r.requirementId === "wall");
      expect(wall, cheat).toMatchObject({ scored: true, aggregate: "censored" });
      if (wall?.scored !== true) throw new Error(`${cheat}: wall unscored`);
      for (const cell of wall.byWorkload) {
        expect(cell, `${cheat}/${cell.workloadId}`).toMatchObject({
          status: "unsolved",
          fraction: 0,
          solved: 0,
          trials: 1,
          cap: capOf[cell.workloadId],
          samples: [capOf[cell.workloadId]],
        });
      }
    }
    // Both honest contenders rank above both cheats.
    const rank = (id: string) => score.ranking.indexOf(id);
    for (const honest of ["gnu-grep", "ripgrep"]) {
      for (const cheat of ["ripgrep+truncated-output", "ripgrep+first-match-only"]) {
        expect(rank(honest), `${honest} vs ${cheat}`).toBeGreaterThanOrEqual(0);
        expect(rank(cheat) === -1 || rank(honest) < rank(cheat), `${honest} vs ${cheat}`).toBe(
          true,
        );
      }
    }
  });
});
