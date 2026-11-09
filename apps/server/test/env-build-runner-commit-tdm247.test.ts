// TDM-247: a stale runner never reaches a trial image. The env build refuses a runner binary that
// carries no build commit (the Nov 7 runner) or, from a checkout, one built from another commit;
// the snapshot cache key carries the runner's commit, so an image baked with an older runner is
// not forked; and the installed runner's `--version` must report the commit in the binary.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKit } from "@anybench/kit";
import { FakeProvider } from "@anybench/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envs, kits, runs } from "../src/db/schema/index.js";
import { providerEnvBuild, runnerInstaller } from "../src/orchestrator/env-build.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { seedUserTdm67 } from "./helpers/runs-tdm67.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_KIT = path.resolve(here, "../../../packages/kit/examples/cli");
const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";
const available = await pgAvailableTdm11();

/** A fake runner binary: some bytes, then the marker build-bin.mjs compiles in (or none). */
function binDir(build: string | null, archs = ["x64", "arm64"]): string {
  const d = mkdtempSync(path.join(tmpdir(), "tdm247-bins-"));
  for (const a of archs) {
    const marker = build ? `anybench-runner-build:${build}` : "token cap crossed";
    writeFileSync(path.join(d, `runner-linux-${a}`), `\x7fELF fake ${a}\0${marker}\0tail`);
  }
  return d;
}

describe("TDM-247 runnerInstaller", () => {
  it("refuses a binary with no build commit (built before TDM-247)", async () => {
    await expect(runnerInstaller({ binDir: binDir(null) })).rejects.toThrow(
      /carries no build commit .*build:bin/,
    );
  });

  it("from a checkout, refuses a binary built from another commit", async () => {
    await expect(
      runnerInstaller({ binDir: binDir(OLD), expect: { commit: NEW, dirty: false } }),
    ).rejects.toThrow(new RegExp(`built from ${OLD}, but this checkout's runner is ${NEW}`));
    await expect(
      runnerInstaller({ binDir: binDir(NEW), expect: { commit: NEW, dirty: true } }),
    ).rejects.toThrow(/-dirty/);
  });

  it("a current binary: the installer knows its build", async () => {
    const r = await runnerInstaller({ binDir: binDir(NEW), expect: { commit: NEW, dirty: false } });
    expect(r!.build!("x64")).toEqual({ commit: NEW, dirty: false });
    expect(r!.build!("arm64")).toEqual({ commit: NEW, dirty: false });
  });
});

describe.skipIf(!available)("TDM-247 env_build on Postgres: the runner commit", () => {
  let h: FreshDbTdm11;
  beforeAll(async () => {
    h = await freshMigratedDbTdm11();
  }, 60_000);
  afterAll(async () => {
    await h?.drop();
  });

  async function seed(spec: unknown) {
    const userId = await seedUserTdm67(h.db, "tdm247");
    const [run] = await h.db
      .insert(runs)
      .values({ ownerId: userId, question: "q", state: "running", budgetMicroUsd: 1_000_000n })
      .returning();
    const [kit] = await h.db
      .insert(kits)
      .values({
        ownerId: userId,
        runId: run!.id,
        version: 1,
        spec,
        filesUrl: pathToFileURL(CLI_KIT).href,
        hash: "e".repeat(64),
      })
      .returning();
    await h.db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
    return { run: run!, kit: kit! };
  }

  function provider(reports: () => string) {
    const p = new FakeProvider();
    p.onExec("uname -m", () => "x86_64\n");
    p.onExec(/runner --version$/, () => `0.1.0 ${reports()}\n`);
    p.onExec(/bash \.\/healthcheck\.sh$/, () => "");
    p.onExec(
      (c) => c.includes("kit/adapters/"),
      () => "",
    );
    return p;
  }

  // The same sha256 for both, so only the commit can tell the images apart.
  const runnerAt = (commit: string) => ({
    sha256: () => "d".repeat(64),
    build: () => ({ commit, dirty: false }),
    install: async () => undefined,
  });

  it("an image baked with an older runner is not reused; the detail names the runner commit", async () => {
    const kit = await loadKit(CLI_KIT);
    const spec = {
      ...kit.spec,
      env: { ...kit.spec.env!, resources: { ...kit.spec.env!.resources, vcpu: 5 } },
    };
    const { run, kit: row } = await seed(spec);
    let reports = OLD;
    const p = provider(() => reports);
    const ctx = { run: { id: run.id }, signal: new AbortController().signal } as never;
    const old = await providerEnvBuild({
      db: h.db,
      provider: p,
      runner: async () => runnerAt(OLD),
    })(ctx, { kit_id: row.id, kit: spec });
    expect(old).toMatchObject({
      ok: true,
      value: { detail: { cached: false, runner_commit: OLD } },
    });

    reports = NEW;
    const build = providerEnvBuild({ db: h.db, provider: p, runner: async () => runnerAt(NEW) });
    const fresh = await build(ctx, { kit_id: row.id, kit: spec });
    expect(fresh).toMatchObject({
      ok: true,
      value: { detail: { cached: false, runner_commit: NEW } },
    });
    const ids = [old, fresh].map((r) => (r as { value: { env_id: string } }).value.env_id);
    expect(ids[1]).not.toBe(ids[0]);
    const again = await build(ctx, { kit_id: row.id, kit: spec });
    expect(again).toMatchObject({
      ok: true,
      value: { env_id: ids[1], detail: { cached: true, runner_commit: NEW } },
    });
    const hashes = (await h.db.select().from(envs)).map((e) => e.specHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("holds when the installed runner reports another commit, or the runner is refused", async () => {
    const kit = await loadKit(CLI_KIT);
    const spec = {
      ...kit.spec,
      env: { ...kit.spec.env!, resources: { ...kit.spec.env!.resources, vcpu: 6 } },
    };
    const { run, kit: row } = await seed(spec);
    const ctx = { run: { id: run.id }, signal: new AbortController().signal } as never;
    const p = provider(() => OLD);
    const r = await providerEnvBuild({ db: h.db, provider: p, runner: async () => runnerAt(NEW) })(
      ctx,
      { kit_id: row.id, kit: spec },
    );
    expect(r).toMatchObject({ ok: false, outcome: "needs_human" });
    expect((r as { reason: string }).reason).toMatch(
      new RegExp(`installed runner reports '0.1.0 ${OLD}', not build ${NEW}`),
    );
    const refused = await providerEnvBuild({
      db: h.db,
      provider: p,
      runner: () => runnerInstaller({ binDir: binDir(null) }),
    })(ctx, { kit_id: row.id, kit: spec });
    expect(refused).toMatchObject({ ok: false, outcome: "needs_human" });
    expect((refused as { reason: string }).reason).toMatch(/carries no build commit/);
  });
});
