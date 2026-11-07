// Sentry (TDM-14): a no-op without SENTRY_DSN. With a DSN, @sentry/node is imported lazily (keeps
// cold starts small on Vercel) and every event is scrubbed by core's redactJson in beforeSend.
// Call `deps.sentry.captureException(err, context)`; never import @sentry/node elsewhere.
import { createRedactor, redactJson, type SecretsInScope } from "@anybench/core";

export interface SentryHandle {
  readonly enabled: boolean;
  captureException(err: unknown, context?: Record<string, unknown>): void;
  flush(timeoutMs?: number): Promise<boolean>;
}

export const noopSentry: SentryHandle = {
  enabled: false,
  captureException() {},
  flush: async () => true,
};

export interface SentryOptions {
  dsn?: string;
  environment: string;
  release?: string;
  secrets?: SecretsInScope;
}

export async function initSentry(options: SentryOptions): Promise<SentryHandle> {
  if (!options.dsn) return noopSentry;
  const Sentry = await import("@sentry/node");
  const redactor = createRedactor(options.secrets ?? {});
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    tracesSampleRate: 0.1,
    beforeSend: (event) => {
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      delete event.request?.cookies;
      return redactJson(event, redactor);
    },
    beforeBreadcrumb: (crumb) => redactJson(crumb, redactor),
  });
  return {
    enabled: true,
    captureException: (err, context) => {
      Sentry.captureException(err, context ? { extra: context } : undefined);
    },
    flush: (timeoutMs = 2000) => Sentry.flush(timeoutMs),
  };
}
