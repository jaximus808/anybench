// pino JSON logger (TDM-14). Two redaction layers:
// 1. pino `redact` paths blank auth headers and cookies wherever a request/response is logged.
// 2. Every serialized line goes through core's createRedactor (exact config secrets + known key
//    patterns) before it reaches the destination, so a secret inside a message, an error stack or
//    any field is replaced with `[REDACTED:NAME]`. The redactor keeps JSON lines valid.
// Use `deps.logger.child({ ... })` for scoped loggers; never console.log in server code.
import { createRedactor, type SecretsInScope } from "@anybench/core";
import { pino, type DestinationStream, type Logger, type LevelWithSilent } from "pino";

export type { Logger } from "pino";

export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["x-runner-token"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "*.headers.authorization",
  "*.headers.cookie",
  "authorization",
  "cookie",
];

export interface LoggerOptions {
  level?: LevelWithSilent;
  /** Exact secret values to scrub (e.g. configSecrets(config)). */
  secrets?: SecretsInScope;
  /** Where lines go; defaults to stdout. Tests pass a collecting stream. */
  destination?: DestinationStream;
  base?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const redactLine = createRedactor(options.secrets ?? {});
  const inner = options.destination ?? pino.destination({ dest: 1, sync: false });
  const stream: DestinationStream = { write: (line: string) => inner.write(redactLine(line)) };
  return pino(
    {
      level: options.level ?? "info",
      base: { service: "anybench-server", ...options.base },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" },
      formatters: { level: (label) => ({ level: label }) },
    },
    stream,
  );
}
