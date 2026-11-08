// TDM-60 [6.6] v1 scope (b): mining inside kit_draft.
//   - no provider and no cached mine → needs_human (never a silent skip);
//   - docker-local: ONE tagged infra mining computer, destroyed; the mine is cached by
//     repo + commit + miner version, and a rerun reuses it with no provider at all;
//   - too few verified tasks → needs_human with the counts and drop reasons;
//   - the orchestrator: a fixture harness repo from POST /runs through understand → kit_draft
//     (mine → issues → materialize → validate) → env_build → proof → awaiting_go, with the
//     docker-local provider for mining, FakeNaive for the agents and the fake pipeline for
//     env build / proof (smoke and baselines need a real agent: the live window).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectDigest } from "@anybench/core";
import { ingestLocalRepo, type RepoIngest } from "@anybench/kit";
import { FakeNaive } from "@anybench/naive/fake";
import { DockerLocalProvider, FakeProvider, dockerLocalAvailable } from "@anybench/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kits, runs } from "../src/db/schema/index.js";
import { FakePipeline } from "../src/orchestrator/fake.js";
import { kitBuilderStages } from "../src/orchestrator/kit-builder.js";
import { noSkeptic } from "../src/orchestrator/kit-designer.js";
import { localClone, mineForRun, miningRecipes } from "../src/orchestrator/mine-stage.js";
import type { StageContext } from "../src/orchestrator/ports.js";
import { writeRepoIngestCache } from "../src/orchestrator/repo-ingest-cache.js";
import { buildMineFixtureRepo } from "../../../packages/kit/test/tdm186-mine-fixture.js";
import { drainTdm54, MemQueueTdm54, workerTdm54 } from "./helpers/orchestrator-tdm54.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { runsAppTdm67, seedUserTdm67, type RunsAppTdm67 } from "./helpers/runs-tdm67.js";

const docker = await dockerLocalAvailable();
const pg = await pgAvailableTdm11();
const TANDEM_KIT = fileURLToPath(new URL("../../../kits/tandem-vs-claude-code/", import.meta.url));
const LABEL = "anybench.test-tdm60-mine";
const ns = `t${Date.now().toString(36)}`;
const URL_ = "https://github.com/example/mine-fixture";

function ctxOf(runId = "0195f3a2-7c1e-7d3a-9b1c-44aa00000060"): StageContext {
  return {
    run: {
      id: runId,
      owner_id: "u",
      project_id: null,
      question: "q",
      intake: {
        source: { kind: "github", github: "example/mine-fixture" },
        contenders: [],
        auto_go: false,
      },
      budget_micro_usd: 0n,
      spent_micro_usd: 0n,
    },
    idempotencyKey: `${runId}:kit_draft:0`,
    signal: new AbortController().signal,
    emit: async () => {},
  };
}

let fixture: RepoIngest;
let repo: string;
const tmp = mkdtempSync(join(tmpdir(), "tdm60-mine-"));

beforeAll(async () => {
  repo = (await buildMineFixtureRepo(join(tmp, "repo"))).repo;
  fixture = await ingestLocalRepo(repo, { githubUrl: URL_ });
}, 120_000);

describe("mineForRun without compute (TDM-60)", () => {
  it("holds when there is no provider and no cached mine", async () => {
    const r = await mineForRun(
      ctxOf(),
      fixture.digest,
      {
        provider: null,
        cacheDir: join(tmp, "cache-empty"),
        clonesDir: join(tmp, "clones-a"),
        clone: localClone(repo),
      },
      async () => {},
    );
    expect(r).toEqual({
      ok: false,
      reason: "mining needs a compute provider, and none is configured",
    });
  });

  it("picks the mining recipes from the digest's languages", () => {
    const d = {
      ...fixture.digest,
      languages: [
        { name: "Go", bytes: 900 },
        { name: "TypeScript", bytes: 100 },
        { name: "Shell", bytes: 1 },
      ],
    } as ProjectDigest;
    expect(miningRecipes(d)).toEqual(["git-time", "go", "node22"]);
  });

  it("holds a non-GitHub source", async () => {
    const d = { ...fixture.digest, source: { kind: "upload" } } as unknown as ProjectDigest;
    expect(
      await mineForRun(ctxOf(), d, { provider: new FakeProvider() }, async () => {}),
    ).toMatchObject({ ok: false });
  });
});

