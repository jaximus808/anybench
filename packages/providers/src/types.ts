// The ComputeProvider contract: one interface over Naïve (default), Vultr (heavy),
// docker-local (dev, CI) and fake (unit tests). Shaped after Naïve's real API:
//   - create is asynchronous (returns `creating`); waitReady polls to `running`.
//   - exec is synchronous with a timeout cap (Naïve: 600 000 ms) and an output cap
//     (Naïve: 262 144 chars per stream); a timeout resolves with exit 124, it does not throw.
//   - execDetached starts work that outlives exec (setsid nohup), e.g. the in-VM runner.
//   - putFile/getFile are confined to the computer's home (Naïve: /home/naive); use exec
//     for system setup.
//   - snapshot + fork ("build once, fork many"), pause/resume, billing in blocks.
//   - computers carry tags (`ab-<run>-<trial>`) so the registry and reaper can find them.
import { z } from "zod";

/** Tag: a short label; Anybench uses `ab-<run>-<trial>` (see tags helpers). */
export const TagSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/,
    "tag must be [A-Za-z0-9_-], 1-128 chars, not starting with - or _",
  );
export type Tag = z.infer<typeof TagSchema>;

export const ComputerStatusSchema = z.enum([
  "creating",
  "running",
  "paused",
  "failed",
  "destroyed",
]);
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;

/** What to provision. Sizes mirror Naïve's limits (vCPU 1-16 there; Vultr goes higher). */
export const ComputerSpecSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  vcpu: z.int().min(1).max(128).default(2),
  memoryMb: z.int().min(128).max(1_048_576).default(4096),
  diskGb: z.int().min(1).max(4096).default(5),
  /** Restore from this snapshot (what `fork` does). */
  snapshotId: z.string().min(1).optional(),
  tags: z.array(TagSchema).max(32).default([]),
});
export type ComputerSpecInput = z.input<typeof ComputerSpecSchema>;
export type ComputerSpec = z.output<typeof ComputerSpecSchema>;

