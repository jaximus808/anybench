// Shared helpers every provider adapter uses, so tags, home-path confinement,
// detached launches and readiness polling behave the same on naive/docker/vultr/fake.
import { posix } from "node:path";
import {
  ProviderForbiddenError,
  ProviderNotFoundError,
  ProviderProvisionError,
  ProviderTimeoutError,
  ProviderValidationError,
} from "./errors.js";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  TagSchema,
  WaitReadyOptionsSchema,
  type ComputerInfo,
  type ExecOptions,
  type ProviderCapabilities,
  type WaitReadyOptions,
} from "./types.js";

// ---------- tags ----------

export const ANYBENCH_TAG_PREFIX = "ab-";
const ID_PART = /^[A-Za-z0-9_]+$/;

/**
 * An id as it appears inside a tag: hyphens stripped, so a lowercase UUIDv7
 * (`0190…-…`) becomes its 32 hex digits and `-` stays the tag's only separator.
 */
function tagPart(kind: string, value: string): string {
  const part = value.replaceAll("-", "");
  if (!ID_PART.test(part)) {
    throw new ProviderValidationError(
      `${kind} id ${JSON.stringify(value)} must be [A-Za-z0-9_-]+ to fit a tag`,
    );
  }
  return part;
}

/**
 * `ab-<run>-<trial>`: the tag every trial computer carries. Hyphens are stripped from
 * both ids, so UUID ids give `ab-<run 32 hex>-<trial 32 hex>`; `hyphenateUuid` undoes it.
 */
export function trialTag(runId: string, trialId: string): string {
  return TagSchema.parse(
    `${ANYBENCH_TAG_PREFIX}${tagPart("run", runId)}-${tagPart("trial", trialId)}`,
  );
}

/** `ab-<run>-`: pass as `list({ tagPrefix })` to find every computer of a run. */
export function runTagPrefix(runId: string): string {
  return `${ANYBENCH_TAG_PREFIX}${tagPart("run", runId)}-`;
}

/** Split a trial tag into its (hyphenless) run and trial parts; null if it is not one. */
export function parseTrialTag(tag: string): { runId: string; trialId: string } | null {
  const m = /^ab-([A-Za-z0-9_]+)-([A-Za-z0-9_]+)$/.exec(tag);
  return m ? { runId: m[1]!, trialId: m[2]! } : null;
}

/**
 * Re-hyphenate a 32-hex UUID taken from a tag (`parseTrialTag`) into the canonical
 * lowercase 8-4-4-4-12 form the database uses. An already hyphenated UUID is normalized.
 */
export function hyphenateUuid(hex: string): string {
  const h = hex.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) {
    throw new ProviderValidationError(`${JSON.stringify(hex)} is not a 32-hex UUID`);
  }
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function matchesTags(
  tags: readonly string[],
  opts: { tag?: string; tagPrefix?: string },
): boolean {
  if (opts.tag !== undefined && !tags.includes(opts.tag)) return false;
  if (opts.tagPrefix !== undefined && !tags.some((t) => t.startsWith(opts.tagPrefix!)))
    return false;
  return true;
}

// ---------- home-confined paths ----------

/**
 * Resolve `path` against `home` and refuse anything outside it, the way Naïve's fs/* does
 * (403 forbidden). Relative paths are relative to home; `..` is normalized first.
 */
export function resolveHomePath(home: string, path: string, provider?: string): string {
  if (path.length === 0) throw new ProviderValidationError("path is empty", { provider });
  if (path.includes("\0")) throw new ProviderValidationError("path contains NUL", { provider });
  const root = posix.normalize(home).replace(/\/+$/, "") || "/";
  const abs = posix.normalize(posix.isAbsolute(path) ? path : posix.join(root, path));
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    throw new ProviderForbiddenError(`path ${path} is outside the computer home ${root}`, {
      provider,
      resource: path,
    });
  }
  if (abs === root) {
    throw new ProviderValidationError(`path ${path} is the home directory itself, not a file`, {
      provider,
      resource: path,
    });
  }
  return abs;
}

// ---------- exec ----------

/** Validate exec options against the provider's cap; returns the effective timeout. */
export function effectiveExecTimeout(
  opts: ExecOptions | undefined,
  caps: ProviderCapabilities,
  provider?: string,
): number {
  const timeoutMs = opts?.timeoutMs ?? Math.min(DEFAULT_EXEC_TIMEOUT_MS, caps.maxExecTimeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ProviderValidationError(`timeoutMs must be a positive integer, got ${timeoutMs}`, {
      provider,
    });
  }
  if (timeoutMs > caps.maxExecTimeoutMs) {
    throw new ProviderValidationError(
      `timeoutMs ${timeoutMs} is over this provider's cap of ${caps.maxExecTimeoutMs}; use execDetached for long work`,
      { provider },
    );
  }
  return timeoutMs;
}

/** Cut a stream at the provider's output cap. */
export function capOutput(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };
}

/** POSIX single-quote a string for sh. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function defaultDetachedLogPath(home: string, n: number | string): string {
  return posix.join(home, ".anybench", "logs", `detached-${n}.log`);
}

/**
 * The one shell line real providers send through exec to start detached work:
 * survives the exec returning, its timeout and the session ending (setsid + nohup,
 * stdin closed), appends output to `logPath`, and prints the new pid.
 */
export function buildDetachedCommand(command: string, logPath: string): string {
  const log = shellQuote(logPath);
  return (
    `mkdir -p "$(dirname ${log})" && ` +
    `setsid nohup sh -c ${shellQuote(command)} >> ${log} 2>&1 < /dev/null & echo $!`
  );
}

/** Parse the pid `buildDetachedCommand` prints. */
export function parseDetachedPid(stdout: string, provider?: string): number {
  const pid = Number.parseInt(stdout.trim().split("\n").pop() ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new ProviderValidationError(
      `could not read the detached pid from ${JSON.stringify(stdout)}`,
      { provider },
    );
  }
  return pid;
}

// ---------- readiness ----------

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Generic waitReady: poll `inspect` until `running`. Naïve has no computer lifecycle
 * event, so polling is the contract. `failed` → ProviderProvisionError, `destroyed` →
 * ProviderNotFoundError, out of time → ProviderTimeoutError.
 */
export async function pollUntilReady(
  inspect: () => Promise<ComputerInfo>,
  opts: WaitReadyOptions | undefined,
  ctx: { provider: string; id: string; now?: () => number },
): Promise<ComputerInfo> {
  const { timeoutMs, intervalMs, signal } = WaitReadyOptionsSchema.parse(opts ?? {});
  const now = ctx.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const info = await inspect();
    if (info.status === "running") return info;
    if (info.status === "paused") return info;
    if (info.status === "failed") {
      throw new ProviderProvisionError(`computer ${ctx.id} failed to provision`, {
        provider: ctx.provider,
        resource: ctx.id,
      });
    }
    if (info.status === "destroyed") {
      throw new ProviderNotFoundError(`computer ${ctx.id} was destroyed`, {
        provider: ctx.provider,
        resource: ctx.id,
      });
    }
    const left = deadline - now();
    if (left <= 0) {
      throw new ProviderTimeoutError(
        `computer ${ctx.id} not running after ${timeoutMs} ms (status ${info.status})`,
        {
          provider: ctx.provider,
          resource: ctx.id,
        },
      );
    }
    await sleep(Math.min(intervalMs, left), signal);
  }
}

/** Decode getFile bytes as UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
