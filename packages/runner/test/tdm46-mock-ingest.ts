// A local stand-in for the runner ingest API ([5.2]) and a presigned-PUT object store, for the
// runner tests and the docker-local e2e. Records every batch, plan request, PUT and completion.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  RunnerEventBatchSchema,
  UploadCompleteRequestSchema,
  UploadPlanRequestSchema,
  type RunnerEventBatch,
  type UploadCompleteRequest,
  type UploadPlanRequest,
} from "../src/index.js";

export type MockIngestMode = "ok" | "fail500" | "unauthorized";

export interface MockIngest {
  url: string;
  port: number;
  token: string;
  mode: MockIngestMode;
  batches: RunnerEventBatch[];
  /** Raw JSON bodies as received (for secret scans). */
  rawBodies: string[];
  planRequests: UploadPlanRequest[];
  completions: UploadCompleteRequest[];
  objects: Map<string, Buffer>;
  /** Batches that came twice (same batch_seq). */
  duplicates: number;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startMockIngestTdm46(
  opts: { token?: string; host?: string; publicHost?: string; mode?: MockIngestMode } = {},
): Promise<MockIngest> {
  const token = opts.token ?? "tdm46-trial-token-0123456789abcdef";
  const seen = new Set<string>();
  const state: MockIngest = {
    url: "",
    port: 0,
    token,
    mode: opts.mode ?? "ok",
    batches: [],
    rawBodies: [],
    planRequests: [],
    completions: [],
    objects: new Map(),
    duplicates: 0,
    close: () => Promise.resolve(),
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const url = new URL(req.url ?? "/", "http://x");
      const send = (status: number, json?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(json === undefined ? "" : JSON.stringify(json));
      };

      if (req.method === "PUT" && url.pathname.startsWith("/s3/")) {
        const key = decodeURIComponent(url.pathname.slice("/s3/".length));
        state.objects.set(key, body);
        res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
        res.end();
        return;
      }

      if (req.headers.authorization !== `Bearer ${token}` || state.mode === "unauthorized") {
        send(401, { error: "unauthorized" });
        return;
      }
      if (state.mode === "fail500") {
        send(500, { error: "boom" });
        return;
      }

      const m = /^\/v1\/trials\/([^/]+)\/(events|uploads|uploads\/complete)$/.exec(url.pathname);
      if (req.method !== "POST" || !m) {
        send(404, { error: "not found" });
        return;
      }
      const text = body.toString("utf8");
      const json = JSON.parse(text) as unknown;
      if (m[2] === "events") {
        const batch = RunnerEventBatchSchema.parse(json);
        const k = `${batch.trial_id}:${batch.attempt}:${batch.batch_seq}`;
        if (seen.has(k)) {
          state.duplicates++;
          send(409, { duplicate: true });
          return;
        }
        seen.add(k);
        state.rawBodies.push(text);
        state.batches.push(batch);
        send(202, { accepted: batch.events.length });
        return;
      }
      if (m[2] === "uploads") {
        const r = UploadPlanRequestSchema.parse(json);
        state.planRequests.push(r);
        const trialId = decodeURIComponent(m[1]!);
        const key = `runs/run-tdm46/trials/${trialId}/${r.name}`;
        send(200, {
          plan: {
            kind: "single",
            key,
            sizeBytes: r.size_bytes,
            sha256: r.sha256,
            maxBytes: 512 * 1024 * 1024,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            method: "PUT",
            url: `${state.url}/s3/${encodeURIComponent(key)}?X-Amz-Signature=fake`,
            headers: { "content-length": String(r.size_bytes), "x-amz-meta-sha256": r.sha256 },
          },
        });
        return;
      }
      state.completions.push(UploadCompleteRequestSchema.parse(json));
      send(200, { ok: true });
    })().catch((err: unknown) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  state.close = () => new Promise((r) => server.close(() => r()));
  await new Promise<void>((r) => server.listen(0, opts.host ?? "127.0.0.1", () => r()));
  state.port = (server.address() as AddressInfo).port;
  state.url = `http://${opts.publicHost ?? "127.0.0.1"}:${state.port}`;
  return state;
}

/** The phase transitions in an event list, as "from→to" strings (heartbeats dropped). */
export function phaseSequenceTdm46(
  events: readonly { type: string; payload: unknown }[],
): string[] {
  return events
    .filter((e) => e.type === "trial.phase")
    .map((e) => {
      const p = e.payload as { from: string | null; to: string };
      return `${p.from ?? "∅"}→${p.to}`;
    });
}
