// TDM-186 [16.15] done condition, on docker-local (node:22): the fixture repo yields verified tasks
// whose new tests fail before the fix and pass after it in 3 of 3 runs; the flaky and docs-only
// commits are dropped with reasons; the verification snapshot and the workload repo carry no
// history; nothing answer-bearing lands under workloads/. Skips cleanly without a Docker daemon.
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerLocalProvider, dockerLocalAvailable } from "@anybench/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkMinedTaskLeaks,
  groupMinedTasks,
  MinedTaskSchema,
  MineReportSchema,
  mineRepoTasks,
  minedTaskId,
  minedTaskPaths,
  parseNodeTap,
  type MineRepoTasksResult,
} from "../src/index.js";
import { buildMineFixtureRepo, type MineFixture } from "./tdm186-mine-fixture.js";

const available = await dockerLocalAvailable();
const ns = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LABEL = "anybench.test-tdm186";

describe.skipIf(!available)("task mining on docker-local (TDM-186)", () => {
  let tmp: string;
  let fx: MineFixture;
  let kit: string;
  let res: MineRepoTasksResult;
  const provider = new DockerLocalProvider({ baseImage: "node:22", labels: { [LABEL]: ns } });
  const lines: string[] = [];

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ab-tdm186-dock-"));
    fx = await buildMineFixtureRepo(join(tmp, "repo"));
    kit = join(tmp, "kit");
    res = await mineRepoTasks(fx.repo, {
      provider,
      computer: { vcpu: 2, memoryMb: 2048 },
      kitDir: kit,
      repoUrl: "https://github.com/example/mine-fixture",
      modelCutoff: "2026-03-05",
      log: (l) => lines.push(l),
    });
    if (process.env.ANYBENCH_MINE_LOG) console.log(lines.join("\n"));
  }, 600_000);

  afterAll(async () => {
    // mineRepoTasks destroys its computer; sweep anything a failure left behind.
    const out = spawnSync("docker", ["ps", "-aq", "--filter", `label=${LABEL}=${ns}`], {
      encoding: "utf8",
    });
    for (const id of out.stdout.split("\n").filter(Boolean)) spawnSync("docker", ["rm", "-f", id]);
    await provider.dispose();
    await rm(tmp, { recursive: true, force: true });
  }, 120_000);

  it("verifies the fix+test commits 3/3 and drops the rest with reasons", () => {
    const { report, tasks } = res;
    MineReportSchema.parse(report);
    const ids = (shas: string[]) => shas.map(minedTaskId).sort();
    expect(tasks.map((t) => t.id).sort()).toEqual(
      ids([
        fx.sha.fixSlugify,
        fx.sha.fixClamp,
        fx.sha.fixTitleEmpty,
        fx.sha.fixTruncate,
        fx.sha.fixPad,
      ]),
    );
    for (const t of tasks) {
      expect(t.runs.before).toHaveLength(3);
      expect(t.runs.after).toHaveLength(3);
      for (const r of t.runs.before) expect(r.exit_code).not.toBe(0);
      for (const r of t.runs.after) expect(r.exit_code).toBe(0);
      expect(t.fail_to_pass.length).toBeGreaterThan(0);
      // symptoms are workspace-relative and never name the upstream commit
      const text = JSON.stringify([t.symptoms, t.before_output_excerpt]);
      expect(text).not.toContain(t.source.commit.slice(0, 7));
      expect(text).not.toContain("/home/naive");
    }
    const code = (sha: string) => res.drops.find((d) => d.sha === sha);
    expect(code(fx.sha.flaky)).toMatchObject({ stage: "verify", code: "flaky" });
    expect(code(fx.sha.flaky)?.detail).toMatch(
      /attempt succeeds passed 0\/3 before and 1\/3 after/,
    );
    expect(code(fx.sha.docs)).toMatchObject({ stage: "select", code: "docs_only" });
    expect(code(fx.sha.passesBefore)).toMatchObject({ stage: "verify", code: "passes_before_fix" });
    expect(code(fx.sha.testsOnly)?.code).toBe("tests_only");
    expect(code(fx.sha.merge)?.code).toBe("merge");
    expect(report.candidates).toBe(7);
    expect(report.verified).toBe(5);
    expect(report.held_out).toBe(2);
    expect(report.drop_counts).toMatchObject({
      flaky: 1,
      docs_only: 2,
      passes_before_fix: 1,
      merge: 1,
    });
  });

  it("records FAIL_TO_PASS, PASS_TO_PASS, dates vs cutoff and before-fix symptoms", () => {
    const slug = res.tasks.find((t) => t.id === minedTaskId(fx.sha.fixSlugify));
    expect(slug?.fail_to_pass).toEqual([
      "test/strings.test.js > slugify collapses runs of whitespace",
    ]);
    expect(slug?.pass_to_pass).toEqual([
      "test/strings.test.js > slugify lowercases",
      "test/strings.test.js > titleCase capitalises each word",
    ]);
    expect(slug?.cutoff).toEqual({
      model_cutoff: "2026-03-05",
      after_cutoff: false,
      days_after_cutoff: -3,
    });
    expect(slug?.symptoms[0]?.message).toContain("'many-spaces-here'");
    const pad = res.tasks.find((t) => t.id === minedTaskId(fx.sha.fixPad));
    expect(pad?.cutoff?.after_cutoff).toBe(true);
    // the new test file could not even load before the fix: the symptom is the load error
    expect(pad?.fail_to_pass).toEqual(["test/pad.test.js > padStart pads with zeros"]);
    expect(pad?.symptoms[0]?.message).toContain("Cannot find module '../src/pad.js'");
    expect(pad?.runner.kind).toBe("node-test");
  });

  it("materializes kit files with nothing answer-bearing under workloads/", async () => {
    for (const t of res.tasks) {
      const p = minedTaskPaths(t.id);
      expect(await checkMinedTaskLeaks(fx.repo, kit, t)).toEqual([]);
      const rec = MinedTaskSchema.parse(JSON.parse(await readFile(join(kit, p.record), "utf8")));
      expect(rec.id).toBe(t.id);
      const gate = JSON.parse(await readFile(join(kit, p.gateTests), "utf8")) as {
        fail_to_pass: string[];
      };
      expect(gate.fail_to_pass).toEqual(t.fail_to_pass);
      // the hidden tests and the fix live in gates/ and proof/, not in the workload
      const wl = await readdir(join(kit, p.input), { recursive: true });
      for (const f of t.files.test_files.filter((x) => x.status === "added")) {
        expect(wl).not.toContain(f.path);
        await readFile(join(kit, p.gateFiles, f.path));
      }
      for (const f of t.files.fix_files) await readFile(join(kit, p.oracle, f.path));
      const instruction = await readFile(join(kit, p.instruction), "utf8");
      expect(instruction).toContain("PLACEHOLDER");
    }
    // a planted leak is caught
    const t = res.tasks.find((x) => x.id === minedTaskId(fx.sha.fixTruncate));
    if (!t) throw new Error("no truncate task");
    const p = minedTaskPaths(t.id);
    await cp(
      join(kit, p.gateFiles, "test/truncate.test.js"),
      join(kit, p.input, "test/truncate.test.js"),
    );
    expect(await checkMinedTaskLeaks(fx.repo, kit, t)).toEqual([
      `${p.workload}/input/test/truncate.test.js is the post-change test/truncate.test.js`,
    ]);
    await rm(join(kit, p.input, "test/truncate.test.js"));
    const report = JSON.parse(await readFile(join(kit, "mined/report.json"), "utf8")) as {
      verified: number;
    };
    expect(report.verified).toBe(5);
  });

  it("the workload repo has one commit and no upstream history; gate + oracle replay locally", async () => {
    const t = res.tasks.find((x) => x.id === minedTaskId(fx.sha.fixTruncate));
    if (!t) throw new Error("no truncate task");
    const p = minedTaskPaths(t.id);
    const ws = join(tmp, "ws-truncate");
    execFileSync("bash", [join(kit, p.setup)], {
      env: { ...process.env, EVAL_IN: join(kit, p.input), EVAL_WS: ws },
    });
    const g = (...a: string[]) => spawnSync("git", ["-C", ws, ...a], { encoding: "utf8" });
    expect(g("rev-list", "--count", "--all").stdout.trim()).toBe("1");
    expect(g("cat-file", "-e", `${t.source.parent}^{commit}`).status).not.toBe(0);
    expect(g("log", "--all", "--format=%s").stdout.trim()).toBe("starting repo");

    const run = () =>
      parseNodeTap(
        spawnSync("sh", ["-c", t.runner.test_command], {
          cwd: ws,
          encoding: "utf8",
          env: { ...process.env, ...t.runner.env },
        }).stdout,
      );
    await cp(join(kit, p.gateFiles), ws, { recursive: true });
    const before = run();
    for (const id of t.fail_to_pass)
      expect(before.tests.get(id)?.outcome ?? "missing").not.toBe("pass");
    await cp(join(kit, p.oracle), ws, { recursive: true });
    const after = run();
    for (const id of [...t.fail_to_pass, ...t.pass_to_pass])
      expect(after.tests.get(id)?.outcome).toBe("pass");
  });

  it("groups the tasks into a backlog", () => {
    const g = groupMinedTasks(res.tasks, { minSize: 5 });
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0]?.area).toBe("src");
    expect(g.groups[0]?.task_ids).toHaveLength(5);
  });
});
