// API entry for Node (local dev and any long-lived host): `pnpm --filter server dev`. TDM-14.
// Production API runs as a Naïve fullstack app through entry-naive.ts (entry-vercel.ts is the
// own-Vercel-project fallback); all wrap the same createApp.
import { ArtifactStore } from "@anybench/envs";
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
import { artifactLogReader } from "./lib/trial-logs.js";

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
// Runner uploads (TDM-47): presigned URLs from the S3_* bucket; without S3_BUCKET they answer 503.
const artifacts = process.env.S3_BUCKET ? ArtifactStore.fromEnv() : undefined;
const app = createApp({
  config,
  logger,
  db: dbh.db,
  sentry,
  artifacts,
  ...(artifacts ? { trialLogs: artifactLogReader(artifacts) } : {}), // TDM-74 log reads
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
