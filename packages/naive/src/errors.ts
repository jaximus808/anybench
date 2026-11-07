// Typed errors for everything that can go wrong talking to Naïve. The live client maps the SDK's
// one `ApiError` onto these; FakeNaive throws the same classes, so callers branch on `instanceof`
// and never on a string code they had to remember.

import { ApiError, ResponseParseError } from "@usenaive-sdk/managed-agents";
import type { MicroUsd } from "./money.js";

export interface NaiveErrorInit {
  code: string;
  status?: number | undefined;
  requestId?: string | undefined;
  param?: string | undefined;
  sessionId?: string | undefined;
  cause?: unknown;
}

/** Base class. `code` is Naïve's machine code (or one of ours for session outcomes). */
export class NaiveError extends Error {
  override readonly name: string = "NaiveError";
  readonly code: string;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly param: string | undefined;
  readonly sessionId: string | undefined;

  constructor(message: string, init: NaiveErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.param = init.param;
    this.sessionId = init.sessionId;
  }

  /** A transient failure worth retrying (rate limit, 5xx, dropped connection). Never true for a write that landed. */
  get retryable(): boolean {
    if (this.code === "response_unreadable") return false;
    if (this.status === undefined) return this.code === "network_error";
    return this.status === 429 || this.status >= 500;
  }
}

/** 402 `subscription_required`: the organization has no active plan. Every non-billing route answers this. */
export class NaiveSubscriptionRequiredError extends NaiveError {
  override readonly name = "NaiveSubscriptionRequiredError";
}

/** 402 `insufficient_credits`: the balance cannot cover the call. */
export class NaiveInsufficientCreditsError extends NaiveError {
  override readonly name = "NaiveInsufficientCreditsError";
}

/** 401 / 403: the key is missing, revoked or lacks a scope. */
export class NaiveAuthError extends NaiveError {
  override readonly name = "NaiveAuthError";
}

/** 404 `not_found`. */
export class NaiveNotFoundError extends NaiveError {
  override readonly name = "NaiveNotFoundError";
}

/** 409 (`version_conflict`, `session_terminal`, `session_running`, `state_conflict`, …). */
export class NaiveConflictError extends NaiveError {
  override readonly name = "NaiveConflictError";
}

/**
 * The session hit its `budget_micro_usd` cap (`budget.exceeded` event or `stop_reason: budget_paused`).
 * The session is paused, not failed: `sessions.setBudget` could raise it, but our runner treats it as a stop.
 */
export class NaiveBudgetExceededError extends NaiveError {
  override readonly name = "NaiveBudgetExceededError";
  /** Null when Naïve refused a call with a 402 `budget_exceeded` rather than ending a session we watched. */
  readonly budgetMicroUsd: MicroUsd | null;
  readonly consumedMicroUsd: MicroUsd | null;
  readonly lastSeq: number | null;

  constructor(
    message: string,
    init: NaiveErrorInit & {
      budgetMicroUsd: MicroUsd | null;
      consumedMicroUsd: MicroUsd | null;
      lastSeq: number | null;
    },
  ) {
    super(message, init);
    this.budgetMicroUsd = init.budgetMicroUsd;
    this.consumedMicroUsd = init.consumedMicroUsd;
    this.lastSeq = init.lastSeq;
  }
}

/** The session ended `failed`, or yielded with a stop reason that is not a clean end of turn. */
export class NaiveSessionFailedError extends NaiveError {
  override readonly name = "NaiveSessionFailedError";
  readonly sessionStatus: string;
  readonly stopReason: string | null;
  readonly stopCode: string | null;
  readonly lastSeq: number;

  constructor(
    message: string,
    init: NaiveErrorInit & {
      sessionStatus: string;
      stopReason: string | null;
      stopCode: string | null;
      lastSeq: number;
    },
  ) {
    super(message, init);
    this.sessionStatus = init.sessionStatus;
    this.stopReason = init.stopReason;
    this.stopCode = init.stopCode;
    this.lastSeq = init.lastSeq;
  }
}

/**
 * The correctness gate on agent output: the session ended cleanly but produced no structured output,
 * or one that does not parse with the caller's schema. Nothing downstream may use the result.
 */
export class NaiveOutputInvalidError extends NaiveError {
  override readonly name = "NaiveOutputInvalidError";
  readonly issues: readonly unknown[];
  readonly received: unknown;

  constructor(
    message: string,
    init: NaiveErrorInit & { issues: readonly unknown[]; received: unknown },
  ) {
    super(message, init);
    this.issues = init.issues;
    this.received = init.received;
  }
}

/** The run was cancelled (AbortSignal, kill switch) and the session was cancelled on Naïve. */
export class NaiveCancelledError extends NaiveError {
  override readonly name = "NaiveCancelledError";
  readonly lastSeq: number;

  constructor(message: string, init: NaiveErrorInit & { lastSeq: number }) {
    super(message, init);
    this.lastSeq = init.lastSeq;
  }
}

/** Builds the right subclass for a Naïve error code + HTTP status. Shared by the live client and FakeNaive. */
export function naiveErrorFor(message: string, init: NaiveErrorInit): NaiveError {
  const { code, status } = init;
  if (code === "subscription_required") return new NaiveSubscriptionRequiredError(message, init);
  if (code === "insufficient_credits") return new NaiveInsufficientCreditsError(message, init);
  if (code === "budget_exceeded") {
    return new NaiveBudgetExceededError(message, {
      ...init,
      budgetMicroUsd: null,
      consumedMicroUsd: null,
      lastSeq: null,
    });
  }
  if (status === 401 || status === 403 || code === "unauthorized" || code === "forbidden") {
    return new NaiveAuthError(message, init);
  }
  if (status === 404 || code === "not_found") return new NaiveNotFoundError(message, init);
  if (status === 409) return new NaiveConflictError(message, init);
  return new NaiveError(message, init);
}

/**
 * Maps anything the SDK (or `fetch`) threw onto a `NaiveError`. A `ResponseParseError` means the call
 * LANDED but the body was unreadable: it maps to `response_unreadable`, which is never retryable.
 */
export function mapNaiveError(error: unknown, sessionId?: string): NaiveError {
  if (error instanceof NaiveError) return error;
  if (error instanceof ResponseParseError) {
    return new NaiveError(
      `Naïve response could not be read (${error.method} ${error.path}): ${error.message}`,
      {
        code: "response_unreadable",
        status: error.status,
        requestId: error.requestId,
        sessionId,
        cause: error,
      },
    );
  }
  if (error instanceof ApiError) {
    return naiveErrorFor(error.message, {
      code: error.code,
      status: error.status,
      requestId: error.requestId || undefined,
      param: error.param,
      sessionId,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new NaiveError(`Naïve request failed: ${message}`, {
    code: "network_error",
    sessionId,
    cause: error,
  });
}
