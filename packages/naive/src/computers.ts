// Naïve computers, Anybench-shaped: camelCase objects, typed errors, bytes for files.
// `liveComputers` adapts the SDK's `client.computers`; FakeNaive implements the same
// `NaiveComputersApi` in memory (fake-computers.ts). `@anybench/providers` builds its
// NaiveProvider (a ComputeProvider) on this interface, so it runs unchanged on either.
//
// Facts this follows (docs/reference/naive-api-computers.md, docs/findings/naive-hosting.md):
// - create is asynchronous (202, `creating`), poll `get` until `running`.
// - `fs/*` is confined to the home `inspect` reports (`/home/naive`); a path outside is 403.
// - exec caps timeout at 600 000 ms and each stream at 262 144 chars; a timeout is exit 124.
// - fs replies come back unparsed from the SDK, so they are validated here.

import type { VettaClient } from "@usenaive-sdk/managed-agents";
import { z } from "zod";
import { mapNaiveError, NaiveError } from "./errors.js";

export const NAIVE_COMPUTER_STATUSES = [
  "creating",
  "running",
  "paused",
  "failed",
  "destroyed",
] as const;
export type NaiveComputerStatus = (typeof NAIVE_COMPUTER_STATUSES)[number];

/** Naïve's own limits on a micro-VM (POST /v1/computers). */
export const NAIVE_COMPUTER_LIMITS = {
  vcpu: { min: 1, max: 16 },
  memoryMb: { min: 128, max: 65_536 },
  diskGb: { min: 1, max: 100 },
  nameMaxChars: 200,
  /** POST …/exec `timeout_ms` cap. */
  maxExecTimeoutMs: 600_000,
  /** Each of stdout/stderr is cut at this many characters. */
  maxOutputChars: 262_144,
  /** A computer is destroyed by the platform 12 h after `created_at`. */
  maxLifetimeMs: 12 * 60 * 60 * 1000,
} as const;

/** Where `fs/*` is rooted when inspect does not say (it always has, so far). */
export const NAIVE_DEFAULT_FS_HOME = "/home/naive";

export interface NaiveComputer {
  id: string;
  name: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  status: NaiveComputerStatus;
  snapshotId: string | null;
  /** Set on an agent's own computer; null for one created through POST /v1/computers. */
  agentId: string | null;
  createdAt: string;
}

export interface NaiveComputerProbe {
  sampledAt: string;
  uptimeSeconds: number;
  processes: number;
  load1m: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
}

export interface NaiveComputerInspect {
  id: string;
  status: NaiveComputerStatus;
  lastActiveAt: string | null;
  /** The directory `fs/*` is rooted in, or null when the provider does not say. */
  home: string | null;
  probe: NaiveComputerProbe | null;
}

export interface NaiveExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Null when the API did not report it. */
  durationMs: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface NaiveSnapshot {
  snapshotId: string;
  computerId: string;
  createdAt: string;
}

export interface NaivePage<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface NaiveComputerCreate {
  name?: string;
  vcpu?: number;
  memoryMb?: number;
  diskGb?: number;
  /** `snp_…` to restore from. */
  snapshotId?: string;
}

export interface NaiveListQuery {
  limit?: number;
  after?: string;
}

/**
 * The computers surface Anybench uses. Every method throws a `NaiveError` subclass
 * (`NaiveNotFoundError` 404, `NaiveConflictError` 409 `computer_unavailable` / `state_conflict`,
 * `NaiveInsufficientCreditsError` 402, `NaiveError` with status 403/429/400, …).
 */
export interface NaiveComputersApi {
  create(body: NaiveComputerCreate): Promise<NaiveComputer>;
  get(id: string): Promise<NaiveComputer>;
  list(query?: NaiveListQuery): Promise<NaivePage<NaiveComputer>>;
  /** Provider status, fs home and (only while running) a probe. Never wakes a paused computer. */
  inspect(id: string): Promise<NaiveComputerInspect>;
  /** Resumes a paused computer. Never put a secret in `command`: history is kept unredacted for 30 days. */
  exec(id: string, command: string, opts?: { timeoutMs?: number }): Promise<NaiveExecResult>;
  pause(id: string): Promise<NaiveComputer>;
  resume(id: string): Promise<NaiveComputer>;
  delete(id: string): Promise<void>;
  snapshot(id: string): Promise<NaiveSnapshot>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  /** `fs/read` with base64 encoding, so binary survives. */
  readFile(id: string, path: string): Promise<Uint8Array>;
  /** `fs/write` with base64 encoding. */
  writeFile(id: string, path: string, content: Uint8Array): Promise<void>;
  /** `fs/mkdir` (mkdir -p). */
  mkdir(id: string, path: string): Promise<void>;
  /** `fs/remove` (rm -rf). */
  remove(id: string, path: string): Promise<void>;
}

// ---------- wire → ours ----------