describe.skipIf(!docker)("mineForRun on docker-local (TDM-60)", () => {
  const provider = new DockerLocalProvider({ baseImage: "node:22", labels: { [LABEL]: ns } });
  afterAll(async () => {
    const left = spawnSync("docker", ["ps", "-aq", "--filter", `label=${LABEL}=${ns}`], {
      encoding: "utf8",
    });
    for (const id of left.stdout.split("\n").filter(Boolean)) spawnSync("docker", ["rm", "-f", id]);
    await provider.dispose();
  }, 120_000);

  it("one tagged infra computer, destroyed; cached by repo + commit + miner version; min-task gate", async () => {
    const said: string[] = [];
    const opts = {
      provider,
      cacheDir: join(tmp, "cache"),
      clonesDir: join(tmp, "clones"),
      clone: localClone(repo),
      recipes: () => [],
      computer: { vcpu: 2, memoryMb: 2048 },
    };
    const created: string[][] = [];
    const orig = provider.create.bind(provider);
    provider.create = async (spec) => {
      created.push([...(spec.tags ?? [])]);
      return orig(spec);
    };
    const r = await mineForRun(ctxOf(), fixture.digest, opts, async (t) => void said.push(t));
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.cached).toBe(false);
    expect(r.tasks.length).toBeGreaterThanOrEqual(3);
    expect(created).toEqual([["ab-infra-mine-0195f3a2"]]);
    expect(
      (await provider.list()).filter((c) => c.tags.includes("ab-infra-mine-0195f3a2")),
    ).toEqual([]);
    expect(readdirSync(join(tmp, "cache"))).toHaveLength(1);
    expect(said[0]).toMatch(
      /^mining https:\/\/github.com\/example\/mine-fixture at [0-9a-f]{7}: one mining computer/,
    );
    // A rerun (a crashed or retried stage) reuses the mine: no provider needed at all.
    const again = await mineForRun(
      ctxOf(),
      fixture.digest,
      { ...opts, provider: null },
      async () => {},
    );
    expect(again).toMatchObject({ ok: true, cached: true, tasks: r.tasks });
    // Too few verified tasks → needs_human with the counts and drop reasons.
    const few = await mineForRun(
      ctxOf(),
      fixture.digest,
      { ...opts, provider: null, minTasks: 99 },
      async () => {},
    );
    expect(few).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /^only \d+ task\(s\) verified from the history \(need 99\): \d+ candidate\(s\) over \d+ commits; drops: /,
      ),
    });
  }, 600_000);
});

describe.skipIf(!docker || !pg)(
  "orchestrator: a harness repo mined inside kit_draft (TDM-60)",
  () => {
    let h: FreshDbTdm11;
    let api: RunsAppTdm67;
    const provider = new DockerLocalProvider({
      baseImage: "node:22",
      labels: { [LABEL]: `${ns}o` },
    });
    beforeAll(async () => {
      h = await freshMigratedDbTdm11({ max: 8 });
      api = runsAppTdm67(h.url);
    }, 60_000);
    afterAll(async () => {
      const left = spawnSync("docker", ["ps", "-aq", "--filter", `label=${LABEL}=${ns}o`], {
        encoding: "utf8",
      });
      for (const id of left.stdout.split("\n").filter(Boolean))
        spawnSync("docker", ["rm", "-f", id]);
      await provider.dispose();
      await api?.dbh.close();
      await h?.drop();
    }, 120_000);

    it("understand → kit_draft (mine → issues → materialize → validate) → env_build → proof → awaiting_go", async () => {
      const userId = await seedUserTdm67(h.db, "tdm60mine");
      const cacheDir = join(tmp, "ingest-cache");
      await writeRepoIngestCache(fixture, { dir: cacheDir });
      const naive = new FakeNaive();
      naive.script("understander", {
        output: {
          kind: "harness",
          driver_type: "harness",
          driver_reason: "orchestrates coding agents",
          summary: "A fixture harness with a history of fixes and tests.",
          better_means: ["more issues solved"],
          benchable: "ready",
          reason: "runs on a VM",
          history: { minable: true, why: "fix + test commits" },
        },
      });
      naive.scriptDefault("issue-writer", {
        output: {
          title: "A helper returns the wrong value",
          body: "Some inputs give a wrong result; it should follow the README.",
          underspecified: false,
          why: "",
        },
        costMicroUsd: 1_200n,
      });
      const gen = join(tmp, "generated");
      const queue = new MemQueueTdm54();
      const w = workerTdm54(h.db, h.url, "tdm60-mine-worker", queue, new FakeProvider(), {
        agents: () =>
          kitBuilderStages({
            db: h.db,
            client: naive,
            ingestCacheDir: cacheDir,
            kitDesigner: {
              generatedKitsDir: gen,
              skeptic: noSkeptic,
              agentTemplate: () => ({
                dir: TANDEM_KIT,
                contenders: ["claude-code-solo", "tandem"],
                subject: "tandem",
              }),
              mining: {
                provider,
                cacheDir: join(tmp, "mine-cache-o"),
                clonesDir: join(tmp, "clones-o"),
                clone: localClone(repo),
                recipes: () => [],
                computer: { vcpu: 2, memoryMb: 2048 },
              },
            },
          }),
        pipeline: () => new FakePipeline({ digest: fixture.digest }),
        billingGate: () => async () => ({ allowed: true }),
        charges: () => null,
      });
      const before = api.jobs.jobs.length;
      const res = await api.app.request("http://api.test/runs", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
        body: JSON.stringify({
          question: "Is this harness better than plain Claude Code?",
          source: { kind: "github", github: "example/mine-fixture" },
          budget_micro_usd: "50000000",
          auto_go: false,
        }),
      });
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { run: { id: string } }).run.id;
      for (const j of api.jobs.jobs.slice(before))
        void queue.add(j.task, j.payload, { jobKey: j.jobKey });
      await drainTdm54(w, queue);
      const [run] = await h.db.select().from(runs).where(eq(runs.id, id));
      expect(run!.state, run!.pausedReason ?? "").toBe("awaiting_go");
      const [kit] = await h.db.select().from(kits).where(eq(kits.runId, id));
      expect(kit!.filesUrl).toMatch(new RegExp(`/${id}/v1$`));
      const dir = fileURLToPath(kit!.filesUrl!);
      expect(existsSync(join(dir, "gates/hidden-tests/check.sh"))).toBe(true);
      const spec = kit!.spec as {
        contenders: { id: string }[];
        workloads: unknown[];
        subject: { kind: string };
      };
      expect(spec.contenders.map((c) => c.id)).toEqual(["claude-code-solo", "tandem"]);
      expect(spec.subject.kind).toBe("harness");
      expect(spec.workloads.length).toBeGreaterThanOrEqual(3);
    }, 900_000);
  },
);
