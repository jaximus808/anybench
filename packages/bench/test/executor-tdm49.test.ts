// TDM-49: the trial executor on FakeProvider. A scripted runner (executor-tdm49-fakes.ts) stands
// in for the in-VM binary; the memory store has the Drizzle store's lease semantics.
import { TRIAL_MAX_INFRA_RETRIES } from "@anybench/core";
import { describe, expect, it } from "vitest";
import {
  createTrialLauncher,
  DB_MAX_TRIAL_ATTEMPTS,
  executeTrial,
  gradesFrozenWorkspace,
  formatEnvFile,
  leaseOwnerBase,
  leaseTakeable,
  parseLeaseOwner,
  planTransition,
  reattachOrphans,
  TRIAL_MAX_ATTEMPTS,
  trialTargetOfStatus,
  type ExecTrial,
} from "../src/index.js";
import {
  harnessTdm49,
  installFakeRunnerTdm49,
  phaseEdgesTdm49,
  SECRET_TDM49,
  TIMING_TDM49,
  waitForTdm49,
} from "./executor-tdm49-fakes.js";
import { parseEnvFile, TrialJobSchema } from "@anybench/runner";

const HAPPY = [
  "queued→forking",
  "forking→installing",
  "installing→warming",
  "warming→running",
  "running→collecting",
];

describe("executor: happy path", () => {
  it("forks, writes secrets + trial.json by fs.write, launches the runner detached, collects", async () => {
    const h = harnessTdm49();
    const launches = installFakeRunnerTdm49(h.fake, () => "ok");
    const trialId = h.newTrial();

    const out = await executeTrial(h.deps(), trialId);

    expect(out.kind).toBe("collected");
    const t = (await h.store.get(trialId))!;
    expect(t.state).toBe("collecting");
    expect(t.attempt).toBe(1);
    expect(t.lease_owner).toBeNull(); // released
    expect(t.logs_url).toBe(`artifact:runs/${h.runId}/trials/${trialId}/out.tar.gz`);
    expect(t.machine).toEqual({ nproc: 2, load_1m: 0.1 });
    expect(t.exit_code).toBe(0);
    expect(t.cost_micro_usd).toBe(27_600n); // one 10-minute block
    expect(phaseEdgesTdm49(h.store, trialId)).toEqual(HAPPY);

    // One computer, tagged for the trial, linked on the trial row, destroyed at the end.
    expect(h.creates()).toBe(1);
    const [row] = [...h.computers.rows.values()];
    expect(row!.trialId).toBe(trialId);
    expect(row!.status).toBe("destroyed");
    expect(t.computer_id).toBe(row!.id);
    const all = await h.fake.list({ includeDestroyed: true });
    expect(all[0]!.tags.some((tag) => tag.startsWith("ab-"))).toBe(true);
    expect(all[0]!.status).toBe("destroyed");

    // One detached launch; nothing secret on any command line.
    expect(launches).toHaveLength(1);
    expect(h.fake.detached()).toHaveLength(1);
    for (const c of h.fake.commands()) {
      expect(c.command).not.toContain(SECRET_TDM49);
      expect(c.command).not.toContain("abrt1.");
    }
    expect(launches[0]!.token).toMatch(/^abrt1\.fake-.*-1-/);
    expect(h.store.events.map((e) => e.type)).toContain("computer.created");
    expect(h.store.events.map((e) => e.type)).toContain("computer.destroyed");

    // A repeat execution (duplicate job, gate enqueue retried) is a no-op, not an infra failure.
    const again = await executeTrial(h.deps(), trialId);
    expect(again.kind).toBe("collected");
    expect((await h.store.get(trialId))!.state).toBe("collecting");
    expect(launches).toHaveLength(1);
    expect(h.creates()).toBe(1);
  });

  it("writes ~/.anybench/env and trial.json with mode 0600 before the runner starts", async () => {
    const h = harnessTdm49();
    let seen: { env?: number; job?: number; envText?: string; jobText?: string } = {};
    h.fake.onExec(/\.anybench\/bin\/runner' --trial/, (ctx) => {
      seen = {
        env: h.fake.fileStat(ctx.computerId, "/home/naive/.anybench/env")?.mode,
        job: h.fake.fileStat(ctx.computerId, "/home/naive/.anybench/trial.json")?.mode,
        envText: ctx.readFile("/home/naive/.anybench/env"),
        jobText: ctx.readFile("/home/naive/.anybench/trial.json"),
      };
      return { exitCode: 0 }; // never writes status: the executor gives up after startTimeoutMs
    });
    const trialId = h.newTrial();
    const out = await executeTrial(h.deps(), trialId);
    expect(seen.env).toBe(0o600);
    expect(seen.job).toBe(0o600);
    expect(parseEnvFile(seen.envText!)).toEqual({ ANTHROPIC_API_KEY: SECRET_TDM49 });
    const job = TrialJobSchema.parse(JSON.parse(seen.jobText!));
    expect(job).toMatchObject({ trial_id: trialId, run_id: h.runId, attempt: 1 });
    expect(job.ingest?.url).toBe("https://api.anybench.test");
    // No status.json ever: runner_start infra failure, retry reported (not run here).
    expect(out.kind).toBe("retry");
    expect((await h.store.get(trialId))!.failure_class).toBe("runner_start");
  });
});

