// API entry for Node (local dev and any long-lived host): `pnpm --filter server dev`. TDM-14.
// Production API runs on Vercel Functions through entry-vercel.ts; both wrap the same createApp.
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import {
  bootRuntime,
  installProcessHandlers,
  loadConfigOrExit,
  loadDotEnv,
  onShutdown,
} from "./boot.js";
import { createDb } from "./db/client.js";
import { EventFanout } from "./lib/events.js";

loadDotEnv();
const config = loadConfigOrExit("api");
const runtime = await bootRuntime(config, "api");
installProcessHandlers(runtime);
const { logger, sentry } = runtime;

const dbh = createDb(config.databaseUrl);
// Long-lived process: SSE streams can share one LISTEN connection (DATABASE_URL_DIRECT).
const eventFanout =
  config.EVENTS_STREAM_MODE === "listen"
    ? new EventFanout({ url: config.databaseUrlDirect, logger }).start()
    : undefined;
const app = createApp({
  config,
  logger,
  db: dbh.db,
  sentry,
  ...(eventFanout ? { eventFanout } : {}),
});
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, `api listening on http://localhost:${info.port}`);
});

onShutdown(logger, async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await eventFanout?.close();
  await dbh.close();
  await sentry.flush();
});
