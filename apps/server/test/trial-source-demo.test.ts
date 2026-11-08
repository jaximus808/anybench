// demo-env-trials: the kit trial source (verbs, workspace prep, env image, Tandem vary setup) and
// its per-trial Naïve proxy key (minted, proxy.env written 0600, stored on the trial, reused on a
// re-attach, the old key revoked on a new attempt), plus the env_build stage's snapshot cache.
// FakeProvider + FakeProxyKeys + local Postgres; no network.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKit } from "@anybench/kit";
import { FakeProvider } from "@anybench/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contenders, envs, kits, runs, trials } from "../src/db/schema/index.js";
import { recordProxyKey } from "../src/jobs/trial-execute.js";
import { providerEnvBuild } from "../src/orchestrator/env-build.js";
import {
  kitTrialSource,
  preparedJob,
  substituteVerb,
  trialProxyCap,
} from "../src/orchestrator/trial-source.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { seedUserTdm67 } from "./helpers/runs-tdm67.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TANDEM_KIT = path.resolve(here, "../../../kits/tandem-vs-claude-code");
const CLI_KIT = path.resolve(here, "../../../packages/kit/examples/cli");
const available = await pgAvailableTdm11();

describe("kit trial source: job shape (demo-env-trials)", () => {
  it("substitutes the verb placeholders with the runner's env", () => {
    expect(substituteVerb("adapters/x/driver.sh run {task} {workspace} {in} {out}")).toBe(
      'adapters/x/driver.sh run "$EVAL_IN/instruction.md" "$EVAL_WS" "$EVAL_IN" "$EVAL_OUT"',
    );
  });

  it("Tandem kit: verbs run from ~/kit, start preps the workspace, C runs at TANDEM_WORKERS=3", async () => {
    const kit = await loadKit(TANDEM_KIT);
    const spec = { ...kit.spec, vary: { ...kit.spec.vary, TANDEM_WORKERS: [3] } };
    const c = preparedJob(spec, "tandem", "todo-api", {
      env: { NODE_HOME: "/opt/node" },
      path: ["/opt/x/bin"],
      kit_dir: "kit",
    });
    expect(c.driver.cwd).toBe("kit");
    expect(c.driver.run).toBe('adapters/tandem/driver.sh run "$EVAL_IN/instruction.md" "$EVAL_WS"');
    expect(c.driver.start).toContain(
      "cp 'workloads/todo-api/instruction.md' \"$EVAL_IN/instruction.md\"",
    );
    expect(c.driver.start).toContain("bash 'workloads/todo-api/setup.sh' \"$EVAL_WS\"");
    expect(c.env?.TANDEM_WORKERS).toBe("3");
    expect(c.env?.AB_TOKEN_SOURCE).toBe("naive_proxy");
    expect(c.env?.NODE_HOME).toBe("/opt/node");
    expect(c.env?.PATH?.startsWith("/opt/x/bin:")).toBe(true);
    // Three TANDEM_WORKERS setups cannot map onto one trial row: refused, never guessed.
    expect(() => preparedJob(kit.spec, "tandem", "todo-api", null)).toThrow(/vary setups/);
    // A: Claude Code solo, its token cap at list price is over the $3 ceiling.
    const a = kit.spec.contenders.find((x) => x.id === "claude-code-solo")!;
    expect(trialProxyCap(a.driver)).toBe(3_000_000n);
    expect(trialProxyCap(a.driver, 100_000_000n)).toBe(24_000_000n);
  });
});

