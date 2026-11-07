// Live log chunks (TDM-160): the driver's redacted stdout / stderr, cut into segments while the
// trial runs, each uploaded through the ingest upload flow (`POST .../uploads` → presigned PUT →
// `POST .../uploads/complete`) and announced with a `trial.log_chunk` event
// `{stream, offset, bytes, url, sha256}`.
//
// The chunker is fed by RedactingLineWriter.onWrite, so it only ever sees text that was redacted
// line by line, and its offsets are byte offsets into stdout.log / stderr.log: concatenating the
// segments of a stream in offset order gives back the exact file.
//
// A segment is cut when it reaches `segment_bytes` (at a write boundary, so normally a line end)
// or `segment_ms` after its first byte. Uploads run one at a time per stream, so the events come
// out in offset order. When a segment cannot be uploaded after `upload_tries`, or there is no way
// to get an upload plan (the event sink went file-only), live chunks stop for that stream; the
// full log is still in the frozen bundle.

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogChunksConfig } from "./job.js";
import type { UploadedArtifact } from "./upload.js";

export type LogStream = "stdout" | "stderr";

export interface LogChunkPayload {
  stream: LogStream;
  offset: number;
  bytes: number;
  url: string;
  sha256: string;
}

export interface LogChunkerOptions {
  stream: LogStream;
  config: LogChunksConfig;
  /** Scratch directory for segment files (outside EVAL_OUT, so they are never bundled). */
  dir: string;
  /** Upload one file under `name`; null = no plan available (file-only). */
  upload: (name: string, path: string) => Promise<UploadedArtifact | null>;
  emit: (payload: LogChunkPayload) => void;
  log: (line: string) => void;
  /** Backoff between upload tries (tests shorten it). */
  retryDelayMs?: number;
}

/** Artifact name of a segment: `logs/<stream>/<offset, 12 digits>.log`. */
export function logChunkName(stream: LogStream, offset: number): string {
  return `logs/${stream}/${String(offset).padStart(12, "0")}.log`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LogChunker {
  private buffer: Buffer[] = [];
  private bufferBytes = 0;
  /** Offset of the first buffered byte in the stream's log file. */
  private bufferOffset = 0;
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private dirReady: Promise<void> | null = null;

  state: "live" | "off" = "live";
  error: string | null = null;
  segments = 0;
  /** Bytes announced in events so far. */
  bytes = 0;

  constructor(private readonly opts: LogChunkerOptions) {}

  /** Append text exactly as it was written to the log file. */
  write(text: string): void {
    if (this.closed || text.length === 0) return;
    const buf = Buffer.from(text, "utf8");
    if (this.state === "off") {
      this.bufferOffset += buf.length;
      return;
    }
    if (this.bufferBytes === 0) {
      this.timer = setTimeout(() => this.cut(), this.opts.config.segment_ms);
      this.timer.unref();
    }
    this.buffer.push(buf);
    this.bufferBytes += buf.length;
    if (this.bufferBytes >= this.opts.config.segment_bytes) this.cut();
  }

  /** Cut whatever is buffered into a segment and queue its upload. */
  private cut(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.bufferBytes === 0) return;
    const data = Buffer.concat(this.buffer, this.bufferBytes);
    const offset = this.bufferOffset;
    this.buffer = [];
    this.bufferOffset += this.bufferBytes;
    this.bufferBytes = 0;
    this.queue = this.queue
      .then(() => this.ship(offset, data))
      .catch((err: unknown) => this.turnOff(`segment at ${offset}: ${(err as Error).message}`));
  }

  private async ship(offset: number, data: Buffer): Promise<void> {
    if (this.state === "off") return;
    const { stream, config } = this.opts;
    const name = logChunkName(stream, offset);
    const sha256 = createHash("sha256").update(data).digest("hex");
    this.dirReady ??= mkdir(this.opts.dir, { recursive: true }).then(() => undefined);
    await this.dirReady;
    const path = join(this.opts.dir, `${stream}-${offset}.log`);
    await writeFile(path, data);
    let lastError = "";
    try {
      for (let attempt = 1; attempt <= config.upload_tries; attempt++) {
        try {
          const uploaded = await this.opts.upload(name, path);
          if (!uploaded) {
            this.turnOff("no upload plan available (file-only)");
            return;
          }
          this.opts.emit({ stream, offset, bytes: data.length, url: uploaded.url, sha256 });
          this.segments++;
          this.bytes += data.length;
          return;
        } catch (err) {
          lastError = (err as Error).message;
          if (attempt < config.upload_tries) {
            await sleep((this.opts.retryDelayMs ?? 500) * 2 ** (attempt - 1));
          }
        }
      }
      this.turnOff(`segment at ${offset} failed ${config.upload_tries} times: ${lastError}`);
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  private turnOff(reason: string): void {
    if (this.state === "off") return;
    this.state = "off";
    this.error = reason;
    this.opts.log(`runner: live ${this.opts.stream} chunks off: ${reason}`);
  }

  /** Cut the last segment and wait (up to `deadlineMs`) for every queued upload. Idempotent. */
  async close(deadlineMs = 60_000): Promise<void> {
    if (!this.closed) {
      this.cut();
      this.closed = true;
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((r) => {
      timer = setTimeout(() => r("deadline"), deadlineMs);
      timer.unref();
    });
    const outcome = await Promise.race([this.queue.then(() => "done" as const), deadline]);
    clearTimeout(timer);
    if (outcome === "deadline") {
      this.turnOff(`uploads still pending after ${deadlineMs} ms`);
    }
  }
}