describe("executor: crash recovery", () => {
  it("a worker killed mid-trial is re-attached once its lease expires: no second computer or runner", async () => {
    const h = harnessTdm49();
    const launches = installFakeRunnerTdm49(h.fake, () => "ok", 30);
    const trialId = h.newTrial();

    const kill = new AbortController();
    const a = executeTrial(h.deps({ owner: "worker-a~1" }), trialId, { signal: kill.signal });
    await waitForTdm49(() => h.store.trials.get(trialId)!.state === "running");
    kill.abort(); // the worker process dies: no release, no cleanup
    expect((await a).kind).toBe("aborted");

    const held = (await h.store.get(trialId))!;
    expect(held.lease_owner).toMatch(/^worker-a~1~/);
    // Lease still valid: the sweep leaves it alone, and another worker cannot take it.
    expect(h.store.listOrphaned()).toEqual([]);
    const busy = await executeTrial(h.deps({ owner: "worker-b~2" }), trialId);
    expect(busy.kind).toBe("busy");

    // The runner is detached: it keeps going while no worker watches.
    await waitForTdm49(
      () => (h.store.trials.get(trialId)!.lease_until?.getTime() ?? 0) < Date.now(),
    );
    const enqueued: string[] = [];
    const swept = await reattachOrphans({
      listOrphaned: async () => h.store.listOrphaned(),
      enqueue: async (o) => {
        enqueued.push(o.id);
      },
    });
    expect(swept.map((o) => o.id)).toEqual([trialId]);
    expect(enqueued).toEqual([trialId]);

    const b = await executeTrial(h.deps({ owner: "worker-b~2" }), trialId);
    expect(b.kind).toBe("collected");
    expect(h.creates()).toBe(1);
    expect(launches).toHaveLength(1);
    expect(h.fake.detached()).toHaveLength(1);
    expect(phaseEdgesTdm49(h.store, trialId)).toEqual(HAPPY);
    expect((await h.store.get(trialId))!.attempt).toBe(1);
  });

  it("re-attaches before expiry when the lease owner's worker is dead (runner heartbeats keep the lease alive)", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok", 30);
    const trialId = h.newTrial();
    const kill = new AbortController();
    const a = executeTrial(h.deps({ owner: "worker-a~1" }), trialId, { signal: kill.signal });
    await waitForTdm49(() => h.store.trials.get(trialId)!.state === "warming");
    kill.abort();
    await a;
    // Simulate ingest heartbeats pushing lease_until far out.
    const row = h.store.trials.get(trialId)!;
    h.store.trials.set(trialId, { ...row, lease_until: new Date(Date.now() + 3_600_000) });
    expect(h.store.listOrphaned()).toEqual([]);
    h.store.deadOwners.add("worker-a~1"); // its worker_heartbeats row went stale
    expect(h.store.listOrphaned().map((o) => o.id)).toEqual([trialId]);
    const b = await executeTrial(h.deps({ owner: "worker-b~2" }), trialId);
    expect(b.kind).toBe("collected");
    expect(h.creates()).toBe(1);
    expect(h.fake.detached()).toHaveLength(1);
  });

  it("a takeover makes the old execution stop without touching the computer", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok", 40);
    const trialId = h.newTrial();
    const a = executeTrial(h.deps({ owner: "worker-a~1" }), trialId);
    await waitForTdm49(() => h.store.trials.get(trialId)!.state === "warming");
    h.store.deadOwners.add("worker-a~1"); // wrongly presumed dead
    const b = executeTrial(h.deps({ owner: "worker-b~2" }), trialId);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.kind).toBe("lease_lost");
    expect(rb.kind).toBe("collected");
    expect(h.creates()).toBe(1);
    expect(h.fake.detached()).toHaveLength(1);
  });
});

