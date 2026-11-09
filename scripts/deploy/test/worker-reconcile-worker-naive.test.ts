// worker-naive: deploy and rotation against an in-memory Naïve computers API. Checks the order of
// a handoff (never two workers at once), rollback when the successor does not heartbeat, and that
// no secret ever reaches an exec command line.
import type {
  NaiveComputer,
  NaiveComputerCreate,
  NaiveExecResult,
  NaivePage,
} from "@anybench/naive";
import { describe, expect, it } from "vitest";
import {
  envFingerprint,
  releaseArtifactRef,
  renderBootstrap,
  renderEnvFile,
  workerComputerName,
  type WorkerManifest,
} from "../lib/worker-plan.js";
import {
  reconcileDeploy,
  reconcileRotate,
  type ReconcileDeps,
  type WantedWorker,
  type WorkerComputersApi,
} from "../lib/worker-reconcile.js";

const SECRET = "PW_SECRET_worker_naive_42";
const PRESIGNED = "https://r2.example.test/release?X-Amz-Signature=SIG_SECRET_wn";
const H = 3600_000;
const RUNNER_COMMIT = "2222222222222222222222222222222222222222";

interface Box {
  c: NaiveComputer;
  host: string;
  files: Map<string, Uint8Array>;
  active: boolean;
  startedAt: number;
  kits: boolean;
}

class FakeNaiveHosts implements WorkerComputersApi {
  boxes = new Map<string, Box>();
  events: string[] = [];
  commands: string[] = [];
  failStartOn = new Set<string>();
  /** What `runner-version` prints on a computer (TDM-247); default: the manifest's commit. */
  runnerVersion = `0.1.0 ${RUNNER_COMMIT}\n`;
  private n = 0;
  constructor(private readonly clock: { now: number }) {}

  seed(name: string, ageMs: number, opts: { active?: boolean; kits?: boolean } = {}): string {
    const id = `cmp_seed${++this.n}`;
    this.boxes.set(id, {
      c: this.computer(id, name, new Date(this.clock.now - ageMs).toISOString()),
      host: `host-${id}`,
      files: new Map(),
      active: opts.active ?? true,
      startedAt: this.clock.now - ageMs,
      kits: opts.kits ?? false,
    });
    return id;
  }
  private computer(id: string, name: string, createdAt: string): NaiveComputer {
    return {
      id,
      name,
      vcpu: 1,
      memoryMb: 2048,
      diskGb: 10,
      status: "running",
      snapshotId: null,
      agentId: null,
      createdAt,
    };
  }
  live(): string[] {
    return [...this.boxes.values()].filter((b) => b.c.status === "running").map((b) => b.c.id);
  }
  activeWorkers(): string[] {
    return [...this.boxes.values()]
      .filter((b) => b.c.status === "running" && b.active)
      .map((b) => b.c.id);
  }

  async create(body: NaiveComputerCreate): Promise<NaiveComputer> {
    const id = `cmp_new${++this.n}`;
    this.clock.now += 1000;
    const c = {
      ...this.computer(id, body.name ?? "computer", new Date(this.clock.now).toISOString()),
      status: "creating" as const,
    };
    this.boxes.set(id, {
      c,
      host: `host-${id}`,
      files: new Map(),
      active: false,
      startedAt: 0,
      kits: false,
    });
    this.events.push(`create ${id}`);
    return c;
  }
  async get(id: string): Promise<NaiveComputer> {
    const b = this.must(id);
    if (b.c.status === "creating") b.c = { ...b.c, status: "running" };
    return b.c;
  }
  async list(): Promise<NaivePage<NaiveComputer>> {
    return { data: [...this.boxes.values()].map((b) => b.c), hasMore: false, nextCursor: null };
  }
  async inspect(id: string) {
    return {
      id,
      status: this.must(id).c.status,
      lastActiveAt: null,
      home: "/home/naive",
      probe: null,
    };
  }
  async mkdir(): Promise<void> {}
  async writeFile(id: string, path: string, content: Uint8Array): Promise<void> {
    this.must(id).files.set(path, content);
  }
  async readFile(id: string, path: string): Promise<Uint8Array> {
    const f = this.must(id).files.get(path);
    if (!f) throw new Error(`404 ${path}`);
    return f;
  }
  async delete(id: string): Promise<void> {
    const b = this.must(id);
    b.c = { ...b.c, status: "destroyed" };
    b.active = false;
    this.events.push(`delete ${id}`);
  }
  async exec(id: string, command: string): Promise<NaiveExecResult> {
    this.commands.push(command);
    const b = this.must(id);
    const [, phase, ...args] = /bootstrap\.sh" ([a-z-]+)((?: [0-9a-f]+)*)$/.exec(command) ?? [];
    const ok = (stdout = ""): NaiveExecResult => ({
      stdout,
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      truncated: false,
    });
    const fail = (stderr: string): NaiveExecResult => ({ ...ok(), stderr, exitCode: 1 });
    this.events.push(`${phase} ${id}`);
    switch (phase) {
      case "install": {
        const need = [
          "/home/naive/.anybench/worker.env",
          "/home/naive/.anybench/bundle.curl",
          "/home/naive/anybench-worker/bootstrap.sh",
        ];
        for (const p of need) if (!b.files.has(p)) return fail(`missing ${p}`);
        void args;
        return ok();
      }
      case "runner-version":
        return ok(this.runnerVersion);
      case "start":
        if (this.failStartOn.has(id)) return ok(); // starts, but never heartbeats
        b.active = true;
        b.startedAt = this.clock.now;
        return ok();
      case "stop":
        b.active = false;
        return ok();
      case "status":
        return ok(
          `${JSON.stringify({ host: b.host, worker: b.active ? "active" : "inactive", supervisor: "systemd", release: "r" })}\n`,
        );
      case "pack-kits":
        if (!b.kits) return ok("0\n");
        b.files.set("/home/naive/anybench-worker/generated-kits.tgz", new Uint8Array([1, 2, 3]));
        return ok("3\n");
      case "unpack-kits":
        b.kits = b.files.has("/home/naive/anybench-worker/generated-kits.tgz");
        return ok();
      default:
        return fail(`unknown command ${command}`);
    }
  }
  private must(id: string): Box {
    const b = this.boxes.get(id);
    if (!b || b.c.status === "destroyed") throw new Error(`409 computer_unavailable ${id}`);
    return b;
  }
}

