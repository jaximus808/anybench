// TDM-56 [6.2]: the kit builder's understand stage. The repo-ingest cache (no DB), then
// kitBuilderStages on local Postgres with FakeNaive recorded outputs: a CLI → ready/cli, a library
// → held "not supported yet", docs-only → failed, the Tandem repo → the curated path with no Naïve
// session; and one orchestrator run through the understand stage. No network, no spend.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectDigest } from "@anybench/core";
import { IngestError, RepoIngestSchema, type RepoContext, type RepoIngest } from "@anybench/kit";
import { FakeNaive } from "@anybench/naive/fake";
import { FakeProvider } from "@anybench/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSessions, costEntries, runs } from "../src/db/schema/index.js";
import { CURATED_KIT_UNAVAILABLE } from "../src/orchestrator/curated.js";
import { FakePipeline } from "../src/orchestrator/fake.js";
import {
  defaultAgentStages,
  kitBuilderStages,
  UNDERSTANDER_BUDGET_MICRO_USD,
} from "../src/orchestrator/kit-builder.js";
import {
  UnderstandingSchema,
  type RunIntake,
  type StageContext,
  type StageEventDraft,
} from "../src/orchestrator/ports.js";
import {
  loadRepoIngest,
  readRepoIngestCache,
  repoIngestCachePath,
  writeRepoIngestCache,
} from "../src/orchestrator/repo-ingest-cache.js";
import { configTdm14 } from "./helpers/server-tdm14.js";
import { drainTdm54, MemQueueTdm54, workerTdm54 } from "./helpers/orchestrator-tdm54.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { runsAppTdm67, seedUserTdm67, type RunsAppTdm67 } from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();

function fixtureTdm56(name: string): RepoIngest {
  const file = fileURLToPath(
    new URL(`../../../packages/kit/fixtures/digests/${name}.json`, import.meta.url),
  );
  return RepoIngestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
const HYPERFINE = fixtureTdm56("hyperfine");

function hashTdm56(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/** A Python library (no console script): ingest with its own digest hash. */
function libIngestTdm56(): RepoIngest {
  const context: RepoContext = {
    ...HYPERFINE.context,
    tree: {
      paths: ["README.md", "pyproject.toml", "fastmath/__init__.py", "tests/test_core.py"],
      dirs: [{ path: "fastmath", files: 1, bytes: 9_000 }],
      truncated: false,
    },
    readme: { path: "README.md", text: "# fastmath\n\nimport fastmath\n", truncated: false },
    manifests: [
      {
        path: "pyproject.toml",
        kind: "pyproject.toml",
        text: '[project]\nname = "fastmath"\n',
        truncated: false,
      },
    ],
    recent_test_commits: [],
  };
  const digest: ProjectDigest = {
    ...HYPERFINE.digest,
    source: { kind: "github", url: "https://github.com/example/fastmath", ref: "main" },
    name: "fastmath",
    summary: "Fast numeric helpers",
    languages: [{ name: "Python", bytes: 9_000 }],
    entrypoints: [{ kind: "library", name: "fastmath" }],
    build_commands: ["pip install -e ."],
    test_commands: ["pytest"],
    suggested_driver_types: ["lib"],
    hash: hashTdm56(0x56_01),
  };
  return { digest, context };
}

/** A docs-only repo. */
function docsIngestTdm56(): RepoIngest {
  const digest: ProjectDigest = {
    ...HYPERFINE.digest,
    source: { kind: "github", url: "https://github.com/example/awesome", ref: "main" },
    name: "awesome",
    summary: "A list of links",
    languages: [{ name: "Markdown", bytes: 3_000 }],
    entrypoints: [],
    build_commands: [],
    test_commands: [],
    suggested_driver_types: [],
    hash: hashTdm56(0x56_02),
  };
  const context: RepoContext = {
    ...HYPERFINE.context,
    tree: { paths: ["README.md"], dirs: [], truncated: false },
    readme: { path: "README.md", text: "# Awesome\n- [a](https://a.example)\n", truncated: false },
    manifests: [],
    tests: { files: 0, dirs: [], sample: [] },
    benchmarks: { files: 0, dirs: [], sample: [] },
    recent_test_commits: [],
  };
  return { digest, context };
}

/** Recorded understander answers (the shape deepseek-v4-flash returns live). */
const CLI_ANSWER_TDM56 = {
  kind: "software",
  driver_type: "cli",
  driver_reason: "ships the hyperfine binary (src/main.rs) with release tags",
  summary: "A command-line benchmarking tool. Developers use it to time shell commands.",
  better_means: ["lower warm wall time", "lower peak RSS"],
  risks: ["timing noise on shared VMs"],
  benchable: "ready",
  reason: "a Rust CLI that runs headless on Linux",
  claims: [],
  subject_command: {
    binary: "hyperfine",
    install_route: "github_release",
    package: "hyperfine",
    version_command: "hyperfine --version",
  },
  history: null,
  labelled_conversations: null,
};
const LIB_ANSWER_TDM56 = {
  ...CLI_ANSWER_TDM56,
  driver_type: "lib",
  driver_reason: "a Python package imported as `fastmath`, with no binary",
  subject_command: null,
};
const DOCS_ANSWER_TDM56 = {
  ...CLI_ANSWER_TDM56,
  driver_type: "web",
  benchable: "skip",
  reason: "a curated list of links: nothing to run",
  subject_command: null,
};

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));