describe("executor: retries", () => {
  it("an infra error (runner heartbeat lost) is retried as a new attempt with a new token", async () => {
    const h = harnessTdm49();
    const launches = installFakeRunnerTdm49(h.fake, (job) => (job.attempt === 1 ? "hang" : "ok"));
    const trialId = h.newTrial();
    const delays: number[] = [];
    const launcher = createTrialLauncher(
      h.deps({
        sleep: async (ms, signal) => {
          if (ms >= 1_000)
            delays.push(ms); // the retry backoff: recorded, not waited
          else
            await new Promise<void>((r) => {
              const t = setTimeout(r, ms);
              signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
            });
        },
      }),
    );
    const res = await launcher.launch(
      { trial_id: trialId },
      { computer_key: "k", position_in_block: 0, block_size: 1 },
    );
    expect(res.state).toBe("done");
    const t = (await h.store.get(trialId))!;
    expect(t.attempt).toBe(2);
    expect(t.state).toBe("collecting");
    expect(delays).toEqual([30_000]); // trialRetryDelayMs(1)
    expect(launches.map((l) => l.attempt)).toEqual([1, 2]);
    expect(launches[0]!.token).not.toBe(launches[1]!.token);
    // Each attempt got its own computer; the broken one was destroyed.
    expect(h.creates()).toBe(2);
    expect([...h.computers.rows.values()].every((r) => r.status === "destroyed")).toBe(true);
    expect(phaseEdgesTdm49(h.store, trialId)).toEqual([
      ...HAPPY.slice(0, 4),
      "running→failed_infra",
      "failed_infra→queued",
      ...HAPPY,
    ]);
  });

  it("stops retrying at the DB attempt limit (core allows 3 retries, trials_attempt_check allows 3 tries)", async () => {
    expect(TRIAL_MAX_INFRA_RETRIES).toBe(3);
    expect(DB_MAX_TRIAL_ATTEMPTS).toBe(3);
    expect(TRIAL_MAX_ATTEMPTS).toBe(3);
    const h = harnessTdm49();
    // A worker-observed failure every time: the runner hangs (heartbeat lost).
    const launches = installFakeRunnerTdm49(h.fake, () => "hang");
    const trialId = h.newTrial();
    const delays: number[] = [];
    const launcher = createTrialLauncher(
      h.deps({
        sleep: async (ms) => {
          if (ms >= 1_000) delays.push(ms);
          else await new Promise((r) => setTimeout(r, ms));
        },
      }),
    );
    const res = await launcher.launch(
      { trial_id: trialId },
      { computer_key: "k", position_in_block: 0, block_size: 1 },
    );
    expect(res).toEqual({ state: "failed_infra", cost_micro_usd: 0n });
    expect(launches.map((l) => l.attempt)).toEqual([1, 2, 3]);
    expect(delays).toEqual([30_000, 60_000]);
    const t = (await h.store.get(trialId))!;
    expect(t.attempt).toBe(3);
    expect(t.state).toBe("failed_infra");
    expect(t.ended_at).not.toBeNull();
    expect(t.failure_class).toBe("heartbeat_lost");
    // TDM-232: an infra failure records no frozen workspace (nothing to grade; never billed).
    expect(t.frozen_workspace ?? null).toBeNull();
    expect(gradesFrozenWorkspace(t)).toBe(false);
    expect(h.creates()).toBe(3);
  });

  it("a subject failure is final and never retried", async () => {
    const h = harnessTdm49();
    const launches = installFakeRunnerTdm49(h.fake, () => "subject_fail");
    const trialId = h.newTrial();
    const launcher = createTrialLauncher(h.deps());
    const res = await launcher.launch(
      { trial_id: trialId },
      { computer_key: "k", position_in_block: 0, block_size: 1 },
    );
    expect(res.state).toBe("failed_subject");
    expect(res.cost_micro_usd).toBe(27_600n); // billed: the subject's side
    expect(launches).toHaveLength(1);
    const t = (await h.store.get(trialId))!;
    expect(t).toMatchObject({ state: "failed_subject", attempt: 1, failure_class: "wall_clock" });
    // Outputs are kept even though the subject failed.
    expect(t.logs_url).toContain("out.tar.gz");
    // TDM-232: the freeze is a recorded fact (from manifest.json), so trial.gate grades it.
    expect(t.frozen_workspace).toEqual({
      present: true,
      manifest: true,
      files: 3,
      workspace_files: 1,
      frozen_at: "2026-11-09T04:00:00.000Z",
      grading: "pending",
    });
    expect(gradesFrozenWorkspace(t)).toBe(true);
    expect(h.creates()).toBe(1);
    // Executing it again does nothing: terminal.
    const again = await executeTrial(h.deps(), trialId, { retryNow: true });
    expect(again).toMatchObject({ kind: "final", state: "failed_subject" });
    expect(launches).toHaveLength(1);
  });

  it("the computer vanishing mid-run is an infra failure, reported as a retry with its due time", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok", 30);
    const trialId = h.newTrial();
    const p = executeTrial(h.deps(), trialId);
    await waitForTdm49(() => h.store.trials.get(trialId)!.state === "running");
    const [c] = await h.fake.list();
    await h.fake.destroy(c!.id);
    const out = await p;
    expect(out.kind).toBe("retry");
    if (out.kind !== "retry") return;
    expect(out.next_attempt).toBe(2);
    expect(out.retry_at).toBeGreaterThan(Date.now() + 25_000);
    const t = (await h.store.get(trialId))!;
    expect(t).toMatchObject({
      state: "failed_infra",
      failure_class: "computer_lost",
      computer_id: null,
    });
  });

  it("a failure the runner claims (status.json outcome failed_infra) is the subject's: final, billed, no retry", async () => {
    const h = harnessTdm49();
    const launches = installFakeRunnerTdm49(h.fake, () => "infra_fail");
    const trialId = h.newTrial();
    const launcher = createTrialLauncher(h.deps());
    const res = await launcher.launch(
      { trial_id: trialId },
      { computer_key: "k", position_in_block: 0, block_size: 1 },
    );
    expect(res.state).toBe("failed_subject");
    expect(res.cost_micro_usd).toBe(27_600n);
    expect(launches).toHaveLength(1);
    expect(await h.store.get(trialId)).toMatchObject({
      state: "failed_subject",
      attempt: 1,
      failure_class: "runner:start",
    });
  });

  it("a final runner phase with no outcome is the subject's too (runner:no_outcome)", async () => {
    const h = harnessTdm49();
    const launches = installFakeRunnerTdm49(h.fake, () => "fail_no_outcome");
    const trialId = h.newTrial();
    const out = await executeTrial(h.deps(), trialId);
    expect(out).toMatchObject({ kind: "final", state: "failed_subject" });
    expect(launches).toHaveLength(1);
    expect((await h.store.get(trialId))!.failure_class).toBe("runner:no_outcome");
  });

  it("a failed_infra edge pushed through ingest is the subject's: runner:<class>, no retry", async () => {
    const h = harnessTdm49();
    h.fake.onExec(/\.anybench\/bin\/runner' --trial/, () => ({ exitCode: 0 }));
    const trialId = h.newTrial();
    const p = executeTrial(
      h.deps({ timing: { ...TIMING_TDM49, startTimeoutMs: 20_000 } }),
      trialId,
    );
    await waitForTdm49(() => h.fake.detached().length === 1);
    h.store.pushRunnerEdge(trialId, 1, {
      from: "installing",
      to: "failed_infra",
      reason: "out of disk, honest",
      failure_class: "disk",
    });
    const out = await p;
    expect(out).toMatchObject({ kind: "final", state: "failed_subject" });
    expect(await h.store.get(trialId)).toMatchObject({ attempt: 1, failure_class: "runner:disk" });
    expect(h.fake.detached()).toHaveLength(1);
  });
});

