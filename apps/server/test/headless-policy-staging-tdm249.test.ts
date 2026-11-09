// TDM-249 [21.9]: the harness league's headless-policy shim reaches the trial image executable,
// and the report states the policy only for the setups whose trial streams show it ran.
//
// Run 1 (TDM-229, docs/findings/harness-league-run-1.md): no Claude Code trial's stream had
// `system/anybench_headless_policy`. subjectPlan staged every kit file 0644 unless its name ended
// in `.sh`, so `adapters/headless-policy/bin/claude` (git mode 100755, a bash script with no
// suffix) landed non-executable, PATH lookup skipped it, and the driver ran the real Claude Code
// with no policy. The report still printed the headless-v1 disclosure.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectStreamJson } from "@anybench/bench";
import type { KitSpec } from "@anybench/core";
import { buildEnvSnapshot, type RecipeCatalog } from "@anybench/envs";
import { loadKit } from "@anybench/kit";
import { FakeProvider } from "@anybench/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultKitsDir, LEAGUE_V1_WORKLOAD, leagueProfile } from "../src/orchestrator/curated.js";
import { stagedMode, subjectPlan } from "../src/orchestrator/env-build.js";
import type { StageTrial } from "../src/orchestrator/ports.js";
import {
  buildSummary,
  HARNESS_LEAGUE_DISCLOSURE,
  harnessLeagueDisclosure,
  headlessPolicySetups,
  HEADLESS_POLICY_ID,
  LONG_HORIZON_DISCLOSURE,
  storedScoreOf,
} from "../src/orchestrator/proof-score.js";

const LEAGUE_TDM249 = path.join(defaultKitsDir(), "harness-league");
const SHIM_TDM249 = "adapters/headless-policy/bin/claude";
const FIX_TDM249 = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/bench/test/fixtures/tdm228",
);
const FAKE_CLAUDE_TDM249 = path.join(FIX_TDM249, "fake-claude.mjs");
/** A recorded Claude Code session that never asks: the policy runs and never fires. */
const NEVER_ASKS_TDM249 = path.join(FIX_TDM249, "cc2.1.319-resumed.jsonl");

