// Worker entry (graphile-worker on DATABASE_URL_DIRECT): `pnpm --filter server dev:worker`. TDM-14.
// Runs on the Oracle VM in production; the logic lives in jobs/runner.ts so tests can start it.
import {
  bootRuntime,
  installProcessHandlers,
  loadConfigOrExit,
  loadDotEnv,
  onShutdown,
} from "./boot.js";
import { startWorker } from "./jobs/runner.js";

loadDotEnv();
const config = loadConfigOrExit("worker");
const runtime = await bootRuntime(config, "worker");
installProcessHandlers(runtime, { surviveNetworkErrors: true });

const worker = await startWorker({ config, ...runtime });
onShutdown(runtime.logger, () => worker.stop());
await worker.done;
