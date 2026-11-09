// Download every trial bundle (out.tar.gz) of one run into <out>/<trial>.tar.gz (TDM-229).
// Read-only: a presigned GET per bundle from ArtifactStore.createDownload, config from .env
// (S3_*), checked against the size the ticket reports. Never prints env values or URLs.
//
//   pnpm exec tsx --env-file=.env scripts/spikes/harness-league/download-bundles.ts <run-id> <out-dir> <trial-id>...
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifactStoreFromEnv } from "../../../apps/server/src/lib/compute.js";

async function main(): Promise<void> {
  const [runId, outDir, ...trials] = process.argv.slice(2);
  if (!runId || !outDir || trials.length === 0) {
    throw new Error("usage: download-bundles.ts <run-id> <out-dir> <trial-id>...");
  }
  const store = artifactStoreFromEnv();
  if (!store) throw new Error("S3_BUCKET (the artifact store) must be set");
  await mkdir(outDir, { recursive: true });
  for (const trialId of trials) {
    try {
      const t = await store.createDownload({ runId, trialId, name: "out.tar.gz", expiresInSec: 600 });
      const res = await fetch(t.url);
      if (!res.ok) throw new Error(`GET ${res.status}`);
      const body = new Uint8Array(await res.arrayBuffer());
      await writeFile(path.join(outDir, `${trialId}.tar.gz`), body);
      process.stdout.write(`${trialId} ${body.byteLength} (ticket ${t.sizeBytes})\n`);
    } catch (err) {
      process.stdout.write(`${trialId} ERROR ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`download-bundles: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