type SdkComputers = VettaClient["computers"];
type SdkComputer = Awaited<ReturnType<SdkComputers["get"]>>;
type SdkInspect = Awaited<ReturnType<SdkComputers["inspect"]>>;
type SdkExec = Awaited<ReturnType<SdkComputers["exec"]>>;
type SdkSnapshot = Awaited<ReturnType<SdkComputers["snapshot"]>>;

export function computerFromSdk(c: SdkComputer): NaiveComputer {
  return {
    id: c.id,
    name: c.name,
    vcpu: c.vcpu,
    memoryMb: c.memory_mb,
    diskGb: c.disk_gb,
    status: c.status,
    snapshotId: c.snapshot_id,
    agentId: c.agent_id ?? null,
    createdAt: c.created_at,
  };
}

export function inspectFromSdk(i: SdkInspect): NaiveComputerInspect {
  return {
    id: i.id,
    status: i.status,
    lastActiveAt: i.last_active_at,
    home: i.home,
    probe: i.probe
      ? {
          sampledAt: i.probe.sampled_at,
          uptimeSeconds: i.probe.uptime_seconds,
          processes: i.probe.processes,
          load1m: i.probe.load_1m,
          memoryUsedMb: i.probe.memory_used_mb,
          memoryTotalMb: i.probe.memory_total_mb,
          diskUsedGb: i.probe.disk_used_gb,
          diskTotalGb: i.probe.disk_total_gb,
        }
      : null,
  };
}

export function execFromSdk(r: SdkExec): NaiveExecResult {
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exit_code,
    durationMs: r.duration_ms ?? null,
    timedOut: r.timed_out ?? r.exit_code === 124,
    truncated: r.truncated ?? false,
  };
}

export function snapshotFromSdk(s: SdkSnapshot): NaiveSnapshot {
  return { snapshotId: s.snapshot_id, computerId: s.computer_id, createdAt: s.created_at };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** `fs/read` reply. The SDK hands it back unparsed. */
export const NaiveFsReadReplySchema = z.object({
  content: z.string(),
  encoding: z.enum(["text", "base64"]).optional(),
});

export function decodeFsRead(reply: unknown, path: string): Uint8Array {
  const parsed = NaiveFsReadReplySchema.safeParse(reply);
  if (!parsed.success) {
    throw new NaiveError(`fs/read ${path}: unexpected reply shape`, {
      code: "response_unreadable",
      cause: parsed.error,
    });
  }
  const { content, encoding } = parsed.data;
  if (encoding === "text") return new TextEncoder().encode(content);
  const compact = content.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) {
    throw new NaiveError(`fs/read ${path}: content is not valid base64`, {
      code: "response_unreadable",
    });
  }
  return new Uint8Array(Buffer.from(compact, "base64"));
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapNaiveError(error);
  }
}

/** `NaiveComputersApi` over the SDK's `client.computers`. */
export function liveComputers(sdk: Pick<VettaClient, "computers">): NaiveComputersApi {
  const c = sdk.computers;
  return {
    create: async (body) =>
      computerFromSdk(
        await call(() =>
          c.create({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.vcpu !== undefined ? { vcpu: body.vcpu } : {}),
            ...(body.memoryMb !== undefined ? { memory_mb: body.memoryMb } : {}),
            ...(body.diskGb !== undefined ? { disk_gb: body.diskGb } : {}),
            ...(body.snapshotId !== undefined ? { snapshot_id: body.snapshotId } : {}),
          }),
        ),
      ),
    get: async (id) => computerFromSdk(await call(() => c.get(id))),
    list: async (query = {}) => {
      const page = await call(() =>
        c.list({
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
          ...(query.after !== undefined ? { after: query.after } : {}),
        }),
      );
      return {
        data: page.data.map(computerFromSdk),
        hasMore: page.has_more,
        nextCursor: page.next_cursor,
      };
    },
    inspect: async (id) => inspectFromSdk(await call(() => c.inspect(id))),
    exec: async (id, command, opts = {}) =>
      execFromSdk(await call(() => c.exec(id, command, opts.timeoutMs))),
    pause: async (id) => computerFromSdk(await call(() => c.pause(id))),
    resume: async (id) => computerFromSdk(await call(() => c.resume(id))),
    delete: async (id) => {
      await call(() => c.delete(id));
    },
    snapshot: async (id) => snapshotFromSdk(await call(() => c.snapshot(id))),
    deleteSnapshot: async (snapshotId) => {
      await call(() => c.deleteSnapshot(snapshotId));
    },
    readFile: async (id, path) =>
      decodeFsRead(await call(() => c.fs(id, "read", { path, encoding: "base64" })), path),
    writeFile: async (id, path, content) => {
      await call(() =>
        c.fs(id, "write", {
          path,
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
        }),
      );
    },
    mkdir: async (id, path) => {
      await call(() => c.fs(id, "mkdir", { path }));
    },
    remove: async (id, path) => {
      await call(() => c.fs(id, "remove", { path }));
    },
  };
}