describe.skipIf(!available)("kit trial source + env build on Postgres (demo-env-trials)", () => {
  let h: FreshDbTdm11;
  beforeAll(async () => {
    h = await freshMigratedDbTdm11();
  }, 60_000);
  afterAll(async () => {
    await h?.drop();
  });

  async function seed(kitDir: string, spec: unknown, stageOutputs: unknown = {}) {
    const userId = await seedUserTdm67(h.db, "demo-src");
    const [run] = await h.db
      .insert(runs)
      .values({
        ownerId: userId,
        question: "q",
        state: "running",
        budgetMicroUsd: 1_000_000n,
        stageOutputs,
      })
      .returning();
    const [kit] = await h.db
      .insert(kits)
      .values({
        ownerId: userId,
        runId: run!.id,
        version: 1,
        spec,
        filesUrl: pathToFileURL(kitDir).href,
        hash: "e".repeat(64),
      })
      .returning();
    await h.db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
    return { userId, run: run!, kit: kit! };
  }

  it("asks the executor for a proxy key (model + cap) and records the minted key on the trial", async () => {
    const kit = await loadKit(TANDEM_KIT);
    const spec = { ...kit.spec, vary: { ...kit.spec.vary, TANDEM_WORKERS: [3] } };
    const { userId, run } = await seed(TANDEM_KIT, spec, {
      env: { env_id: "snap_demo", detail: { env: {}, path: [], kit_dir: "kit" } },
    });
    const [cont] = await h.db
      .insert(contenders)
      .values({
        runId: run.id,
        source: "claude-code-solo",
        role: "baseline",
        foundBy: "kit",
        status: "kept",
      })
      .returning();
    const [trial] = await h.db
      .insert(trials)
      .values({
        ownerId: userId,
        runId: run.id,
        contenderId: cont!.id,
        workloadId: "todo-api",
        repeat: 0,
      })
      .returning();
    const exec = {
      id: trial!.id,
      run_id: run.id,
      owner_id: userId,
      attempt: 1,
      computer_id: null,
    } as never;
    const p = await kitTrialSource(h.db, { proxyCapMicroUsd: 3_000_000n }).prepare(exec);
    expect(p.computer).toMatchObject({
      snapshotId: "snap_demo",
      vcpu: 4,
      memoryMb: 8192,
      diskGb: 20,
    });
    expect(p.naive_proxy).toEqual({
      model: "anthropic/claude-opus-5.5",
      smallFastModel: "anthropic/claude-opus-5.5",
      capMicroUsd: 3_000_000n,
    });
    expect(p.job.driver.cwd).toBe("kit");
    expect(p.job.env?.CC_SETUP).toBe("claude-code-solo");

    await recordProxyKey(h.db)(exec, {
      keyId: "key_demo123",
      createdAt: "2026-11-08T00:00:00.000Z",
    });
    const [stored] = await h.db.select().from(trials).where(eq(trials.id, trial!.id));
    expect(stored).toMatchObject({ proxyKeyId: "key_demo123", proxyKeyAttempt: 1 });
    expect(stored!.proxyKeyCreatedAt?.toISOString()).toBe("2026-11-08T00:00:00.000Z");
  });

  it("env_build: builds once, caches by spec hash, holds (never throws) on a build failure", async () => {
    const kit = await loadKit(CLI_KIT);
    const { run, kit: kitRow } = await seed(CLI_KIT, kit.spec);
    const provider = new FakeProvider();
    provider.onExec("uname -m", () => "x86_64\n");
    provider.onExec(/runner --version$/, () => "runner 0\n");
    provider.onExec(/bash \.\/healthcheck\.sh$/, () => ""); // every recipe already healthy
    provider.onExec(
      (c) => c.includes("kit/adapters/"),
      () => "",
    );
    const runner = {
      sha256: () => "f".repeat(64),
      install: async () => undefined,
    };
    const ctx = { run: { id: run.id }, signal: new AbortController().signal } as never;
    const build = providerEnvBuild({ db: h.db, provider, runner: async () => runner });
    const r1 = await build(ctx, { kit_id: kitRow.id, kit: kit.spec });
    expect(r1.ok).toBe(true);
    const v1 = (r1 as { value: { env_id: string; detail: { cached: boolean; kit_dir: string } } })
      .value;
    expect(v1.detail).toMatchObject({ cached: false, kit_dir: "kit" });
    // Subject files only: adapters, workloads; never gates/, reference/ or proof/.
    const fork = await provider.waitReady((await provider.fork(v1.env_id)).id);
    await expect(
      provider.getFile(fork.id, "/home/naive/kit/adapters/ripgrep/driver.sh"),
    ).resolves.toBeDefined();
    await expect(
      provider.getFile(fork.id, "/home/naive/kit/workloads/literal-search/input/pattern.txt"),
    ).resolves.toBeDefined();
    await expect(
      provider.getFile(fork.id, "/home/naive/kit/gates/same-matches/check.sh"),
    ).rejects.toThrow();
    await expect(
      provider.getFile(fork.id, "/home/naive/kit/reference/same-matches/literal-search/stdout.txt"),
    ).rejects.toThrow();
    const r2 = await build(ctx, { kit_id: kitRow.id, kit: kit.spec });
    expect((r2 as { value: { env_id: string; detail: { cached: boolean } } }).value).toMatchObject({
      env_id: v1.env_id,
      detail: { cached: true },
    });
    expect((await h.db.select().from(envs)).length).toBe(2); // the subject image and the scoring image
    expect((v1.detail as { scoring_snapshot_id?: string }).scoring_snapshot_id).toMatch(/.+/);

    // A failing contender install: needs_human with the reason, nothing left running.
    provider.onExec(
      (c) => c.includes("kit/adapters/ripgrep/install.sh"),
      () => ({ exitCode: 3, stderr: "curl: (6)" }),
    );
    const other = {
      ...kit.spec,
      env: { ...kit.spec.env!, resources: { ...kit.spec.env!.resources, vcpu: 4 } },
    };
    const r3 = await build(ctx, { kit_id: kitRow.id, kit: other });
    expect(r3).toMatchObject({ ok: false, outcome: "needs_human" });
    expect((r3 as { reason: string }).reason).toMatch(
      /env build failed \(ours, not billed\).*install/s,
    );
    expect(
      (await provider.list()).filter((c) => c.tags.some((t) => t.startsWith("ab-infra-envbuild-"))),
    ).toHaveLength(0);
  });

  it("TDM-60 env_build: declared toolchains go on both images (and their hashes); unknown holds", async () => {
    const kit = await loadKit(CLI_KIT);
    const { run, kit: kitRow } = await seed(CLI_KIT, kit.spec);
    const provider = new FakeProvider();
    provider.onExec("uname -m", () => "x86_64\n");
    provider.onExec(/runner --version$/, () => "runner 0\n");
    provider.onExec(/bash \.\/healthcheck\.sh$/, () => "");
    provider.onExec(
      (c) => c.includes("kit/adapters/"),
      () => "",
    );
    const runner = { sha256: () => "e".repeat(64), install: async () => undefined };
    const ctx = { run: { id: run.id }, signal: new AbortController().signal } as never;
    const build = providerEnvBuild({ db: h.db, provider, runner: async () => runner });
    const withGo = {
      ...kit.spec,
      env: {
        ...kit.spec.env!,
        resources: { ...kit.spec.env!.resources, vcpu: 3 },
        toolchains: [{ name: "go", version: "1.26" }],
      },
    };
    const before = (await h.db.select().from(envs)).length;
    const r = await build(ctx, { kit_id: kitRow.id, kit: withGo });
    expect(r.ok).toBe(true);
    const detail = (r as { value: { detail: { recipes: string[] } } }).value.detail;
    expect(detail.recipes).toContain("go@1.26.3");
    const rows = (await h.db.select().from(envs)).slice(before);
    const scoringRow = rows.find((x) => x.profile === "scoring")!;
    expect((scoringRow.health as { recipes: string[] }).recipes).toContain("go");
    const unknown = {
      ...kit.spec,
      env: { ...kit.spec.env!, toolchains: [{ name: "rust", version: "stable" }] },
    };
    expect(await build(ctx, { kit_id: kitRow.id, kit: unknown })).toEqual({
      ok: false,
      outcome: "needs_human",
      reason: "env build: toolchain 'rust' has no recipe yet (known: node, python, go)",
    });
  });
});
