// Per-trial runner tokens (TDM-47, plan.md P1 "In-VM runner").
//
// The worker mints one token per trial attempt and puts it in ~/.anybench/trial.json
// (`ingest.token`); the runner sends it as `Authorization: Bearer <token>` to the ingest routes.
//
//   token = "abrt1." + base64url( HMAC-SHA256(RUNNER_TOKEN_SECRET, "anybench.runner.v1\0<trial>\0<attempt>") )
//
// The token carries no data of its own: the server recomputes it from the trial id in the URL and
// the attempt in the DB, so nothing in the token can be forged or replayed onto another trial.
// "Expires with the trial" (checkRunnerTokenLive below):
// - a token minted for an older attempt stops working once the worker bumps `trials.attempt`;
// - once the trial is terminal (done, failed_*, cancelled) the token works for a short grace
//   window after `ended_at`, so a final batch already in flight still lands, then never again.
// Comparison is constant-time (timingSafeEqual over equal-length digests).
import { createHmac, timingSafeEqual } from "node:crypto";
import { isTerminalTrialState, type TrialState } from "@anybench/core";

export const RUNNER_TOKEN_PREFIX = "abrt1.";
/** Minimum RUNNER_TOKEN_SECRET length (bytes of text); `openssl rand -base64 48` gives 64. */
export const RUNNER_TOKEN_SECRET_MIN_LENGTH = 32;
/** How long a token keeps working after its trial reached a terminal state. */
export const RUNNER_TOKEN_GRACE_MS = 5 * 60 * 1000;

const DOMAIN = "anybench.runner.v1";

function digest(secret: string, trialId: string, attempt: number): Buffer {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  return createHmac("sha256", secret)
    .update(`${DOMAIN}\0${trialId.toLowerCase()}\0${attempt}`)
    .digest();
}

/** The bearer token for one trial attempt. The worker puts it in trial.json `ingest.token`. */
export function mintRunnerToken(secret: string, trialId: string, attempt: number): string {
  if (secret.length < RUNNER_TOKEN_SECRET_MIN_LENGTH) {
    throw new RangeError(
      `RUNNER_TOKEN_SECRET must be at least ${RUNNER_TOKEN_SECRET_MIN_LENGTH} chars`,
    );
  }
  return RUNNER_TOKEN_PREFIX + digest(secret, trialId, attempt).toString("base64url");
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}

/**
 * True when `token` is the token for (trialId, attempt). Constant-time: the presented token is
 * decoded and compared as a 32-byte digest; a malformed token is compared against a dummy of the
 * same length so its timing matches a wrong one.
 */
export function verifyRunnerToken(
  secret: string,
  token: string,
  trialId: string,
  attempt: number,
): boolean {
  const expected = digest(secret, trialId, attempt);
  let presented: Buffer | null = null;
  if (token.startsWith(RUNNER_TOKEN_PREFIX)) {
    const raw = token.slice(RUNNER_TOKEN_PREFIX.length);
    if (/^[A-Za-z0-9_-]{43}$/.test(raw)) presented = Buffer.from(raw, "base64url");
  }
  const ok = timingSafeEqual(
    presented?.length === expected.length ? presented : Buffer.alloc(expected.length),
    expected,
  );
  return ok && presented !== null && presented.length === expected.length;
}

export type RunnerTokenLiveness =
  { ok: true } | { ok: false; reason: "attempt_superseded" | "trial_ended" };

/**
 * Whether a trial still accepts its runner's token for `attempt`. The HMAC check proves which
 * attempt the token was minted for; this decides whether that attempt is still live.
 */
export function checkRunnerTokenLive(
  trial: { attempt: number; state: TrialState; endedAt: Date | null },
  attempt: number,
  now: Date = new Date(),
  graceMs: number = RUNNER_TOKEN_GRACE_MS,
): RunnerTokenLiveness {
  if (attempt !== trial.attempt) return { ok: false, reason: "attempt_superseded" };
  if (isTerminalTrialState(trial.state)) {
    const endedAt = trial.endedAt?.getTime();
    if (endedAt === undefined || now.getTime() - endedAt > graceMs) {
      return { ok: false, reason: "trial_ended" };
    }
  }
  return { ok: true };
}
