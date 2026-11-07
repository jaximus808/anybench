// DockerLocalProvider: containers as eval computers, for dev, CI and small Docker evals on
// the worker VM. Drives the docker CLI through child_process (no SDK dependency) and works
// on any Linux or Docker Desktop host, amd64 or arm64.
//
// - Every container runs a base image derived from `baseImage` (default ubuntu:24.04) that
//   adds a `naive` user with home /home/naive, so putFile/getFile confinement matches Naïve.
//   The derived image is built once per host and cached under a content-hashed tag.
// - exec runs as root by default (system setup goes through exec, as on Naïve) with
//   HOME=/home/naive and cwd /home/naive. Run something as the naive user with
//   `runuser -u naive -- <cmd>`, or construct the provider with `execUser: "naive"`.
// - Timeouts are enforced inside the container with coreutils `timeout`, which kills the
//   command's whole process group, so a timed-out exec leaves nothing running.
// - snapshot = `docker commit` to an image; fork = run a new container from that image.
// - Tags and the spec live in container labels (`anybench.*`), so list/reaper find them
//   with `docker ps --filter label=anybench.provider=docker-local`.
// - pause/resume = docker pause/unpause. Billing is free.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  ProviderError,
  ProviderForbiddenError,
  ProviderNotFoundError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderValidationError,
} from "./errors.js";
import {
  buildDetachedCommand,
  capOutput,
  defaultDetachedLogPath,
  effectiveExecTimeout,
  matchesTags,
  parseDetachedPid,
  pollUntilReady,
  resolveHomePath,
  shellQuote,
} from "./helpers.js";
import {
  ComputerInfoSchema,
  ComputerSpecSchema,
  ExecDetachedOptionsSchema,
  ExecOptionsSchema,
  ListOptionsSchema,
  PutFileOptionsSchema,
  TagSchema,
  type ComputeProvider,
  type ComputerInfo,
  type ComputerSpecInput,
  type ComputerStatus,
  type DetachedProcess,
  type ExecDetachedOptions,
  type ExecOptions,
  type ExecResult,
  type ListOptions,
  type ProviderCapabilities,
  type PutFileOptions,
  type SnapshotInfo,
  type WaitReadyOptions,
} from "./types.js";

export const DOCKER_LOCAL_PROVIDER = "docker-local";
export const DOCKER_LOCAL_HOME = "/home/naive";
export const DOCKER_LOCAL_USER = "naive";
export const DOCKER_LOCAL_DEFAULT_BASE_IMAGE = "ubuntu:24.04";
export const DOCKER_LOCAL_SNAPSHOT_REPO = "anybench-docker-local-snapshot";
export const DOCKER_LOCAL_BASE_REPO = "anybench-docker-local-base";

/** Label keys the provider writes on every container it creates. */
export const DOCKER_LOCAL_LABELS = {
  provider: "anybench.provider",
  name: "anybench.name",
  tags: "anybench.tags",
  vcpu: "anybench.vcpu",
  memoryMb: "anybench.memory-mb",
  diskGb: "anybench.disk-gb",
  snapshotId: "anybench.snapshot-id",
  home: "anybench.home",
  createdAt: "anybench.created-at",
  snapshotOf: "anybench.snapshot-of",
  snapshotCreatedAt: "anybench.snapshot-created-at",
} as const;

export interface DockerLocalProviderOptions {
  /** docker CLI to run. Default "docker" (DOCKER_HOST etc. are honored as usual). */
  dockerBin?: string;
  /** Image the naive-user base image is derived from. Needs sh, coreutils and util-linux. */
  baseImage?: string;
  /** User exec runs as. Default "root"; fs calls always land files owned by naive. */
  execUser?: "root" | "naive";
  /** Extra labels put on every container (and so on every snapshot image). */
  labels?: Record<string, string>;
  /** Apply --cpus/--memory from the spec (clamped to the host). Default true. */
  enforceLimits?: boolean;
  /** `docker run --network`. Default: docker's default bridge. */
  network?: string;
  capabilities?: Partial<ProviderCapabilities>;
}

