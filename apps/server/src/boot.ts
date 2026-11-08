// Boot helpers shared by the entries (main.ts, worker.ts, entry-vercel.ts). TDM-14.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError, configSecrets, loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { initSentry, type SentryHandle } from "./lib/sentry.js";

/**
 * Load `<cwd>/.env` (apps/server/.env under `pnpm --filter server ...`) if it exists. Variables
 * already in the environment win, so `DATABASE_URL=... pnpm --filter server dev` overrides it.
 */
export function loadDotEnv(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/** loadConfig, but on a bad env print every problem to stderr and exit 1 (entries only). */
export function loadConfigOrExit(
  role: string,
  source: Record<string, string | undefined> = process.env,
): Config {
  try {
    return loadConfig(source);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`anybench ${role}: refusing to boot.\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

export interface Runtime {
  logger: Logger;
  sentry: SentryHandle;
}

export async function bootRuntime(config: Config, role: "api" | "worker"): Promise<Runtime> {
  const secrets = configSecrets(config);
  const logger = createLogger({
    level: config.LOG_LEVEL,
    secrets,
    base: { role, env: config.ANYBENCH_ENV },
  });
  const sentry = await initSentry({
    dsn: config.SENTRY_DSN,
    environment: config.ANYBENCH_ENV,
    secrets,
  });
  logger.info({ sentry: sentry.enabled, billingMode: config.BILLING_MODE }, `${role} booting`);
  return { logger, sentry };
}

/** Socket-level errors a dropped database or API connection raises (follow-up 68). */
const TRANSIENT_NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "57P01", // admin_shutdown: Neon restarted the endpoint under us
  "57P03", // cannot_connect_now
]);

/** A network error the process can outlive: the connection is gone, no in-memory state is. */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return /^Connection terminated( unexpectedly| due to connection timeout)?$/.test(err.message);
}

export interface ProcessHandlerOptions {
  /**
   * Worker only: a transient network error that still escapes as an uncaught exception (a socket
   * with no 'error' listener) is logged and survived instead of exiting. Jobs whose queries it
   * broke fail and are retried by graphile-worker.
   */
  surviveNetworkErrors?: boolean;
}

/** Log + report crashes that escape every handler. */
export function installProcessHandlers(
  { logger, sentry }: Runtime,
  options: ProcessHandlerOptions = {},
): void {
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled rejection");
    sentry.captureException(reason);
  });
  process.on("uncaughtException", (err) => {
    if (options.surviveNetworkErrors && isTransientNetworkError(err)) {
      logger.error({ err }, "uncaught transient network error; survived");
      sentry.captureException(err);
      return;
    }
    logger.fatal({ err }, "uncaught exception");
    sentry.captureException(err);
    void sentry.flush(2000).finally(() => process.exit(1));
  });
}

/** Run `stop` once on SIGINT/SIGTERM, then exit. */
export function onShutdown(logger: Logger, stop: () => Promise<void>): void {
  let stopping = false;
  const handler = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    stop()
      .catch((err: unknown) => logger.error({ err }, "shutdown failed"))
      .finally(() => {
        logger.flush();
        process.exit(0);
      });
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}
