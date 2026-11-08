// TDM-49 docker-local end-to-end: a cli example trial through the REAL runner binary. Opt-in:
//   pnpm -r build && pnpm --filter @anybench/runner build:bin && BENCH_DOCKER_E2E=1 \
//     pnpm --filter @anybench/bench exec vitest run test/executor-docker-tdm49.test.ts
//
// A base computer gets the bun-compiled runner at ~/.anybench/bin/runner and is snapshotted (the
// env build's job in production); the executor forks that snapshot, writes secrets + workload +
// trial.json with putFile, launches the runner detached (setsid nohup, all three std streams
// redirected) and follows it through status.json alone (file-only: no ingest), then uploads the
// frozen bundle through the fs/read fallback. Every container is random-named and removed.
import { existsSync, readFileSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { newId, RunIdSchema, TrialIdSchema } from "@anybench/core";
import { createComputerRegistry, MemoryComputerStore } from "@anybench/envs";
import { decodeText, dockerLocalAvailable, DockerLocalProvider } from "@anybench/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeTrial, MemoryTrialExecStore, type ExecutorDeps } from "../src/index.js";

const enabled = process.env.BENCH_DOCKER_E2E === "1";
const BIN = join(
  import.meta.dirname,
  "..",
  "..",
  "runner",
  "dist",
  "bin",
  `runner-linux-${arch() === "arm64" ? "arm64" : "x64"}`,
);
const SECRET = "sk-tdm49-docker-e2e-secret-value-31337";

describe.skipIf(!enabled)("executor on docker-local with the real runner (TDM-49)", () => {
  const provider = new DockerLocalProvider({ execUser: "naive", enforceLimits: false });
  const computers = new MemoryComputerStore();
  const registry = createComputerRegistry({
    provider,
    store: computers,
    pricing: { pricePerBlockMicroUsd: 0n },
  });
  let snapshotId = "";
  const created: string[] = [];

  beforeAll(async () => {
    if (!(await dockerLocalAvailable())) throw new Error("docker is not available");
    if (!existsSync(BIN))
      throw new Error(`${BIN} missing: run pnpm --filter @anybench/runner build:bin`);
    const base = await provider.create({ name: "tdm49-e2e-base" });
    created.push(base.id);
    await provider.waitReady(base.id);
    await provider.putFile(base.id, ".anybench/bin/runner", readFileSync(BIN), { mode: 0o755 });
    const v = await provider.exec(base.id, "~/.anybench/bin/runner --version");
    expect(v.exitCode).toBe(0);
    snapshotId = (await provider.snapshot(base.id)).snapshotId;
    await provider.destroy(base.id);
  }, 300_000);

  afterAll(async () => {
    for (const row of computers.rows.values()) {
      if (row.providerId) await provider.destroy(row.providerId).catch(() => undefined);
    }
    for (const id of created) await provider.destroy(id).catch(() => undefined);
    if (snapshotId) await provider.deleteSnapshot(snapshotId).catch(() => undefined);
    await provider.dispose().catch(() => undefined);
  }, 120_000);

  it("forks, launches the runner detached, follows status.json to collecting, cleans up", async () => {
    const runId = newId(RunIdSchema);
    const trialId = newId(TrialIdSchema);
    const store = new MemoryTrialExecStore();
    store.seed({ id: trialId, run_id: runId });
    const uploads: Uint8Array[] = [];
    let sorted: string;
    let envMode: string;
    const deps: ExecutorDeps = {
      store,
      registry,
      ingest: null,
      owner: `tdm49-e2e~${Date.now()}`,
      timing: { pollMs: 500, leaseRefreshMs: 1_000, staleMs: 30_000, startTimeoutMs: 60_000 },
      source: {
        prepare: async () => ({
          job: {
            driver: {
              type: "cli",
              run: 'sleep 3 && sort "$1/words.txt" > "$2/sorted.txt" && echo "key=$MODEL_KEY"',
            },
            warmup_runs: 1,
            wall_clock_s: 60,
            heartbeat_s: 1,
            upload: { enabled: false },
          },
          computer: { snapshotId, vcpu: 1, memoryMb: 512 },
          secrets: { MODEL_KEY: SECRET },
          files: [{ path: "eval/in/words.txt", content: "delta\nalpha\ncharlie\nbravo\n" }],
        }),
      },
      fallbackUpload: async (_t, bytes) => {
        uploads.push(bytes);
        return { key: `runs/${runId}/trials/${trialId}/out.tar.gz` };
      },
    };

    const t0 = Date.now();
    const out = await executeTrial(deps, trialId, { keepComputer: true });
    const ms = Date.now() - t0;
    expect(out.kind).toBe("collected");
    if (out.kind !== "collected") return;
    const computerId = out.kept_computer_id!;
    const row = computers.rows.get(computerId)!;
    const pid = row.providerId!;
    try {
      sorted = decodeText(await provider.getFile(pid, "eval/out/sorted.txt"));
      envMode = (await provider.exec(pid, "stat -c %a ~/.anybench/env")).stdout.trim();
      const stdout = decodeText(await provider.getFile(pid, "eval/out/stdout.log"));
      expect(stdout).toContain("key=[REDACTED:MODEL_KEY]");
      expect(stdout).not.toContain(SECRET);
    } finally {
      await registry.destroy(computerId);
    }

    const t = (await store.get(trialId))!;
    expect(t.state).toBe("collecting");
    expect(t.exit_code).toBe(0);
    expect(t.machine).toMatchObject({ nproc: expect.any(Number) });
    expect(t.logs_url).toBe(`artifact:runs/${runId}/trials/${trialId}/out.tar.gz`);
    expect(sorted).toBe("alpha\nbravo\ncharlie\ndelta\n");
    expect(envMode).toBe("600");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]![0]).toBe(0x1f); // gzip
    expect(
      store.events
        .filter((e) => e.type === "trial.phase")
        .map((e) => (e.payload as { to: string }).to),
    ).toEqual(["forking", "installing", "warming", "running", "collecting"]);
    expect((await provider.list({ includeDestroyed: false })).map((c) => c.id)).not.toContain(pid);
    console.log(
      JSON.stringify({ trial_ms: ms, machine: t.machine, bundle_bytes: uploads[0]!.length }),
    );
  }, 300_000);
});