interface DockerRun {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  stdoutCut: boolean;
  stderrCut: boolean;
  killed: boolean;
}

interface DockerRunOpts {
  input?: Uint8Array;
  timeoutMs?: number;
  /** Stop buffering a stream past this many bytes (the process keeps running). */
  maxBytes?: number;
}

interface ContainerInspect {
  Id: string;
  Created: string;
  State: { Status: string; Paused?: boolean };
  Config: { Labels: Record<string, string> | null };
}

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^snap-[0-9a-f]{16}$/;
/** Exit codes the fs helper scripts use; chosen well away from docker's own 125-127. */
const FS_FORBIDDEN = 43;
const FS_MISSING = 44;
const FS_IS_DIR = 45;

const NOT_FOUND = /no such (container|object|image)|not found|no such file/i;
const DAEMON_DOWN =
  /cannot connect to the docker daemon|is the docker daemon running|error during connect/i;

/** True when a docker CLI is on PATH and its daemon answers. Use it to skip tests cleanly. */
export async function dockerLocalAvailable(dockerBin = "docker"): Promise<boolean> {
  try {
    const r = await runDocker(dockerBin, ["info", "--format", "{{.ServerVersion}}"], {
      timeoutMs: 15_000,
    });
    return r.code === 0 && r.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

function runDocker(bin: string, args: string[], opts: DockerRunOpts = {}): Promise<DockerRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const max = opts.maxBytes ?? Number.POSITIVE_INFINITY;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let stdoutCut = false;
    let stderrCut = false;
    let killed = false;
    child.stdout.on("data", (b: Buffer) => {
      if (outLen >= max) return void (stdoutCut = true);
      const take = b.subarray(0, Math.max(0, max - outLen));
      if (take.length < b.length) stdoutCut = true;
      out.push(take);
      outLen += take.length;
    });
    child.stderr.on("data", (b: Buffer) => {
      if (errLen >= max) return void (stderrCut = true);
      const take = b.subarray(0, Math.max(0, max - errLen));
      if (take.length < b.length) stderrCut = true;
      err.push(take);
      errLen += take.length;
    });
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs);
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(
        new ProviderUnavailableError(`could not run ${bin}: ${e.message}`, {
          provider: DOCKER_LOCAL_PROVIDER,
          cause: e,
        }),
      );
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? 137,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        stdoutCut,
        stderrCut,
        killed,
      });
    });
    child.stdin.on("error", () => undefined); // EPIPE if the process exits before reading
    child.stdin.end(opts.input ?? undefined);
  });
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function snapshotRef(snapshotId: string): string {
  return `${DOCKER_LOCAL_SNAPSHOT_REPO}:${snapshotId}`;
}

function baseDockerfile(baseImage: string): string {
  const u = DOCKER_LOCAL_USER;
  const h = DOCKER_LOCAL_HOME;
  return [
    `FROM ${baseImage}`,
    `RUN (id -u ${u} >/dev/null 2>&1 || useradd -m -d ${h} -s /bin/sh ${u} || adduser -D -h ${h} -s /bin/sh ${u}) \\`,
    `  && mkdir -p ${h} && chown ${u}:${u} ${h}`,
    `ENV HOME=${h}`,
    `WORKDIR ${h}`,
    `CMD ["sleep", "infinity"]`,
    "",
  ].join("\n");
}

