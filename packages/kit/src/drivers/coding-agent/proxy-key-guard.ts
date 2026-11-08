// TDM-39 [4.7]: revoke a trial's Naïve proxy key the moment its token cap is hit, and at trial
// end on every path.
//
// The per-trial `proxy:write` key (TDM-16, `provisionClaudeCodeProxyEnv` in @anybench/naive) has
// no Naïve-side spend cap: whoever holds it can spend Naïve credit until it is revoked. The caps
// are ours: the runner meters the stream-json the driver tees to stdout (spend cap,
// `token_cap_micro_usd`, reported as `status.json` `token_cap.exceeded`), and the driver meters
// tokens (`token_cap_tokens`, written to EVAL_OUT/coding-agent/token-cap.json). Either one
// stops the agent, but only revoking the key stops the spend for certain, so the trial executor
// creates one guard per trial and calls:
//   - `observeRunnerStatus(status)` on every status.json it polls (heartbeat), and
//     `capHit(reason)` when it sees the driver's token-cap.json or any other cap signal;
//   - `trialEnded(reason)` in a `finally`, whatever happened (done, failed, cancelled, crashed).
// The guard revokes exactly once and retries a failed revoke with backoff; the reaper
// (`revokeStaleTrialProxyKeys`) is the backstop for a worker that dies before `finally` runs.
// It takes the revoke call as a function, so it has no Naïve dependency and tests run offline.
import { CODING_AGENT_OUTPUT_PATHS } from "./outputs.js";

export type ProxyKeyRevokeReason = "token_cap" | "trial_end";

export interface ProxyKeyGuardOptions {
  /** Revokes the key: `() => revokeTrialProxyCredential(keys, cred)`. Must be idempotent. */
  revoke: () => Promise<void>;
  /** Attempts per revoke before giving up (the reaper still catches it). Default 5. */
  attempts?: number;
  /** First backoff in ms, doubled each try. Default 500. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once when the key is revoked (or every attempt failed), for the trial's events. */
  onRevoked?: (r: {
    reason: ProxyKeyRevokeReason;
    detail: string;
    ok: boolean;
    error?: string;
  }) => void;
}

export interface ProxyKeyGuard {
  /** Feed every polled runner status.json; revokes when the runner's spend cap was crossed. */
  observeRunnerStatus(status: unknown): Promise<void>;
  /** A cap was hit (the driver's token-cap.json, a budget failure event, ...): revoke now. */
  capHit(detail: string): Promise<void>;
  /** The trial is over, on any path: revoke if not yet revoked. */
  trialEnded(detail?: string): Promise<void>;
  readonly revoked: boolean;
  readonly reason: ProxyKeyRevokeReason | null;
}

/** EVAL_OUT-relative path whose existence means the driver's token cap stopped the run. */
export const DRIVER_TOKEN_CAP_FILE = CODING_AGENT_OUTPUT_PATHS.tokenCap;

/** The runner's status.json says the spend cap was crossed (`token_cap.exceeded`). */
export function runnerTokenCapExceeded(status: unknown): boolean {
  if (status === null || typeof status !== "object") return false;
  const cap = (status as { token_cap?: unknown }).token_cap;
  return (
    cap !== null && typeof cap === "object" && (cap as { exceeded?: unknown }).exceeded === true
  );
}

export function createProxyKeyGuard(opts: ProxyKeyGuardOptions): ProxyKeyGuard {
  const attempts = opts.attempts ?? 5;
  const backoff = opts.backoffMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let pending: Promise<void> | null = null;
  let reason: ProxyKeyRevokeReason | null = null;
  let revoked = false;

  let inFlight = false;
  const revokeOnce = (why: ProxyKeyRevokeReason, detail: string): Promise<void> => {
    // Revoked, or a revoke is running: never twice. A revoke that gave up is tried again.
    if (pending && (revoked || inFlight)) return pending;
    inFlight = true;
    reason ??= why;
    pending = (async () => {
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          await opts.revoke();
          revoked = true;
          opts.onRevoked?.({ reason: why, detail, ok: true });
          return;
        } catch (e) {
          last = e;
          if (i < attempts - 1) await sleep(backoff * 2 ** i);
        }
      }
      opts.onRevoked?.({
        reason: why,
        detail,
        ok: false,
        error: last instanceof Error ? last.message : String(last),
      });
    })().finally(() => {
      inFlight = false;
    });
    return pending;
  };

  return {
    observeRunnerStatus: async (status) => {
      if (runnerTokenCapExceeded(status))
        await revokeOnce("token_cap", "runner: token cap exceeded");
    },
    capHit: (detail) => revokeOnce("token_cap", detail),
    trialEnded: (detail = "trial ended") => revokeOnce("trial_end", detail),
    get revoked() {
      return revoked;
    },
    get reason() {
      return reason;
    },
  };
}