function setup(over: { envFile?: string; release?: string } = {}) {
  const clock = { now: Date.parse("2026-11-08T06:00:00.000Z") };
  const api = new FakeNaiveHosts(clock);
  const releaseId = over.release ?? "0123456789abcdef0123456789abcdef";
  const manifest: WorkerManifest = {
    version: 1,
    release: {
      id: releaseId,
      sha256: "f".repeat(64),
      sizeBytes: 123,
      artifact: releaseArtifactRef(releaseId),
    },
    size: { vcpu: 1, memoryMb: 2048, diskGb: 10 },
    rotateAfterMs: 10 * H,
    commit: "abc",
    runnerCommit: RUNNER_COMMIT,
    builtAt: "2026-11-08T05:00:00.000Z",
  };
  const want: WantedWorker = {
    manifest,
    envFile: over.envFile ?? renderEnvFile({ DATABASE_URL_DIRECT: `postgres://u:${SECRET}@h/db` }),
    bootstrap: renderBootstrap(),
  };
  const logs: string[] = [];
  const deps: ReconcileDeps = {
    computers: api,
    async heartbeat(host, sinceMs) {
      const b = [...api.boxes.values()].find((x) => x.host === host);
      const healthy = !!b && b.active && b.c.status === "running" && b.startedAt >= sinceMs;
      return { healthy, detail: { host } };
    },
    releaseUrl: async () => PRESIGNED,
    log: (step, data) => logs.push(`${step} ${JSON.stringify(data ?? {})}`),
    sleep: async (ms) => {
      clock.now += ms;
    },
    now: () => clock.now,
  };
  const name = (env = want.envFile, rel = releaseId) =>
    workerComputerName(rel, envFingerprint(env));
  return { api, deps, want, clock, logs, name };
}

const noSecretsOnArgv = (api: FakeNaiveHosts, logs: string[]) => {
  for (const c of api.commands) {
    expect(c).not.toContain(SECRET);
    expect(c).not.toContain("SIG_SECRET");
  }
  for (const l of logs) {
    expect(l).not.toContain(SECRET);
    expect(l).not.toContain("SIG_SECRET");
  }
};

