// TDM-60 [6.6]: the kit designer stage on local Postgres + FakeNaive (no network, no spend).
//   design   a cli understanding → one kit-designer session → pinned, rendered, validated kit in
//            <generated>/<run>/v1 (files_dir); the task message carried the repo context.
//   fix      an invalid draft → ONE re-ask with the issues → a valid kit; still invalid → needs_human.
//   holds    coding-agent / harness (miner not built), unsupported drivers (understander's reason).
//   repair   previous spec + proof only: contender metrics planted on the run's trials and in a
//            proof reason never reach the designer; the repair input refuses a score field.
//   prereg   the kit is frozen at Go and a changed kit refuses to start trials.
//   Tandem   the curated kit is untouched (no kit-designer session).
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildKitDesignerRepairInput,
  KitDesignerRepairInputSchema,
  type KitDesignerRepairInput,
} from "@anybench/agents";
import { newId, KitIdSchema, type ProofCheckResult } from "@anybench/core";
import { RepoIngestSchema, type RepoIngest } from "@anybench/kit";
import { FakeNaive } from "@anybench/naive/fake";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kits, runs, trials, contenders } from "../src/db/schema/index.js";
import { kitBuilderStages, wantsMinedKit } from "../src/orchestrator/kit-builder.js";
import type {
  RunIntake,
  StageContext,
  StageEventDraft,
  Understanding,
} from "../src/orchestrator/ports.js";
import { writeRepoIngestCache } from "../src/orchestrator/repo-ingest-cache.js";
import { kitFilesSha256, preregistrationOf, preregMismatch } from "../src/orchestrator/prereg.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { seedUserTdm67 } from "./helpers/runs-tdm67.js";
import {
  TDM60_RG_DRAFT,
  tdm60FakeFetch,
} from "../../../packages/kit/test/tdm60-generate-fixtures.js";

const available = await pgAvailableTdm11();

function fixtureTdm60(name: string): RepoIngest {
  return RepoIngestSchema.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(`../../../packages/kit/fixtures/digests/${name}.json`, import.meta.url),
        ),
        "utf8",
      ),
    ),
  );
}

const CLI_UNDERSTANDING_TDM60: Understanding = {
  kind: "software",
  summary: "A line-oriented search tool.",
  better_means: ["less wall time on the same matches"],
  risks: [],
  benchable: "ready",
  reason: "ships rg",
  driver_type: "cli",
  supported: true,
  claims: [],
  subject_command: {
    binary: "rg",
    install_route: "github_release",
    package: null,
    version_command: "rg --version",
  },
};

