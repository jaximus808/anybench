// Worker liveness thresholds (TDM-14), shared by the heartbeat job and GET /health/worker.
/** The worker enqueues worker.heartbeat this often. */
export const WORKER_TICK_INTERVAL_MS = 15_000;
/** Four missed ticks means the worker is down. */
export const WORKER_MAX_TICK_AGE_MS = 60_000;