describe("executor: cancellation", () => {
  it("a cancel mid-run writes ~/.anybench/cancel, destroys the computer and cancels the trial", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok", 40);
    const trialId = h.newTrial();
    const p = executeTrial(h.deps(), trialId);
    await waitForTdm49(() => h.store.trials.get(trialId)!.state === "running");
    const [c] = await h.fake.list();
    h.store.cancelledRuns.set(h.runId, "user cancelled the run");
    const out = await p;
    expect(out).toMatchObject({ kind: "final", state: "cancelled", cost_micro_usd: 0n });
    expect(await h.fake.inspect(c!.id).catch((e: Error) => e.name)).toBe("ProviderNotFoundError");
    expect([...h.computers.rows.values()][0]!.status).toBe("destroyed");
    // The runner saw ~/.anybench/cancel (fs.write) and stopped itself before the destroy.
    await h.fake.settle();
    expect(h.fake.detached(c!.id)[0]!.exitCode).toBe(12);
    const t = (await h.store.get(trialId))!;
    expect(t.state).toBe("cancelled");
    expect(t.ended_at).not.toBeNull();
    expect(phaseEdgesTdm49(h.store, trialId).at(-1)).toBe("running→cancelled");
  });

  it("a cancel before launch never creates a computer", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok");
    const trialId = h.newTrial();
    h.store.cancelledRuns.set(h.runId, "kill switch: global");
    const out = await executeTrial(h.deps(), trialId);
    expect(out).toMatchObject({ kind: "final", state: "cancelled" });
    expect(h.creates()).toBe(0);
    expect(phaseEdgesTdm49(h.store, trialId)).toEqual(["queued→cancelled"]);
  });

  it("a failed_infra trial waiting for its retry is cancelled with its run", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "hang");
    const trialId = h.newTrial();
    expect((await executeTrial(h.deps(), trialId)).kind).toBe("retry");
    h.store.cancelledRuns.set(h.runId, "user cancelled");
    const out = await executeTrial(h.deps(), trialId, { retryNow: true });
    expect(out).toMatchObject({ kind: "final", state: "cancelled" });
    expect((await h.store.get(trialId))!.attempt).toBe(1);
  });

  it("a runner that writes cancelled into status.json unasked fails as the subject (unrequested_cancel)", async () => {
    const h = harnessTdm49();
    const launches = installFakeRunnerTdm49(h.fake, () => "self_cancel");
    const trialId = h.newTrial();
    const out = await executeTrial(h.deps(), trialId);
    expect(out).toMatchObject({ kind: "final", state: "failed_subject" });
    expect(out.kind === "final" && out.cost_micro_usd).toBe(27_600n);
    expect(launches).toHaveLength(1);
    expect(await h.store.get(trialId)).toMatchObject({
      state: "failed_subject",
      attempt: 1,
      failure_class: "unrequested_cancel",
    });
  });

  it("a cancelled edge pushed through ingest unasked fails as the subject; a requested one cancels", async () => {
    const h = harnessTdm49();
    h.fake.onExec(/\.anybench\/bin\/runner' --trial/, () => ({ exitCode: 0 }));
    const timing = { ...TIMING_TDM49, startTimeoutMs: 20_000 };
    const unasked = h.newTrial();
    const p1 = executeTrial(h.deps({ timing }), unasked);
    await waitForTdm49(() => h.fake.detached().length === 1);
    h.store.pushRunnerEdge(unasked, 1, { from: "installing", to: "cancelled" });
    expect(await p1).toMatchObject({ kind: "final", state: "failed_subject" });
    expect((await h.store.get(unasked))!.failure_class).toBe("unrequested_cancel");

    // The same edge while the run really is cancelled is honoured. The cancel lands exactly when
    // ingest delivers the edge, so the poll loop's own check (which runs first) has not seen it:
    // only the edge path can cancel, and it writes no worker event for the runner's edge.
    const asked = h.newTrial();
    const realEdges = h.store.runnerEdges.bind(h.store);
    h.store.runnerEdges = async (t) => {
      if (t.id === asked && h.fake.detached().length === 2) {
        h.store.cancelledRuns.set(h.runId, "user cancelled");
        return [{ from: "installing", to: "cancelled" }];
      }
      return realEdges(t);
    };
    const out2 = await executeTrial(h.deps({ timing }), asked);
    expect(out2).toMatchObject({ kind: "final", state: "cancelled" });
    expect(phaseEdgesTdm49(h.store, asked)).not.toContain("installing→cancelled");
  });
});

