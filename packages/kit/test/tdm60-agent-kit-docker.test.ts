// TDM-60 [6.6] step 6: a generated agent/harness kit from MINED tasks. The tasks are mined on
// docker-local (node:22, the TDM-186 fixture repo); the kit is materialized with the Tandem kit
// as the contender template; then the proof suite runs with a host runner whose trials APPLY the
// overlay drivers' dirs (oracle = the fix, partial-fix, no-op) and whose gates run the generated
// check.sh for real (node --test on the host). Smoke and baselines need a real agent: they are
// left for a live window. Skips without Docker.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerLocalProvider, dockerLocalAvailable } from "@anybench/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  materializeAgentKit,
  minedVerdictProgram,
  mineRepoTasks,
  parseTestRun,
  runProofSuiteReport,
  validateGeneratedKit,
  type MineRepoTasksResult,
  type ProofTrialRequest,
} from "../src/index.js";
import { buildMineFixtureRepo } from "./tdm186-mine-fixture.js";
import { hostProofRunnerTdm44 } from "./tdm44-proof-helpers.js";

const available = await dockerLocalAvailable();
const TANDEM_KIT = fileURLToPath(new URL("../../../kits/tandem-vs-claude-code/", import.meta.url));
const ns = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LABEL = "anybench.test-tdm60";

function filesUnder(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel))) {
    const p = rel ? `${rel}/${e}` : e;
    if (statSync(join(root, p)).isDirectory()) out.push(...filesUnder(root, p));
    else out.push(p);
  }
  return out;
}

