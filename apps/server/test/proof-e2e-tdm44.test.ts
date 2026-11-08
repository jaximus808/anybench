// TDM-44 [4.12] end to end: the six proof checks on the cli example (ripgrep vs GNU grep, the
// honest-vs-cheater kit) through the REAL trial path: the env image (recipes + runner binary +
// subject files + contender installs, then a snapshot), bench executeTrial with the runner binary
// on a fork of it for every proof trial, bench runGates on a fresh scoring computer for every gate
// run. Opt-in, two ways:
//
//   docker-local (no spend; needs Docker and `pnpm --filter @anybench/runner build:bin`):
//     cd apps/server && PROOF_DOCKER_E2E=1 pnpm exec vitest run test/proof-e2e-tdm44.test.ts
//   Naïve LIVE (spends credit: two image builds plus ~25 computer blocks, under $1):
//     cd apps/server && NAIVE_LIVE=1 PROOF_LIVE=1 node --env-file=<repo>/.env \
//       ../../node_modules/vitest/vitest.mjs run test/proof-e2e-tdm44.test.ts
//
// Writes a JSON summary to PROOF_E2E_LOG when set (docs/findings/proof-suite.md quotes it).
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROOF_CHECKS } from "@anybench/core";
import {
  buildEnvSnapshot,
  KIT_DIR_REL,
  MemoryComputerStore,
  recipesForProfile,
  runnerFromBytes,
  type RecipeArch,
} from "@anybench/envs";
import { loadKit, runProofSuiteReport } from "@anybench/kit";
import { createNaiveClient } from "@anybench/naive";
import {
  dockerLocalAvailable,
  DockerLocalProvider,
  NaiveProvider,
  type ComputeProvider,
} from "@anybench/providers";
import { afterAll, describe, expect, it } from "vitest";
import { providerProofRunner } from "../src/jobs/proof-runner.js";
import {
  defaultRunnerBinDir,
  SCORING_RECIPES,
  subjectPlan,
} from "../src/orchestrator/env-build.js";

const CLI = fileURLToPath(new URL("../../../packages/kit/examples/cli/", import.meta.url));
const RUN_ID = "0195f3a2-7c1e-7d3a-9b1c-44aa00000044";
const DOCKER = process.env.PROOF_DOCKER_E2E === "1" && (await dockerLocalAvailable());
const LIVE =
  process.env.NAIVE_LIVE === "1" && process.env.PROOF_LIVE === "1" && !!process.env.NAIVE_API_KEY;