describe("repo ingest cache (TDM-56)", () => {
  it("round-trips a RepoIngest under its digest hash; corrupt or mismatched files read as a miss", async () => {
    const dir = tmp("tdm56-cache-");
    const file = await writeRepoIngestCache(HYPERFINE, { dir });
    expect(file).toBe(path.join(dir, `${HYPERFINE.digest.hash}.json`));
    expect(await readRepoIngestCache(HYPERFINE.digest.hash, { dir })).toEqual(HYPERFINE);
    expect(await readRepoIngestCache(hashTdm56(1), { dir })).toBeNull();
    writeFileSync(repoIngestCachePath(hashTdm56(2), dir), "{not json");
    expect(await readRepoIngestCache(hashTdm56(2), { dir })).toBeNull();
    // A file whose digest has another hash is not this digest's context.
    writeFileSync(repoIngestCachePath(hashTdm56(3), dir), JSON.stringify(HYPERFINE));
    expect(await readRepoIngestCache(hashTdm56(3), { dir })).toBeNull();
    expect(() => repoIngestCachePath("../../etc/passwd", dir)).toThrow();
  });

  it("loadRepoIngest: cache hit, else re-ingest the digest's commit (and cache it), else unavailable", async () => {
    const dir = tmp("tdm56-load-");
    const calls: string[] = [];
    const ingest = async (input: string) => {
      calls.push(input);
      return HYPERFINE;
    };
    const miss = await loadRepoIngest(HYPERFINE.digest, { dir, ingest });
    expect(miss.from).toBe("ingest");
    expect(calls).toEqual([
      `https://github.com/sharkdp/hyperfine#${HYPERFINE.digest.source.kind === "github" ? HYPERFINE.digest.source.commit : ""}`,
    ]);
    const hit = await loadRepoIngest(HYPERFINE.digest, { dir, ingest });
    expect(hit).toEqual({ ingest: HYPERFINE, from: "cache" });
    expect(calls).toHaveLength(1);

    const broken = await loadRepoIngest(libIngestTdm56().digest, {
      dir,
      ingest: async () => {
        throw new IngestError("git_failed", "fetch failed");
      },
    });
    expect(broken).toMatchObject({
      ingest: null,
      from: "unavailable",
      why: "re-ingest failed: git_failed",
    });
    await expect(
      loadRepoIngest(libIngestTdm56().digest, {
        dir,
        ingest: async () => {
          throw new Error("our bug");
        },
      }),
    ).rejects.toThrow("our bug");
  });

  it("defaultAgentStages is the curated stages without NAIVE_API_KEY", () => {
    const config = configTdm14("postgres://x@localhost:1/x");
    expect(config.NAIVE_API_KEY).toBeUndefined();
    const stages = defaultAgentStages({ db: {} as never, config });
    expect(Object.keys(stages).sort()).toEqual(["analyze", "designKit", "research", "understand"]);
  });
});