describe.skipIf(!available)("generated agent kit from mined tasks (TDM-60 step 6)", () => {
  let tmp: string;
  let repo: string;
  let mined: MineRepoTasksResult;
  const provider = new DockerLocalProvider({ baseImage: "node:22", labels: { [LABEL]: ns } });

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ab-tdm60-agent-"));
    repo = (await buildMineFixtureRepo(join(tmp, "repo"))).repo;
    mined = await mineRepoTasks(repo, {
      provider,
      computer: { vcpu: 2, memoryMb: 2048 },
      kitDir: join(tmp, "mined"),
      repoUrl: "https://github.com/example/mine-fixture",
      modelCutoff: "2026-03-05",
    });
  }, 600_000);

  afterAll(async () => {
    const out = spawnSync("docker", ["ps", "-aq", "--filter", `label=${LABEL}=${ns}`], {
      encoding: "utf8",
    });
    for (const id of out.stdout.split("\n").filter(Boolean)) spawnSync("docker", ["rm", "-f", id]);
    await provider.dispose();
    await rm(tmp, { recursive: true, force: true });
  }, 120_000);

  it("the embedded verdict program grades exactly like the miner's parser", () => {
    const log = [
      "# anybench-file: test/a.test.js",
      "ok 1 - adds",
      "not ok 2 - subtracts",
      "  ---",
      "  error: 'nope'",
      "  ...",
    ].join("\n");
    const ours = parseTestRun("node-test", { log, workspace: "/w" });
    const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    const spec = join(dir, "tests.json");
    const logf = join(dir, "log");
    const verdict = join(dir, "gate.json");
    writeFileSync(
      spec,
      JSON.stringify({
        runner: { kind: "node-test" },
        fail_to_pass: ["test/a.test.js > adds"],
        pass_to_pass: ["test/a.test.js > subtracts"],
      }),
    );
    writeFileSync(logf, log);
    execFileSync(
      "node",
      ["-", spec, logf, join(dir, "none"), "/w", verdict, "hidden-tests", "w1"],
      {
        input: minedVerdictProgram(),
      },
    );
    const v = JSON.parse(readFileSync(verdict, "utf8")) as { pass: boolean; reason: string };
    expect(ours.tests.get("test/a.test.js > adds")?.outcome).toBe("pass");
    expect(v.pass).toBe(false);
    expect(v.reason).toBe(
      "hidden-tests: 1/1 FAIL_TO_PASS and 0/1 PASS_TO_PASS tests pass on w1 (not passing: test/a.test.js > subtracts)",
    );
  });

  it("materializes a valid kit and proves oracle, do-less (noop + partial) and mutation on the real gate", async () => {
    expect(mined.tasks.length).toBeGreaterThanOrEqual(3);
    const dir = join(tmp, "kit");
    const tasks = mined.tasks.map((task) => ({
      task,
      instruction: `# A bug in ${task.area}\n\nUsers report that a helper in \`${task.area}\` returns the wrong result for some inputs. Fix the behaviour so it matches what the README and the surrounding code promise, without breaking anything that works today.\n`,
    }));
    const kit = await materializeAgentKit({
      repoDir: repo,
      dir,
      subject: {
        kind: "harness",
        name: "tandem",
        summary: "Tandem on issues mined from the repo's history.",
        better_means: ["more issues solved", "less time and cost per solved issue"],
      },
      tasks,
      template: { dir: TANDEM_KIT, contenders: ["claude-code-solo", "tandem"], subject: "tandem" },
    });
    const v = await validateGeneratedKit(dir);
    expect(v.issues).toEqual([]);
    const spec = v.kit!.spec;
    expect(spec.contenders.map((c) => c.id)).toEqual(["claude-code-solo", "tandem"]);
    expect(spec.subject.summary).toMatch(/on these \d+ tasks only/);
    expect(spec.repeats).toBe(10);
    expect(spec.vary).toEqual({ TANDEM_WORKERS: [3] });
    expect(spec.proof.do_less.map((o) => o.kind)).toContain("noop");
    // the Claude Code pins are the template's, byte for byte
    const tpl = readFileSync(join(TANDEM_KIT, "adapters/claude-code/install.sh"), "utf8");
    expect(readFileSync(join(dir, "adapters/claude-code/install.sh"), "utf8")).toBe(tpl);
    // checkMinedTaskLeaks (bytes) + the no-leak lint (per workload) passed above.

    // Host proof: trials apply the overlay dir to the workload input; gates run check.sh for real.
    const behave = (req: ProofTrialRequest) => {
      const input = join(dir, "workloads", req.workloadId, "input");
      const files: Record<string, Uint8Array> = {};
      for (const f of filesUnder(input)) files[`workspace/${f}`] = readFileSync(join(input, f));
      const overlayDir =
        req.overlay?.id === "upstream-fix"
          ? "proof/oracle"
          : req.overlay?.env?.AB_OVERLAY_DIR
            ? req.overlay.env.AB_OVERLAY_DIR
            : null;
      const o = overlayDir ? join(dir, overlayDir, req.workloadId) : null;
      if (o && existsSync(o))
        for (const f of filesUnder(o)) files[`workspace/${f}`] = readFileSync(join(o, f));
      return {
        files,
        metrics: [{ name: "wall_s", value: 1, gate_id: "hidden-tests", level: "trial" }],
      };
    };
    const report = await runProofSuiteReport(v.kit!, {
      runner: hostProofRunnerTdm44(v.kit!, behave),
      concurrency: 4,
    });
    const c = Object.fromEntries(report.checks.map((x) => [x.check, x]));
    console.log(
      JSON.stringify(
        {
          checks: report.checks.map((x) => [x.check, x.pass, x.reason.slice(0, 300)]),
          mutation: report.mutation,
          noPartial: kit.noPartial,
        },
        null,
        1,
      ),
    );
    if (process.env.TDM60_KEEP) execFileSync("cp", ["-R", dir, process.env.TDM60_KEEP]);
    expect(c.no_secret_in_kit!.pass).toBe(true);
    expect(c.oracle_passes!.pass, c.oracle_passes!.reason).toBe(true);
    expect(c.do_less_fails!.pass, c.do_less_fails!.reason).toBe(true);
    expect(report.mutation!.total).toBeGreaterThan(0);
    expect(report.mutation!.killed / report.mutation!.total).toBeGreaterThanOrEqual(0.9);
    // Smoke, baselines and the planted regression need a real agent session: live window only.
  }, 300_000);
});