describe("executor: runner edges and packed blocks", () => {
  it("applies runner trial.phase edges from the store's state, ignoring the claimed from", async () => {
    const h = harnessTdm49();
    // A runner that never writes status.json: only ingest edges drive the state.
    h.fake.onExec(/\.anybench\/bin\/runner' --trial/, () => ({ exitCode: 0, durationMs: 0 }));
    const trialId = h.newTrial();
    // No status.json: give it a long start timeout so only the edges decide.
    const p = executeTrial(
      h.deps({ timing: { ...TIMING_TDM49, startTimeoutMs: 20_000 } }),
      trialId,
    );
    await waitForTdm49(() => h.store.trials.get(trialId)!.state === "installing");
    await waitForTdm49(() => h.fake.detached().length === 1);
    // Lies about `from`; names a state two steps ahead.
    h.store.pushRunnerEdge(trialId, 1, { from: "queued", to: "running" });
    await waitForTdm49(() => h.store.trials.get(trialId)!.state === "running");
    // The executor wrote each legal step itself (none of them matched the runner's claimed edge).
    expect(phaseEdgesTdm49(h.store, trialId).slice(-2)).toEqual([
      "installing→warming",
      "warming→running",
    ]);
    // An edge the runner may not make (done) is ignored; a subject failure is applied.
    h.store.pushRunnerEdge(trialId, 1, { from: "gating", to: "done" });
    h.store.pushRunnerEdge(trialId, 1, {
      from: "running",
      to: "failed_subject",
      reason: "token cap",
      failure_class: "budget",
    });
    const out = await p;
    expect(out).toMatchObject({ kind: "final", state: "failed_subject" });
    const t = (await h.store.get(trialId))!;
    expect(t.failure_class).toBe("budget");
    // The runner's own edge was already written by ingest: not written twice.
    expect(phaseEdgesTdm49(h.store, trialId)).not.toContain("running→failed_subject");
  });

  it("a packed block reuses one computer for its trials and destroys it at block end", async () => {
    const h = harnessTdm49();
    const launches = installFakeRunnerTdm49(h.fake, () => "ok");
    const t1 = h.newTrial();
    const t2 = h.newTrial();
    const launcher = createTrialLauncher(h.deps());
    const ctx = (i: number) => ({ computer_key: "run:b0", position_in_block: i, block_size: 2 });
    expect((await launcher.launch({ trial_id: t1 }, ctx(0))).state).toBe("done");
    expect(h.creates()).toBe(1);
    const [row] = [...h.computers.rows.values()];
    expect(row!.status).toBe("running"); // kept for the next trial
    expect((await launcher.launch({ trial_id: t2 }, ctx(1))).state).toBe("done");
    expect(h.creates()).toBe(1);
    expect(launches.map((l) => l.computerId)).toEqual([
      launches[0]!.computerId,
      launches[0]!.computerId,
    ]);
    expect((await h.store.get(t2))!.computer_id).toBe(row!.id);
    // The last trial of the block destroyed it already; onBlockEnd is idempotent.
    await launcher.onBlockEnd("run:b0");
    expect([...h.computers.rows.values()][0]!.status).toBe("destroyed");
  });

  it("refreshes the lease while it watches", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok", 40);
    const trialId = h.newTrial();
    const p = executeTrial(h.deps(), trialId);
    await waitForTdm49(() => h.store.trials.get(trialId)!.state === "warming");
    const first = h.store.trials.get(trialId)!.lease_until!.getTime();
    await new Promise((r) => setTimeout(r, 120));
    expect(h.store.trials.get(trialId)!.lease_until!.getTime()).toBeGreaterThan(first);
    await p;
  });

  it("an unexpected error releases the lease, so the next execution is not busy", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok");
    const trialId = h.newTrial();
    const real = h.store.cancelState.bind(h.store);
    let thrown = false;
    h.store.cancelState = async (t) => {
      if (!thrown) {
        thrown = true;
        throw new Error("db connection reset");
      }
      return real(t);
    };
    await expect(executeTrial(h.deps(), trialId)).rejects.toThrow("db connection reset");
    expect((await h.store.get(trialId))!.lease_owner).toBeNull();
    const out = await executeTrial(h.deps({ owner: "worker-b~2" }), trialId);
    expect(out.kind).toBe("collected");
  });

  it("the deadline runs from started_at: a re-attach does not restart it", async () => {
    const h = harnessTdm49();
    installFakeRunnerTdm49(h.fake, () => "ok", 60);
    const trialId = h.newTrial();
    const timing = { ...TIMING_TDM49, deadlineMs: () => 500 };
    const kill = new AbortController();
    const a = executeTrial(h.deps({ owner: "worker-a~1", timing }), trialId, {
      signal: kill.signal,
    });
    await waitForTdm49(() => h.store.trials.get(trialId)!.state === "warming");
    kill.abort();
    await a;
    const startedAt = h.store.trials.get(trialId)!.started_at!.getTime();
    await waitForTdm49(() => Date.now() > startedAt + 550);
    h.store.deadOwners.add("worker-a~1");
    const out = await executeTrial(h.deps({ owner: "worker-b~2", timing }), trialId);
    expect(out.kind).toBe("retry");
    expect((await h.store.get(trialId))!.failure_class).toBe("deadline");
  });
});

