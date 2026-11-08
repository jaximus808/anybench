// TDM-60 [6.6] LIVE, sessions only (no computers): the real understander + kit designer on
//   (1) BurntSushi/ripgrep: the generated, pinned, validated kit is written to TDM60_LIVE_KITS
//       (then proved on docker-local with test/proof-e2e-tdm44.test.ts + PROOF_E2E_KIT_DIR);
//   (2) jaximus808/tandem, bypassing the curated branch (naiveUnderstand + naiveKitDesigner
//       directly), from a local checkout (TDM60_TANDEM_DIR) since ingest needs the history.
//
//   cd apps/server && LOCAL_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench \
//     NAIVE_LIVE=1 TDM60_LIVE=1 TDM60_LIVE_KITS=<dir> TDM60_LIVE_OUT=<file> TDM60_TANDEM_DIR=<clone> \
//     node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs run \
//     test/kit-designer-naive-live-tdm60.test.ts --reporter=verbose
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestGitHubRepo,
  ingestLocalRepo,
  mineRepoTasks,
  runProofSuiteReport,
  validateGeneratedKit,
  type ProofTrialRequest,
  type RepoIngest,
} from "@anybench/kit";
import { DockerLocalProvider } from "@anybench/providers";
import { designMinedAgentKit } from "../src/orchestrator/agent-kit-designer.js";
import { hostProofRunnerTdm44 } from "../../../packages/kit/test/tdm44-proof-helpers.js";
import { createNaiveClientFromEnv } from "@anybench/naive";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentSessions, runs } from "../src/db/schema/index.js";
import { naiveUnderstand } from "../src/orchestrator/kit-builder.js";
import { naiveKitDesigner } from "../src/orchestrator/kit-designer.js";
import type { RunIntake, StageContext, StageEventDraft } from "../src/orchestrator/ports.js";
import { writeRepoIngestCache } from "../src/orchestrator/repo-ingest-cache.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { seedUserTdm67 } from "./helpers/runs-tdm67.js";

const LIVE =
  process.env.NAIVE_LIVE === "1" && process.env.TDM60_LIVE === "1" && !!process.env.NAIVE_API_KEY;
