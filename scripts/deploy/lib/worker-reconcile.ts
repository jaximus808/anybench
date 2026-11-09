// Bring the Naïve worker computers to the wanted state (worker-naive). One code path for the deploy
// (scripts/deploy/worker.ts) and the on-host rotator (scripts/deploy/worker-rotate.ts).
//
// A handoff is blue/green with a short gap, never two workers at once:
//   1. create the successor (tagged ab-infra-worker: the reaper leaves it alone) and provision it:
//      env file, curl config and manifest by the fs API, then `bootstrap.sh install` (Node ≥ 22,
//      fetch + sha256-check the release, npm install, systemd units). The worker is not started.
//      Then `bootstrap.sh runner-version` must report the manifest's runnerCommit (TDM-247).
//   2. stop the old worker(s) (SIGTERM: graphile drains, in-flight trials re-attach later through
//      trial.reattach), copy ~/.anybench/generated-kits across (kits.files_url is a file:// path),
//   3. start the successor and wait for its worker_heartbeats row to tick,
//   4. delete the old computer(s). If 3 fails: start the old worker again, delete the successor.
// Exec command lines carry only phase names and hex ids; every secret goes in an fs write body.
import { NAIVE_DEFAULT_FS_HOME, type NaiveComputersApi } from "@anybench/naive";
import {
  bootstrapCommand,
  curlConfig,
  decideDeploy,
  decideRotate,
  envFingerprint,
  HOST_PATHS,
  HostStatusSchema,
  hostRunnerProblem,
  liveWorkers,
  workerComputerName,
  type Decision,
  type HostStatus,
  type WorkerComputer,
  type WorkerManifest,
} from "./worker-plan.js";

export type WorkerComputersApi = Pick<
  NaiveComputersApi,
  "create" | "get" | "list" | "inspect" | "exec" | "writeFile" | "readFile" | "mkdir" | "delete"
>;

export interface HeartbeatResult {
  healthy: boolean;
  detail: Record<string, unknown>;
}

export interface ReconcileDeps {
  computers: WorkerComputersApi;
  /** Whether a worker on `host` started at or after `sinceMs` is ticking worker_heartbeats. */
  heartbeat(host: string, sinceMs: number): Promise<HeartbeatResult>;
  /** A fresh presigned GET for the release tarball. */
  releaseUrl(manifest: WorkerManifest): Promise<string>;
  log(step: string, data?: Record<string, unknown>): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface WantedWorker {
  manifest: WorkerManifest;
  /** The rendered env file (secret). */
  envFile: string;
  /** The rendered bootstrap.sh. */
  bootstrap: string;
}

export interface ReconcileTimeouts {
  createMs: number;
  heartbeatMs: number;
  pollMs: number;
}
export const DEFAULT_TIMEOUTS: ReconcileTimeouts = {
  createMs: 5 * 60_000,
  heartbeatMs: 4 * 60_000,
  pollMs: 5_000,
};

const enc = (s: string) => new TextEncoder().encode(s);

export async function listWorkerComputers(api: WorkerComputersApi): Promise<WorkerComputer[]> {
  const all = [];
  let after: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await api.list({ limit: 100, ...(after ? { after } : {}) });
    all.push(...page.data);
    if (!page.hasMore || !page.nextCursor) break;
    after = page.nextCursor;
  }
  return liveWorkers(all);
}

async function run(
  deps: ReconcileDeps,
  id: string,
  phase: Parameters<typeof bootstrapCommand>[0],
  args: string[] = [],
  timeoutMs = 120_000,
): Promise<string> {
  const r = await deps.computers.exec(id, bootstrapCommand(phase, args), { timeoutMs });
  if (r.exitCode !== 0) {
    // bootstrap.sh never prints a secret; the tail is there to say which step failed.
    throw new Error(
      `${phase} on ${id} exited ${r.exitCode}${r.timedOut ? " (timed out)" : ""}: ${r.stderr.trim().split("\n").slice(-6).join(" | ")}`,
    );
  }
  return r.stdout;
}

export async function hostStatus(deps: ReconcileDeps, id: string): Promise<HostStatus> {
  const out = await run(deps, id, "status", [], 60_000);
  const line = out.trim().split("\n").at(-1) ?? "";
  return HostStatusSchema.parse(JSON.parse(line));
}

async function homeOf(deps: ReconcileDeps, id: string): Promise<string> {
  const i = await deps.computers.inspect(id).catch(() => null);
  return (i?.home ?? NAIVE_DEFAULT_FS_HOME).replace(/\/+$/, "");
}

