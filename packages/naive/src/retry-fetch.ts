// Follow-up 67: Naïve answers 429 "the service is at capacity" (and now and then 502/503/504) in
// storms lasting minutes, on session reads, exec and fs calls alike. The SDK has no retry policy
// (docs/reference/naive-sdk-errors.md: "the caller owns that decision"), so every live client we
// build wraps its `fetch` in `naiveRetryFetch`:
//
// - a 429 is retried on every method: the request was refused, so nothing landed. The SDK puts the
//   same Idempotency-Key header on the retried write, so it is a replay at worst.
// - a read (GET/HEAD, and the POST fs/read and fs/list, which change nothing) is also retried on
//   502/503/504 and on a dropped connection (fetch rejecting with ETIMEDOUT, ECONNRESET, …).
// - anything else (a write's 5xx or network error, where the write may have landed) is returned or
//   thrown unchanged, as before.
// Backoff is exponential with jitter, honours Retry-After, and is bounded (default 8 tries, about
// 1.5 min in all), so a storm longer than that still surfaces as the typed error it always was.

export interface NaiveRetryFetchOptions {
  /** Tries per request, the first included. Default 8. */
  attempts?: number;
  /** First backoff in ms; doubles each try, plus up to 50% jitter. Default 1000. */
  baseMs?: number;
  /** Backoff ceiling in ms (Retry-After is capped to it too). Default 30 000. */
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 0..1, for the jitter. Default Math.random. */
  random?: () => number;
  /** Called before each wait. Default: one line on stderr (method, path, status; never headers). */
  onRetry?: (r: NaiveRetryInfo) => void;
}

export interface NaiveRetryInfo {
  method: string;
  path: string;
  attempt: number;
  waitMs: number;
  /** The HTTP status, or null for a dropped connection. */
  status: number | null;
  error?: string;
}

const READ_METHODS = new Set(["GET", "HEAD"]);
/** POST routes that only read (Naïve's fs API is all POST). */
const READ_POST_PATH = /\/v1\/computers\/[^/]+\/fs\/(read|list|stat)$/;
const READ_RETRY_STATUS = new Set([429, 502, 503, 504]);

function requestParts(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
): { method: string; path: string; signal: AbortSignal | null | undefined } {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const method = (init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
  const href = isRequest ? input.url : input instanceof URL ? input.href : String(input);
  let path = href;
  try {
    path = new URL(href).pathname;
  } catch {
    // keep the raw string
  }
  return { method, path, signal: init?.signal ?? (isRequest ? input.signal : undefined) };
}

/** True for a request that changes nothing on the server, so any transient failure may be retried. */
export function isNaiveReadRequest(method: string, path: string): boolean {
  return READ_METHODS.has(method) || (method === "POST" && READ_POST_PATH.test(path));
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

const defaultOnRetry = (r: NaiveRetryInfo) => {
  process.stderr.write(
    `naive: ${r.method} ${r.path} -> ${r.status ?? r.error ?? "network error"}; ` +
      `retry ${r.attempt} in ${r.waitMs} ms\n`,
  );
};

/** `fetch` with bounded retry of Naïve's transient refusals (see the header comment). */
export function naiveRetryFetch(
  inner: typeof globalThis.fetch,
  opts: NaiveRetryFetchOptions = {},
): typeof globalThis.fetch {
  const attempts = Math.max(1, opts.attempts ?? 8);
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const onRetry = opts.onRetry ?? defaultOnRetry;
  const backoff = (attempt: number) => {
    const exp = Math.min(max, base * 2 ** (attempt - 1));
    return Math.round(exp + exp * 0.5 * random());
  };

  return async (input, init) => {
    const { method, path, signal } = requestParts(input, init);
    const read = isNaiveReadRequest(method, path);
    // A Request carrying its own body cannot be sent twice; the SDK never passes one.
    const replayable = !(typeof Request !== "undefined" && input instanceof Request && input.body);
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= attempts || !replayable;
      let res: Response;
      try {
        res = await inner(input, init);
      } catch (err) {
        if (last || !read || signal?.aborted) throw err;
        const waitMs = backoff(attempt);
        const code = (err as { cause?: { code?: unknown } })?.cause?.code;
        onRetry({
          method,
          path,
          attempt,
          waitMs,
          status: null,
          error: typeof code === "string" ? code : err instanceof Error ? err.message : String(err),
        });
        await sleep(waitMs);
        continue;
      }
      const retry = res.status === 429 || (read && READ_RETRY_STATUS.has(res.status));
      if (!retry || last || signal?.aborted) return res;
      const waitMs = Math.min(max, Math.max(backoff(attempt), retryAfterMs(res) ?? 0));
      onRetry({ method, path, attempt, waitMs, status: res.status });
      await res.body?.cancel().catch(() => undefined);
      await sleep(waitMs);
    }
  };
}
