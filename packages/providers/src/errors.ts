// Typed errors every ComputeProvider throws. Callers branch on `code` (or the
// subclass), never on a provider's own error shape: the naive/docker/vultr
// adapters map their native errors into these.
//
// Note: a command that runs past its exec timeout is NOT an error. It resolves
// with `timedOut: true` and exit code 124 (Naïve semantics). ProviderTimeoutError
// is for the provider itself taking too long (e.g. waitReady never reaching
// `running`).

export const PROVIDER_ERROR_CODES = [
  "capacity", // no machine available right now (quota, concurrency cap, region full). Retry later.
  "not_found", // the computer, snapshot or file does not exist (or is already destroyed).
  "timeout", // the provider did not reach the wanted state in time.
  "billing", // the account cannot pay for it (Naïve 402 insufficient_credits).
  "unavailable", // the computer exists but cannot take the call (creating, failed; Naïve 409 computer_unavailable).
  "provision_failed", // provisioning ended in `failed`. Terminal for that computer.
  "forbidden", // a path outside the computer's home, or a scope the key lacks.
  "validation", // the request was refused before (or by) the provider: bad spec, timeout over cap.
  "provider", // anything else the provider reported.
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderErrorOptions {
  /** Provider name, e.g. "naive", "fake". */
  provider?: string;
  /** Computer, snapshot or path the error is about. */
  resource?: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string | undefined;
  readonly resource: string | undefined;
  /** True when the same call can succeed later without changing it. */
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode, message: string, opts: ProviderErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ProviderError";
    this.code = code;
    this.provider = opts.provider;
    this.resource = opts.resource;
    this.retryable = code === "capacity" || code === "timeout" || code === "unavailable";
  }
}

export class ProviderCapacityError extends ProviderError {
  constructor(message: string, opts?: ProviderErrorOptions) {
    super("capacity", message, opts);
    this.name = "ProviderCapacityError";
  }
}

export class ProviderNotFoundError extends ProviderError {
  constructor(message: string, opts?: ProviderErrorOptions) {
    super("not_found", message, opts);
    this.name = "ProviderNotFoundError";
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(message: string, opts?: ProviderErrorOptions) {
    super("timeout", message, opts);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderBillingError extends ProviderError {
  constructor(message: string, opts?: ProviderErrorOptions) {
    super("billing", message, opts);
    this.name = "ProviderBillingError";
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(message: string, opts?: ProviderErrorOptions) {
    super("unavailable", message, opts);
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderProvisionError extends ProviderError {
  constructor(message: string, opts?: ProviderErrorOptions) {
    super("provision_failed", message, opts);
    this.name = "ProviderProvisionError";
  }
}

export class ProviderForbiddenError extends ProviderError {
  constructor(message: string, opts?: ProviderErrorOptions) {
    super("forbidden", message, opts);
    this.name = "ProviderForbiddenError";
  }
}

export class ProviderValidationError extends ProviderError {
  constructor(message: string, opts?: ProviderErrorOptions) {
    super("validation", message, opts);
    this.name = "ProviderValidationError";
  }
}

export function isProviderError(err: unknown, code?: ProviderErrorCode): err is ProviderError {
  return err instanceof ProviderError && (code === undefined || err.code === code);
}
