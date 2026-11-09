// Where trial traces live and how one is built from the stored bundle.
//
// A trace is a server-owned artifact at `runs/<run>/server/traces/<trial>.json` (envs
// serverArtifactKey): outside every trial prefix, so the runner (which may upload any name under
// `runs/<run>/trials/<trial>/`) can never plant or overwrite one. The bundle it is built from is
// the trial's out.tar.gz, fetched through a short-lived presigned GET and checked against the
// sha256 recorded at upload.
import { createHash } from "node:crypto";
import { stringifyJson, TrialTraceSchema, type TrialTrace } from "@anybench/core";
import { ArtifactTransferError, type DownloadTicket } from "@anybench/envs";
import { traceFromBundle } from "./parse.js";

/** Bundles bigger than this are not traced (a trace needs the transcripts, not the outputs). */
export const TRACE_MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
export const TRACE_MAX_BYTES = 16 * 1024 * 1024;

export const traceArtifactName = (trialId: string): string => `traces/${trialId}.json`;

export interface TrialTraceStore {
  get(runId: string, trialId: string): Promise<TrialTrace | null>;
  put(runId: string, trialId: string, trace: TrialTrace): Promise<void>;
}

/** The part of `@anybench/envs` ArtifactStore the trace store uses. */
export interface ServerArtifacts {
  putServerArtifact(
    runId: string,
    name: string,
    body: Uint8Array,
    contentType?: string,
  ): Promise<unknown>;
  getServerArtifact(runId: string, name: string, maxBytes?: number): Promise<Uint8Array | null>;
}

export function artifactTraceStore(store: ServerArtifacts): TrialTraceStore {
  return {
    async get(runId, trialId) {
      const bytes = await store.getServerArtifact(
        runId,
        traceArtifactName(trialId),
        TRACE_MAX_BYTES,
      );
      if (!bytes) return null;
      const parsed = TrialTraceSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      // An old or broken trace reads as missing (the backfill rebuilds it), never as a 500.
      return parsed.success ? parsed.data : null;
    },
    async put(runId, trialId, trace) {
      const body = new TextEncoder().encode(stringifyJson(trace));
      await store.putServerArtifact(runId, traceArtifactName(trialId), body, "application/json");
    },
  };
}

/** Reads a trial's frozen bundle. */
export interface BundleSource {
  bundle(runId: string, trialId: string): Promise<Uint8Array | null>;
}

export interface BundleDownloads {
  createDownload(input: {
    runId: string;
    trialId: string;
    name: string;
    expiresInSec?: number;
  }): Promise<DownloadTicket>;
}

export function artifactBundleSource(
  store: BundleDownloads,
  options: { fetch?: typeof fetch } = {},
): BundleSource {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async bundle(runId, trialId) {
      let t: DownloadTicket;
      try {
        t = await store.createDownload({ runId, trialId, name: "out.tar.gz", expiresInSec: 600 });
      } catch (err) {
        if (err instanceof ArtifactTransferError && err.code === "not_found") return null;
        throw err;
      }
      if (t.sizeBytes > TRACE_MAX_BUNDLE_BYTES) {
        throw new Error(`out.tar.gz is ${t.sizeBytes} bytes, over the trace limit`);
      }
      const res = await fetchImpl(t.url, {
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`out.tar.gz download failed: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > TRACE_MAX_BUNDLE_BYTES)
        throw new Error("out.tar.gz grew past the limit");
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== t.sha256) throw new Error("out.tar.gz does not match its recorded sha256");
      return bytes;
    },
  };
}

export interface TraceDeps {
  bundles: BundleSource;
  traces: TrialTraceStore;
  now?: () => Date;
}

/**
 * Build a trial's trace from its bundle and store it. Returns the trace, or null when the trial
 * has no bundle. Reads the bundle and writes the trace artifact; touches nothing else.
 */
export async function buildAndStoreTrace(
  deps: TraceDeps,
  input: {
    runId: string;
    trialId: string;
    gate: unknown;
    /** The bundle already read by the caller (null: it has none); omitted: read it here. */
    bundle?: Uint8Array | null;
  },
): Promise<TrialTrace | null> {
  const bundle =
    input.bundle !== undefined
      ? input.bundle
      : await deps.bundles.bundle(input.runId, input.trialId);
  if (!bundle) return null;
  const trace = traceFromBundle(bundle, {
    trialId: input.trialId,
    gate: input.gate,
    ...(deps.now ? { now: deps.now } : {}),
  });
  await deps.traces.put(input.runId, input.trialId, trace);
  return trace;
}
