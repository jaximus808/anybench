// Live run 01a1c1f2 (2026-11-09): trials of the harness league's A (claude-code-solo, BYOK) failed
// ~4 s into `installing` as provider_forbidden, "naive forbidden (403): path is outside the sandbox
// working directory" (docs/findings/naive-fs-missing-parent.md, "Race: the runner creates ~/eval/out
// between the read and the check"). The executor's first poll after the launch reads
// ~/eval/out/status.json while ~/eval/out does not exist yet (prepareAndLaunch removes it, the
// runner recreates it), so Naïve answers 403; NaiveProvider.getFile then asked the shell
// `test -e`, and when the runner had written status.json in between, the 403 was kept and the trial
// failed. Here the FakeNaive's live 403 rule plus a runner that starts in exactly that window,
// through the real executor and the trial source's job for the league kit's contenders.
import {
  executeTrial,
  MemoryTrialExecStore,
  type ExecutorDeps,
  type TrialPrepared,
} from "@anybench/bench";
import { newId, TrialIdSchema } from "@anybench/core";
import { createComputerRegistry, KIT_DIR_REL, MemoryComputerStore } from "@anybench/envs";
import { loadKit } from "@anybench/kit";
import { FakeNaive, type NaiveComputersApi } from "@anybench/naive";
import { NaiveProvider } from "@anybench/providers";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_KEY_SECRET, preparedJob } from "../src/orchestrator/trial-source.js";

const KIT = fileURLToPath(new URL("../../../kits/harness-league/", import.meta.url));
const RUN_ID = "0195f3a2-7c1e-7d3a-9b1c-44aa00000403";
const HOME = "/home/naive";
const STATUS = `${HOME}/eval/out/status.json`;
const enc = new TextEncoder();

/** A finished runner's status.json for this trial (phase done, outcome ok). */
function doneStatus(trialId: string, attempt: number): string {
  const now = new Date().toISOString();
  return JSON.stringify({
    trial_id: trialId,
    run_id: RUN_ID,
    attempt,
    runner_version: "test",
    pid: 4242,
    hostname: "fork",
    phase: "done",
    trial_state: "collecting",
    started_at: now,
    updated_at: now,
    heartbeat_at: now,
    phases: [],
    push: { mode: "file_only", sent_batches: 0, failed_posts: 0, last_error: null },
    events: { count: 0, bytes: 0 },
    run: { exit_code: 0, signal: null, duration_ms: 1, timed_out: false },
    upload: null,
    result: { outcome: "ok", reason: null, failure_class: null },
  });
}

/**
 * FakeNaive computers whose runner (the detached `~/.anybench/bin/runner --trial <id>` launch)
 * creates ~/eval/out and writes status.json right after the worker's fs/read of status.json was
 * refused for the missing directory, i.e. before the provider's shell check runs: the live race.
 */
function racingRunner(naive: FakeNaive): { api: NaiveComputersApi; races: () => number } {
  const real = naive.computers;
  const launched = new Map<string, { trialId: string; attempt: number }>();
  let races = 0;
  const api = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "exec") {
        return async (id: string, command: string, opts?: { timeoutMs?: number }) => {
          if (/\.anybench\/bin\/runner.* --trial /.test(command)) {
            const job = JSON.parse(
              new TextDecoder().decode(await real.readFile(id, `${HOME}/.anybench/trial.json`)),
            ) as { trial_id: string; attempt: number };
            launched.set(id, { trialId: job.trial_id, attempt: job.attempt });
          }
          return real.exec(id, command, opts);
        };
      }
      if (prop === "readFile") {
        return async (id: string, path: string) => {
          try {
            return await real.readFile(id, path);
          } catch (err) {
            const run = launched.get(id);
            if (path === STATUS && run && (err as { status?: number }).status === 403) {
              // The runner, starting now: mkdir ~/eval/out, then the atomic status.json.
              launched.delete(id);
              races++;
              await real.mkdir(id, `${HOME}/eval/out`);
              await real.writeFile(id, STATUS, enc.encode(doneStatus(run.trialId, run.attempt)));
            }
            throw err;
          }
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as NaiveComputersApi;
  return { api, races: () => races };
}

async function leagueTrial(contenderId: string) {
  const kit = await loadKit(KIT);
  const naive = new FakeNaive({ computers: { timeScale: 0.01 } });
  const { api, races } = racingRunner(naive);
  const provider = new NaiveProvider({
    client: { computers: api },
    readyIntervalMs: 5,
    putFileCheck: { attempts: 40, intervalMs: 10 },
  });
  // The env image: the home link, a subject file, then the snapshot (env_build's shape).
  const b = await provider.waitReady((await provider.create({ tags: ["ab-infra-envbuild-x"] })).id);
  await provider.putFile(b.id, `${HOME}/kit/adapters/claude-code-solo/CLAUDE.md`, "# A\n");
  const snap = await provider.snapshot(b.id);
  await provider.destroy(b.id);

  const workload = kit.spec.workloads[0]!.id;
  // kitTrialSource's job for this contender, with the run owner's BYOK key as its secret.
  const job = preparedJob(kit.spec, contenderId, workload, { kit_dir: KIT_DIR_REL });
  expect(job.env?.AB_TOKEN_SOURCE).toBe("anthropic_key");
  const prepared: TrialPrepared = {
    job,
    computer: { vcpu: 1, memoryMb: 1024, diskGb: 10, snapshotId: snap.snapshotId },
    secrets: { [ANTHROPIC_KEY_SECRET]: "sk-ant-fork-403-not-a-real-key" },
  };
  const store = new MemoryTrialExecStore();
  const trialId = newId(TrialIdSchema);
  store.seed({ id: trialId, run_id: RUN_ID });
  const warnings: string[] = [];
  const deps: ExecutorDeps = {
    logger: {
      info: () => undefined,
      warn: (o, m) => warnings.push(`${m ?? ""} ${String((o as { err?: unknown }).err ?? "")}`),
      error: (o, m) => warnings.push(`${m ?? ""} ${String((o as { err?: unknown }).err ?? "")}`),
    },
    store,
    registry: createComputerRegistry({
      provider,
      store: new MemoryComputerStore(),
      pricing: { pricePerBlockMicroUsd: 0n },
    }),
    source: { prepare: async () => prepared },
    ingest: null,
    owner: `fork-403~${Date.now()}`,
    timing: { pollMs: 10, startTimeoutMs: 2_000 },
  };
  const out = await executeTrial(deps, trialId);
  return { out, trial: (await store.get(trialId))!, races: races(), warnings };
}

describe("fork-403 race: status.json appears between the 403 and the shell check", () => {
  it("A (claude-code-solo) is collected, not failed_infra provider_forbidden", async () => {
    const r = await leagueTrial("claude-code-solo");
    expect(r.races).toBe(1); // the interleaving the live run hit really happened
    expect(r.trial.failure_class, r.warnings.join("\n")).toBeNull();
    expect(r.out.kind).toBe("collected");
    expect(r.trial.state).toBe("collecting");
    expect(r.trial.exit_code).toBe(0);
  }, 60_000);

  it.each(["claude-code-subagents", "gstack", "superpowers", "tandem"])(
    "%s takes the same path and is collected too",
    async (id) => {
      const r = await leagueTrial(id);
      expect(r.races).toBe(1);
      expect(r.trial.failure_class, r.warnings.join("\n")).toBeNull();
      expect(r.out.kind).toBe("collected");
    },
    60_000,
  );
});
