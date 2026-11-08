// On-host rotator (worker-naive), shipped in the worker release as dist/rotate.js and run every
// 15 min by the anybench-worker-rotate systemd timer:
//
//   node --env-file=~/.anybench/worker.env dist/rotate.js      (via ~/anybench-worker/run-worker.sh rotate)
//
// Naïve destroys a computer 12 h after create. Once this computer is past the manifest's
// rotateAfterMs (default 10 h), it provisions a successor with the same release and env file,
// stops its own worker, starts the successor, checks its heartbeat and deletes itself. If the
// successor does not come up, its own worker is started again and the next tick retries.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { liveNaive, liveReconcileDeps, releaseStore } from "./lib/worker-deps.js";
import { HOST_PATHS, renderBootstrap, WorkerManifestSchema } from "./lib/worker-plan.js";
import { reconcileRotate } from "./lib/worker-reconcile.js";

const say = (step: string, data?: Record<string, unknown>) =>
  console.log(
    `${new Date().toISOString()} [worker:rotate] ${step}${data ? ` ${JSON.stringify(data)}` : ""}`,
  );

const RotateEnvSchema = z.object({
  NAIVE_API_KEY: z.string().min(1),
  NAIVE_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()),
  DATABASE_URL_DIRECT: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

async function main(): Promise<void> {
  const parsed = RotateEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`env: missing ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const env = parsed.data;
  const home = homedir();
  const read = (rel: string) => readFileSync(join(home, rel), "utf8");
  const manifest = WorkerManifestSchema.parse(JSON.parse(read(HOST_PATHS.manifest)));
  const self = z.object({ id: z.string().min(1) }).parse(JSON.parse(read(HOST_PATHS.computer)));
  const deps = liveReconcileDeps({
    naive: liveNaive(env.NAIVE_API_KEY, env.NAIVE_BASE_URL),
    databaseUrlDirect: env.DATABASE_URL_DIRECT,
    store: releaseStore(env),
    log: say,
  });
  const result = await reconcileRotate(
    deps,
    { manifest, envFile: read(HOST_PATHS.envFile), bootstrap: renderBootstrap() },
    self.id,
  );
  say("done", { decision: result.decision.kind, successor: result.handoff?.successor ?? null });
}

main().catch((err: unknown) => {
  say("failed", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
