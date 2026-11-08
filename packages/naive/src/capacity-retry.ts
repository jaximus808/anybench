// TDM-39 [4.7]: retry Naïve's 429 "the service is at capacity" with backoff (TDM-16 saw it on
// computer create: 429 rate_limited after 15 s, then 202 on retry).
//
// `withCapacityRetry(computers)` wraps a `NaiveComputersApi` so `create`, `exec`, `writeFile` and
// `mkdir` retry ONLY on a 429: the request was refused, so nothing landed and a retry cannot
// double-create a computer, run a command twice or write twice. A 5xx is not retried here (the
// write may have landed); every other method passes through unchanged.
import type { NaiveComputersApi } from "./computers.js";
import { NaiveError } from "./errors.js";

export interface CapacityRetryOptions {
  /** Tries per call, the first included. Default 6. */
  attempts?: number;
  /** First backoff in ms; doubles each try, plus up to 25% jitter. Default 2000. */
  baseMs?: number;
  /** Backoff ceiling in ms. Default 30 000. */
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 0..1, for the jitter. Default Math.random. */
  random?: () => number;
  /** Called before each wait (for logs and events). */
  onRetry?: (r: { op: string; attempt: number; waitMs: number; error: NaiveError }) => void;
}

/** A refused request: 429 (`rate_limited`, "the service is at capacity"). */
export function isNaiveCapacityError(e: unknown): e is NaiveError {
  return e instanceof NaiveError && (e.status === 429 || e.code === "rate_limited");
}

/** Run `fn`, retrying a Naïve 429 with exponential backoff. Any other error is rethrown at once. */
export async function retryOnNaiveCapacity<T>(
  op: string,
  fn: () => Promise<T>,
  opts: CapacityRetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseMs ?? 2000;
  const max = opts.maxMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isNaiveCapacityError(e) || attempt >= attempts) throw e;
      const exp = Math.min(max, base * 2 ** (attempt - 1));
      const waitMs = Math.round(exp + exp * 0.25 * random());
      opts.onRetry?.({ op, attempt, waitMs, error: e });
      await sleep(waitMs);
    }
  }
}

/** `computers` with create / exec / writeFile / mkdir retried on a Naïve 429. */
export function withCapacityRetry(
  computers: NaiveComputersApi,
  opts: CapacityRetryOptions = {},
): NaiveComputersApi {
  // Delegate method by method: `computers` may be a class instance (FakeComputers), whose
  // methods a spread would drop.
  return {
    get: (id) => computers.get(id),
    list: (q) => computers.list(q),
    inspect: (id) => computers.inspect(id),
    pause: (id) => computers.pause(id),
    resume: (id) => computers.resume(id),
    delete: (id) => computers.delete(id),
    snapshot: (id) => computers.snapshot(id),
    deleteSnapshot: (s) => computers.deleteSnapshot(s),
    readFile: (id, path) => computers.readFile(id, path),
    remove: (id, path) => computers.remove(id, path),
    create: (body) => retryOnNaiveCapacity("create", () => computers.create(body), opts),
    exec: (id, command, o) =>
      retryOnNaiveCapacity("exec", () => computers.exec(id, command, o), opts),
    writeFile: (id, path, content) =>
      retryOnNaiveCapacity("writeFile", () => computers.writeFile(id, path, content), opts),
    mkdir: (id, path) => retryOnNaiveCapacity("mkdir", () => computers.mkdir(id, path), opts),
  };
}
