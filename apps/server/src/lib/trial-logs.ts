// Trial log reads by byte offset (TDM-74, plan.md section 6, ticket 8.3).
//
// Where the bytes are: the in-VM runner cuts the driver's stdout / stderr into segments, uploads
// each one to `runs/<run>/trials/<trial>/logs/<stream>/<offset, 12 digits>.log` and announces it
// with a `trial.log_chunk` event `{stream, offset, bytes, url}` (packages/runner/src/logs.ts). The
// segments of a stream, in offset order, are the log file. So the chunk index is the run's
// `trial.log_chunk` events for this trial and stream, and a slice is a few ranged GETs.
//
// Everything in those events came from the eval computer, where the agent under test can write,
// so none of it is trusted:
// - The object key is re-derived from (run, trial, stream, offset). The event's `url` is never
//   followed, returned or rendered; a chunk whose url is not exactly that key's `artifact:` ref
//   is dropped (TDM-47 already refuses it at ingest; this is the second check).
// - Chunks are only taken from the trial's CURRENT attempt (after the last trial.phase event of an
//   earlier attempt), since every attempt restarts its logs at offset 0 under the same keys.
// - Duplicate offsets keep the latest event; overlapping chunks are dropped; `bytes` is checked
//   against what the object really holds (a short object ends the slice there).
// - Each request reads at most `bytes` (≤ LOG_TAIL_MAX_BYTES) plus a small look-back, from at most
//   LOG_SLICE_MAX_SEGMENTS objects.
//
// Redaction: core redaction matches whole tokens, so a slice is cut only at a break byte (a line
// end, whitespace or JSON punctuation) and starts at one: a request that lands inside a token is
// moved back to the token's start (up to LOG_LOOKBACK_BYTES), and the response's `offset` says
// where its text really starts. A secret is therefore never split across two responses.
import { createRedactor, isFinalTrialState, type Redactor, type TrialState } from "@anybench/core";
import { ArtifactTransferError, trialArtifactKey, type DownloadTicket } from "@anybench/envs";
import { sql } from "drizzle-orm";
import { configSecrets, type Config } from "../config.js";
import type { DbTx } from "../db/client.js";
import { mintRunnerToken } from "./runner-token.js";

/** The log streams a reader may ask for (core apiRoutes.trials.log `stream`). */
export type TrialLogStream = "stdout" | "stderr" | "runner";

/** How far back a slice may start to reach the start of the token holding the requested offset. */
export const LOG_LOOKBACK_BYTES = 4096;
/** Most segment objects one slice reads. */
export const LOG_SLICE_MAX_SEGMENTS = 64;
/** Most chunk rows one index query loads (a slice never needs more than the segments above). */
const INDEX_ROW_LIMIT = 512;
/** Presigned GET lifetime for a server-side read. */
const READ_URL_TTL_SEC = 60;
/** Per-object read timeout. */
const READ_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------------------------
// Object reads

export interface TrialLogRange {
  runId: string;
  trialId: string;
  /** Artifact name under the trial prefix, e.g. `logs/stdout/000000000000.log`. */
  name: string;
  /** First byte (inclusive). */
  start: number;
  /** Last byte (exclusive). */
  end: number;
}

/**
 * Reads byte ranges of trial artifacts for the server. Returns at most `end - start` bytes (fewer
 * when the object is shorter), or null when the object does not exist.
 */
export interface TrialLogReader {
  read(range: TrialLogRange): Promise<Uint8Array | null>;
}

/** The part of `@anybench/envs` ArtifactStore the reader needs. */
export interface ArtifactDownloads {
  createDownload(input: {
    runId: string;
    trialId: string;
    name: string;
    expiresInSec?: number;
  }): Promise<DownloadTicket>;
}

