// TDM-60 [6.6]: Go on both images, on docker-local (no spend).
//   1. A Go fixture repo (a bug fixed with a test) is mined on docker-local (golang image).
//   2. materializeAgentKit declares the `go` toolchain from the runner (env.toolchains).
//   3. A scoring-like computer (ubuntu:24.04) gets SCORING_RECIPES + the kit's toolchain recipes
//      exactly as env-build computes them (toolchainRecipes + withRecipes): the go recipe installs
//      and passes its health check.
//   4. The generated mined-task gate runs there: on the untouched workspace it FAILS, on the
//      upstream fix it PASSES (go test -json graded by the miner's parser).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRecipeCatalog,
  renderRecipeEnv,
  runRecipes,
  toolchainRecipes,
  withRecipes,
} from "@anybench/envs";
import { materializeAgentKit, mineRepoTasks, type MinedTask } from "@anybench/kit";
import { DockerLocalProvider, dockerLocalAvailable, trialTag } from "@anybench/providers";
import { afterAll, describe, expect, it } from "vitest";
import { SCORING_RECIPES } from "../src/orchestrator/env-build.js";

const available = await dockerLocalAvailable();
const TANDEM_KIT = fileURLToPath(new URL("../../../kits/tandem-vs-claude-code/", import.meta.url));
const LABEL = "anybench.test-tdm60-go";
const ns = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_AUTHOR_DATE: "2026-04-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-04-01T00:00:00Z",
    },
  });
}

async function goFixture(dir: string): Promise<string> {
  await mkdir(join(dir, "calc"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "go.mod"), "module example.com/calc\n\ngo 1.22\n");
  await writeFile(join(dir, "README.md"), "# calc\n\nSmall math helpers.\n");
  await writeFile(
    join(dir, "calc/calc.go"),
    "package calc\n\n// Clamp limits x to [lo, hi].\nfunc Clamp(x, lo, hi int) int {\n\tif x > hi {\n\t\treturn hi\n\t}\n\treturn x\n}\n\n// Abs is |x|.\nfunc Abs(x int) int {\n\treturn x\n}\n",
  );
  await writeFile(
    join(dir, "calc/calc_test.go"),
    'package calc\n\nimport "testing"\n\nfunc TestClampHigh(t *testing.T) {\n\tif Clamp(9, 0, 5) != 5 {\n\t\tt.Fatal("want 5")\n\t}\n}\n',
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "calc helpers");
  // The fix (two hunks: Clamp's low bound and Abs) with its tests.
  await writeFile(
    join(dir, "calc/calc.go"),
    "package calc\n\n// Clamp limits x to [lo, hi].\nfunc Clamp(x, lo, hi int) int {\n\tif x > hi {\n\t\treturn hi\n\t}\n\tif x < lo {\n\t\treturn lo\n\t}\n\treturn x\n}\n\n// Abs is |x|.\nfunc Abs(x int) int {\n\tif x < 0 {\n\t\treturn -x\n\t}\n\treturn x\n}\n",
  );
  await writeFile(
    join(dir, "calc/calc_test.go"),
    'package calc\n\nimport "testing"\n\nfunc TestClampHigh(t *testing.T) {\n\tif Clamp(9, 0, 5) != 5 {\n\t\tt.Fatal("want 5")\n\t}\n}\n\nfunc TestClampLow(t *testing.T) {\n\tif got := Clamp(-3, 0, 5); got != 0 {\n\t\tt.Fatalf("Clamp(-3, 0, 5) = %d, want 0", got)\n\t}\n}\n\nfunc TestAbsNegative(t *testing.T) {\n\tif got := Abs(-4); got != 4 {\n\t\tt.Fatalf("Abs(-4) = %d, want 4", got)\n\t}\n}\n',
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fix clamp low bound and abs of negatives");
  return dir;
}

async function filesUnder(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel))) {
    const p = rel ? `${rel}/${e}` : e;
    if ((await stat(join(root, p))).isDirectory()) out.push(...(await filesUnder(root, p)));
    else out.push(p);
  }
  return out;
}