describe.skipIf(!available)("kit designer stage (TDM-60)", () => {
  let h: FreshDbTdm11;
  let userId: string;
  let ingest: RepoIngest;
  const naive = new FakeNaive();
  // TDM-187: the default skeptic runs on every validated kit; its model finds nothing here, so
  // the verdict is the deterministic checks' (no block on a generated cli kit).
  naive.scriptDefault("skeptic", { output: { verdict: "pass", summary: "", findings: [] } });
  const cacheDir = mkdtempSync(path.join(tmpdir(), "tdm60-cache-"));
  const genDir = mkdtempSync(path.join(tmpdir(), "tdm60-gen-"));

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 8 });
    userId = await seedUserTdm67(h.db, "tdm60");
    ingest = fixtureTdm60("hyperfine");
    await writeRepoIngestCache(ingest, { dir: cacheDir });
  }, 60_000);
  afterAll(async () => {
    await h?.drop();
  });

  async function runTdm60(github: string): Promise<{ id: string; intake: RunIntake }> {
    const intake: RunIntake = { source: { kind: "github", github }, contenders: [], auto_go: true };
    const [r] = await h.db
      .insert(runs)
      .values({ ownerId: userId, question: "is it faster?", budgetMicroUsd: 10_000_000n, intake })
      .returning();
    return { id: r!.id, intake };
  }

  function ctxTdm60(run: { id: string; intake: RunIntake }, key = "kit_draft:0") {
    const emitted: StageEventDraft[] = [];
    const ctx: StageContext & { emitted: StageEventDraft[] } = {
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
      idempotencyKey: `${run.id}:${key}`,
      signal: new AbortController().signal,
      emit: async (d) => {
        emitted.push(...d);
      },
    };
    return ctx;
  }

  const stages = () =>
    kitBuilderStages({
      db: h.db,
      client: naive,
      ingestCacheDir: cacheDir,
      ingest: async () => {
        throw new Error("no re-ingest expected");
      },
      kitDesigner: {
        generatedKitsDir: genDir,
        pins: { fetch: tdm60FakeFetch(), cacheDir: null },
      },
    });
  const designerCreates = () => naive.sessionCreates.filter((c) => c.role === "kit-designer");

  it("designs, pins, renders and validates a cli kit in <generated>/<run>/v1", async () => {
    const run = await runTdm60("BurntSushi/ripgrep");
    const ctx = ctxTdm60(run);
    naive.script("kit-designer", { output: TDM60_RG_DRAFT, costMicroUsd: 41_000n });
    const before = designerCreates().length;
    const r = await stages().designKit(ctx, {
      digest: ingest.digest,
      understanding: CLI_UNDERSTANDING_TDM60,
      research: { baselines: [], sources: [] },
      previous: null,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.files_dir).toBe(path.join(genDir, run.id, "v1"));
    expect(existsSync(path.join(r.value.files_dir!, "anybench.yaml"))).toBe(true);
    expect(r.value.spec.contenders.map((c) => [c.id, c.version])).toEqual([
      ["ripgrep", "ripgrep 14.1.1"],
      ["gnu-grep", "GNU grep 3.11"],
    ]);
    expect(r.value.spec.gates[0]!.capture).toEqual({ from: "oracle" });
    expect(designerCreates().length).toBe(before + 1);
    const message = JSON.parse(designerCreates().at(-1)!.body.message) as Record<string, unknown>;
    expect(message.mode).toBe("design");
    expect(message.readme).toBeTruthy();
    expect((message.understanding as { driver_type: string }).driver_type).toBe("cli");
    const texts = ctx.emitted.map((e) => (e.payload as { text?: string }).text ?? "");
    expect(texts.at(-1)).toMatch(/designed kit v1: ripgrep \(ripgrep 14.1.1\) vs gnu-grep/);
  });

  it("re-asks once with the issues, then succeeds", async () => {
    const run = await runTdm60("BurntSushi/ripgrep");
    const broken = structuredClone(TDM60_RG_DRAFT);
    broken.contenders[0]!.install = { route: "github_release", repo: "x/none", tag: null };
    naive.script("kit-designer", { output: broken }, { output: TDM60_RG_DRAFT });
    const before = designerCreates().length;
    const r = await stages().designKit(ctxTdm60(run), {
      digest: ingest.digest,
      understanding: CLI_UNDERSTANDING_TDM60,
      research: null,
      previous: null,
    });
    expect(r.ok).toBe(true);
    const sessions = designerCreates().slice(before);
    expect(sessions).toHaveLength(2);
    const fix = JSON.parse(sessions[1]!.body.message) as { mode: string; issues: string[] };
    expect(fix.mode).toBe("fix");
    expect(fix.issues[0]).toMatch(/contender 'ripgrep': x\/none has no published release/);
  });

  it("holds with the issues when the re-ask is still invalid", async () => {
    const run = await runTdm60("BurntSushi/ripgrep");
    const broken = structuredClone(TDM60_RG_DRAFT);
    broken.contenders[0]!.install = { route: "github_release", repo: "x/none", tag: null };
    naive.script("kit-designer", { output: broken }, { output: broken });
    const r = await stages().designKit(ctxTdm60(run), {
      digest: ingest.digest,
      understanding: CLI_UNDERSTANDING_TDM60,
      research: null,
      previous: null,
    });
    expect(r).toMatchObject({
      ok: false,
      outcome: "needs_human",
      reason: expect.stringMatching(/does not validate after 2 drafts: contender 'ripgrep'/),
    });
  });

  it("holds a harness with no adapter and unsupported drivers with the understander's reason", async () => {
    const run = await runTdm60("example/agent");
    const before = designerCreates().length;
    const agent = await stages().designKit(ctxTdm60(run), {
      digest: ingest.digest,
      understanding: { ...CLI_UNDERSTANDING_TDM60, kind: "harness", driver_type: "harness" },
      research: null,
      previous: null,
    });
    expect(agent).toMatchObject({
      outcome: "needs_human",
      reason: expect.stringMatching(/no contender adapter for this harness yet/),
    });
    const lib = await stages().designKit(ctxTdm60(run), {
      digest: ingest.digest,
      understanding: {
        ...CLI_UNDERSTANDING_TDM60,
        driver_type: "lib",
        supported: false,
        reason: "driver lib is not supported yet: a library needs a bench shim",
      },
      research: null,
      previous: null,
    });
    expect(lib).toMatchObject({
      reason: "driver lib is not supported yet: a library needs a bench shim",
    });
    expect(designerCreates().length).toBe(before);
  });

  it("repair: the designer sees the previous kit and proof results, never contender metrics", async () => {
    const run = await runTdm60("BurntSushi/ripgrep");
    // v1: a designed kit, stored as the orchestrator would.
    naive.script("kit-designer", { output: TDM60_RG_DRAFT });
    const v1 = await stages().designKit(ctxTdm60(run), {
      digest: ingest.digest,
      understanding: CLI_UNDERSTANDING_TDM60,
      research: null,
      previous: null,
    });
    if (!v1.ok) throw new Error(v1.reason);
    const kitId = newId(KitIdSchema);
    await h.db.insert(kits).values({
      id: kitId,
      ownerId: userId,
      runId: run.id,
      version: 1,
      spec: JSON.parse(JSON.stringify(v1.value.spec)),
      filesUrl: pathToFileURL(v1.value.files_dir!).href,
      proof: null,
      hash: "h1",
    });
    // Contender metrics on the run (e.g. a previous attempt): distinctive values.
    const [c] = await h.db
      .insert(contenders)
      .values({ runId: run.id, source: "ripgrep", role: "subject", status: "kept", foundBy: "kit" })
      .returning();
    await h.db.insert(trials).values({
      ownerId: userId,
      runId: run.id,
      contenderId: c!.id,
      workloadId: "literal-search",
      repeat: 0,
      metrics: { wall_s: 7.654321, peak_rss_bytes: 98765432 },
    });
    const proof: ProofCheckResult[] = [
      {
        check: "no_secret_in_kit",
        pass: true,
        reason: "no secret in 25 kit file(s)",
        evidence: [],
      },
      {
        check: "do_less_fails",
        pass: false,
        reason: "do-less passed the gate: 'first-match-only' passed same-output on literal-search",
        evidence: [
          "wall_s=7.654321 median 7654.3 ms on literal-search (planted to test the scrub)",
        ],
      },
    ];
    naive.script("kit-designer", { output: TDM60_RG_DRAFT });
    const before = designerCreates().length;
    const r = await stages().designKit(ctxTdm60(run, "kit_draft:1"), {
      digest: ingest.digest,
      understanding: CLI_UNDERSTANDING_TDM60,
      research: null,
      previous: { spec: v1.value.spec, proof },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.files_dir).toBe(path.join(genDir, run.id, "v2"));
    const body = designerCreates().slice(before)[0]!.body.message;
    const message = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual([
      "mode",
      "note",
      "previous_draft",
      "previous_spec",
      "proof",
    ]);
    expect(message.mode).toBe("repair");
    expect(message.previous_draft).toMatchObject({ driver: "cli" });
    for (const planted of ["7.654321", "98765432", "7654.3"]) expect(body).not.toContain(planted);
    expect(body).toContain("do-less passed the gate: 'first-match-only'");
  });

  it("the repair input type and schema have no room for scores", () => {
    const ok: KitDesignerRepairInput = { previous_spec: {}, previous_draft: null, proof: [] };
    expect(() => buildKitDesignerRepairInput(ok)).not.toThrow();
    const withScores = {
      ...ok,
      // @ts-expect-error -- KitDesignerRepairInput has no field for contender scores
      scores: { ripgrep: 91 },
    } satisfies KitDesignerRepairInput;
    expect(KitDesignerRepairInputSchema.safeParse(withScores).success).toBe(false);
    expect(() => buildKitDesignerRepairInput(withScores)).toThrow(/scores/);
    expect(() =>
      buildKitDesignerRepairInput({
        ...ok,
        proof: [
          { check: "smoke_passes", pass: true, reason: "", evidence: [], metrics: [1] } as never,
        ],
      }),
    ).toThrow();
  });

  it("prereg: freezes hash, files, weights, primary, repeats; any change is named", async () => {
    const run = await runTdm60("BurntSushi/ripgrep");
    naive.script("kit-designer", { output: TDM60_RG_DRAFT });
    const r = await stages().designKit(ctxTdm60(run), {
      digest: ingest.digest,
      understanding: CLI_UNDERSTANDING_TDM60,
      research: null,
      previous: null,
    });
    if (!r.ok) throw new Error(r.reason);
    const row = {
      id: "k1",
      version: 1,
      hash: "h",
      filesUrl: pathToFileURL(r.value.files_dir!).href,
    };
    const frozen = await preregistrationOf(row, r.value.spec);
    expect(frozen).toMatchObject({ weights: { wall: 70, rss: 30 }, primary: "wall", repeats: 5 });
    expect(frozen.files_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preregMismatch(frozen, await preregistrationOf(row, r.value.spec))).toBeNull();
    await mkdir(path.join(r.value.files_dir!, "reference/same-output/x"), { recursive: true });
    await writeFile(
      path.join(r.value.files_dir!, "reference/same-output/x/stdout.txt"),
      "edited\n",
    );
    const edited = await preregistrationOf(row, { ...r.value.spec, repeats: 9 });
    expect(preregMismatch(frozen, edited)).toBe("kit files, repeats");
    expect(await kitFilesSha256(null)).toBeNull();
    expect(await readFile(path.join(r.value.files_dir!, "design/draft.json"), "utf8")).toContain(
      '"driver": "cli"',
    );
  });

  it("the Tandem repo takes the mined path when the question asks for a mined kit", () => {
    expect(wantsMinedKit("Benchmark Tandem on tasks mined from its own history")).toBe(true);
    expect(wantsMinedKit("a kit from the repo's history please")).toBe(true);
    expect(wantsMinedKit("is tandem faster than claude code?")).toBe(false);
  });

  it("the Tandem repo stays curated: no kit-designer session", async () => {
    const run = await runTdm60("jaximus808/tandem");
    const before = designerCreates().length;
    const r = await stages().designKit(ctxTdm60(run), {
      digest: null,
      understanding: null,
      research: null,
      previous: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.files_dir).toMatch(/kits\/tandem-vs-claude-code$/);
    expect(designerCreates().length).toBe(before);
  });
});