async function waitRunning(deps: ReconcileDeps, id: string, t: ReconcileTimeouts): Promise<void> {
  const until = deps.now() + t.createMs;
  for (;;) {
    const c = await deps.computers.get(id);
    if (c.status === "running") return;
    if (c.status === "failed" || c.status === "destroyed") {
      throw new Error(`successor ${id} is ${c.status}`);
    }
    if (deps.now() >= until) throw new Error(`successor ${id} still ${c.status} after create`);
    await deps.sleep(t.pollMs);
  }
}

async function waitHeartbeat(
  deps: ReconcileDeps,
  host: string,
  sinceMs: number,
  t: ReconcileTimeouts,
): Promise<HeartbeatResult> {
  const until = deps.now() + t.heartbeatMs;
  for (;;) {
    const last = await deps.heartbeat(host, sinceMs);
    if (last.healthy) return last;
    if (deps.now() >= until) return last;
    await deps.sleep(t.pollMs);
  }
}

/** Create and provision a successor. The worker on it is installed, not started. */
export async function provisionSuccessor(
  deps: ReconcileDeps,
  want: WantedWorker,
  t: ReconcileTimeouts = DEFAULT_TIMEOUTS,
): Promise<string> {
  const { manifest } = want;
  const created = await deps.computers.create({
    name: workerComputerName(manifest.release.id, envFingerprint(want.envFile)),
    vcpu: manifest.size.vcpu,
    memoryMb: manifest.size.memoryMb,
    diskGb: manifest.size.diskGb,
  });
  deps.log("successor created", { id: created.id, size: manifest.size });
  try {
    await waitRunning(deps, created.id, t);
    const home = await homeOf(deps, created.id);
    for (const d of [HOST_PATHS.root, HOST_PATHS.secretsDir]) {
      await deps.computers.mkdir(created.id, `${home}/${d}`);
    }
    const files: [string, string][] = [
      [HOST_PATHS.envFile, want.envFile],
      [HOST_PATHS.curlConfig, curlConfig(await deps.releaseUrl(manifest))],
      [HOST_PATHS.manifest, `${JSON.stringify(manifest, null, 2)}\n`],
      [HOST_PATHS.computer, `${JSON.stringify({ id: created.id })}\n`],
      [HOST_PATHS.bootstrap, want.bootstrap],
    ];
    for (const [rel, content] of files) {
      await deps.computers.writeFile(created.id, `${home}/${rel}`, enc(content));
    }
    deps.log("successor files written", { id: created.id, files: files.map(([p]) => p) });
    const t0 = deps.now();
    await run(deps, created.id, "install", [manifest.release.id, manifest.release.sha256], 600_000);
    deps.log("successor installed", {
      id: created.id,
      release: manifest.release.id,
      s: Math.round((deps.now() - t0) / 1000),
    });
    // TDM-247: the runner this worker will bake into trial images is the deploy's, checked on the
    // host before anything is stopped (a failure deletes the successor; the old worker keeps going).
    const version = await run(deps, created.id, "runner-version", [], 60_000);
    const problem = hostRunnerProblem(version, manifest.runnerCommit);
    if (problem) throw new Error(`successor ${created.id}: ${problem}`);
    deps.log("successor runner", { id: created.id, version: version.trim().split("\n").at(-1) });
    return created.id;
  } catch (err) {
    await deps.computers.delete(created.id).catch(() => {});
    deps.log("successor deleted after a failed provision", { id: created.id });
    throw err;
  }
}

/** Copy ~/.anybench/generated-kits from `from` to `to` (both stopped or about to start). */
async function copyGeneratedKits(deps: ReconcileDeps, from: string, to: string): Promise<void> {
  const size = Number((await run(deps, from, "pack-kits")).trim().split("\n").at(-1));
  if (!Number.isFinite(size) || size <= 0) {
    deps.log("generated kits: none to copy", { from });
    return;
  }
  if (size > 64 * 1024 * 1024) {
    deps.log("generated kits: archive over 64 MiB, not copied", { from, bytes: size });
    return;
  }
  const [fromHome, toHome] = [await homeOf(deps, from), await homeOf(deps, to)];
  const bytes = await deps.computers.readFile(from, `${fromHome}/${HOST_PATHS.kitsArchive}`);
  await deps.computers.writeFile(to, `${toHome}/${HOST_PATHS.kitsArchive}`, bytes);
  await run(deps, to, "unpack-kits");
  deps.log("generated kits copied", { from, to, bytes: bytes.byteLength });
}

export interface HandoffResult {
  successor: string;
  host: string;
  retired: string[];
}

/**
 * Provision a successor, stop `retire`, start the successor, check its heartbeat, delete `retire`.
 * On a failed start the old workers are started again and the successor is deleted.
 */