const log = (msg: string, data: unknown = {}) =>
  console.log(
    `PROOF-E2E ${msg} ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
  );

function runnerBins(): Partial<Record<RecipeArch, Uint8Array>> {
  const dir = defaultRunnerBinDir(process.env.ANYBENCH_RUNNER_BIN_DIR);
  const out: Partial<Record<RecipeArch, Uint8Array>> = {};
  for (const arch of ["x64", "arm64"] as const) {
    try {
      out[arch] = new Uint8Array(readFileSync(path.join(dir, `runner-linux-${arch}`)));
    } catch {
      // not built for that arch
    }
  }
  return out;
}

async function proveCliExample(
  provider: ComputeProvider,
  opts: { recipes: readonly string[]; scoringImage: boolean; pricePerBlockMicroUsd: bigint },
) {
  const kit = await loadKit(CLI);
  const cleanups: (() => Promise<unknown>)[] = [];
  const t0 = Date.now();
  try {
    const plan = await subjectPlan(kit.dir, kit.spec);
    const [subject, scoring] = await Promise.all([
      buildEnvSnapshot({
        provider,
        spec: { vcpu: 2, memoryMb: 4096, diskGb: 20 },
        label: "tdm44-proof",
        recipes: opts.recipes,
        runner: runnerFromBytes(runnerBins()),
        files: plan.files,
        installs: plan.installs,
        log: (m, d) => log(`env: ${m}`, d),
      }),
      opts.scoringImage
        ? buildEnvSnapshot({
            provider,
            spec: { vcpu: 2, memoryMb: 4096, diskGb: 20 },
            label: "tdm44-scoring",
            recipes: SCORING_RECIPES,
            log: (m, d) => log(`scoring image: ${m}`, d),
          })
        : Promise.resolve(null),
    ]);
    cleanups.push(() => provider.deleteSnapshot(subject.snapshotId));
    if (scoring) cleanups.push(() => provider.deleteSnapshot(scoring.snapshotId));
    const buildMs = Date.now() - t0;
    log("images built", {
      subject: subject.snapshotId,
      scoring: scoring?.snapshotId ?? null,
      buildMs,
    });

    const store = new MemoryComputerStore();
    const runner = providerProofRunner({
      provider,
      kit,
      env: {
        env_id: subject.snapshotId,
        detail: {
          env: subject.recipes.env,
          path: subject.recipes.path,
          kit_dir: KIT_DIR_REL,
          ...(scoring ? { scoring_snapshot_id: scoring.snapshotId } : {}),
        },
      },
      runId: RUN_ID,
      store,
      pricePerBlockMicroUsd: opts.pricePerBlockMicroUsd,
      log: (m, d) => log(m, d),
    });
    const t1 = Date.now();
    let report;
    try {
      report = await runProofSuiteReport(kit, { runner, concurrency: 4, log: (m, d) => log(m, d) });
    } finally {
      const swept = await runner.sweep();
      log("swept", { swept });
    }
    const rows = [...store.rows.values()];
    const summary = {
      checks: report.checks,
      infra: report.infra,
      trials: report.trials,
      gateRuns: report.gateRuns,
      computers: rows.length,
      destroyed: rows.filter((r) => r.status === "destroyed").length,
      blocks: rows.reduce((n, r) => n + r.blocksBilled, 0),
      cost_micro_usd: rows.reduce((n, r) => n + r.costMicroUsd, 0n),
      build_ms: buildMs,
      proof_ms: Date.now() - t1,
    };
    log("summary", summary);
    if (process.env.PROOF_E2E_LOG) {
      await writeFile(
        process.env.PROOF_E2E_LOG,
        JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      );
    }
    return summary;
  } finally {
    for (const c of cleanups.reverse())
      await c().catch((e: unknown) => log("cleanup failed", String(e)));
  }
}

function expectAllSix(summary: Awaited<ReturnType<typeof proveCliExample>>) {
  expect(summary.infra).toEqual([]);
  expect(summary.checks.map((c) => c.check)).toEqual([...PROOF_CHECKS]);
  for (const c of summary.checks)
    expect(c.pass, `${c.check}: ${c.reason}\n${c.evidence.join("\n")}`).toBe(true);
  expect(summary.destroyed).toBe(summary.computers);
}

describe.skipIf(!DOCKER)("proof suite on docker-local (real runner + gate runner)", () => {
  const ns = `t${Date.now().toString(36)}`;
  const provider = new DockerLocalProvider({ labels: { "anybench.test-tdm44": ns } });
  afterAll(async () => {
    const left = await provider.list({ includeDestroyed: false });
    for (const c of left) await provider.destroy(c.id).catch(() => undefined);
    await provider.dispose();
    expect(
      left.map((c) => c.id),
      "the proof leaked computers",
    ).toEqual([]);
  }, 120_000);

  it("the honest-vs-cheater cli kit passes all six checks", async () => {
    // The cli driver's own collectors (GNU time, hyperfine); the scoring computer is a fresh base box.
    const summary = await proveCliExample(provider, {
      recipes: ["git-time", "hyperfine"],
      scoringImage: false,
      pricePerBlockMicroUsd: 0n,
    });
    expectAllSix(summary);
  }, 3_600_000);
});

describe.skipIf(!LIVE)("proof suite on Naïve (live)", () => {
  it("the honest-vs-cheater cli kit passes all six checks; nothing is left running", async () => {
    const naive = createNaiveClient({
      apiKey: process.env.NAIVE_API_KEY!,
      ...(process.env.NAIVE_BASE_URL ? { baseUrl: process.env.NAIVE_BASE_URL } : {}),
    });
    const before = await naive.credits.show();
    log("balance before", before);
    const provider = new NaiveProvider({ client: naive });
    let summary;
    try {
      summary = await proveCliExample(provider, {
        recipes: recipesForProfile("base")!,
        scoringImage: true,
        pricePerBlockMicroUsd: 27_600n,
      });
    } finally {
      const left = await provider.list({ includeDestroyed: false }).catch(() => []);
      log(
        "computers left",
        left.map((c) => ({ id: c.id, tags: c.tags })),
      );
      const after = await naive.credits.show().catch(() => null);
      log("balance after", after);
    }
    expectAllSix(summary);
  }, 3_600_000);
});