describe("executor: pure helpers", () => {
  const row = (over: Partial<ExecTrial> = {}): ExecTrial => ({
    id: "t",
    run_id: "r",
    owner_id: "o",
    state: "running",
    attempt: 1,
    computer_id: null,
    provider: null,
    lease_owner: "w~1~a",
    lease_until: new Date(10_000),
    started_at: null,
    ended_at: null,
    failure_class: null,
    exit_code: null,
    logs_url: null,
    machine: null,
    cost_micro_usd: 0n,
    log_offset: 0,
    ...over,
  });
  const actor = { kind: "system" } as const;
  const at = new Date(0);

  it("planTransition applies the command from the row's state and pins lease + attempt", () => {
    const ok = planTransition(row(), "w~1~a", {
      command: { type: "advance" },
      expectAttempt: 1,
      emit: true,
      actor,
      at,
    });
    expect(ok).toMatchObject({ ok: true, from: "running", to: "collecting" });
    expect(
      planTransition(row(), "other", {
        command: { type: "advance" },
        expectAttempt: 1,
        emit: true,
        actor,
        at,
      }),
    ).toMatchObject({ ok: false, reason: "lease_lost" });
    expect(
      planTransition(row(), "w~1~a", {
        command: { type: "advance" },
        expectAttempt: 2,
        emit: true,
        actor,
        at,
      }),
    ).toMatchObject({ ok: false, reason: "stale_attempt" });
    expect(
      planTransition(row({ state: "queued" }), "w~1~a", {
        command: { type: "fail_subject", reason: "x" },
        expectAttempt: 1,
        emit: true,
        actor,
        at,
      }),
    ).toMatchObject({ ok: false, reason: "illegal" });
    // retry bumps the attempt; the DB limit refuses a 4th try even though core allows it.
    const r2 = planTransition(row({ state: "failed_infra", attempt: 2 }), "w~1~a", {
      command: { type: "retry", attempt: 2 },
      expectAttempt: 2,
      emit: true,
      actor,
      at,
    });
    expect(r2).toMatchObject({ ok: true, next: { attempt: 3, state: "queued" } });
    const r3 = planTransition(row({ state: "failed_infra", attempt: 3 }), "w~1~a", {
      command: { type: "retry", attempt: 3 },
      expectAttempt: 3,
      emit: true,
      actor,
      at,
    });
    expect(r3).toMatchObject({ ok: false, reason: "illegal" });
  });

  it("leaseTakeable: free, own, expired, or dead owner", () => {
    const alive = () => true;
    expect(leaseTakeable(row({ lease_owner: null }), "me", 0, alive)).toBe(true);
    expect(leaseTakeable(row({ lease_owner: "me" }), "me", 0, alive)).toBe(true);
    expect(leaseTakeable(row(), "me", 5_000, alive)).toBe(false);
    expect(leaseTakeable(row(), "me", 10_000, alive)).toBe(true);
    expect(leaseTakeable(row(), "me", 5_000, () => false)).toBe(true);
    expect(parseLeaseOwner(`${leaseOwnerBase("host:12", new Date(1234))}~nonce`)).toEqual({
      workerId: "host:12",
      startedMs: 1234,
    });
    expect(() => leaseOwnerBase("a~b", new Date())).toThrow();
  });

  it("formatEnvFile round-trips through the runner's parser", () => {
    const secrets = { A: 'quote " back \\ slash', B: "line1\nline2", C: "plain" };
    expect(parseEnvFile(formatEnvFile(secrets))).toEqual(secrets);
    expect(() => formatEnvFile({ "BAD-KEY": "x" })).toThrow();
  });

  it("trialTargetOfStatus maps runner phases and outcomes", () => {
    const base = { phase: "run", result: null } as const;
    expect(trialTargetOfStatus(base as never).to).toBe("running");
    expect(
      trialTargetOfStatus({
        phase: "done",
        result: { outcome: "ok", reason: null, failure_class: null },
      } as never).to,
    ).toBe("collecting");
    expect(
      trialTargetOfStatus({
        phase: "failed",
        result: { outcome: "failed_subject", reason: "r", failure_class: "budget" },
      } as never),
    ).toEqual({ to: "failed_subject", reason: "r", failure_class: "budget" });
    expect(trialTargetOfStatus({ phase: "failed", result: null } as never).to).toBe("failed_infra");
  });
});
