// New run (launch-ux): the client side never hangs. Each request the screen waits on has a
// deadline; runs.create retries fast gateway failures inside its deadline with the SAME
// Idempotency-Key (the server returns the run it already made, never a second one), and a
// timeout ends in a message the user can act on instead of a button stuck on "Working…".
import { ApiClientError, type ApiClient } from "@anybench/core";
import type { CreateRunBody } from "./new-run";

/** How long Start waits for runs.create, retries included, before asking the user to retry. */
export const CREATE_TIMEOUT_MS = 25_000;
/** Pause before an automatic retry of a fast gateway failure. */
export const CREATE_RETRY_DELAY_MS = 1_000;

/** The request ran past its client deadline and was aborted. */
export class ClientTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`no answer in ${Math.round(timeoutMs / 1000)} s`);
    this.name = "ClientTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run `fn` with an AbortSignal that fires after `ms`. A run past the deadline rejects with
 * ClientTimeoutError (whatever the aborted fetch threw); `outer` aborts it early.
 */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onOuter = () => ctrl.abort(outer?.reason);
  if (outer?.aborted) ctrl.abort(outer.reason);
  outer?.addEventListener("abort", onOuter, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
      reject(new ClientTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(ctrl.signal), deadline]);
  } catch (e) {
    if (timedOut) throw new ClientTimeoutError(ms);
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}

/** A failure worth one more try with the same key: the gateway or the network, not the request. */
export function isRetryableCreateError(e: unknown): boolean {
  if (e instanceof ApiClientError) return [408, 502, 503, 504].includes(e.status);
  // fetch rejects with a TypeError when the network drops.
  return e instanceof TypeError;
}

export interface CreateRunOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Called before each attempt (1-based), so the screen can say "retrying". */
  onAttempt?: (attempt: number) => void;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * runs.create inside one overall deadline. Fast 408/502/503/504 or network failures retry with the
 * same Idempotency-Key while time remains; anything else is thrown as is. Past the deadline it
 * throws ClientTimeoutError.
 */
export async function createRunWithDeadline(
  client: ApiClient,
  body: CreateRunBody,
  idempotencyKey: string,
  opts: CreateRunOptions = {},
) {
  const timeoutMs = opts.timeoutMs ?? CREATE_TIMEOUT_MS;
  const retryDelayMs = opts.retryDelayMs ?? CREATE_RETRY_DELAY_MS;
  const now = opts.now ?? (() => Date.now());
  const end = now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    const left = end - now();
    if (left <= 0) throw new ClientTimeoutError(timeoutMs);
    opts.onAttempt?.(attempt);
    try {
      return await withTimeout(
        left,
        (signal) =>
          client.runs.create({ headers: { "idempotency-key": idempotencyKey }, body }, { signal }),
        opts.signal,
      );
    } catch (e) {
      if (e instanceof ClientTimeoutError) throw new ClientTimeoutError(timeoutMs);
      if (!isRetryableCreateError(e) || end - now() <= retryDelayMs) throw e;
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
}

/** "7 s", "1 min 04 s". */
export function formatWait(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}