export const ComputerProbeSchema = z.object({
  sampledAt: z.string(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  load1m: z.number().nonnegative().nullable(),
  memoryUsedMb: z.number().nonnegative().nullable(),
  memoryTotalMb: z.number().nonnegative().nullable(),
});
export type ComputerProbe = z.infer<typeof ComputerProbeSchema>;

export const ComputerInfoSchema = z.object({
  /** Provider-native id (Naïve `cmp_…`, docker container id, Vultr instance id). */
  id: z.string().min(1),
  provider: z.string().min(1),
  name: z.string(),
  status: ComputerStatusSchema,
  vcpu: z.int().positive(),
  memoryMb: z.int().positive(),
  diskGb: z.int().positive(),
  tags: z.array(TagSchema),
  snapshotId: z.string().nullable(),
  /** Absolute directory putFile/getFile are confined to. Read it from here; never hardcode. */
  home: z.string().startsWith("/"),
  createdAt: z.iso.datetime({ offset: true }),
  /** Live sample from inspect, only while running and only if the provider supports it. */
  probe: ComputerProbeSchema.nullable().default(null),
});
export type ComputerInfo = z.output<typeof ComputerInfoSchema>;

export const ExecOptionsSchema = z.strictObject({
  /** Kill the command after this long. Must be <= capabilities.maxExecTimeoutMs. */
  timeoutMs: z.int().positive().optional(),
});
export type ExecOptions = z.infer<typeof ExecOptionsSchema>;

export const ExecResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.int(),
  durationMs: z.int().nonnegative(),
  /** The timeout elapsed; the command was killed and exitCode is 124. */
  timedOut: z.boolean(),
  /** stdout or stderr was cut at capabilities.maxOutputChars. */
  truncated: z.boolean(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

export const ExecDetachedOptionsSchema = z.strictObject({
  /** File the detached command's stdout+stderr are appended to. Default: `<home>/.anybench/logs/detached-<n>.log`. */
  logPath: z.string().min(1).optional(),
});
export type ExecDetachedOptions = z.infer<typeof ExecDetachedOptionsSchema>;

export const DetachedProcessSchema = z.object({
  pid: z.int().positive(),
  logPath: z.string().startsWith("/"),
});
export type DetachedProcess = z.infer<typeof DetachedProcessSchema>;

export const PutFileOptionsSchema = z.strictObject({
  /** POSIX mode, e.g. 0o600 for the secrets env file. */
  mode: z.int().min(0).max(0o7777).optional(),
});
export type PutFileOptions = z.infer<typeof PutFileOptionsSchema>;

export const WaitReadyOptionsSchema = z.object({
  timeoutMs: z.int().positive().default(300_000),
  intervalMs: z.int().positive().default(2_000),
  signal: z.custom<AbortSignal>((v) => v instanceof AbortSignal).optional(),
});
export type WaitReadyOptions = z.input<typeof WaitReadyOptionsSchema>;

export const ListOptionsSchema = z.strictObject({
  /** Only computers carrying this exact tag. */
  tag: TagSchema.optional(),
  /** Only computers with at least one tag starting with this (e.g. `ab-<run>-` for a whole run). */
  tagPrefix: z.string().min(1).optional(),
  /** Include computers already destroyed (if the provider still knows them). Default false. */
  includeDestroyed: z.boolean().default(false),
});
export type ListOptions = z.input<typeof ListOptionsSchema>;

export const SnapshotInfoSchema = z.object({
  snapshotId: z.string().min(1),
  computerId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
});
export type SnapshotInfo = z.infer<typeof SnapshotInfoSchema>;

/** How the provider bills compute, so the scheduler can pack trials into paid blocks. */
export const BillingModelSchema = z.discriminatedUnion("kind", [
  /** Paid in advance per block (Naïve: 600 s); pausing does not refund the current block. */
  z.object({ kind: z.literal("block"), blockSeconds: z.int().positive() }),
  z.object({ kind: z.literal("per_second") }),
  z.object({ kind: z.literal("hourly") }),
  z.object({ kind: z.literal("free") }),
]);
export type BillingModel = z.infer<typeof BillingModelSchema>;

export const ProviderCapabilitiesSchema = z.object({
  snapshot: z.boolean(),
  /** fork(snapshotId) works (requires snapshot). */
  fork: z.boolean(),
  pause: z.boolean(),
  /** Hard cap on ExecOptions.timeoutMs. Naïve: 600 000. */
  maxExecTimeoutMs: z.int().positive(),
  /** Each of stdout/stderr is cut at this many characters. Naïve: 262 144. */
  maxOutputChars: z.int().positive(),
  billing: BillingModelSchema,
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

/**
 * One interface over every place an eval computer can run.
 *
 * Every method that names a computer throws ProviderNotFoundError for an unknown or
 * destroyed id, except `destroy`, which is idempotent.
 */
export interface ComputeProvider {
  /** "naive" | "vultr" | "docker-local" | "fake" | … */
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /** Start provisioning. Returns at once, usually with status `creating`. */
  create(spec: ComputerSpecInput): Promise<ComputerInfo>;
  /** Poll until `running` (or `paused`, which exec resumes). Throws ProviderTimeoutError, or ProviderProvisionError if it ends `failed`. */
  waitReady(id: string, opts?: WaitReadyOptions): Promise<ComputerInfo>;
  /** Current state. Never wakes a paused computer. */
  inspect(id: string): Promise<ComputerInfo>;
  /** Computers this provider holds, filtered by tag. */
  list(opts?: ListOptions): Promise<ComputerInfo[]>;

  /**
   * Run a shell command and wait for it to exit. A paused computer is resumed first.
   * A timeout resolves with `timedOut: true, exitCode: 124`. Rejects timeoutMs over the cap
   * with ProviderValidationError. Never put a secret on the command line (Naïve keeps
   * command history unredacted for 30 days): write it with putFile instead.
   */
  exec(id: string, command: string, opts?: ExecOptions): Promise<ExecResult>;
  /**
   * Start a command that outlives exec and its timeout (setsid nohup semantics), with
   * stdout+stderr appended to `logPath`. Returns once it is started.
   */
  execDetached(id: string, command: string, opts?: ExecDetachedOptions): Promise<DetachedProcess>;

  /** Write a file. `path` is absolute inside `home`, or relative to it; anything else is ProviderForbiddenError. */
  putFile(
    id: string,
    path: string,
    content: string | Uint8Array,
    opts?: PutFileOptions,
  ): Promise<void>;
  /** Read a file (same path rules). Missing file is ProviderNotFoundError. */
  getFile(id: string, path: string): Promise<Uint8Array>;

  /** Capture the filesystem. ProviderValidationError if !capabilities.snapshot. */
  snapshot(id: string): Promise<SnapshotInfo>;
  /** New computer restored from a snapshot (async, like create). */
  fork(snapshotId: string, spec?: Omit<ComputerSpecInput, "snapshotId">): Promise<ComputerInfo>;
  deleteSnapshot(snapshotId: string): Promise<void>;

  /** Stop compute billing; disk kept. ProviderValidationError if !capabilities.pause. */
  pause(id: string): Promise<ComputerInfo>;
  resume(id: string): Promise<ComputerInfo>;

  /** Destroy the machine and its disk. Idempotent: an unknown or destroyed id resolves. */
  destroy(id: string): Promise<void>;
}