export async function handoff(
  deps: ReconcileDeps,
  want: WantedWorker,
  retire: readonly string[],
  t: ReconcileTimeouts = DEFAULT_TIMEOUTS,
): Promise<HandoffResult> {
  const successor = await provisionSuccessor(deps, want, t);
  const stopped: string[] = [];
  for (const id of retire) {
    try {
      await run(deps, id, "stop", [], 300_000);
      stopped.push(id);
      deps.log("old worker stopped", { id });
    } catch (err) {
      // An unreachable old computer cannot run a second worker either; it is deleted below.
      deps.log("old worker did not stop cleanly", { id, error: (err as Error).message });
    }
  }
  try {
    if (stopped[0]) {
      await copyGeneratedKits(deps, stopped[0], successor).catch((err: unknown) =>
        deps.log("generated kits copy failed (continuing)", { error: (err as Error).message }),
      );
    }
    const startedAt = deps.now();
    await run(deps, successor, "start");
    const { host } = await hostStatus(deps, successor);
    // started_at comes from the host clock; allow some skew.
    const beat = await waitHeartbeat(deps, host, startedAt - 120_000, t);
    if (!beat.healthy) throw new Error(`successor ${successor} (${host}) is not heartbeating`);
    deps.log("successor heartbeating", { id: successor, host, ...beat.detail });
    for (const id of retire) {
      await deps.computers
        .delete(id)
        .catch((err: unknown) =>
          deps.log("delete old computer failed", { id, error: (err as Error).message }),
        );
      deps.log("old computer deleted", { id });
    }
    return { successor, host, retired: [...retire] };
  } catch (err) {
    for (const id of stopped) {
      await run(deps, id, "start").then(
        () => deps.log("old worker restarted", { id }),
        (e: unknown) => deps.log("old worker restart failed", { id, error: (e as Error).message }),
      );
    }
    await deps.computers.delete(successor).catch(() => {});
    deps.log("successor deleted", { id: successor });
    throw err;
  }
}

export interface ReconcileResult {
  decision: Decision;
  handoff?: HandoffResult;
}

/** Is the newest worker running its worker process and ticking worker_heartbeats? */
async function newestHealthy(deps: ReconcileDeps, w: WorkerComputer | undefined): Promise<boolean> {
  if (!w || w.status !== "running") return false;
  try {
    const st = await hostStatus(deps, w.id);
    if (st.worker !== "active") return false;
    const beat = await deps.heartbeat(st.host, 0);
    deps.log("newest worker", { id: w.id, ...st, ...beat.detail, healthy: beat.healthy });
    return beat.healthy;
  } catch (err) {
    deps.log("newest worker unreachable", { id: w.id, error: (err as Error).message });
    return false;
  }
}

/** The deploy: keep the newest worker if it runs this release and env and is healthy, else replace. */
export async function reconcileDeploy(
  deps: ReconcileDeps,
  want: WantedWorker,
  opts: { force?: boolean; timeouts?: ReconcileTimeouts } = {},
): Promise<ReconcileResult> {
  const workers = await listWorkerComputers(deps.computers);
  deps.log("worker computers", {
    live: workers.map((w) => ({
      id: w.id,
      createdAt: w.createdAt,
      status: w.status,
      release: w.release,
      env: w.env,
    })),
  });
  const decision = decideDeploy({
    workers,
    newestHealthy: await newestHealthy(deps, workers[0]),
    want: { release: want.manifest.release.id, env: envFingerprint(want.envFile) },
    nowMs: deps.now(),
    rotateAfterMs: want.manifest.rotateAfterMs,
    force: opts.force ?? false,
  });
  deps.log("decision", decision as unknown as Record<string, unknown>);
  if (decision.kind === "keep") {
    for (const id of decision.retire) {
      await deps.computers.delete(id).catch(() => {});
      deps.log("stale worker computer deleted", { id });
    }
    return { decision };
  }
  if (decision.kind === "wait") return { decision };
  return { decision, handoff: await handoff(deps, want, decision.retire, opts.timeouts) };
}

/** The on-host rotator: hand off to a successor once this computer is past its rotation age. */
export async function reconcileRotate(
  deps: ReconcileDeps,
  want: WantedWorker,
  selfId: string,
  opts: { timeouts?: ReconcileTimeouts } = {},
): Promise<ReconcileResult> {
  const workers = await listWorkerComputers(deps.computers);
  const decision = decideRotate({
    selfId,
    workers,
    nowMs: deps.now(),
    rotateAfterMs: want.manifest.rotateAfterMs,
  });
  deps.log("decision", decision as unknown as Record<string, unknown>);
  if (decision.kind !== "replace") return { decision };
  // Retire ourselves last: deleting this computer ends this process.
  const retire = [...decision.retire.filter((id) => id !== selfId), selfId];
  return { decision, handoff: await handoff(deps, want, retire, opts.timeouts) };
}