const available = LIVE && (await pgAvailableTdm11());
const log = (msg: string, data: unknown = {}) =>
  console.log(
    `TDM60-LIVE ${msg} ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
  );

describe.skipIf(!available)("kit designer on Naïve, sessions only (TDM-60)", () => {
  let h: FreshDbTdm11;
  let userId: string;
  const naive = LIVE ? createNaiveClientFromEnv() : (null as never);
  const cacheDir = mkdtempSync(path.join(tmpdir(), "tdm60-live-cache-"));
  const kitsDir =
    process.env.TDM60_LIVE_KITS ?? mkdtempSync(path.join(tmpdir(), "tdm60-live-kits-"));
  const out: Record<string, unknown> = {};

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 4 });
    userId = await seedUserTdm67(h.db, "tdm60live");
  }, 60_000);
  afterAll(async () => {
    if (process.env.TDM60_LIVE_OUT)
      await writeFile(
        process.env.TDM60_LIVE_OUT,
        JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      );
    await h?.drop();
  });

  async function ctxFor(github: string, stage: string) {
    const intake: RunIntake = {
      source: { kind: "github", github },
      contenders: [],
      auto_go: false,
    };
    const [r] = await h.db
      .insert(runs)
      .values({ ownerId: userId, question: "is it faster?", budgetMicroUsd: 10_000_000n, intake })
      .returning();
    const emitted: StageEventDraft[] = [];
    const ctx: StageContext = {
      run: {
        id: r!.id,
        owner_id: userId,
        project_id: null,
        question: "is it faster?",
        intake,
        budget_micro_usd: 10_000_000n,
        spent_micro_usd: 0n,
      },
      idempotencyKey: `${r!.id}:${stage}:0`,
      signal: new AbortController().signal,
      emit: async (d) => {
        emitted.push(...d);
        for (const e of d) {
          const t = (e.payload as { text?: string }).text;
          if (t) log("message", { text: t.slice(0, 800) });
        }
      },
    };
    return { ctx, runId: r!.id };
  }

  async function designFor(name: string, github: string, ingest: RepoIngest) {
    await writeRepoIngestCache(ingest, { dir: cacheDir });
    const u = await ctxFor(github, "understand");
    const understood = await naiveUnderstand(
      { db: h.db, client: naive, ingestCacheDir: cacheDir },
      u.ctx,
      ingest.digest,
    );
    log(`${name} understand`, { result: understood.result, cost: understood.costMicroUsd });
    const d = await ctxFor(github, "kit_draft");
    const design = naiveKitDesigner({
      db: h.db,
      client: naive,
      ingestCacheDir: cacheDir,
      generatedKitsDir: kitsDir,
    });
    const r = await design(d.ctx, {
      digest: ingest.digest,
      understanding: understood.result.ok
        ? (understood.result.value as never)
        : (understood.verdict?.understanding as never),
      research: { baselines: [], sources: [] },
      previous: null,
    });
    const sessions = await h.db.select().from(agentSessions);
    log(`${name} design`, {
      ok: r.ok,
      ...(r.ok ? { dir: r.value.files_dir } : { reason: r.reason }),
    });
    out[name] = {
      understanding: understood.verdict?.understanding ?? null,
      understand_cost_micro_usd: understood.costMicroUsd,
      design: r.ok ? { files_dir: r.value.files_dir, spec: r.value.spec } : r,
      sessions: sessions
        .filter((s) => s.runId === u.runId || s.runId === d.runId)
        .map((s) => ({ role: s.role, status: s.status, cost_micro_usd: s.costMicroUsd })),
    };
    return r;
  }

  it(
    "ripgrep: a pinned, validated generated kit",
    async () => {
      const ingest = await ingestGitHubRepo("BurntSushi/ripgrep", {
        ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
      });
      const r = await designFor("ripgrep", "BurntSushi/ripgrep", ingest);
      expect(r.ok).toBe(true);
    },
    20 * 60_000,
  );

  it.skipIf(!process.env.TDM60_TANDEM_DIR)(
    "jaximus808/tandem through the generated path (curated branch bypassed)",
    async () => {
      const ingest = await ingestLocalRepo(process.env.TDM60_TANDEM_DIR!, {
        githubUrl: "https://github.com/jaximus808/tandem",
      });
      await designFor("tandem", "jaximus808/tandem", ingest);
    },
    20 * 60_000,
  );

  // Step 6 on the real Tandem repo: mine its history on docker-local, write the issues on Naïve
  // (issue-writer sessions only), materialize the kit, prove oracle + do-less + mutation with
  // host trials and the real gate (go / node on this machine). TDM60_TANDEM_MINE=1.
  it.skipIf(!process.env.TDM60_TANDEM_MINE || !process.env.TDM60_TANDEM_DIR)(
    "jaximus808/tandem: a generated agent kit from its own history",
    async () => {
      const repoDir = process.env.TDM60_TANDEM_DIR!;
      const provider = new DockerLocalProvider({
        baseImage: process.env.TDM60_MINE_IMAGE ?? "golang:1.26-bookworm",
        labels: { "anybench.tdm60-live-mine": "1" },
      });
      let mined;
      try {
        mined = await mineRepoTasks(repoDir, {
          provider,
          computer: { vcpu: 4, memoryMb: 4096 },
          repoUrl: "https://github.com/jaximus808/tandem",
          modelCutoff: process.env.TDM60_MODEL_CUTOFF ?? "2026-03-01",
          targetTasks: 30,
          maxVerify: 60,
          log: (l: string) => log("mine", { l }),
        });
      } finally {
        await provider.dispose();
      }
      log("mined", { verified: mined.tasks.length, drops: mined.report.drop_counts });
      out.tandem_mined = { report: mined.report };
      if (mined.tasks.length === 0) return;
      const { ctx } = await ctxFor("jaximus808/tandem", "kit_draft");
      const dir = join(kitsDir, "tandem-agent-kit");
      const readme = readFileSync(join(repoDir, "README.md"), "utf8").slice(0, 4000);
      const r = await designMinedAgentKit({ db: h.db, client: naive }, ctx, {
        repoDir,
        tasks: mined.tasks,
        repo: {
          name: "tandem",
          summary: "a shared task queue for parallel AI coding-agent sessions",
        },
        readmeExcerpt: readme,
        subject: {
          kind: "harness",
          name: "tandem",
          summary:
            "Tandem (3 workers) vs plain Claude Code on issues mined from Tandem's own history.",
          better_means: ["more issues solved", "less time and cost per solved issue"],
        },
        template: {
          dir: fileURLToPath(new URL("../../../kits/tandem-vs-claude-code/", import.meta.url)),
          contenders: ["claude-code-solo", "tandem"],
          subject: "tandem",
        },
        dir,
      });
      log(
        "tandem agent kit",
        r.ok ? { kept: r.kept, dropped: r.dropped, cost: r.costMicroUsd } : r,
      );
      out.tandem_agent_kit = r.ok
        ? { dir: r.dir, kept: r.kept, dropped: r.dropped, cost: r.costMicroUsd }
        : r;
      if (!r.ok) return;
      const v = await validateGeneratedKit(dir);
      const files = (root: string, rel = ""): string[] =>
        readdirSync(join(root, rel)).flatMap((e) => {
          const p = rel ? `${rel}/${e}` : e;
          return statSync(join(root, p)).isDirectory() ? files(root, p) : [p];
        });
      const behave = (req: ProofTrialRequest) => {
        const input = join(dir, "workloads", req.workloadId, "input");
        const f: Record<string, Uint8Array> = {};
        for (const p of files(input)) f[`workspace/${p}`] = readFileSync(join(input, p));
        const od =
          req.overlay?.id === "upstream-fix"
            ? "proof/oracle"
            : (req.overlay?.env?.AB_OVERLAY_DIR ?? null);
        const o = od ? join(dir, od, req.workloadId) : null;
        if (o && existsSync(o))
          for (const p of files(o)) f[`workspace/${p}`] = readFileSync(join(o, p));
        return {
          files: f,
          metrics: [{ name: "wall_s", value: 1, gate_id: "hidden-tests", level: "trial" }],
        };
      };
      const report = await runProofSuiteReport(v.kit!, {
        runner: hostProofRunnerTdm44(v.kit!, behave),
        concurrency: 2,
      });
      out.tandem_proof = { checks: report.checks, mutation: report.mutation };
      for (const c of report.checks)
        log("tandem proof", { check: c.check, pass: c.pass, reason: c.reason.slice(0, 400) });
    },
    120 * 60_000,
  );
});