describe.skipIf(!available)(
  "Go toolchain on the scoring image + the mined Go gate (TDM-60)",
  () => {
    const miner = new DockerLocalProvider({
      baseImage: "golang:1.26-bookworm",
      labels: { [LABEL]: ns },
    });
    const scoring = new DockerLocalProvider({ labels: { [LABEL]: ns } });
    let tmp = "";

    afterAll(async () => {
      const left = spawnSync("docker", ["ps", "-aq", "--filter", `label=${LABEL}=${ns}`], {
        encoding: "utf8",
      });
      for (const id of left.stdout.split("\n").filter(Boolean))
        spawnSync("docker", ["rm", "-f", id]);
      await miner.dispose();
      await scoring.dispose();
      if (tmp) await rm(tmp, { recursive: true, force: true });
    }, 120_000);

    it("installs go on a scoring image and grades the mined Go task there", async () => {
      tmp = await mkdtemp(join(tmpdir(), "tdm60-go-"));
      const repo = await goFixture(join(tmp, "repo"));
      const mined = await mineRepoTasks(repo, {
        provider: miner,
        computer: { vcpu: 2, memoryMb: 2048 },
        repoUrl: "https://github.com/example/calc",
      });
      expect(mined.tasks.map((t: MinedTask) => t.runner.kind)).toEqual(["go"]);
      const task = mined.tasks[0]!;
      expect(task.fail_to_pass.sort()).toEqual([
        "example.com/calc/calc/TestAbsNegative",
        "example.com/calc/calc/TestClampLow",
      ]);
      expect(task.pass_to_pass).toEqual(["example.com/calc/calc/TestClampHigh"]);

      const kitDir = join(tmp, "kit");
      const kit = await materializeAgentKit({
        repoDir: repo,
        dir: kitDir,
        subject: {
          kind: "harness",
          name: "tandem",
          summary: "Tandem on calc issues.",
          better_means: ["more issues solved"],
        },
        tasks: [
          {
            task,
            instruction:
              "# Clamp and Abs are wrong for negative inputs\n\nValues below the lower bound are not clamped, and Abs returns negatives unchanged.\n",
          },
        ],
        template: {
          dir: TANDEM_KIT,
          contenders: ["claude-code-solo", "tandem"],
          subject: "tandem",
        },
      });
      const toolchains = (kit.spec.env as { toolchains: { name: string; version: string }[] })
        .toolchains;
      expect(toolchains).toEqual([
        { name: "node", version: "22" },
        { name: "go", version: "1.26" },
      ]);
      expect(kit.noPartial).toEqual([]);

      // The scoring image's recipes, exactly as env-build computes them.
      const catalog = await loadRecipeCatalog();
      const tools = toolchainRecipes(catalog, toolchains);
      if (!tools.ok) throw new Error(tools.reason);
      const recipes = withRecipes(SCORING_RECIPES, tools.recipes);
      expect(recipes).toEqual([...SCORING_RECIPES, "go"]);
      const c = await scoring.create({ vcpu: 2, memoryMb: 4096, tags: [trialTag(ns, "scoring")] });
      const id = (await scoring.waitReady(c.id, { timeoutMs: 600_000, intervalMs: 500 })).id;
      // Only what the gate needs here: git/time, node (the verdict program) and go.
      const r = await runRecipes(scoring, id, ["git-time", "node22", "go"], {
        catalog,
        runId: `run_${ns}`,
      });
      expect(r.results.map((x) => [x.name, x.status])).toEqual([
        ["git-time", "installed"],
        ["node22", "installed"],
        ["go", "installed"],
      ]);
      const home = c.home;
      const put = async (local: string, remote: string) =>
        scoring.putFile(id, `${home}/${remote}`, new Uint8Array(await readFile(local)), {
          mode: 0o755,
        });
      for (const f of await filesUnder(join(kitDir, "gates/hidden-tests")))
        await put(join(kitDir, "gates/hidden-tests", f), `kit/gates/hidden-tests/${f}`);
      const input = join(kitDir, "workloads", task.id, "input");
      const oracle = join(kitDir, "proof/oracle", task.id);
      for (const f of await filesUnder(input)) await put(join(input, f), `before/workspace/${f}`);
      for (const f of await filesUnder(input)) await put(join(input, f), `after/workspace/${f}`);
      for (const f of await filesUnder(oracle)) await put(join(oracle, f), `after/workspace/${f}`);
      await scoring.putFile(id, `${home}/abrun`, '#!/usr/bin/env bash\nexec "$@"\n', {
        mode: 0o755,
      });
      await scoring.putFile(id, `${home}/recipe.env`, renderRecipeEnv(r), { mode: 0o644 });
      const grade = async (which: string) => {
        const out = await scoring.exec(
          id,
          `set -e; . ~/recipe.env; cp -R ~/${which} ~/${which}-run; AB_RUN=~/abrun AB_RUN_DIR=~/${which}-run bash ~/kit/gates/hidden-tests/check.sh ~/${which} ${task.id} ~/${which}.json; cat ~/${which}.json`,
          { timeoutMs: 300_000 },
        );
        return JSON.parse(out.stdout.trim().split("\n").pop()!) as {
          pass: boolean;
          reason: string;
        };
      };
      const before = await grade("before");
      const after = await grade("after");
      console.log(JSON.stringify({ recipes: r.results, before, after }));
      expect(before).toMatchObject({
        pass: false,
        reason: expect.stringContaining("0/2 FAIL_TO_PASS and 1/1 PASS_TO_PASS"),
      });
      expect(after).toMatchObject({
        pass: true,
        reason: `hidden-tests: 2/2 FAIL_TO_PASS and 1/1 PASS_TO_PASS tests pass on ${task.id}`,
      });
      await scoring.destroy(id);
    }, 900_000);
  },
);