/** Read `want` bytes from a response body, skipping `skip` first; cancels the rest. */
async function readCapped(res: Response, skip: number, want: number): Promise<Uint8Array> {
  const out = new Uint8Array(want);
  let filled = 0;
  let skipped = 0;
  const reader = res.body?.getReader();
  if (!reader) return out.subarray(0, 0);
  try {
    while (filled < want) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (skipped < skip) {
        const drop = Math.min(skip - skipped, chunk.length);
        skipped += drop;
        chunk = chunk.subarray(drop);
      }
      const take = Math.min(chunk.length, want - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.subarray(0, filled);
}

/**
 * The production reader: a short-lived presigned GET from ArtifactStore.createDownload, fetched
 * here with a `Range` header. The URL never leaves the server.
 */
export function artifactLogReader(
  store: ArtifactDownloads,
  options: { fetch?: typeof fetch } = {},
): TrialLogReader {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async read(range) {
      let ticket: DownloadTicket;
      try {
        ticket = await store.createDownload({
          runId: range.runId,
          trialId: range.trialId,
          name: range.name,
          expiresInSec: READ_URL_TTL_SEC,
        });
      } catch (err) {
        if (err instanceof ArtifactTransferError && err.code === "not_found") return null;
        throw err;
      }
      const end = Math.min(range.end, ticket.sizeBytes);
      if (end <= range.start) return new Uint8Array(0);
      const res = await fetchImpl(ticket.url, {
        headers: { range: `bytes=${range.start}-${end - 1}` },
        redirect: "error",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (res.status === 416) {
        await res.body?.cancel().catch(() => undefined);
        return new Uint8Array(0);
      }
      if (res.status !== 206 && res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`log read failed: HTTP ${res.status}`);
      }
      // 200 = the store ignored Range and sent the whole object.
      return readCapped(res, res.status === 200 ? range.start : 0, end - range.start);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Chunk index

/** One segment of a stream: bytes [offset, offset + bytes) of the log. */
export interface LogChunk {
  offset: number;
  bytes: number;
}

/** Artifact name of a segment (same as packages/runner logChunkName). */
export function logChunkName(stream: TrialLogStream, offset: number): string {
  return `logs/${stream}/${String(offset).padStart(12, "0")}.log`;
}

export interface TrialRef {
  id: string;
  runId: string;
  attempt: number;
}

/**
 * Seq after which the trial's current attempt starts: the last trial.phase event of an earlier
 * attempt (0 when there is none).
 */
async function attemptStartSeq(tx: DbTx, trial: TrialRef): Promise<number> {
  const res = await tx.execute(sql`
    select coalesce(max(seq), 0)::bigint as seq from events
    where run_id = ${trial.runId} and source_id = ${trial.id} and type = 'trial.phase'
      and (payload->>'attempt') ~ '^[0-9]{1,9}$' and (payload->>'attempt')::int < ${trial.attempt}`);
  return Number((res as unknown as { rows: { seq: string | number }[] }).rows[0]?.seq ?? 0);
}

export interface ChunkWindow {
  /** Chunks with end > `from`, in offset order, deduplicated and non-overlapping. */
  chunks: LogChunk[];
}

/**
 * The current attempt's chunks of one stream that end after `from`, read under the caller's
 * scopedDb transaction (RLS: only the owner's events are visible). `url` is checked, never kept.
 */
export async function loadChunkWindow(
  tx: DbTx,
  trial: TrialRef,
  stream: TrialLogStream,
  from: number,
): Promise<ChunkWindow> {
  const afterSeq = await attemptStartSeq(tx, trial);
  const base = sql`run_id = ${trial.runId} and source_id = ${trial.id} and type = 'trial.log_chunk'
      and seq > ${afterSeq} and payload->>'stream' = ${stream}
      and (payload->>'offset') ~ '^[0-9]{1,15}$' and (payload->>'bytes') ~ '^[0-9]{1,15}$'`;
  const res = await tx.execute(sql`
    select seq, (payload->>'offset')::bigint as "offset", (payload->>'bytes')::bigint as bytes,
           payload->>'url' as url
    from events
    where ${base}
      and (payload->>'offset')::bigint + (payload->>'bytes')::bigint > ${from}
    order by (payload->>'offset')::bigint asc, seq desc
    limit ${INDEX_ROW_LIMIT}`);
  const rows = (
    res as unknown as {
      rows: {
        seq: string | number;
        offset: string | number;
        bytes: string | number;
        url: string;
      }[];
    }
  ).rows;
  const chunks: LogChunk[] = [];
  let lastEnd = -1;
  let lastOffset = -1;
  for (const row of rows) {
    const offset = Number(row.offset);
    const bytes = Number(row.bytes);
    if (offset === lastOffset) continue; // an older event for the same segment
    lastOffset = offset;
    if (bytes <= 0 || offset < lastEnd) continue; // empty or overlapping: not a segment of this log
    if (
      row.url !==
      `artifact:${trialArtifactKey(trial.runId, trial.id, logChunkName(stream, offset))}`
    )
      continue;
    chunks.push({ offset, bytes });
    lastEnd = offset + bytes;
  }
  return { chunks };
}

// ---------------------------------------------------------------------------------------------
// Slicing

export interface LogSlice {
  /** Where `text` starts (≤ the requested offset only when that landed inside a token). */
  offset: number;
  /** Where the next read continues. */
  next_offset: number;
  /** Redacted text of bytes [offset, next_offset), minus any bytes the store no longer holds. */
  text: string;
  /** The trial is final and next_offset is the end of the log. */
  eof: boolean;
}

/**
 * A break byte: a slice may start right after one and end right after one. Line ends, whitespace
 * and JSON/shell punctuation; never a byte that can sit inside a key, URL or token.
 */
function isBreak(b: number): boolean {
  return (
    b === 0x0a || // \n
    b === 0x0d ||
    b === 0x09 ||
    b === 0x20 ||
    b === 0x22 || // "
    b === 0x27 || // '
    b === 0x60 || // `
    b === 0x2c || // ,
    b === 0x3b || // ;
    b === 0x28 ||
    b === 0x29 ||
    b === 0x5b ||
    b === 0x5d ||
    b === 0x7b ||
    b === 0x7d ||
    b === 0x3c ||
    b === 0x3e ||
    b === 0x7c // |
  );
}

/** Where to cut the end of `data` so its last code point is whole (never below `floor`). */
function utf8Cut(data: Uint8Array, floor: number): number {
  let lead = data.length - 1;
  for (let i = 0; i < 3 && lead > floor && (data[lead]! & 0xc0) === 0x80; i++) lead--;
  const b = data[lead] ?? 0;
  const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  return lead + len > data.length ? Math.max(lead, floor) : data.length;
}

export interface SliceRequest {
  trial: TrialRef;
  stream: TrialLogStream;
  offset: number;
  bytes: number;
  /** The trial is in a final state: no more chunks will come for this attempt. */
  final: boolean;
}

const decoder = new TextDecoder("utf-8");

/**
 * Read one slice. `window` must come from loadChunkWindow(…, max(0, offset - LOG_LOOKBACK_BYTES)).
 */
export async function readLogSlice(
  reader: TrialLogReader,
  redactor: Redactor,
  req: SliceRequest,
  window: ChunkWindow,
): Promise<LogSlice> {
  const { chunks } = window;
  const endOf = (c: LogChunk) => c.offset + c.bytes;
  const eofAt = (next: number) => req.final && !chunks.some((c) => endOf(c) > next);
  const nothing = (at: number, next = at): LogSlice => ({
    offset: at,
    next_offset: next,
    text: "",
    eof: eofAt(next),
  });

  // The chunk holding the requested offset, or the first one after it (past a gap).
  let first = chunks.findIndex((c) => endOf(c) > req.offset);
  if (first < 0) return nothing(req.offset);
  const start = Math.max(req.offset, chunks[first]!.offset);
  // Look back for the token start, only inside this contiguous run of chunks.
  let runStart = chunks[first]!.offset;
  for (let i = first - 1; i >= 0 && endOf(chunks[i]!) === runStart; i--)
    runStart = chunks[i]!.offset;
  const lbStart = Math.max(runStart, start - LOG_LOOKBACK_BYTES);
  while (first > 0 && endOf(chunks[first - 1]!) > lbStart) first--;

  // Read [lbStart, start + bytes) through contiguous chunks: stop at a gap, a short object or the
  // segment cap.
  const wantEnd = start + req.bytes;
  const parts: Uint8Array[] = [];
  let pos = lbStart;
  let skipTo: number | undefined;
  let segments = 0;
  for (let i = first; i < chunks.length && pos < wantEnd; i++) {
    const c = chunks[i]!;
    if (c.offset > pos || segments >= LOG_SLICE_MAX_SEGMENTS) break;
    segments++;
    const from = pos - c.offset;
    const to = Math.min(c.bytes, wantEnd - c.offset);
    const got = await reader.read({
      runId: req.trial.runId,
      trialId: req.trial.id,
      name: logChunkName(req.stream, c.offset),
      start: from,
      end: to,
    });
    const n = Math.min(got?.length ?? 0, to - from);
    if (n > 0) parts.push(n === got!.length ? got! : got!.subarray(0, n));
    pos += n;
    if (n < to - from) {
      skipTo = endOf(c); // the object holds less than its event claimed: the rest is gone
      break;
    }
  }
  // Do the bytes at `pos` continue what was read (now, or later at the live end)?
  const covered = chunks.some((c) => c.offset <= pos && pos < endOf(c));
  const liveEnd = !req.final && !chunks.some((c) => endOf(c) > pos);
  const continues = skipTo === undefined && (covered || liveEnd);

  const data = parts.length === 1 ? parts[0]! : new Uint8Array(Buffer.concat(parts));
  const startIdx = start - lbStart;
  if (data.length < startIdx) return nothing(start, skipTo ?? start);

  // Start right after the last break byte before `start`: the start of the token holding it.
  let alignIdx = startIdx;
  if (startIdx > 0) {
    let i = startIdx - 1;
    while (i >= 0 && !isBreak(data[i]!)) i--;
    if (i >= 0) alignIdx = i + 1;
    else if (lbStart === runStart) alignIdx = 0; // the token starts where the log run starts
    // else: a token longer than the look-back; start where asked
  }

  let cutIdx = data.length;
  if (continues) {
    // End after the last line end, else after the last break byte, past the requested offset.
    let at = -1;
    for (let i = data.length - 1; i >= startIdx; i--) {
      if (data[i] === 0x0a) {
        at = i;
        break;
      }
      if (at < 0 && isBreak(data[i]!)) at = i;
    }
    if (at >= 0) cutIdx = at + 1;
    else if (liveEnd)
      return nothing(start); // a partial token at the live end: wait for the rest
    else cutIdx = utf8Cut(data, startIdx + 1); // one huge token: cut it
  }
  if (cutIdx <= alignIdx) return nothing(start, skipTo ?? start);
  const next = skipTo !== undefined && cutIdx === data.length ? skipTo : lbStart + cutIdx;
  return {
    offset: lbStart + alignIdx,
    next_offset: next,
    text: redactor(decoder.decode(data.subarray(alignIdx, cutIdx))),
    eof: eofAt(next),
  };
}

// ---------------------------------------------------------------------------------------------
// Redaction scope

/**
 * The redactor for one trial's logs: the server's own secrets, the trial's runner tokens (every
 * attempt so far) and the core key patterns. The runner already redacted its own secrets line by
 * line; this is the server-side pass on every chunk it serves.
 */
export function trialLogRedactor(config: Config, trial: TrialRef): Redactor {
  const secrets: Record<string, string | undefined> = { ...configSecrets(config) };
  const tokenSecret = config.RUNNER_TOKEN_SECRET;
  if (tokenSecret) {
    for (let a = 1; a <= trial.attempt; a++) {
      try {
        secrets[`RUNNER_TOKEN_${a}`] = mintRunnerToken(tokenSecret, trial.id, a);
      } catch {
        // a too-short secret mints nothing; ingest refuses it too
      }
    }
  }
  return createRedactor(secrets);
}

export function isFinalForLogs(state: TrialState): boolean {
  return isFinalTrialState(state);
}
