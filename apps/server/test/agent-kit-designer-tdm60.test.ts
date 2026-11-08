// TDM-60 [6.6] step 6: designMinedAgentKit on local Postgres + FakeNaive, with tasks mined on
// docker-local from the TDM-186 fixture repo. One issue is "underspecified", one names a hidden
// test: both are dropped; the rest become a valid kit (template: kits/tandem-vs-claude-code).
// Needs Docker and Postgres; no spend.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mineRepoTasks, type MinedTask } from "@anybench/kit";
import { FakeNaive } from "@anybench/naive/fake";
import { DockerLocalProvider, dockerLocalAvailable } from "@anybench/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runs } from "../src/db/schema/index.js";
import { designMinedAgentKit } from "../src/orchestrator/agent-kit-designer.js";
import type { RunIntake, StageContext } from "../src/orchestrator/ports.js";
import { buildMineFixtureRepo } from "../../../packages/kit/test/tdm186-mine-fixture.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { seedUserTdm67 } from "./helpers/runs-tdm67.js";

const available = (await pgAvailableTdm11()) && (await dockerLocalAvailable());
const TANDEM_KIT = fileURLToPath(new URL("../../../kits/tandem-vs-claude-code/", import.meta.url));
const LABEL = "anybench.test-tdm60-server";
const ns = `t${Date.now().toString(36)}`;

describe.skipIf(!available)("designMinedAgentKit (TDM-60 step 6)", () => {
  let h: FreshDbTdm11;
  let tmp: string;
  let repo: string;
  let tasks: MinedTask[];
  const provider = new DockerLocalProvider({ baseImage: "node:22", labels: { [LABEL]: ns } });

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 4 });
    tmp = await mkdtemp(join(tmpdir(), "tdm60-akd-"));
    repo = (await buildMineFixtureRepo(join(tmp, "repo"))).repo;
    tasks = (
      await mineRepoTasks(repo, {
        provider,
        computer: { vcpu: 2, memoryMb: 2048 },
        repoUrl: "https://github.com/example/mine-fixture",
      })
    ).tasks;
  }, 600_000);
  afterAll(async () => {
    const out = spawnSync("docker", ["ps", "-aq", "--filter", `label=${LABEL}=${ns}`], {
      encoding: "utf8",
    });
    for (const id of out.stdout.split("\n").filter(Boolean)) spawnSync("docker", ["rm", "-f", id]);
    await provider.dispose();
    await rm(tmp, { recursive: true, force: true });
    await h?.drop();
  }, 120_000);

  it("writes issues from symptoms, drops underspecified and leaking ones, builds a valid kit", async () => {
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    const userId = await seedUserTdm67(h.db, "tdm60akd");
    const intake: RunIntake = {
      source: { kind: "github", github: "example/mine-fixture" },
      contenders: [],
      auto_go: false,
    };
    const [run] = await h.db
      .insert(runs)
      .values({ ownerId: userId, question: "q", budgetMicroUsd: 1_000_000n, intake })
      .returning();
    const ctx: StageContext = {
      run: {
        id: run!.id,
        owner_id: userId,
        project_id: null,
        question: "q",
        intake,
        budget_micro_usd: 1_000_000n,
        spent_micro_usd: 0n,
      },
      idempotencyKey: `${run!.id}:kit_draft:0`,
      signal: new AbortController().signal,
      emit: async () => {},
    };
    const naive = new FakeNaive();
    const leaf = tasks[1]!.fail_to_pass[0]!.split(" > ").pop()!;
    naive.script(
      "issue-writer",
      {
        output: {
          title: "Vague",
          body: "Something is off.",
          underspecified: true,
          why: "only expected true, got false",
        },
      },
      {
        output: { title: "Bad", body: `The case "${leaf}" fails.`, underspecified: false, why: "" },
      },
      ...tasks.slice(2).map((t) => ({
        output: {
          title: `A helper in ${t.area} misbehaves`,
          body: "It returns the wrong value for some inputs; it should follow the README.",
          underspecified: false,
          why: "",
        },
        costMicroUsd: 1_500n,
      })),
    );
    const dir = join(tmp, "kit");
    const r = await designMinedAgentKit({ db: h.db, client: naive }, ctx, {
      repoDir: repo,
      tasks,
      repo: { name: "mine-fixture", summary: "string and math helpers" },
      subject: {
        kind: "harness",
        name: "tandem",
        summary: "Tandem on mined issues.",
        better_means: ["more issues solved"],
      },
      template: { dir: TANDEM_KIT, contenders: ["claude-code-solo", "tandem"], subject: "tandem" },
      dir,
    });
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.dropped.map((d) => d.why)).toEqual([
      "underspecified: only expected true, got false",
      expect.stringMatching(/^the issue names the test/),
    ]);
    expect(r.kept).toHaveLength(tasks.length - 2);
    expect(r.spec.workloads).toHaveLength(tasks.length - 2);
    // every session is booked, including the two dropped ones
    expect(r.costMicroUsd).toBe(1_500n * BigInt(tasks.length - 2) + 2_000n);
    const instr = await readFile(join(dir, "workloads", r.kept[0]!, "instruction.md"), "utf8");
    expect(instr).toMatch(/^# A helper in /);
    // The session saw screened symptoms only: no hidden test id in any task message.
    for (const c of naive.sessionCreates.filter((x) => x.role === "issue-writer"))
      for (const t of tasks)
        for (const id of t.fail_to_pass) expect(c.body.message).not.toContain(id);
  }, 300_000);
});
