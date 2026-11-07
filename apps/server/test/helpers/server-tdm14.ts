// TDM-14 test helpers: a silent app/worker wired to a database URL.
import { createApp } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createDb, type DbHandle } from "../../src/db/client.js";
import { createLogger } from "../../src/lib/logger.js";
import type { SentryHandle } from "../../src/lib/sentry.js";

export function configTdm14(url: string, extra: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: url, DATABASE_URL_DIRECT: url, LOG_LEVEL: "silent", ...extra });
}

export function silentLoggerTdm14() {
  return createLogger({ level: "silent", destination: { write() {} } });
}

export function recordingSentryTdm14(): SentryHandle & { captured: unknown[] } {
  const captured: unknown[] = [];
  return {
    enabled: true,
    captured,
    captureException: (e) => captured.push(e),
    flush: async () => true,
  };
}

export function appTdm14(url: string, sentry = recordingSentryTdm14()) {
  const config = configTdm14(url);
  const dbh: DbHandle = createDb(url, { max: 2 });
  const app = createApp({ config, logger: silentLoggerTdm14(), db: dbh.db, sentry });
  return { app, dbh, sentry, config };
}
