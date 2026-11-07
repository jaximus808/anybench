// What the ingest side does with `trial.log_chunk` events (TDM-160): order a stream's segments by
// offset, check they are contiguous and match their sha256, and concatenate the stored objects.

import { createHash } from "node:crypto";
import { artifactKeyFromUrl } from "../src/index.js";

export interface LogChunkEventTdm160 {
  type: string;
  payload: unknown;
}

interface ChunkPayload {
  stream: string;
  offset: number;
  bytes: number;
  url: string;
  sha256?: string;
}

export function logChunksTdm160(
  events: readonly LogChunkEventTdm160[],
  stream: string,
): ChunkPayload[] {
  return events
    .filter((e) => e.type === "trial.log_chunk")
    .map((e) => e.payload as ChunkPayload)
    .filter((p) => p.stream === stream);
}

/** Throws when a segment is missing, overlapping, absent from the store or corrupted. */
export function reassembleLogTdm160(
  events: readonly LogChunkEventTdm160[],
  stream: string,
  objects: ReadonlyMap<string, Buffer>,
): Buffer {
  const chunks = logChunksTdm160(events, stream);
  const parts: Buffer[] = [];
  let next = 0;
  for (const c of chunks) {
    if (c.offset !== next) throw new Error(`${stream}: expected offset ${next}, got ${c.offset}`);
    const key = artifactKeyFromUrl(c.url);
    if (!key) throw new Error(`${stream}: not an artifact url: ${c.url}`);
    const body = objects.get(key);
    if (!body) throw new Error(`${stream}: object ${key} was never uploaded`);
    if (body.length !== c.bytes) throw new Error(`${stream}: ${key} is ${body.length} bytes`);
    const sha = createHash("sha256").update(body).digest("hex");
    if (c.sha256 !== sha) throw new Error(`${stream}: ${key} sha256 mismatch`);
    parts.push(body);
    next += c.bytes;
  }
  return Buffer.concat(parts);
}