function toIso(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function mapStatus(state: ContainerInspect["State"]): ComputerStatus {
  if (state.Paused || state.Status === "paused") return "paused";
  switch (state.Status) {
    case "running":
      return "running";
    case "created":
    case "restarting":
      return "creating";
    case "removing":
      return "destroyed";
    default: // exited, dead
      return "failed";
  }
}

export class DockerLocalProvider implements ComputeProvider {
  readonly name = DOCKER_LOCAL_PROVIDER;
  readonly capabilities: ProviderCapabilities;

  private readonly bin: string;
  private readonly baseImage: string;
  private readonly execUser: "root" | "naive";
  private readonly extraLabels: Record<string, string>;
  private readonly enforceLimits: boolean;
  private readonly network: string | undefined;
  private baseTag: Promise<string> | undefined;
  private builtBase = false;
  private hostLimits: Promise<{ cpus: number; memoryMb: number }> | undefined;
  private detachedSeq = 0;

  constructor(opts: DockerLocalProviderOptions = {}) {
    this.bin = opts.dockerBin ?? "docker";
    this.baseImage = opts.baseImage ?? DOCKER_LOCAL_DEFAULT_BASE_IMAGE;
    this.execUser = opts.execUser ?? "root";
    this.extraLabels = { ...opts.labels };
    for (const k of Object.keys(this.extraLabels)) {
      if (Object.values(DOCKER_LOCAL_LABELS).includes(k as never)) {
        throw new ProviderValidationError(`label ${k} is reserved by the docker-local provider`);
      }
    }
    this.enforceLimits = opts.enforceLimits ?? true;
    this.network = opts.network;
    this.capabilities = {
      snapshot: true,
      fork: true,
      pause: true,
      maxExecTimeoutMs: 600_000,
      maxOutputChars: 262_144,
      billing: { kind: "free" },
      ...opts.capabilities,
    };
  }

  // ---------- lifecycle ----------

  async create(spec: ComputerSpecInput): Promise<ComputerInfo> {
    const parsed = ComputerSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderValidationError(`invalid computer spec: ${parsed.error.message}`, {
        provider: this.name,
      });
    }
    const s = parsed.data;
    let image: string;
    if (s.snapshotId !== undefined) {
      image = await this.requireSnapshot(s.snapshotId);
    } else {
      image = await this.ensureBaseImage();
    }
    const L = DOCKER_LOCAL_LABELS;
    const containerName = `ab-dl-${randomHex(6)}`;
    const labels: Record<string, string> = {
      ...this.extraLabels,
      [L.provider]: this.name,
      [L.name]: s.name ?? containerName,
      [L.tags]: s.tags.join(","),
      [L.vcpu]: String(s.vcpu),
      [L.memoryMb]: String(s.memoryMb),
      [L.diskGb]: String(s.diskGb),
      [L.snapshotId]: s.snapshotId ?? "",
      [L.home]: DOCKER_LOCAL_HOME,
      [L.createdAt]: new Date().toISOString(),
      // a snapshot image carries its source's snapshot labels; blank them on the fork
      [L.snapshotOf]: "",
      [L.snapshotCreatedAt]: "",
    };
    const args = ["run", "-d", "--init", "--name", containerName];
    for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
    if (this.enforceLimits) {
      const host = await this.limits();
      args.push("--cpus", String(Math.min(s.vcpu, host.cpus)));
      args.push("--memory", `${Math.min(s.memoryMb, host.memoryMb)}m`);
    }
    if (this.network !== undefined) args.push("--network", this.network);
    args.push("-e", `HOME=${DOCKER_LOCAL_HOME}`, "-w", DOCKER_LOCAL_HOME);
    args.push("--entrypoint", "sleep", image, "infinity");
    const r = await this.docker(args, { timeoutMs: 120_000 });
    if (r.code !== 0) this.fail(r, `docker run ${image}`, image);
    const id = r.stdout.toString().trim().split("\n").pop() ?? "";
    return this.inspect(id);
  }

  waitReady(id: string, opts?: WaitReadyOptions): Promise<ComputerInfo> {
    return pollUntilReady(() => this.inspect(id), opts, { provider: this.name, id });
  }

  async inspect(id: string): Promise<ComputerInfo> {
    const [c] = await this.inspectContainers([this.checkId(id)], true);
    if (!c) throw this.notFound(id);
    return this.toInfo(c);
  }

  async list(opts?: ListOptions): Promise<ComputerInfo[]> {
    const o = ListOptionsSchema.parse(opts ?? {});
    const ps = await this.docker([
      "ps",
      "-a",
      "-q",
      "--no-trunc",
      "--filter",
      `label=${DOCKER_LOCAL_LABELS.provider}=${this.name}`,
    ]);
    if (ps.code !== 0) this.fail(ps, "docker ps");
    const ids = ps.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (ids.length === 0) return [];
    const infos = (await this.inspectContainers(ids, false)).map((c) => this.toInfo(c));
    return infos.filter(
      (i) => (o.includeDestroyed || i.status !== "destroyed") && matchesTags(i.tags, o),
    );
  }

  async destroy(id: string): Promise<void> {
    if (!CONTAINER_ID.test(id)) return;
    const [c] = await this.inspectContainers([id], true);
    if (!c) return;
    const r = await this.docker(["rm", "-f", "-v", id], { timeoutMs: 60_000 });
    if (r.code !== 0 && !NOT_FOUND.test(r.stderr.toString())) this.fail(r, "docker rm", id);
  }

  async pause(id: string): Promise<ComputerInfo> {
    const info = await this.inspect(id);
    if (info.status === "paused") return info;
    if (info.status !== "running") throw this.unavailable(id, info.status);
    const r = await this.docker(["pause", id]);
    if (r.code !== 0) this.fail(r, "docker pause", id);
    return this.inspect(id);
  }

  async resume(id: string): Promise<ComputerInfo> {
    await this.ensureRunning(id);
    return this.inspect(id);
  }

  // ---------- exec ----------

  async exec(id: string, command: string, opts?: ExecOptions): Promise<ExecResult> {
    const o = ExecOptionsSchema.safeParse(opts ?? {});
    if (!o.success) {
      throw new ProviderValidationError(`invalid exec options: ${o.error.message}`, {
        provider: this.name,
      });
    }
    const timeoutMs = effectiveExecTimeout(o.data, this.capabilities, this.name);
    await this.ensureRunning(id);
    const max = this.capabilities.maxOutputChars;
    const secs = (timeoutMs / 1000).toFixed(3);
    const started = Date.now();
    const r = await this.docker(
      ["exec", ...this.execEnv(this.execUser), id, "timeout", "-k", "2", secs, "sh", "-c", command],
      // host-side backstop in case `timeout` itself cannot run or hangs
      { timeoutMs: timeoutMs + 10_000, maxBytes: max * 4 },
    );
    const durationMs = Date.now() - started;
    const stderrText = r.stderr.toString("utf8");
    if (!r.killed && (r.code === 125 || r.code === 126) && this.isDockerError(stderrText)) {
      await this.inspect(id); // not_found if it vanished mid-call
      this.fail(r, "docker exec", id);
    }
    const timedOut =
      r.killed || ((r.code === 124 || r.code === 137) && durationMs >= timeoutMs - 50);
    const so = capOutput(r.stdout.toString("utf8"), max);
    const se = capOutput(stderrText, max);
    return {
      stdout: so.text,
      stderr: se.text,
      exitCode: timedOut ? 124 : r.code,
      durationMs,
      timedOut,
      truncated: so.truncated || se.truncated || r.stdoutCut || r.stderrCut,
    };
  }

  async execDetached(
    id: string,
    command: string,
    opts?: ExecDetachedOptions,
  ): Promise<DetachedProcess> {
    const o = ExecDetachedOptionsSchema.safeParse(opts ?? {});
    if (!o.success) {
      throw new ProviderValidationError(`invalid execDetached options: ${o.error.message}`, {
        provider: this.name,
      });
    }
    const logPath =
      o.data.logPath === undefined
        ? defaultDetachedLogPath(DOCKER_LOCAL_HOME, `${Date.now()}-${++this.detachedSeq}`)
        : resolveHomePath(DOCKER_LOCAL_HOME, o.data.logPath, this.name);
    const r = await this.exec(id, buildDetachedCommand(command, logPath), { timeoutMs: 30_000 });
    if (r.exitCode !== 0) {
      throw new ProviderError("provider", `execDetached failed to start: ${r.stderr.trim()}`, {
        provider: this.name,
        resource: id,
      });
    }
    return { pid: parseDetachedPid(r.stdout, this.name), logPath };
  }

  // ---------- files ----------

  async putFile(
    id: string,
    path: string,
    content: string | Uint8Array,
    opts?: PutFileOptions,
  ): Promise<void> {
    const o = PutFileOptionsSchema.safeParse(opts ?? {});
    if (!o.success) {
      throw new ProviderValidationError(`invalid putFile options: ${o.error.message}`, {
        provider: this.name,
      });
    }
    const abs = resolveHomePath(DOCKER_LOCAL_HOME, path, this.name);
    await this.ensureRunning(id);
    const mode = (o.data.mode ?? 0o644).toString(8);
    const u = DOCKER_LOCAL_USER;
    // Create missing parents as naive, refuse a parent that resolves outside home (symlink),
    // write to a 0600 temp file, then chmod/chown and rename into place atomically.
    const script = [
      `p=${shellQuote(abs)}`,
      `d=$(dirname "$p")`,
      `first=; top="$d"; while [ ! -e "$top" ]; do first="$top"; top=$(dirname "$top"); done`,
      `rt=$(realpath "$top") || exit 1`,
      `case "$rt/" in ${DOCKER_LOCAL_HOME}/*) ;; *) exit ${FS_FORBIDDEN} ;; esac`,
      `mkdir -p "$d" || exit 1`,
      `[ -n "$first" ] && chown -R ${u}:${u} "$first"`,
      `r=$(realpath "$d") || exit 1`,
      `case "$r/" in ${DOCKER_LOCAL_HOME}/*) ;; *) exit ${FS_FORBIDDEN} ;; esac`,
      `[ -d "$p" ] && exit ${FS_IS_DIR}`,
      `t="$r/.ab-put-$$"`,
      `umask 077 && cat > "$t" && chmod ${mode} "$t" && chown ${u}:${u} "$t" && mv -f "$t" "$r/$(basename "$p")" || { rm -f "$t"; exit 1; }`,
    ].join("\n");
    const input = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const r = await this.docker(["exec", "-i", ...this.execEnv("root"), id, "sh", "-c", script], {
      input,
      timeoutMs: 120_000,
    });
    this.fsResult(r, id, path, "putFile");
  }

  async getFile(id: string, path: string): Promise<Uint8Array> {
    const abs = resolveHomePath(DOCKER_LOCAL_HOME, path, this.name);
    await this.ensureRunning(id);
    const script = [
      `p=${shellQuote(abs)}`,
      `[ -e "$p" ] || exit ${FS_MISSING}`,
      `r=$(realpath "$p") || exit ${FS_MISSING}`,
      `case "$r" in ${DOCKER_LOCAL_HOME}/*) ;; *) exit ${FS_FORBIDDEN} ;; esac`,
      `[ -d "$r" ] && exit ${FS_IS_DIR}`,
      `exec cat "$r"`,
    ].join("\n");
    const r = await this.docker(["exec", ...this.execEnv("root"), id, "sh", "-c", script], {
      timeoutMs: 120_000,
    });
    this.fsResult(r, id, path, "getFile");
    return new Uint8Array(r.stdout); // copy: Buffer.concat may hand out a pooled slab
  }

  // ---------- snapshots ----------

  async snapshot(id: string): Promise<SnapshotInfo> {
    if (!this.capabilities.snapshot) {
      throw new ProviderValidationError("snapshots are disabled on this provider", {
        provider: this.name,
      });
    }
    await this.ensureRunning(id);
    const snapshotId = `snap-${randomHex(8)}`;
    const createdAt = new Date().toISOString();
    const L = DOCKER_LOCAL_LABELS;
    const r = await this.docker(
      [
        "commit",
        "--change",
        `LABEL ${L.snapshotOf}=${id} ${L.snapshotCreatedAt}=${createdAt}`,
        id,
        snapshotRef(snapshotId),
      ],
      { timeoutMs: 600_000 },
    );
    if (r.code !== 0) this.fail(r, "docker commit", id);
    return { snapshotId, computerId: id, createdAt };
  }

  async fork(
    snapshotId: string,
    spec: Omit<ComputerSpecInput, "snapshotId"> = {},
  ): Promise<ComputerInfo> {
    if (!this.capabilities.fork) {
      throw new ProviderValidationError("fork is disabled on this provider", {
        provider: this.name,
      });
    }
    return this.create({ ...spec, snapshotId });
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const ref = await this.requireSnapshot(snapshotId);
    const r = await this.docker(["rmi", ref], { timeoutMs: 120_000 });
    if (r.code === 0) return;
    const msg = r.stderr.toString();
    if (NOT_FOUND.test(msg)) throw this.notFound(snapshotId, "snapshot");
    if (/conflict|being used|in use/i.test(msg)) {
      throw new ProviderUnavailableError(
        `snapshot ${snapshotId} is still used by a computer; destroy its forks first`,
        { provider: this.name, resource: snapshotId },
      );
    }
    this.fail(r, "docker rmi", snapshotId);
  }

  // ---------- housekeeping ----------

  /**
   * Remove the base image this instance built, if nothing uses it any more. Tests call it
   * so they leave no images behind; long-lived workers keep the image as a cache.
   */
  async dispose(): Promise<void> {
    if (!this.builtBase || !this.baseTag) return;
    const tag = await this.baseTag.catch(() => undefined);
    if (tag === undefined) return;
    await this.docker(["rmi", tag], { timeoutMs: 120_000 }).catch(() => undefined);
    this.builtBase = false;
    this.baseTag = undefined;
  }

  /** The base image tag (built on first use). */
  ensureBaseImage(): Promise<string> {
    this.baseTag ??= this.buildBaseImage().catch((e: unknown) => {
      this.baseTag = undefined;
      throw e;
    });
    return this.baseTag;
  }

  // ---------- internals ----------

  private async buildBaseImage(): Promise<string> {
    const dockerfile = baseDockerfile(this.baseImage);
    const hash = createHash("sha256").update(dockerfile).digest("hex").slice(0, 16);
    const tag = `${DOCKER_LOCAL_BASE_REPO}:${hash}`;
    const have = await this.docker(["image", "inspect", "--format", "{{.Id}}", tag]);
    if (have.code === 0) return tag;
    const r = await this.docker(["build", "-q", "-t", tag, "-"], {
      input: Buffer.from(dockerfile, "utf8"),
      timeoutMs: 600_000,
    });
    if (r.code !== 0) {
      throw new ProviderError(
        "provision_failed",
        `building ${tag} from ${this.baseImage} failed: ${r.stderr.toString().trim().slice(-2000)}`,
        { provider: this.name, resource: this.baseImage },
      );
    }
    this.builtBase = true;
    return tag;
  }

  private limits(): Promise<{ cpus: number; memoryMb: number }> {
    this.hostLimits ??= (async () => {
      const r = await this.docker(["info", "--format", "{{.NCPU}} {{.MemTotal}}"]);
      if (r.code !== 0) this.fail(r, "docker info");
      const [cpu, mem] = r.stdout.toString().trim().split(/\s+/).map(Number);
      return {
        cpus: cpu && cpu > 0 ? cpu : 1,
        memoryMb: mem && mem > 0 ? Math.floor(mem / (1024 * 1024)) : 1024,
      };
    })().catch((e: unknown) => {
      this.hostLimits = undefined;
      throw e;
    });
    return this.hostLimits;
  }

  private execEnv(user: "root" | "naive"): string[] {
    return ["-u", user, "-w", DOCKER_LOCAL_HOME, "-e", `HOME=${DOCKER_LOCAL_HOME}`];
  }

  private docker(args: string[], opts?: DockerRunOpts): Promise<DockerRun> {
    return runDocker(this.bin, args, opts);
  }

  private checkId(id: string): string {
    if (!CONTAINER_ID.test(id)) throw this.notFound(id);
    return id;
  }

  /** Inspect containers; ones that vanished are dropped. Only our own containers count. */
  private async inspectContainers(ids: string[], single: boolean): Promise<ContainerInspect[]> {
    const r = await this.docker(["container", "inspect", ...ids]);
    const text = r.stdout.toString().trim();
    if (r.code !== 0 && !NOT_FOUND.test(r.stderr.toString())) this.fail(r, "docker inspect");
    if (r.code !== 0 && single) return [];
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : [];
    } catch (e) {
      throw new ProviderError("provider", `docker inspect printed invalid JSON`, {
        provider: this.name,
        cause: e,
      });
    }
    return (parsed as ContainerInspect[]).filter(
      (c) => c?.Config?.Labels?.[DOCKER_LOCAL_LABELS.provider] === this.name,
    );
  }

  private toInfo(c: ContainerInspect): ComputerInfo {
    const L = DOCKER_LOCAL_LABELS;
    const labels = c.Config.Labels ?? {};
    const int = (k: string, d: number) => {
      const n = Number.parseInt(labels[k] ?? "", 10);
      return Number.isInteger(n) && n > 0 ? n : d;
    };
    const tags = (labels[L.tags] ?? "").split(",").filter((t) => TagSchema.safeParse(t).success);
    return ComputerInfoSchema.parse({
      id: c.Id,
      provider: this.name,
      name: labels[L.name] ?? c.Id.slice(0, 12),
      status: mapStatus(c.State),
      vcpu: int(L.vcpu, 1),
      memoryMb: int(L.memoryMb, 1024),
      diskGb: int(L.diskGb, 1),
      tags,
      snapshotId: labels[L.snapshotId] || null,
      home: labels[L.home] || DOCKER_LOCAL_HOME,
      createdAt: toIso(labels[L.createdAt]) ?? toIso(c.Created) ?? new Date(0).toISOString(),
      probe: null,
    });
  }

  /** Resume a paused computer; anything other than running/paused is unavailable. */
  private async ensureRunning(id: string): Promise<void> {
    const info = await this.inspect(id);
    if (info.status === "running") return;
    if (info.status !== "paused") throw this.unavailable(id, info.status);
    const r = await this.docker(["unpause", id]);
    if (r.code !== 0 && !/not paused/i.test(r.stderr.toString()))
      this.fail(r, "docker unpause", id);
  }

  private async requireSnapshot(snapshotId: string): Promise<string> {
    if (!SNAPSHOT_ID.test(snapshotId)) throw this.notFound(snapshotId, "snapshot");
    const ref = snapshotRef(snapshotId);
    const r = await this.docker(["image", "inspect", "--format", "{{.Id}}", ref]);
    if (r.code !== 0) {
      if (NOT_FOUND.test(r.stderr.toString())) throw this.notFound(snapshotId, "snapshot");
      this.fail(r, "docker image inspect", snapshotId);
    }
    return ref;
  }

  private fsResult(r: DockerRun, id: string, path: string, op: string): void {
    if (r.code === 0) return;
    const opts = { provider: this.name, resource: path };
    if (r.code === FS_MISSING) throw new ProviderNotFoundError(`${path} not found on ${id}`, opts);
    if (r.code === FS_FORBIDDEN) {
      throw new ProviderForbiddenError(`${path} resolves outside ${DOCKER_LOCAL_HOME}`, opts);
    }
    if (r.code === FS_IS_DIR) {
      throw new ProviderValidationError(`${path} is a directory, not a file`, opts);
    }
    this.fail(r, op, id);
  }

  private isDockerError(stderr: string): boolean {
    return /error response from daemon|no such container|is not running|is paused/i.test(stderr);
  }

  private notFound(resource: string, kind = "computer"): ProviderNotFoundError {
    return new ProviderNotFoundError(`${kind} ${resource} not found`, {
      provider: this.name,
      resource,
    });
  }

  private unavailable(id: string, status: ComputerStatus): ProviderUnavailableError {
    return new ProviderUnavailableError(`computer ${id} is ${status}, not running`, {
      provider: this.name,
      resource: id,
    });
  }

  /** Map a failed docker CLI call to a typed ProviderError. */
  private fail(r: DockerRun, what: string, resource?: string): never {
    const msg = r.stderr.toString().trim().slice(-2000) || `exit ${r.code}`;
    const opts = { provider: this.name, resource };
    if (DAEMON_DOWN.test(msg)) throw new ProviderUnavailableError(`${what}: ${msg}`, opts);
    if (NOT_FOUND.test(msg)) throw new ProviderNotFoundError(`${what}: ${msg}`, opts);
    if (r.killed) throw new ProviderTimeoutError(`${what} timed out`, opts);
    throw new ProviderError("provider", `${what} failed: ${msg}`, opts);
  }
}
