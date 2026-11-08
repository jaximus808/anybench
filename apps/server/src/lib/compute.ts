// Default compute wiring for the worker's jobs (demo-env-trials): the eval-computer provider, the
// trial artifact store and the Naïve proxy-key deps, from config. Tests pass their own
// (FakeProvider etc.) through the job options, so nothing here runs without NAIVE_API_KEY.
//
//   NAIVE_API_KEY set  → NaiveProvider for trial.execute, trial.gate (the scoring computer) and the
//                        env_build stage; liveProxyKeys + liveLedgerSpend for per-trial proxy keys.
//   S3_BUCKET set      → ArtifactStore for the frozen bundle (gate download, fs/read fallback upload)
//                        and for shipping the runner binary into env images.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ExecTrial } from "@anybench/bench";
import { ArtifactStore, uploadFileWithPlan } from "@anybench/envs";
import { createNaiveClient, liveLedgerSpend, liveProxyKeys } from "@anybench/naive";
import { NaiveProvider, type ComputeProvider } from "@anybench/providers";
import type { Config } from "../config.js";
import type { ExecutorDeps } from "@anybench/bench";

type NaiveConfig = Pick<Config, "NAIVE_API_KEY" | "NAIVE_BASE_URL">;

/** NaiveProvider when NAIVE_API_KEY is set, else null (the job then refuses to run). */
export function computeProviderFromConfig(config: NaiveConfig): ComputeProvider | null {
  if (!config.NAIVE_API_KEY) return null;
  return new NaiveProvider({
    client: createNaiveClient({
      apiKey: config.NAIVE_API_KEY,
      ...(config.NAIVE_BASE_URL ? { baseUrl: config.NAIVE_BASE_URL } : {}),
    }),
  });
}

/** Per-trial Naïve proxy keys (TDM-16) when NAIVE_API_KEY is set. */
export function proxyDepsFromConfig(config: NaiveConfig): ExecutorDeps["naiveProxy"] | null {
  if (!config.NAIVE_API_KEY) return null;
  const opts = {
    apiKey: config.NAIVE_API_KEY,
    ...(config.NAIVE_BASE_URL ? { baseUrl: config.NAIVE_BASE_URL } : {}),
  };
  return {
    keys: liveProxyKeys(opts),
    spend: liveLedgerSpend(opts),
    ...(config.NAIVE_BASE_URL ? { baseUrl: config.NAIVE_BASE_URL } : {}),
  };
}

/** The S3/R2 trial artifact store, when S3_BUCKET is set (read from the process env, like main.ts). */
export function artifactStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ArtifactStore | null {
  return env.S3_BUCKET ? ArtifactStore.fromEnv(env) : null;
}

/** executor fallbackUpload: the worker read the bundle by fs/read; put it in the artifact store. */
export function fallbackBundleUpload(
  store: Pick<ArtifactStore, "createUpload" | "completeUpload">,
  maxBytes = 512 * 1024 * 1024,
): (trial: ExecTrial, bundle: Uint8Array) => Promise<{ key: string } | null> {
  return async (trial, bundle) => {
    const dir = await mkdtemp(path.join(tmpdir(), "ab-bundle-"));
    try {
      const file = path.join(dir, "out.tar.gz");
      await writeFile(file, bundle);
      const plan = await store.createUpload({
        runId: trial.run_id,
        trialId: trial.id,
        name: "out.tar.gz",
        sizeBytes: bundle.byteLength,
        sha256: createHash("sha256").update(bundle).digest("hex"),
        maxBytes,
      });
      await uploadFileWithPlan(plan, file);
      const stored = await store.completeUpload(plan);
      return { key: stored.key };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
