// NaiveProvider: the ComputeProvider over Naïve micro-VMs (`NaiveClient.computers`, from
// @anybench/naive). It runs on the live client and on FakeNaive unchanged.
//
// What it does that the raw API does not (each from a live finding, docs/findings/naive-hosting.md):
// - Tags. Naïve computers have no tags or metadata, only a name (1-200 chars). The provider
//   writes tags into the name as `<tag> <tag> :: <display name>` and parses them back in
//   list/inspect, so the registry and reaper (TDM-31) find `ab-<run>-<trial>` computers. A name
//   without the ` :: ` form (agent computers, anything made by hand) carries no tags, so the
//   reaper never takes it for ours; agent-owned computers are left out of `list` entirely.
// - Home. fs/* is rooted at `/home/naive` (inspect's `home`), but the shell runs as another
//   user whose HOME is elsewhere (`/home/tenki` on the live box). Before the first exec on a
//   computer the provider links the fs home to $HOME (`sudo -n ln -s`) and checks both resolve to
//   the same directory, so `ComputerInfo.home` paths mean the same file to putFile and to exec.
// - putFile. fs/write has no mode and its result can take ~0.7 s to reach the shell. putFile
//   mkdirs the parent through fs, creates a non-world-readable file empty with its mode before the
//   content goes in, then checks through exec (chmod + stat size) until the shell sees it.
//   Secrets therefore never go on an exec command line; only paths and modes do.
// - execDetached. `buildDetachedCommand` puts only the setsid job in the background with every
//   fd redirected, because a Naïve exec waits for anything still holding its stdout/stderr.
// - Cost. Billed in advance per 10-minute block at 8 400 µ$ per vCPU + 2 700 µ$ per GiB;
//   `naiveBlockPriceMicroUsd` and `naiveComputerCostMicroUsd` compute it in bigint micro-USD.
//
// Everything a computer sends back (exec output, file bytes, the listing) is untrusted: it is
// validated with zod and output is capped before it leaves this file.
import { posix } from "node:path";
import {
  createNaiveClientFromEnv,
  NAIVE_COMPUTER_LIMITS,
  NAIVE_DEFAULT_FS_HOME,
  NaiveError,
  type NaiveClient,
  type NaiveComputer,
  type NaiveComputersApi,
  type NaiveExecResult,
} from "@anybench/naive";
import {
  ProviderBillingError,
  ProviderCapacityError,
  ProviderError,
  ProviderForbiddenError,
  ProviderNotFoundError,
  ProviderUnavailableError,
  ProviderValidationError,
  isProviderError,
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
  ExecResultSchema,
  ListOptionsSchema,
  ProviderCapabilitiesSchema,
  PutFileOptionsSchema,
  SnapshotInfoSchema,
  TagSchema,
  type ComputeProvider,
  type ComputerInfo,
  type ComputerProbe,
  type ComputerSpecInput,
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

export const NAIVE_PROVIDER_NAME = "naive";

export const NAIVE_CAPABILITIES: ProviderCapabilities = {
  snapshot: true,
  fork: true,
  pause: true,
  maxExecTimeoutMs: NAIVE_COMPUTER_LIMITS.maxExecTimeoutMs,
  maxOutputChars: NAIVE_COMPUTER_LIMITS.maxOutputChars,
  billing: { kind: "block", blockSeconds: 600 },
};

// ---------- cost (pure, bigint micro-USD) ----------

/** Naïve's published compute price per 10-minute block; disk is not metered. */
export const NAIVE_RATE_CARD = {
  blockSeconds: 600,
  vcpuPerBlockMicroUsd: 8_400n,
  gibPerBlockMicroUsd: 2_700n,
} as const;

function sizeOf(spec: { vcpu: number; memoryMb: number }): { vcpu: bigint; memoryMb: bigint } {
  if (!Number.isSafeInteger(spec.vcpu) || spec.vcpu < 1)
    throw new ProviderValidationError(`vcpu must be a positive integer, got ${spec.vcpu}`);
  if (!Number.isSafeInteger(spec.memoryMb) || spec.memoryMb < 1)
    throw new ProviderValidationError(`memoryMb must be a positive integer, got ${spec.memoryMb}`);
  return { vcpu: BigInt(spec.vcpu), memoryMb: BigInt(spec.memoryMb) };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Price of one 10-minute block of a computer this size: 8 400 µ$ per vCPU + 2 700 µ$ per GiB,
 * memory prorated per MiB and rounded up. 1 vCPU / 1 GiB = 11 100 (matches the ledger).
 */
export function naiveBlockPriceMicroUsd(spec: { vcpu: number; memoryMb: number }): bigint {
  const s = sizeOf(spec);
  return (
    s.vcpu * NAIVE_RATE_CARD.vcpuPerBlockMicroUsd +
    ceilDiv(s.memoryMb * NAIVE_RATE_CARD.gibPerBlockMicroUsd, 1_024n)
  );
}

/**
 * What Naïve debits for a computer alive from `createdAt` to `endedAt`, following the observed
 * ledger: create charges the part-block up to the next wall-clock 10-minute boundary, prorated
 * per millisecond (rounded up); then one full block is charged in advance at every boundary the
 * computer is still alive at. Nothing is refunded on destroy. `blocksBilled` counts the part-block.
 */
export function naiveComputerCostMicroUsd(
  spec: { vcpu: number; memoryMb: number },
  createdAt: Date | string,
  endedAt: Date | string,
): { blocksBilled: number; costMicroUsd: bigint } {
  const start = new Date(createdAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw new ProviderValidationError("createdAt and endedAt must be valid dates");
  const price = naiveBlockPriceMicroUsd(spec);
  const blockMs = NAIVE_RATE_CARD.blockSeconds * 1000;
  const firstBoundary = (Math.floor(start / blockMs) + 1) * blockMs;
  const partial = ceilDiv(price * BigInt(firstBoundary - start), BigInt(blockMs));
  const full = end > firstBoundary ? Math.ceil((end - firstBoundary) / blockMs) : 0;
  return { blocksBilled: 1 + full, costMicroUsd: partial + price * BigInt(full) };
}

// ---------- tags in the name ----------

export const NAIVE_NAME_SEPARATOR = "::";
const TAGGED_NAME =
  /^((?:[A-Za-z0-9][A-Za-z0-9_-]{0,127})(?: [A-Za-z0-9][A-Za-z0-9_-]{0,127})*)? ?::(?: ([\s\S]*))?$/;

/** `<tag> <tag> :: <name>` (each part optional). Throws if it does not fit Naïve's 200 chars. */
export function encodeNaiveComputerName(tags: readonly string[], name?: string): string {
  for (const t of tags) TagSchema.parse(t);
  const head = tags.join(" ");
  const encoded = `${head}${head ? " " : ""}${NAIVE_NAME_SEPARATOR}${name ? ` ${name}` : ""}`;
  if (encoded.length > NAIVE_COMPUTER_LIMITS.nameMaxChars) {
    throw new ProviderValidationError(
      `name plus tags is ${encoded.length} chars; a Naïve computer name holds ${NAIVE_COMPUTER_LIMITS.nameMaxChars}`,
      { provider: NAIVE_PROVIDER_NAME },
    );
  }
  return encoded;
}

/** Inverse of `encodeNaiveComputerName`. A name not in that form has no tags. */
export function decodeNaiveComputerName(raw: string): { name: string; tags: string[] } {
  const m = TAGGED_NAME.exec(raw);
  if (!m) return { name: raw, tags: [] };
  return { name: m[2] ?? "", tags: m[1] ? m[1].split(" ") : [] };
}

// ---------- errors ----------

const BILLING_CODES = new Set(["insufficient_credits", "subscription_required", "budget_exceeded"]);

/** Any Naïve failure as the ProviderError a caller branches on. */
export function providerErrorFromNaive(err: unknown, resource?: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const opts = { provider: NAIVE_PROVIDER_NAME, resource, cause: err };
  if (!(err instanceof NaiveError)) {
    return new ProviderError(
      "provider",
      `naive: ${err instanceof Error ? err.message : String(err)}`,
      opts,
    );
  }
  const { status, code } = err;
  const msg = `naive ${code}${status === undefined ? "" : ` (${status})`}: ${err.message}`;
  if (status === 402 || BILLING_CODES.has(code)) return new ProviderBillingError(msg, opts);
  if (status === 404 || code === "not_found") return new ProviderNotFoundError(msg, opts);
  if (status === 409) return new ProviderUnavailableError(msg, opts);
  if (status === 429 || code === "rate_limited") return new ProviderCapacityError(msg, opts);
  if (status === 401 || status === 403) return new ProviderForbiddenError(msg, opts);
  if (status === 400 || status === 413 || status === 422 || code === "validation_failed")
    return new ProviderValidationError(msg, opts);
  return new ProviderError("provider", msg, opts);
}

// ---------- detached launch ----------

/** Links the fs home to $HOME when they differ, then checks both name the same directory. */
export function buildNaiveHomeLinkCommand(fsHome: string): string {
  const h = shellQuote(fsHome);
  return (
    `[ "$HOME" = ${h} ] || [ -e ${h} ] || sudo -n ln -s "$HOME" ${h}; ` +
    `[ "$(readlink -f ${h})" = "$(readlink -f "$HOME")" ]`
  );
}

// ---------- the provider ----------

export interface NaiveProviderOptions {
  /** `createNaiveClient(…)`, `createNaiveClientFromEnv()` or a `FakeNaive`. */
  client: Pick<NaiveClient, "computers">;
  capabilities?: Partial<ProviderCapabilities>;
  /** Confirm each putFile through exec before returning (fs → exec lag). Default true. */
  verifyPutFile?: boolean;
  /** Tries and spacing of that check. Default 20 × 250 ms. */
  putFileCheck?: { attempts: number; intervalMs: number };
  /** waitReady poll interval when the caller gives none. Default 2 000 ms. */
  readyIntervalMs?: number;
}

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const LIST_PAGE = 100;
const SETUP_TIMEOUT_MS = 30_000;

export class NaiveProvider implements ComputeProvider {
  readonly name = NAIVE_PROVIDER_NAME;
  readonly capabilities: ProviderCapabilities;
  private readonly api: NaiveComputersApi;
  private readonly verifyPutFile: boolean;
  private readonly putFileCheck: { attempts: number; intervalMs: number };
  private readonly readyIntervalMs: number;
  /** fs home per computer, from Naïve's inspect. */
  private readonly homes = new Map<string, string>();
  /** The one home-link exec per computer (per provider instance). */
  private readonly homeLinked = new Map<string, Promise<string>>();
  private detachedSeq = 0;

  constructor(opts: NaiveProviderOptions) {
    this.api = opts.client.computers;
    this.capabilities = ProviderCapabilitiesSchema.parse({
      ...NAIVE_CAPABILITIES,
      ...opts.capabilities,
    });
    if (this.capabilities.maxExecTimeoutMs > NAIVE_COMPUTER_LIMITS.maxExecTimeoutMs) {
      throw new ProviderValidationError("maxExecTimeoutMs cannot exceed Naïve's 600 000 ms cap");
    }
    this.verifyPutFile = opts.verifyPutFile ?? true;
    this.putFileCheck = opts.putFileCheck ?? { attempts: 20, intervalMs: 250 };
    this.readyIntervalMs = opts.readyIntervalMs ?? 2_000;
  }

  private async call<T>(fn: () => Promise<T>, resource?: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw providerErrorFromNaive(err, resource);
    }
  }

  private toInfo(c: NaiveComputer, probe: ComputerProbe | null = null): ComputerInfo {
    const { name, tags } = decodeNaiveComputerName(c.name);
    const parsed = ComputerInfoSchema.safeParse({
      id: c.id,
      provider: this.name,
      name,
      status: c.status,
      vcpu: c.vcpu,
      memoryMb: c.memoryMb,
      diskGb: c.diskGb,
      tags,
      snapshotId: c.snapshotId,
      home: this.homes.get(c.id) ?? NAIVE_DEFAULT_FS_HOME,
      createdAt: c.createdAt,
      probe,
    });
    if (!parsed.success) {
      throw new ProviderError("provider", `naive returned an unreadable computer ${c.id}`, {
        provider: this.name,
        resource: c.id,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  private parseSpec(spec: ComputerSpecInput) {
    const parsed = ComputerSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderValidationError(`invalid computer spec: ${parsed.error.message}`, {
        provider: this.name,
      });
    }
    const s = parsed.data;
    const L = NAIVE_COMPUTER_LIMITS;
    const out = (what: string, v: number, lo: number, hi: number) => {
      if (v < lo || v > hi)
        throw new ProviderValidationError(`${what} ${v} is outside Naïve's ${lo}-${hi}`, {
          provider: this.name,
        });
    };
    out("vcpu", s.vcpu, L.vcpu.min, L.vcpu.max);
    out("memoryMb", s.memoryMb, L.memoryMb.min, L.memoryMb.max);
    out("diskGb", s.diskGb, L.diskGb.min, L.diskGb.max);
    return s;
  }

  // ---------- lifecycle ----------

  async create(specInput: ComputerSpecInput): Promise<ComputerInfo> {
    const spec = this.parseSpec(specInput);
    const name = encodeNaiveComputerName(spec.tags, spec.name);
    const c = await this.call(
      () =>
        this.api.create({
          name,
          vcpu: spec.vcpu,
          memoryMb: spec.memoryMb,
          diskGb: spec.diskGb,
          ...(spec.snapshotId === undefined ? {} : { snapshotId: spec.snapshotId }),
        }),
      spec.snapshotId,
    );
    return this.toInfo(c);
  }

  async waitReady(id: string, opts?: WaitReadyOptions): Promise<ComputerInfo> {
    const info = await pollUntilReady(
      async () => this.toInfo(await this.call(() => this.api.get(id), id)),
      { intervalMs: this.readyIntervalMs, ...opts },
      { provider: this.name, id },
    );
    if (info.status !== "running") return info;
    const home = await this.ensureHome(id);
    return { ...info, home };
  }

  async inspect(id: string): Promise<ComputerInfo> {
    const c = await this.call(() => this.api.get(id), id);
    let probe: ComputerProbe | null = null;
    if (c.status === "running" || c.status === "paused") {
      try {
        const i = await this.api.inspect(id);
        if (i.home) this.homes.set(id, i.home);
        if (i.probe && i.status === "running") {
          probe = {
            sampledAt: i.probe.sampledAt,
            uptimeSeconds: i.probe.uptimeSeconds,
            load1m: i.probe.load1m,
            memoryUsedMb: i.probe.memoryUsedMb,
            memoryTotalMb: i.probe.memoryTotalMb,
          };
        }
      } catch (err) {
        // The probe is optional; a computer that changed state underneath us still has a status.
        const mapped = providerErrorFromNaive(err, id);
        if (!isProviderError(mapped, "unavailable") && !isProviderError(mapped, "not_found"))
          throw mapped;
      }
    }
    return this.toInfo(c, probe);
  }

  async list(opts?: ListOptions): Promise<ComputerInfo[]> {
    const parsed = ListOptionsSchema.safeParse(opts ?? {});
    if (!parsed.success) {
      throw new ProviderValidationError(`invalid list options: ${parsed.error.message}`, {
        provider: this.name,
      });
    }
    const o = parsed.data;
    const out: ComputerInfo[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    for (let pages = 0; pages < 1_000; pages++) {
      const page = await this.call(() =>
        this.api.list({ limit: LIST_PAGE, ...(after === undefined ? {} : { after }) }),
      );
      for (const c of page.data) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        // An agent's computer belongs to the agent (Naïve refuses to destroy it): never ours.
        if (c.agentId !== null) continue;
        if (c.status === "destroyed" && !o.includeDestroyed) continue;
        const info = this.toInfo(c);
        if (matchesTags(info.tags, o)) out.push(info);
      }
      if (!page.hasMore || !page.nextCursor) return out;
      after = page.nextCursor;
    }
    throw new ProviderError("provider", "naive computers list did not end after 1 000 pages", {
      provider: this.name,
    });
  }

  async destroy(id: string): Promise<void> {
    try {
      await this.call(() => this.api.delete(id), id);
    } catch (err) {
      if (isProviderError(err, "not_found")) return this.forget(id);
      if (isProviderError(err, "unavailable")) {
        // Already gone is fine; anything else (an agent's computer, a live session's) is not.
        const status = await this.api.get(id).then(
          (c) => c.status,
          () => "destroyed" as const,
        );
        if (status === "destroyed") return this.forget(id);
      }
      throw err;
    }
    this.forget(id);
  }

  private forget(id: string): void {
    this.homes.delete(id);
    this.homeLinked.delete(id);
  }

  // ---------- home ----------

  private async fsHome(id: string): Promise<string> {
    const known = this.homes.get(id);
    if (known) return known;
    const i = await this.call(() => this.api.inspect(id), id);
    const home = i.home && i.home.startsWith("/") ? posix.normalize(i.home) : NAIVE_DEFAULT_FS_HOME;
    this.homes.set(id, home);
    return home;
  }

  /** Makes the fs home and the shell's $HOME one directory (once per computer). */
  private ensureHome(id: string): Promise<string> {
    let p = this.homeLinked.get(id);
    if (!p) {
      p = (async () => {
        const home = await this.fsHome(id);
        const r = await this.call(
          () => this.api.exec(id, buildNaiveHomeLinkCommand(home), { timeoutMs: SETUP_TIMEOUT_MS }),
          id,
        );
        if (r.exitCode !== 0) {
          throw new ProviderError(
            "provider",
            `naive: could not make ${home} the shell's home on ${id} (exit ${r.exitCode}): ${capOutput(r.stderr, 500).text.trim()}`,
            { provider: this.name, resource: id },
          );
        }
        return home;
      })();
      this.homeLinked.set(id, p);
      p.catch(() => this.homeLinked.delete(id));
    }
    return p;
  }

  // ---------- exec ----------

  private normalizeExec(r: NaiveExecResult, startedAt: number): ExecResult {
    const stdout = capOutput(r.stdout, this.capabilities.maxOutputChars);
    const stderr = capOutput(r.stderr, this.capabilities.maxOutputChars);
    const parsed = ExecResultSchema.safeParse({
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: r.timedOut ? 124 : r.exitCode,
      durationMs: r.durationMs ?? Math.max(0, Date.now() - startedAt),
      timedOut: r.timedOut,
      truncated: r.truncated || stdout.truncated || stderr.truncated,
    });
    if (!parsed.success) {
      throw new ProviderError("provider", "naive returned an unreadable exec result", {
        provider: this.name,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  async exec(id: string, command: string, opts?: ExecOptions): Promise<ExecResult> {
    const o = ExecOptionsSchema.safeParse(opts ?? {});
    if (!o.success) {
      throw new ProviderValidationError(`invalid exec options: ${o.error.message}`, {
        provider: this.name,
      });
    }
    const timeoutMs = effectiveExecTimeout(o.data, this.capabilities, this.name);
    await this.ensureHome(id);
    const startedAt = Date.now();
    const r = await this.call(() => this.api.exec(id, command, { timeoutMs }), id);
    return this.normalizeExec(r, startedAt);
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
    const home = await this.ensureHome(id);
    const logPath =
      o.data.logPath === undefined
        ? defaultDetachedLogPath(home, `${Date.now()}-${++this.detachedSeq}`)
        : resolveHomePath(home, o.data.logPath, this.name);
    const r = await this.exec(id, buildDetachedCommand(command, logPath), {
      timeoutMs: Math.min(SETUP_TIMEOUT_MS, this.capabilities.maxExecTimeoutMs),
    });
    if (r.exitCode !== 0) {
      throw new ProviderError(
        "provider",
        `execDetached failed to start (exit ${r.exitCode}): ${capOutput(r.stderr, 500).text.trim()}`,
        { provider: this.name, resource: id },
      );
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
    const mode = o.data.mode;
    const home = await this.fsHome(id);
    const abs = resolveHomePath(home, path, this.name);
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    const dir = posix.dirname(abs);
    const q = shellQuote(abs);
    const modeArg = mode === undefined ? undefined : mode.toString(8).padStart(3, "0");

    if (dir !== home) await this.call(() => this.api.mkdir(id, dir), abs);
    if (mode !== undefined && modeArg !== undefined && (mode & 0o004) === 0) {
      // Not world-readable (e.g. the 0600 secrets file): give the file its mode while it is
      // still empty, so the content never sits on disk under the default 0644.
      const pre = await this.exec(
        id,
        `mkdir -p ${shellQuote(dir)} && touch ${q} && chmod ${modeArg} ${q}`,
        {
          timeoutMs: SETUP_TIMEOUT_MS,
        },
      );
      if (pre.exitCode !== 0) {
        throw new ProviderError(
          "provider",
          `putFile could not create ${abs} with mode ${modeArg}: ${capOutput(pre.stderr, 500).text.trim()}`,
          { provider: this.name, resource: abs },
        );
      }
    }
    await this.call(() => this.api.writeFile(id, abs, bytes), abs);
    if (!this.verifyPutFile && modeArg === undefined) return;

    // The shell can lag fs/write: wait until it sees this content's size (and set the mode).
    const check = `${modeArg === undefined ? "" : `chmod ${modeArg} ${q} && `}stat -c %s ${q}`;
    let last = "";
    for (let attempt = 1; attempt <= this.putFileCheck.attempts; attempt++) {
      const r = await this.exec(id, check, { timeoutMs: SETUP_TIMEOUT_MS });
      if (r.exitCode === 0 && r.stdout.trim() === String(bytes.byteLength)) return;
      last = `exit ${r.exitCode}, stdout ${JSON.stringify(capOutput(r.stdout, 100).text)}, stderr ${JSON.stringify(capOutput(r.stderr, 200).text)}`;
      if (attempt < this.putFileCheck.attempts) await sleep(this.putFileCheck.intervalMs);
    }
    throw new ProviderError(
      "provider",
      `putFile ${abs}: the shell did not see the written file (${last})`,
      { provider: this.name, resource: abs },
    );
  }

  async getFile(id: string, path: string): Promise<Uint8Array> {
    const home = await this.fsHome(id);
    const abs = resolveHomePath(home, path, this.name);
    try {
      return await this.call(() => this.api.readFile(id, abs), abs);
    } catch (err) {
      // Live Naïve answers fs/read of a path whose parent directory is missing with 403 "path is
      // outside the sandbox working directory" (a missing file in an existing directory is 404;
      // docs/findings/naive-fs-missing-parent.md). The path is inside the home (resolveHomePath
      // checked it), so ask the shell: nothing there is a plain not_found, e.g.
      // ~/eval/out/status.json on a freshly forked trial computer.
      if (!isProviderError(err, "forbidden")) throw err;
      const q = shellQuote(abs);
      const r = await this.exec(id, `test -e ${q} || test -L ${q}`, {
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      if (r.exitCode === 1) {
        throw new ProviderNotFoundError(`naive: no such file ${abs}`, {
          provider: this.name,
          resource: abs,
          cause: err,
        });
      }
      throw err;
    }
  }

  // ---------- snapshots ----------

  async snapshot(id: string): Promise<SnapshotInfo> {
    if (!this.capabilities.snapshot)
      throw new ProviderValidationError("snapshot is disabled for this provider", {
        provider: this.name,
      });
    const s = await this.call(() => this.api.snapshot(id), id);
    const parsed = SnapshotInfoSchema.safeParse(s);
    if (!parsed.success) {
      throw new ProviderError("provider", `naive returned an unreadable snapshot for ${id}`, {
        provider: this.name,
        resource: id,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  async fork(
    snapshotId: string,
    spec: Omit<ComputerSpecInput, "snapshotId"> = {},
  ): Promise<ComputerInfo> {
    if (!this.capabilities.fork)
      throw new ProviderValidationError("fork is disabled for this provider", {
        provider: this.name,
      });
    return this.create({ ...spec, snapshotId });
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.call(() => this.api.deleteSnapshot(snapshotId), snapshotId);
  }

  // ---------- pause ----------

  async pause(id: string): Promise<ComputerInfo> {
    if (!this.capabilities.pause)
      throw new ProviderValidationError("pause is disabled for this provider", {
        provider: this.name,
      });
    return this.toInfo(await this.call(() => this.api.pause(id), id));
  }

  async resume(id: string): Promise<ComputerInfo> {
    return this.toInfo(await this.call(() => this.api.resume(id), id));
  }
}

/** A NaiveProvider on the live API, from `NAIVE_API_KEY` / `NAIVE_BASE_URL`. Spends money. */
export function createNaiveProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: Omit<NaiveProviderOptions, "client"> = {},
): NaiveProvider {
  return new NaiveProvider({ ...opts, client: createNaiveClientFromEnv(env) });
}
