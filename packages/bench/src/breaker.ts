// Provider-outage circuit breaker (worker-hardening). When the compute provider fails on its side
// (HTTP 5xx / 429 on computer create, fork or proxy-key mint), every trial and gate burned its
// attempts within minutes and became failed_infra for good. The breaker stops that:
//
//   closed ──(N consecutive outage errors within windowMs)──▶ open
//   open   ──(health probe passes: list computers, then a tiny create + delete)──▶ closed
//   open   ──(probe fails)──▶ open, next probe at now + probeIntervalMs
//
// While open, nothing new launches: trial.execute and trial.gate park their work (the trial keeps
// its state and attempt, nothing is billed) and look again at the next probe time. A success while
// closed resets the count. The state is shared (one row per provider in Postgres on the server),
// so every job and every worker process sees the same breaker.
//
// This file is the pure part: the transition function and the port the executor calls. The store
// (apps/server lib/provider-breaker.ts) applies `breakerOnFailure` / `breakerOnProbe` under a row
// lock.

export type BreakerStatus = "closed" | "open";

/** What failed: computer create, fork of a snapshot, proxy-key mint, or a gate's scoring computer. */
export type BreakerOp = "create" | "fork" | "mint" | "gate";

export interface BreakerConfig {
  /** Consecutive outage errors that open the breaker. */
  threshold: number;
  /** The failures must fall within this window (ms) of the first one. */
  windowMs: number;
  /** While open, probe this often (ms). */
  probeIntervalMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  threshold: 3,
  windowMs: 120_000,
  probeIntervalMs: 30_000,
};

export interface BreakerState {
  status: BreakerStatus;
  /** Consecutive outage errors counted in the current window. */
  failures: number;
  /** Epoch ms of the first failure in the current window. */
  windowStartedAt: number | null;
  openedAt: number | null;
  /** While open: the earliest time the next probe may run (epoch ms). */
  nextProbeAt: number | null;
  lastError: string | null;
}

export const CLOSED_BREAKER: BreakerState = {
  status: "closed",
  failures: 0,
  windowStartedAt: null,
  openedAt: null,
  nextProbeAt: null,
  lastError: null,
};

/** One outage error. `opened` is true only on the failure that tripped the breaker. */
export function breakerOnFailure(
  s: BreakerState,
  now: number,
  error: string,
  cfg: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): { state: BreakerState; opened: boolean } {
  if (s.status === "open") return { state: { ...s, lastError: error }, opened: false };
  const inWindow = s.windowStartedAt !== null && now - s.windowStartedAt <= cfg.windowMs;
  const failures = inWindow ? s.failures + 1 : 1;
  const windowStartedAt = inWindow ? s.windowStartedAt : now;
  if (failures >= cfg.threshold) {
    return {
      state: {
        status: "open",
        failures,
        windowStartedAt,
        openedAt: now,
        nextProbeAt: now + cfg.probeIntervalMs,
        lastError: error,
      },
      opened: true,
    };
  }
  return { state: { ...s, failures, windowStartedAt, lastError: error }, opened: false };
}

/** A provider call that worked: a closed breaker forgets its count; an open one waits for a probe. */
export function breakerOnSuccess(s: BreakerState): BreakerState {
  if (s.status === "open" || s.failures === 0) return s;
  return { ...CLOSED_BREAKER };
}

/** A health probe's result while open. `closed` is true when it passed. */
export function breakerOnProbe(
  s: BreakerState,
  now: number,
  passed: boolean,
  error: string | null,
  cfg: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): { state: BreakerState; closed: boolean } {
  if (s.status !== "open") return { state: s, closed: false };
  if (passed) return { state: { ...CLOSED_BREAKER }, closed: true };
  return {
    state: { ...s, nextProbeAt: now + cfg.probeIntervalMs, lastError: error ?? s.lastError },
    closed: false,
  };
}

/** The breaker as the executor and the gate job see it. */
export interface LaunchBreaker {
  /**
   * Null when launches may go ahead; otherwise when to look again (epoch ms, the next probe).
   * Called before every create, fork and mint.
   */
  blockedUntil(): Promise<number | null>;
  /** An outage error (isProviderOutageError) from `op`. Returns the state after it. */
  recordFailure(op: BreakerOp, err: unknown): Promise<BreakerState>;
  /** A create / fork / mint that worked. */
  recordSuccess(op: BreakerOp): Promise<void>;
}

/** The message the live page shows while the breaker is open. */
export function outageMessage(provider: string): string {
  return `${providerLabel(provider)} is having an outage; trials paused, nothing billed`;
}

export function recoveredMessage(provider: string): string {
  return `${providerLabel(provider)} is back; trials resumed`;
}

function providerLabel(provider: string): string {
  return provider === "naive" ? "Naïve" : provider;
}

/**
 * In-memory LaunchBreaker (tests, the in-process launcher). `probe` closes it when it passes.
 */
export function memoryLaunchBreaker(
  cfg: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  now: () => number = Date.now,
): LaunchBreaker & {
  state(): BreakerState;
  probe(passed: boolean, error?: string): boolean;
} {
  let s: BreakerState = { ...CLOSED_BREAKER };
  return {
    state: () => s,
    async blockedUntil() {
      return s.status === "open" ? (s.nextProbeAt ?? now()) : null;
    },
    async recordFailure(_op, err) {
      s = breakerOnFailure(s, now(), err instanceof Error ? err.message : String(err), cfg).state;
      return s;
    },
    async recordSuccess() {
      s = breakerOnSuccess(s);
    },
    probe(passed, error) {
      const r = breakerOnProbe(s, now(), passed, error ?? null, cfg);
      s = r.state;
      return r.closed;
    },
  };
}