describe("reconcileDeploy", () => {
  it("first deploy: creates, writes the secrets by fs, installs, starts and waits for the heartbeat", async () => {
    const { api, deps, want, logs } = setup();
    const r = await reconcileDeploy(deps, want);
    expect(r.decision).toMatchObject({ kind: "replace", reason: "no worker computer" });
    const id = r.handoff!.successor;
    expect(api.events).toEqual([
      `create ${id}`,
      `install ${id}`,
      `runner-version ${id}`,
      `start ${id}`,
      `status ${id}`,
    ]);
    const box = api.boxes.get(id)!;
    expect(new TextDecoder().decode(box.files.get("/home/naive/.anybench/worker.env"))).toBe(
      want.envFile,
    );
    expect(new TextDecoder().decode(box.files.get("/home/naive/.anybench/bundle.curl"))).toContain(
      PRESIGNED,
    );
    expect(
      JSON.parse(
        new TextDecoder().decode(box.files.get("/home/naive/anybench-worker/computer.json")),
      ),
    ).toEqual({ id });
    expect(
      api.commands.some((c) => c.endsWith(`install ${want.manifest.release.id} ${"f".repeat(64)}`)),
    ).toBe(true);
    expect(api.activeWorkers()).toEqual([id]);
    noSecretsOnArgv(api, logs);
  });

  it("re-run with nothing changed keeps the worker and creates nothing", async () => {
    const { api, deps, want, name } = setup();
    const id = api.seed(name(), 2 * H);
    const r = await reconcileDeploy(deps, want);
    expect(r.decision).toEqual({ kind: "keep", keep: id, retire: [] });
    expect(api.events.filter((e) => e.startsWith("create"))).toEqual([]);
  });

  it("env change: successor installed, old stopped before the new one starts, old deleted last", async () => {
    const { api, deps, want, name, logs } = setup();
    const old = api.seed(name(renderEnvFile({ A: "1" })), 2 * H, { kits: true });
    const r = await reconcileDeploy(deps, want);
    expect(r.decision).toMatchObject({ kind: "replace", reason: "env changed" });
    const s = r.handoff!.successor;
    const order = api.events.filter((e) => !e.startsWith("status"));
    expect(order).toEqual([
      `create ${s}`,
      `install ${s}`,
      `runner-version ${s}`,
      `stop ${old}`,
      `pack-kits ${old}`,
      `unpack-kits ${s}`,
      `start ${s}`,
      `delete ${old}`,
    ]);
    expect(api.boxes.get(s)!.kits).toBe(true);
    expect(api.live()).toEqual([s]);
    noSecretsOnArgv(api, logs);
  });

  it("rolls back when the successor never heartbeats: old worker restarted, successor deleted", async () => {
    const { api, deps, want, name } = setup();
    const old = api.seed(name(), 10.5 * H);
    const origCreate = api.create.bind(api);
    api.create = async (b) => {
      const c = await origCreate(b);
      api.failStartOn.add(c.id);
      return c;
    };
    await expect(reconcileDeploy(deps, want)).rejects.toThrow(/not heartbeating/);
    expect(api.live()).toEqual([old]);
    expect(api.activeWorkers()).toEqual([old]);
    expect(api.events.at(-2)).toBe(`start ${old}`);
  });

  it("a failed install deletes the successor and leaves the old worker running", async () => {
    const { api, deps, want, name } = setup();
    const old = api.seed(name(renderEnvFile({ A: "1" })), H);
    const origWrite = api.writeFile.bind(api);
    api.writeFile = async (id, p, c) =>
      p.endsWith("bundle.curl") ? undefined : origWrite(id, p, c);
    await expect(reconcileDeploy(deps, want)).rejects.toThrow(/install .* exited 1: missing/);
    expect(api.live()).toEqual([old]);
    expect(api.activeWorkers()).toEqual([old]);
  });

  it("TDM-247: a successor whose runner is not the deploy's is deleted before the old worker stops", async () => {
    const { api, deps, want, name } = setup();
    const old = api.seed(name(renderEnvFile({ A: "1" })), H);
    api.runnerVersion = `0.1.0 ${"1".repeat(40)}\n`;
    await expect(reconcileDeploy(deps, want)).rejects.toThrow(
      new RegExp(`the host's runner was built from 1{40}, not ${RUNNER_COMMIT}`),
    );
    expect(api.events.some((e) => e.startsWith("stop"))).toBe(false);
    expect(api.live()).toEqual([old]);
    expect(api.activeWorkers()).toEqual([old]);
  });

  it("replaces a worker that is past its rotation age", async () => {
    const { api, deps, want, name } = setup();
    const old = api.seed(name(), 10.1 * H);
    const r = await reconcileDeploy(deps, want);
    expect(r.decision).toMatchObject({ kind: "replace", retire: [old] });
    expect(api.live()).toEqual([r.handoff!.successor]);
  });
});

describe("reconcileRotate (on the worker computer)", () => {
  it("young: keeps itself", async () => {
    const { api, deps, want, name } = setup();
    const me = api.seed(name(), 3 * H);
    expect((await reconcileRotate(deps, want, me)).decision.kind).toBe("keep");
    expect(api.events).toEqual([]);
  });

  it("past rotation: hands off to a successor with the same release and env, deletes itself last", async () => {
    const { api, deps, want, name } = setup();
    const me = api.seed(name(), 10.2 * H);
    const r = await reconcileRotate(deps, want, me);
    const s = r.handoff!.successor;
    expect(api.events.at(-1)).toBe(`delete ${me}`);
    expect(api.boxes.get(s)!.c.name).toBe(name());
    expect(api.live()).toEqual([s]);
  });

  it("a newer worker exists: waits", async () => {
    const { api, deps, want, name } = setup();
    const me = api.seed(name(), 11 * H);
    api.seed(name(), 0.5 * H);
    expect((await reconcileRotate(deps, want, me)).decision.kind).toBe("wait");
  });
});