/** `git ls-files -s` modes of the kit's subject files: 100755 → true. */
function gitExecutables(): Map<string, boolean> {
  const r = spawnSync("git", ["ls-files", "-s", "adapters", "workloads", "scripts"], {
    cwd: LEAGUE_TDM249,
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  const out = new Map<string, boolean>();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [meta, file] = line.split("\t");
    out.set(file!, meta!.startsWith("100755"));
  }
  return out;
}

let root = "";
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "ab-tdm249-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("kit files keep their executable bit on the trial image (TDM-249)", () => {
  it("stagedMode: any x bit, whatever the name, or a .sh script, is 0755", () => {
    expect(stagedMode("adapters/headless-policy/bin/claude", 0o100755)).toBe(0o755);
    expect(stagedMode("adapters/x/bin/tool", 0o100744)).toBe(0o755);
    expect(stagedMode("adapters/x/bin/tool", 0o100644)).toBe(0o644);
    expect(stagedMode("adapters/x/driver.sh", 0o100644)).toBe(0o755);
    expect(stagedMode("adapters/x/policy.mjs", 0o100644)).toBe(0o644);
  });

  it("subjectPlan stages bin/claude 0755, and every league file with its git mode", async () => {
    const kit = await loadKit(LEAGUE_TDM249);
    const plan = await subjectPlan(kit.dir, kit.spec);
    const byPath = new Map(plan.files.map((f) => [f.path, f.mode]));
    expect(byPath.get(`kit/${SHIM_TDM249}`)).toBe(0o755);
    expect(byPath.get("kit/adapters/headless-policy/policy.mjs")).toBe(0o644);
    const git = gitExecutables();
    let checked = 0;
    for (const f of plan.files) {
      const rel = f.path.slice("kit/".length);
      const exec = git.get(rel);
      if (exec === undefined) continue; // not tracked (a generated file)
      expect(f.mode, rel).toBe(exec || rel.endsWith(".sh") ? 0o755 : 0o644);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("the snapshot cache key's subject part changes when only a mode changes", async () => {
    const kit = await loadKit(LEAGUE_TDM249);
    const copy = path.join(root, "league-copy");
    for (const d of ["adapters", "workloads", "scripts"]) {
      cpSync(path.join(LEAGUE_TDM249, d), path.join(copy, d), { recursive: true });
    }
    chmodSync(path.join(copy, SHIM_TDM249), 0o755);
    const before = await subjectPlan(copy, kit.spec);
    chmodSync(path.join(copy, SHIM_TDM249), 0o644);
    const after = await subjectPlan(copy, kit.spec);
    expect(after.files.find((f) => f.path === `kit/${SHIM_TDM249}`)?.mode).toBe(0o644);
    expect(after.sha256).not.toBe(before.sha256);
    chmodSync(path.join(copy, SHIM_TDM249), 0o755);
    expect((await subjectPlan(copy, kit.spec)).sha256).toBe(before.sha256);
  });
});

describe("a league trial forked from the staged image runs the policy (TDM-249)", () => {
  /** The env build's subject files on FakeProvider, forked, laid out on disk with their modes. */
  async function stagedHome(name: string): Promise<{ home: string; spec: KitSpec }> {
    const kit = await loadKit(LEAGUE_TDM249);
    const plan = await subjectPlan(kit.dir, kit.spec);
    const p = new FakeProvider();
    p.onExec("uname -m", () => "x86_64\n");
    const catalog: RecipeCatalog = { recipes: new Map(), lib: "# lib\n" };
    const snap = await buildEnvSnapshot({
      provider: p,
      spec: { vcpu: 2, memoryMb: 4096, diskGb: 20 },
      label: "tdm249",
      recipes: [],
      catalog,
      files: plan.files,
    });
    const fork = await p.waitReady((await p.fork(snap.snapshotId)).id);
    const home = path.join(root, name);
    for (const f of plan.files) {
      const abs = path.posix.join(p.home, f.path);
      const st = p.fileStat(fork.id, abs);
      expect(st, f.path).toBeDefined();
      const dest = path.join(home, f.path);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, await p.getFile(fork.id, abs));
      chmodSync(dest, st!.mode); // what Naïve's and docker's putFile do with the mode
    }
    return { home, spec: kit.spec };
  }

  /**
   * One trial of A through its staged driver. `realOnPath`: the image's real Claude Code is also
   * on PATH (as on a trial computer), here a `claude` that runs the fake.
   */
  function runA(home: string, spec: KitSpec, realOnPath = false) {
    const c = spec.contenders.find((x) => x.id === "claude-code-solo")!;
    const out = path.join(home, "out");
    const ws = path.join(home, "ws");
    mkdirSync(out, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(home, "task.md"), "Build the thing.\n");
    const log = path.join(home, "calls.jsonl");
    writeFileSync(log, "");
    const realBin = path.join(home, "real-bin");
    if (realOnPath) {
      mkdirSync(realBin, { recursive: true });
      writeFileSync(
        path.join(realBin, "claude"),
        `#!/usr/bin/env bash\nexec ${JSON.stringify(FAKE_CLAUDE_TDM249)} "$@"\n`,
        { mode: 0o755 },
      );
    }
    const env: Record<string, string> = {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin${realOnPath ? `:${realBin}` : ""}`,
      HOME: home,
      EVAL_OUT: out,
      ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000",
      ...(c.driver.env ?? {}),
      AB_REAL_CLAUDE: FAKE_CLAUDE_TDM249,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_FIXTURES: NEVER_ASKS_TDM249,
    };
    delete env.CC_WALL_CAP_S;
    const r = spawnSync(
      "bash",
      [path.join(home, "kit", c.driver.script!), "run", path.join(home, "task.md"), ws],
      { env, encoding: "utf8", timeout: 60_000 },
    );
    let stream = "";
    try {
      stream = readFileSync(path.join(out, "stream.jsonl"), "utf8");
    } catch {
      // the driver stopped before the stream
    }
    return { status: r.status, stderr: r.stderr, stream, calls: readFileSync(log, "utf8") };
  }

  it("the stream carries the policy's start event, and 0 auto-answers when it never fires", async () => {
    const { home, spec } = await stagedHome("staged");
    expect(statSync(path.join(home, "kit", SHIM_TDM249)).mode & 0o777).toBe(0o755);
    const t = runA(home, spec);
    expect(t.status, t.stderr).toBe(0);
    const events = t.stream
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type?: string; subtype?: string; policy?: string });
    const start = events.findIndex((e) => e.subtype === "anybench_headless_policy");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(events[start]!.policy).toBe(HEADLESS_POLICY_ID);
    // First, before Claude Code's own init.
    expect(start).toBeLessThan(events.findIndex((e) => e.subtype === "init"));
    expect(events.filter((e) => e.subtype === "anybench_auto_answer")).toHaveLength(0);
    const rows = collectStreamJson(t.stream);
    expect(rows.find((m) => m.name === "questions_auto_answered")?.value).toBe(0);
  });

  it("a shim staged 0644 (the old suffix rule) stops the trial loudly, never runs Claude Code bare", async () => {
    const { home, spec } = await stagedHome("staged-0644");
    chmodSync(path.join(home, "kit", SHIM_TDM249), 0o644);
    // Run 1's computers: the real Claude Code further down PATH, which bash's lookup then picks.
    const t = runA(home, spec, true);
    expect(t.status).toBe(2);
    expect(t.stderr).toContain("is it executable?");
    expect(t.calls).toBe(""); // Claude Code never started
    // And with no other claude on PATH (bash would fall back to the 0644 file): the same stop.
    const alone = runA(home, spec);
    expect(alone.status).toBe(2);
    expect(alone.calls).toBe("");
  });

  it("with the shim executable and the real Claude Code on PATH, the wrapper still wins", async () => {
    const { home, spec } = await stagedHome("staged-real");
    const t = runA(home, spec, true);
    expect(t.status, t.stderr).toBe(0);
    expect(t.stream).toContain('"subtype":"anybench_headless_policy"');
  });
});

describe("the report states the headless policy only where it ran (TDM-249)", () => {
  function trialTdm249(
    contender: string,
    repeat: number,
    metrics: unknown,
    state: StageTrial["state"] = "done",
  ): StageTrial {
    return {
      id: `${contender}-${repeat}`,
      contender,
      contender_id: contender,
      workload_id: "project-tracker",
      repeat,
      state,
      attempt: 1,
      metrics,
      gate: null,
      cost_micro_usd: 0n,
    };
  }
  const ran = { questions_auto_answered: 0, wall_s: 10 };
  const bare = { wall_s: 10 };

  it("the policy setups are the league's Claude Code setups, not D", async () => {
    const kit = await loadKit(LEAGUE_TDM249);
    expect(headlessPolicySetups(kit.spec)).toEqual([
      "claude-code-solo",
      "claude-code-subagents",
      "gstack",
      "superpowers",
    ]);
  });

  it("ran in every trial (0 answers counts as ran): the full headless-v1 disclosure", async () => {
    const kit = await loadKit(LEAGUE_TDM249);
    const nameOf = (id: string) => kit.spec.contenders.find((c) => c.id === id)?.name ?? id;
    const trials = [
      ...headlessPolicySetups(kit.spec).map((id) => trialTdm249(id, 0, ran)),
      trialTdm249("superpowers", 1, { ...ran, questions_auto_answered: 2 }),
      trialTdm249("superpowers", -1, bare), // a warm-up does not count
      trialTdm249("gstack", 1, null, "failed_infra"), // never ran the agent: not counted
      trialTdm249("tandem", 0, bare), // D: no policy, by design
    ];
    expect(harnessLeagueDisclosure(kit.spec, trials, nameOf)).toBe(HARNESS_LEAGUE_DISCLOSURE);
  });

  it("did not run (no start event in any trial): no headless-v1 terms, says it did not run", async () => {
    const kit = await loadKit(LEAGUE_TDM249);
    const nameOf = (id: string) => kit.spec.contenders.find((c) => c.id === id)?.name ?? id;
    const trials = [
      ...headlessPolicySetups(kit.spec).map((id) => trialTdm249(id, 0, bare)),
      trialTdm249("tandem", 0, bare),
    ];
    const d = harnessLeagueDisclosure(kit.spec, trials, nameOf);
    expect(d).toBe(
      `${LONG_HORIZON_DISCLOSURE}; headless policy headless-v1 did not run for A · Claude Code solo, B · Claude Code + subagents, G · Claude Code + gstack, S · Claude Code + Superpowers (no trial's stream has the policy start event); Tandem's approvals automatic`,
    );
    expect(d).not.toContain("is resumed with");
    expect(d).not.toContain("D · Tandem");
  });

  it("ran for some setups or trials only: each named, with k of n", async () => {
    const kit = await loadKit(LEAGUE_TDM249);
    const nameOf = (id: string) => kit.spec.contenders.find((c) => c.id === id)?.name ?? id;
    const trials = [
      trialTdm249("claude-code-solo", 0, ran),
      trialTdm249("claude-code-solo", 1, ran),
      trialTdm249("claude-code-subagents", 0, ran),
      trialTdm249("claude-code-subagents", 1, bare, "failed_subject"),
      trialTdm249("gstack", 0, bare),
      trialTdm249("superpowers", 0, ran),
    ];
    expect(harnessLeagueDisclosure(kit.spec, trials, nameOf)).toBe(
      `${LONG_HORIZON_DISCLOSURE}; headless policy headless-v1 for A · Claude Code solo, B · Claude Code + subagents, S · Claude Code + Superpowers: a session that stops to ask is resumed with "Yes, approved. Proceed with your recommended option and complete the task." (at most 8 times per trial, counted as questions_auto_answered), but it ran in only 1 of 2 trials of B · Claude Code + subagents (the other trials' streams have no policy start event); headless policy headless-v1 did not run for G · Claude Code + gstack (no trial's stream has the policy start event); Tandem's approvals automatic`,
    );
  });

  /** The league's v1 cut, A and D only, five passing trials each; A's metrics from `a`. */
  async function reportTdm249(a: Record<string, number>) {
    const league = (await loadKit(LEAGUE_TDM249)).spec;
    const cut = leagueProfile(league, { workloads: [LEAGUE_V1_WORKLOAD], repeats: 5 });
    if (!cut.ok) throw new Error(cut.reason);
    const spec: KitSpec = {
      ...cut.spec,
      contenders: cut.spec.contenders.filter(
        (c) => c.id === "claude-code-solo" || c.id === "tandem",
      ),
    };
    const trials: StageTrial[] = [];
    for (const contender of ["claude-code-solo", "tandem"]) {
      for (let repeat = 0; repeat < 5; repeat++) {
        trials.push({
          ...trialTdm249(contender, repeat, {
            wall_s: 800 + repeat,
            hidden_test_fraction: 1,
            hidden_tests_passed: 120,
            hidden_tests_total: 120,
            byok_token_cost_micro_usd: 3_000_000,
            ...(contender === "claude-code-solo" ? a : {}),
          }),
          workload_id: LEAGUE_V1_WORKLOAD,
          gate: { "hidden-tests": { pass: true, reason: "120/120", evidence: [] } },
          cost_micro_usd: 100_000n,
        });
      }
    }
    const built = buildSummary({
      kit: spec,
      score: storedScoreOf(spec, trials),
      proof: [],
      trials,
      disclosure: HARNESS_LEAGUE_DISCLOSURE,
      headlessPolicy: true,
    });
    if (!built.ok) throw new Error(built.reason);
    return built.analysis;
  }

  it("the report: 'ran, 0 answers' prints headless-v1 and the 0; 'did not run' says so instead", async () => {
    const ranReport = await reportTdm249({
      questions_auto_answered: 0,
      auto_answer_cap_reached: 0,
    });
    expect(ranReport.md).toContain(HARNESS_LEAGUE_DISCLOSURE);
    expect(ranReport.md).toContain(
      "questions auto-answered (headless policy): A · Claude Code solo 0 in 5 trials",
    );
    expect(ranReport.report.answer).toContain(HARNESS_LEAGUE_DISCLOSURE);

    const notRun = await reportTdm249({});
    expect(notRun.md).not.toContain("is resumed with");
    expect(notRun.md).not.toContain("questions auto-answered");
    const said = `${LONG_HORIZON_DISCLOSURE}; headless policy headless-v1 did not run for A · Claude Code solo (no trial's stream has the policy start event); Tandem's approvals automatic`;
    expect(notRun.md).toContain(said);
    expect(notRun.report.answer).toContain(said);
    expect(notRun.report.answer).not.toContain(HARNESS_LEAGUE_DISCLOSURE);
  });
});
