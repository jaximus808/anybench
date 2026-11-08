// TDM-186 follow-up on docker-local: monorepo layouts verify 3/3. A Go module nested at apps/api
// (golang image) and TypeScript tests under `tsx --test` in an npm workspace (node:22) both yield
// tasks; a commit whose tests span two modules and a TypeScript package with no declared loader
// are dropped with reasons. One container at a time; each suite sweeps its own label.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerLocalProvider, dockerLocalAvailable } from "@anybench/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MineReportSchema,
  mineRepoTasks,
  minedTaskId,
  type MineRepoTasksResult,
} from "../src/index.js";
import {
  buildGoMonorepoFixture,
  buildTsWorkspaceFixture,
  type GoMonorepoFixture,
  type TsWorkspaceFixture,
} from "./tdm186-runners-fixture.js";

const available = await dockerLocalAvailable();
const LABEL = "anybench.test-tdm186-runners";
const newNs = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function sweep(ns: string): void {
  const out = spawnSync("docker", ["ps", "-aq", "--filter", `label=${LABEL}=${ns}`], {
    encoding: "utf8",
  });
  for (const id of out.stdout.split("\n").filter(Boolean)) spawnSync("docker", ["rm", "-f", id]);
}

function expectVerified3of3(res: MineRepoTasksResult): void {
  for (const t of res.tasks) {
    expect(t.runs.before).toHaveLength(3);
    expect(t.runs.after).toHaveLength(3);
    for (const r of t.runs.before) expect(r.exit_code).not.toBe(0);
    for (const r of t.runs.after) expect(r.exit_code).toBe(0);
    expect(t.fail_to_pass.length).toBeGreaterThan(0);
  }
}

describe.skipIf(!available)("mining a nested Go module on docker-local", () => {
  const ns = newNs();
  const provider = new DockerLocalProvider({
    baseImage: "golang:1.26-bookworm",
    labels: { [LABEL]: ns },
  });
  let tmp: string;
  let fx: GoMonorepoFixture;
  let res: MineRepoTasksResult;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ab-tdm186-go-"));
    fx = await buildGoMonorepoFixture(join(tmp, "repo"));
    const lines: string[] = [];
    res = await mineRepoTasks(fx.repo, {
      provider,
      computer: { vcpu: 2, memoryMb: 2048 },
      log: (l) => lines.push(l),
    });
    if (process.env.ANYBENCH_MINE_LOG) console.log(lines.join("\n"));
  }, 600_000);

  afterAll(async () => {
    sweep(ns);
    await provider.dispose();
    await rm(tmp, { recursive: true, force: true });
  }, 120_000);

  it("runs go test from apps/api and verifies both fixes 3/3", () => {
    MineReportSchema.parse(res.report);
    expect(res.tasks.map((t) => t.id).sort()).toEqual(
      [fx.sha.fixClampLow, fx.sha.fixSlugTrim].map(minedTaskId).sort(),
    );
    expectVerified3of3(res);
    const clamp = res.tasks.find((t) => t.id === minedTaskId(fx.sha.fixClampLow));
    expect(clamp?.runner).toMatchObject({
      kind: "go",
      module_dir: "apps/api",
      install_command: "cd 'apps/api' && go mod download",
      test_command: "cd 'apps/api' && go test -count=1 -json './internal/store'",
      targets: ["apps/api/internal/store/store_test.go"],
    });
    expect(clamp?.fail_to_pass).toEqual(["example.com/api/internal/store/TestClampLow"]);
    expect(clamp?.pass_to_pass).toEqual(["example.com/api/internal/store/TestClampHigh"]);
    expect(clamp?.symptoms[0]?.message).toContain("Clamp(-3, 0, 5) = -3, want 0");
  });

  it("drops a commit whose tests span two modules, with the reason", () => {
    expect(res.drops.find((d) => d.sha === fx.sha.multiModule)).toMatchObject({
      stage: "verify",
      code: "no_runner",
      detail:
        "the changed tests span 2 modules (apps/api, apps/worker); a mined task verifies one module",
    });
  });
});

describe.skipIf(!available)("mining TypeScript under node --test on docker-local", () => {
  const ns = newNs();
  const provider = new DockerLocalProvider({ baseImage: "node:22", labels: { [LABEL]: ns } });
  let tmp: string;
  let fx: TsWorkspaceFixture;
  let res: MineRepoTasksResult;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ab-tdm186-ts-"));
    fx = await buildTsWorkspaceFixture(join(tmp, "repo"));
    const lines: string[] = [];
    res = await mineRepoTasks(fx.repo, {
      provider,
      computer: { vcpu: 2, memoryMb: 2048 },
      log: (l) => lines.push(l),
    });
    if (process.env.ANYBENCH_MINE_LOG) console.log(lines.join("\n"));
  }, 600_000);

  afterAll(async () => {
    sweep(ns);
    await provider.dispose();
    await rm(tmp, { recursive: true, force: true });
  }, 120_000);

  it("uses the declared tsx loader from packages/gw and verifies both fixes 3/3", () => {
    MineReportSchema.parse(res.report);
    expect(res.tasks.map((t) => t.id).sort()).toEqual(
      [fx.sha.fixSlug, fx.sha.fixClamp].map(minedTaskId).sort(),
    );
    expectVerified3of3(res);
    const slug = res.tasks.find((t) => t.id === minedTaskId(fx.sha.fixSlug));
    expect(slug?.runner.kind).toBe("node-test");
    expect(slug?.runner.module_dir).toBe("packages/gw");
    // the root lockfile's manager, run at the root; the tests run from the package
    expect(slug?.runner.install_command).toBe("npm ci --no-audit --no-fund");
    expect(slug?.runner.test_command).toMatch(/^cd 'packages\/gw' && \{ /);
    expect(slug?.runner.test_command).toContain(
      `node '--import' 'tsx' --test --test-reporter=tap "$f"`,
    );
    expect(slug?.fail_to_pass).toEqual([
      "packages/gw/test/strings.test.ts > slugify collapses whitespace",
    ]);
    expect(slug?.pass_to_pass).toEqual(["packages/gw/test/strings.test.ts > slugify lowercases"]);
  });

  it("still refuses TypeScript tests in a package that declares no loader", () => {
    const d = res.drops.find((x) => x.sha === fx.sha.plainNoLoader);
    expect(d).toMatchObject({ stage: "verify", code: "no_runner" });
    expect(d?.detail).toContain(
      "node --test on TypeScript test files needs a loader, and tools/plain/package.json declares none",
    );
  });
});
