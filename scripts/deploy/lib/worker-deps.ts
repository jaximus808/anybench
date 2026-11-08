// Live wiring for worker-reconcile.ts (worker-naive): Naïve computers, the worker_heartbeats check
// on Postgres and the release tarball in the artifact store. Used by scripts/deploy/worker.ts and
// by the on-host rotator; neither prints a value it is given.
import { ArtifactStore, ArtifactTransferError, uploadFileWithPlan } from "@anybench/envs";
import { createNaiveClient, withCapacityRetry, type NaiveClient } from "@anybench/naive";
import pg from "pg";
import type { HeartbeatResult, ReconcileDeps } from "./worker-reconcile.js";
import type { WorkerManifest } from "./worker-plan.js";

/** worker_heartbeats rows tick every 15 s; four missed ticks is down (lib/worker-health.ts). */
export const HEARTBEAT_MAX_AGE_MS = 60_000;

/** The newest worker_heartbeats row for `host` that started at or after `sinceMs`. */
export async function checkHeartbeat(
  databaseUrlDirect: string,
  host: string,
  sinceMs: number,
): Promise<HeartbeatResult> {
  const client = new pg.Client({ connectionString: databaseUrlDirect });
  client.on("error", () => {});
  await client.connect();
  try {
    const r = await client.query<{ worker_id: string; ticks: number; age_ms: string }>(
      `select worker_id, ticks, (extract(epoch from (now() - last_tick_at)) * 1000)::bigint as age_ms
         from worker_heartbeats
        where host = $1 and started_at >= to_timestamp($2::double precision / 1000)
        order by last_tick_at desc limit 1`,
      [host, sinceMs],
    );
    const row = r.rows[0];
    if (!row) return { healthy: false, detail: { heartbeat: "none" } };
    const age = Number(row.age_ms);
    return {
      healthy: age < HEARTBEAT_MAX_AGE_MS && row.ticks >= 2,
      detail: { worker_id: row.worker_id, ticks: row.ticks, heartbeat_age_ms: age },
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export type S3Env = Record<
  "S3_ENDPOINT" | "S3_REGION" | "S3_BUCKET" | "S3_ACCESS_KEY_ID" | "S3_SECRET_ACCESS_KEY",
  string
>;

export function releaseStore(s3: S3Env): ArtifactStore {
  return ArtifactStore.fromEnv({ ...s3 });
}

/** The tarball already in the store for this artifact ref, or null. */
export async function storedRelease(
  store: ArtifactStore,
  ref: WorkerManifest["release"]["artifact"],
): Promise<{ sha256: string; sizeBytes: number } | null> {
  try {
    const t = await store.createDownload({ ...ref, expiresInSec: 60 });
    return { sha256: t.sha256, sizeBytes: t.sizeBytes };
  } catch (err) {
    if (err instanceof ArtifactTransferError && err.code === "not_found") return null;
    throw err;
  }
}

export async function uploadRelease(
  store: ArtifactStore,
  ref: WorkerManifest["release"]["artifact"],
  file: string,
  meta: { sha256: string; sizeBytes: number },
): Promise<void> {
  const plan = await store.createUpload({
    ...ref,
    sizeBytes: meta.sizeBytes,
    sha256: meta.sha256,
    maxBytes: 1024 * 1024 * 1024,
  });
  await uploadFileWithPlan(plan, file);
  await store.completeUpload(plan);
}

export function liveNaive(apiKey: string, baseUrl?: string): NaiveClient {
  return createNaiveClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

export function liveReconcileDeps(opts: {
  naive: NaiveClient;
  databaseUrlDirect: string;
  store: ArtifactStore;
  log: ReconcileDeps["log"];
}): ReconcileDeps {
  return {
    computers: withCapacityRetry(opts.naive.computers),
    heartbeat: (host, sinceMs) => checkHeartbeat(opts.databaseUrlDirect, host, sinceMs),
    releaseUrl: async (m) =>
      (await opts.store.createDownload({ ...m.release.artifact, expiresInSec: 3600 })).url,
    log: opts.log,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