describe.skipIf(!available)("kitBuilderStages on Postgres + FakeNaive (TDM-56)", () => {
  let h: FreshDbTdm11;
  let api: RunsAppTdm67;
  let userId: string;
  const naive = new FakeNaive();
  const cacheDir = tmp("tdm56-stages-cache-");

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 8 });
    api = runsAppTdm67(h.url);
    userId = await seedUserTdm67(h.db, "tdm56");
    for (const fx of [HYPERFINE, libIngestTdm56(), docsIngestTdm56()]) {
      await writeRepoIngestCache(fx, { dir: cacheDir });
    }
  }, 60_000);

  afterAll(async () => {
    await api?.dbh.close();
    await h?.drop();
  });

  async function runTdm56(github: string): Promise<{ id: string; intake: RunIntake }> {
    const intake: RunIntake = {
      source: { kind: "github", github },
      contenders: [],
      auto_go: true,
    };
    const [r] = await h.db
      .insert(runs)
      .values({ ownerId: userId, question: "is it faster?", budgetMicroUsd: 10_000_000n, intake })
      .returning();
    return { id: r!.id, intake };
  }

  function ctxTdm56(run: { id: string; intake: RunIntake }): StageContext & {
    emitted: StageEventDraft[];
  } {
    const emitted: StageEventDraft[] = [];
    return {
      emitted,
      run: {
        id: run.id,
        owner_id: userId,
        project_id: null,
        question: "is it faster?",
        intake: run.intake,
        budget_micro_usd: 10_000_000n,
        spent_micro_usd: 0n,
      },
      idempotencyKey: `${run.id}:understand:0`,
      signal: new AbortController().signal,
      emit: async (d) => {
        emitted.push(...d);
      },
    };
  }

  const stages = () =>
    kitBuilderStages({
      db: h.db,
      client: naive,
      ingestCacheDir: cacheDir,
      ingest: async () => {
        throw new Error("no re-ingest expected: the cache holds every fixture");
      },
    });
  const creates = () => naive.calls.filter((c) => c.method === "sessions.create").length;
  const texts = (c: { emitted: StageEventDraft[] }) =>
    c.emitted.map((e) => (e.payload as { text?: string }).text ?? "");

  it("a CLI repo: one understander session → ready / cli / supported, cost booked", async () => {
    const run = await runTdm56("sharkdp/hyperfine");
    const ctx = ctxTdm56(run);
    naive.script("understander", { output: CLI_ANSWER_TDM56, costMicroUsd: 3_100n });
    const before = creates();
    const r = await stages().understand(ctx, { digest: HYPERFINE.digest });
    expect(r).toMatchObject({
      ok: true,
      value: {
        kind: "software",
        driver_type: "cli",
        supported: true,
        benchable: "ready",
        subject_command: { binary: "hyperfine", install_route: "github_release" },
      },
    });
    expect(creates()).toBe(before + 1);
    // The task message carried the repo context from the cache (numbered README, manifests).
    const create = naive.sessionCreates.at(-1)!;
    const message = JSON.parse(create.body.message) as Record<string, unknown>;
    expect((message.readme as { lines: string }).lines).toMatch(/^1\| /);
    expect(message.manifests).toBeInstanceOf(Array);
    expect(create.body.budgetMicroUsd).toBe(UNDERSTANDER_BUDGET_MICRO_USD);
    const [row] = await h.db.select().from(agentSessions).where(eq(agentSessions.runId, run.id));
    expect(row).toMatchObject({ role: "understander", status: "done", costMicroUsd: 3_100n });
    const costs = await h.db.select().from(costEntries).where(eq(costEntries.runId, run.id));
    expect(costs.map((c) => c.amountMicroUsd)).toEqual([3_100n]);
    expect(texts(ctx).some((t) => t.startsWith("software / driver cli / ready"))).toBe(true);
  });

  it("a library: held with 'driver lib is not supported yet: <why>'", async () => {
    const lib = libIngestTdm56();
    const ctx = ctxTdm56(await runTdm56("example/fastmath"));
    naive.script("understander", { output: LIB_ANSWER_TDM56 });
    const r = await stages().understand(ctx, { digest: lib.digest });
    expect(r).toEqual({
      ok: false,
      outcome: "needs_human",
      reason:
        "driver lib is not supported yet: a Python package imported as `fastmath`, with no binary",
    });
  });

  it("a library the model calls a CLI is still held (code corrects cli → lib)", async () => {
    const lib = libIngestTdm56();
    const ctx = ctxTdm56(await runTdm56("example/fastmath"));
    naive.script("understander", { output: CLI_ANSWER_TDM56 });
    const r = await stages().understand(ctx, { digest: lib.digest });
    expect(r).toMatchObject({ ok: false, outcome: "needs_human" });
    expect(!r.ok && r.reason).toMatch(/^driver lib is not supported yet: no executable entrypoint/);
    expect(texts(ctx).join("\n")).toContain("corrected: driver cli → lib");
  });

  it("a docs-only repo fails with the reason", async () => {
    const docs = docsIngestTdm56();
    const ctx = ctxTdm56(await runTdm56("example/awesome"));
    naive.script("understander", { output: DOCS_ANSWER_TDM56 });
    const r = await stages().understand(ctx, { digest: docs.digest });
    expect(r).toEqual({
      ok: false,
      outcome: "fail",
      reason: "not benchable: a curated list of links: nothing to run",
    });
  });

  it("the Tandem repo takes the curated path untouched: no Naïve session", async () => {
    const ctx = ctxTdm56(await runTdm56("jaximus808/tandem"));
    const before = naive.calls.length;
    const s = stages();
    const u = await s.understand(ctx, { digest: fixtureTdm56("agentcanvas").digest });
    expect(u).toMatchObject({ ok: true, value: { kind: "harness", reason: "curated kit" } });
    const research = await s.research(ctx, {
      digest: fixtureTdm56("agentcanvas").digest,
      understanding: UnderstandingSchema.parse((u as { value: unknown }).value),
    });
    expect(research).toEqual({ ok: true, value: { baselines: [], sources: [] } });
    const kit = await s.designKit(ctx, {
      digest: null,
      understanding: null,
      research: null,
      previous: null,
    });
    expect(kit.ok).toBe(true);
    expect(naive.calls.slice(before)).toEqual([]);
    expect(texts(ctx)).toContain("using the curated Tandem kit");
  });

  it("research is a pass-through and designKit delegates (TDM-60's seam) for other repos", async () => {
    const ctx = ctxTdm56(await runTdm56("sharkdp/hyperfine"));
    const r = await stages().research(ctx, {
      digest: HYPERFINE.digest,
      understanding: {
        kind: "software",
        summary: "x",
        better_means: ["y"],
        risks: [],
        benchable: "ready",
        reason: "",
      },
    });
    expect(r).toEqual({ ok: true, value: { baselines: [], sources: [] } });
    expect(texts(ctx)[0]).toMatch(/^pass-through for v1/);
    const held = await stages().designKit(ctx, {
      digest: HYPERFINE.digest,
      understanding: null,
      research: null,
      previous: null,
    });
    expect(held).toEqual({ ok: false, outcome: "needs_human", reason: CURATED_KIT_UNAVAILABLE });
    const designed = await kitBuilderStages({
      db: h.db,
      client: naive,
      designKit: async () => ({ ok: false, outcome: "needs_human", reason: "tdm60 designer" }),
    }).designKit(ctx, {
      digest: HYPERFINE.digest,
      understanding: null,
      research: null,
      previous: null,
    });
    expect(designed).toMatchObject({ reason: "tdm60 designer" });
  });

  // ---------- one orchestrator run through the understand stage ----------

  async function orchestrateTdm56(digest: ProjectDigest, github: string) {
    const queue = new MemQueueTdm54();
    const w = workerTdm54(h.db, h.url, `tdm56-worker-${digest.name}`, queue, new FakeProvider(), {
      agents: () =>
        kitBuilderStages({
          db: h.db,
          client: naive,
          ingestCacheDir: cacheDir,
        }),
      pipeline: () => new FakePipeline({ digest }),
      billingGate: () => async () => ({ allowed: true }),
      charges: () => null,
    });
    const before = api.jobs.jobs.length;
    const res = await api.app.request("http://api.test/runs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
      body: JSON.stringify({
        question: `Is ${digest.name} faster?`,
        source: { kind: "github", github },
        budget_micro_usd: "50000000",
      }),
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { run: { id: string } }).run.id;
    for (const j of api.jobs.jobs.slice(before))
      void queue.add(j.task, j.payload, { jobKey: j.jobKey });
    await drainTdm54(w, queue);
    const [run] = await h.db.select().from(runs).where(eq(runs.id, id));
    return run!;
  }

  it("orchestrator: a CLI passes understand (stored with driver_type) and holds at kit design", async () => {
    naive.script("understander", { output: CLI_ANSWER_TDM56 });
    const run = await orchestrateTdm56(HYPERFINE.digest, "sharkdp/hyperfine");
    expect(run).toMatchObject({ state: "needs_human", pausedReason: CURATED_KIT_UNAVAILABLE });
    const outputs = run.stageOutputs as {
      held_from?: string;
      understand?: Record<string, unknown>;
      research?: unknown;
    };
    expect(outputs.held_from).toBe("kit_draft");
    expect(outputs.understand).toMatchObject({
      driver_type: "cli",
      supported: true,
      benchable: "ready",
    });
    expect(outputs.research).toEqual({ baselines: [], sources: [] });
    const sessions = await h.db.select().from(agentSessions).where(eq(agentSessions.runId, run.id));
    expect(sessions.map((s) => [s.role, s.status])).toEqual([["understander", "done"]]);
  }, 60_000);

  it("orchestrator: a library holds at understand with the not-supported reason", async () => {
    naive.script("understander", { output: LIB_ANSWER_TDM56 });
    const run = await orchestrateTdm56(libIngestTdm56().digest, "example/fastmath");
    expect(run.state).toBe("needs_human");
    expect(run.pausedReason).toMatch(/^driver lib is not supported yet: /);
    expect((run.stageOutputs as { held_from?: string }).held_from).toBe("understand");
  }, 60_000);
});
