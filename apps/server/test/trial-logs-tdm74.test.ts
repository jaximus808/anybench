// TDM-74 [8.3]: trial log slices by byte offset, the SSE live tail, redaction on every chunk and
// tenancy. Pure slicing tests run without a database; the route tests use a fresh local Postgres
// (skipped without it) and a synthetic 50 MB log that the fake reader generates on demand.
import {
  createRedactor,
  newId,
  SseParser,
  TrialIdSchema,
  type AnybenchEvent,
  type RunId,
  type SseFrame,
} from "@anybench/core";
import { ArtifactTransferError, trialArtifactKey } from "@anybench/envs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { apiKeys, contenders, kits, runs, trials, users } from "../src/db/schema/index.js";
import { appendEvents } from "../src/lib/events.js";
import { mintRunnerToken } from "../src/lib/runner-token.js";
import {
  artifactLogReader,
  logChunkName,
  readLogSlice,
  type LogChunk,
  type TrialLogRange,
  type TrialLogReader,
} from "../src/lib/trial-logs.js";
import type { AppDeps } from "../src/types.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { seedApiKeyTdm67 } from "./helpers/runs-tdm67.js";
import { configTdm14, recordingSentryTdm14, silentLoggerTdm14 } from "./helpers/server-tdm14.js";

const MIB = 1024 * 1024;
const PLANTED_KEY_TDM74 = "sk-ant-api03-PLANTEDtdm74keyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SESSION_SECRET_TDM74 = "tdm74-session-secret-value-0123456789abcdefghijkl";
const RUNNER_SECRET_TDM74 = "tdm74-runner-token-secret-0123456789abcdef-0123456789";

// ---------------------------------------------------------------------------------------------
// A synthetic log: 64-byte lines, `line <n> ....\n`; some lines carry secrets.

const LINE = 64;

/** Line `n`, exactly 64 bytes with the trailing newline (planted secrets make it longer). */
function lineTdm74(n: number, plants: Map<number, string>): string {
  const secret = plants.get(n);
  const head = `line ${String(n).padStart(9, "0")} `;
  if (secret) return `${head}token=${secret} end\n`;
  return head + "x".repeat(LINE - head.length - 1) + "\n";
}

/** A log built from lines, with byte-addressable content, generated on demand. */
class SyntheticLogTdm74 {
  /** Byte offset where each planted (longer) line starts, sorted. */
  private readonly lineStarts: { n: number; at: number; len: number }[] = [];
  readonly size: number;
  constructor(
    readonly lines: number,
    readonly plants: Map<number, string>,
  ) {
    let extra = 0;
    for (const n of [...plants.keys()].sort((a, b) => a - b)) {
      const len = Buffer.byteLength(lineTdm74(n, plants));
      this.lineStarts.push({ n, at: n * LINE + extra, len });
      extra += len - LINE;
    }
    this.size = lines * LINE + extra;
  }

  /** Start offset of line n. */
  offsetOf(n: number): number {
    let extra = 0;
    for (const p of this.lineStarts) if (p.n < n) extra += p.len - LINE;
    return n * LINE + extra;
  }

  /** Line number holding byte `pos`. */
  private lineAt(pos: number): number {
    let extra = 0;
    for (const p of this.lineStarts) {
      if (p.at > pos) break;
      if (pos < p.at + p.len) return p.n;
      extra += p.len - LINE;
    }
    return Math.floor((pos - extra) / LINE);
  }

  bytes(start: number, end: number): Buffer {
    const e = Math.min(end, this.size);
    if (e <= start) return Buffer.alloc(0);
    const out: Buffer[] = [];
    let n = this.lineAt(start);
    let at = this.offsetOf(n);
    let total = 0;
    while (at < e && n < this.lines) {
      const buf = Buffer.from(lineTdm74(n, this.plants));
      const from = Math.max(0, start - at);
      const to = Math.min(buf.length, e - at);
      if (to > from) {
        out.push(buf.subarray(from, to));
        total += to - from;
      }
      at += buf.length;
      n++;
    }
    return Buffer.concat(out, total);
  }
}

/** Segments of `segment` bytes over a log of `size` bytes. */
function chunksTdm74(size: number, segment: number): LogChunk[] {
  const out: LogChunk[] = [];
  for (let o = 0; o < size; o += segment)
    out.push({ offset: o, bytes: Math.min(segment, size - o) });
  return out;
}

/** A reader serving the synthetic log's segments; records every read. */
function fakeReaderTdm74(
  log: SyntheticLogTdm74,
  chunks: () => LogChunk[],
  stream = "stdout",
): TrialLogReader & { reads: TrialLogRange[]; short: Map<number, number> } {
  const reads: TrialLogRange[] = [];
  const short = new Map<number, number>();
  return {
    reads,
    short,
    async read(range) {
      reads.push(range);
      const m = new RegExp(`^logs/${stream}/(\\d{12})\\.log$`).exec(range.name);
      if (!m) return null;
      const offset = Number(m[1]);
      const c = chunks().find((x) => x.offset === offset);
      if (!c) return null;
      const stored = short.get(offset) ?? c.bytes;
      const end = Math.min(range.end, stored);
      return new Uint8Array(log.bytes(offset + range.start, offset + Math.max(range.start, end)));
    },
  };
}

const TRIAL_REF = {
  id: "01900000-0000-7000-8000-0000000000a1",
  runId: "01900000-0000-7000-8000-0000000000b1",
  attempt: 1,
};

// ---------------------------------------------------------------------------------------------
// Pure slicing

describe("readLogSlice (TDM-74, no DB)", () => {
  const redactor = createRedactor({});

  it("walks a log end to end in line-aligned, contiguous, redacted slices", async () => {
    const plants = new Map([
      [10, PLANTED_KEY_TDM74],
      [16_383, PLANTED_KEY_TDM74], // straddles the 1 MiB segment boundary
    ]);
    const log = new SyntheticLogTdm74(40_000, plants);
    const chunks = chunksTdm74(log.size, MIB);
    expect(chunks[1]!.offset).toBeGreaterThan(log.offsetOf(16_383));
    expect(chunks[1]!.offset).toBeLessThan(log.offsetOf(16_384));
    const reader = fakeReaderTdm74(log, () => chunks);
    let offset = 0;
    let all = "";
    for (let i = 0; i < 200; i++) {
      const s = await readLogSlice(
        reader,
        redactor,
        { trial: TRIAL_REF, stream: "stdout", offset, bytes: 300_000, final: true },
        { chunks },
      );
      expect(s.offset).toBe(offset);
      all += s.text;
      offset = s.next_offset;
      if (s.eof) break;
    }
    expect(offset).toBe(log.size);
    expect(all).not.toContain("PLANTEDtdm74");
    expect(all.match(/\[REDACTED:ANTHROPIC_API_KEY\]/g)?.length).toBe(2);
    expect(all.split("\n").length - 1).toBe(40_000);
    expect(all.startsWith("line 000000000 ")).toBe(true);
  });

  it("moves a mid-token offset back to the token start, so a key is never split", async () => {
    const plants = new Map([[3, PLANTED_KEY_TDM74]]);
    const log = new SyntheticLogTdm74(100, plants);
    const chunks = chunksTdm74(log.size, 1024);
    const reader = fakeReaderTdm74(log, () => chunks);
    const keyAt = log.offsetOf(3) + "line 000000003 token=".length;
    const s = await readLogSlice(
      reader,
      redactor,
      { trial: TRIAL_REF, stream: "stdout", offset: keyAt + 20, bytes: 200, final: true },
      { chunks },
    );
    // Back to the last break byte before it (the space; `=` can sit inside a secret).
    expect(s.offset).toBe(log.offsetOf(3) + "line 000000003 ".length);
    expect(s.text.startsWith("token=[REDACTED:ANTHROPIC_API_KEY] end\n")).toBe(true);
    expect(s.text).not.toContain("PLANTED");
  });

  it("at the live end of a running trial, holds back a partial line and waits for the rest", async () => {
    const log = new SyntheticLogTdm74(10, new Map());
    // The runner cut a segment mid-line: bytes 0..100 (line 1 is half there).
    const chunks: LogChunk[] = [{ offset: 0, bytes: 100 }];
    const reader = fakeReaderTdm74(log, () => chunks);
    const a = await readLogSlice(
      reader,
      redactor,
      { trial: TRIAL_REF, stream: "stdout", offset: 0, bytes: 4096, final: false },
      { chunks },
    );
    // A line end wins: only line 0.
    expect([a.text, a.next_offset, a.eof]).toEqual([log.bytes(0, LINE).toString(), LINE, false]);
    const live = { trial: TRIAL_REF, stream: "stdout" as const, bytes: 4096, final: false };
    // Then up to the last break byte of the partial line ("line 000000001 ").
    const b = await readLogSlice(reader, redactor, { ...live, offset: LINE }, { chunks });
    expect([b.text, b.next_offset]).toEqual(["line 000000001 ", LINE + 15]);
    // Then a partial token: nothing until more bytes (or the end of the trial) come.
    const w = await readLogSlice(reader, redactor, { ...live, offset: LINE + 15 }, { chunks });
    expect(w).toEqual({ offset: LINE + 15, next_offset: LINE + 15, text: "", eof: false });
    // The trial ends: the rest of what was uploaded is served, and eof is set.
    const c = await readLogSlice(
      reader,
      redactor,
      { ...live, offset: LINE + 15, final: true },
      { chunks },
    );
    expect([c.text, c.next_offset, c.eof]).toEqual(["x".repeat(100 - LINE - 15), 100, true]);
  });

  it("skips a gap and a short object instead of looping on them", async () => {
    const log = new SyntheticLogTdm74(100, new Map());
    const chunks: LogChunk[] = [
      { offset: 0, bytes: 640 },
      { offset: 1280, bytes: 640 }, // 640..1280 was never uploaded
    ];
    const reader = fakeReaderTdm74(log, () => chunks);
    const req = { trial: TRIAL_REF, stream: "stdout" as const, bytes: 4096, final: true };
    const a = await readLogSlice(reader, redactor, { ...req, offset: 0 }, { chunks });
    expect([a.offset, a.next_offset, a.eof]).toEqual([0, 640, false]);
    const b = await readLogSlice(reader, redactor, { ...req, offset: 640 }, { chunks });
    expect([b.offset, b.next_offset, b.eof]).toEqual([1280, 1920, true]);
    // The second object holds only 128 of its 640 bytes: serve those, then move past it.
    reader.short.set(1280, 128);
    const c = await readLogSlice(reader, redactor, { ...req, offset: 1280 }, { chunks });
    expect([c.offset, c.next_offset, c.eof]).toEqual([1280, 1920, true]);
    expect(c.text).toBe(log.bytes(1280, 1408).toString());
  });

  it("cuts a token longer than the window on a UTF-8 boundary", async () => {
    const text = "é".repeat(3000); // 6000 bytes, no break byte
    const buf = Buffer.from(text);
    const chunks: LogChunk[] = [{ offset: 0, bytes: buf.length }];
    const reader: TrialLogReader = {
      async read(r) {
        return new Uint8Array(buf.subarray(r.start, r.end));
      },
    };
    const s = await readLogSlice(
      reader,
      redactor,
      { trial: TRIAL_REF, stream: "stdout", offset: 0, bytes: 1001, final: false },
      { chunks },
    );
    expect(s.next_offset).toBe(1000);
    expect(s.text).toBe("é".repeat(500));
  });
});

describe("artifactLogReader (TDM-74, no DB)", () => {
  const ticket = (sizeBytes: number) => ({
    key: "runs/r/trials/t/logs/stdout/000000000000.log",
    url: "https://bucket.example/presigned?sig=abc",
    sizeBytes,
    sha256: "a".repeat(64),
    expiresAt: new Date().toISOString(),
  });

  it("fetches a presigned GET with a Range header and caps the bytes it returns", async () => {
    const seen: { url: string; range: string | null; redirect: RequestInit["redirect"] }[] = [];
    const reader = artifactLogReader(
      { createDownload: async () => ticket(1000) },
      {
        fetch: async (url, init) => {
          seen.push({
            url: String(url),
            range: new Headers(init?.headers).get("range"),
            redirect: init?.redirect,
          });
          // A store that sends more than asked: only the asked bytes come back.
          return new Response(new Uint8Array(500).fill(0x61), { status: 206 });
        },
      },
    );
    const got = await reader.read({
      runId: "r",
      trialId: "t",
      name: "logs/stdout/000000000000.log",
      start: 100,
      end: 300,
    });
    expect(got?.length).toBe(200);
    expect(seen).toEqual([
      {
        url: "https://bucket.example/presigned?sig=abc",
        range: "bytes=100-299",
        redirect: "error",
      },
    ]);
  });

  it("slices a 200 (Range ignored), clamps to the object size, and maps not_found to null", async () => {
    const body = new TextEncoder().encode("0123456789");
    const reader = artifactLogReader(
      { createDownload: async () => ticket(10) },
      { fetch: async () => new Response(body, { status: 200 }) },
    );
    const got = await reader.read({ runId: "r", trialId: "t", name: "n", start: 4, end: 50 });
    expect(Buffer.from(got!).toString()).toBe("456789");
    const missing = artifactLogReader({
      createDownload: async () => {
        throw new ArtifactTransferError("not_found", "nope");
      },
    });
    expect(
      await missing.read({ runId: "r", trialId: "t", name: "n", start: 0, end: 1 }),
    ).toBeNull();
    const broken = artifactLogReader(
      { createDownload: async () => ticket(10) },
      { fetch: async () => new Response("denied", { status: 403 }) },
    );
    await expect(
      broken.read({ runId: "r", trialId: "t", name: "n", start: 0, end: 1 }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

// ---------------------------------------------------------------------------------------------
// Routes

const available = await pgAvailableTdm11();

function logChunkEventTdm74(
  runId: string,
  trialId: string,
  c: LogChunk,
  url = `artifact:${trialArtifactKey(runId, trialId, logChunkName("stdout", c.offset))}`,
  stream: "stdout" | "stderr" = "stdout",
): AnybenchEvent {
  return {
    run_id: runId as RunId,
    seq: 0,
    type: "trial.log_chunk",
    source: "trial",
    source_id: trialId,
    severity: "info",
    actor: { kind: "runner", id: "runner-tdm74" },
    cost_delta_micro_usd: 0n,
    at: new Date().toISOString(),
    payload: { stream, offset: c.offset, bytes: c.bytes, url },
  } as AnybenchEvent;
}

function phaseEventTdm74(runId: string, trialId: string, attempt: number): AnybenchEvent {
  return {
    run_id: runId as RunId,
    seq: 0,
    type: "trial.phase",
    source: "trial",
    source_id: trialId,
    severity: "warn",
    actor: { kind: "runner", id: "runner-tdm74" },
    cost_delta_micro_usd: 0n,
    at: new Date().toISOString(),
    payload: { from: "running", to: "failed_infra", attempt },
  } as AnybenchEvent;
}

interface LogBody {
  offset: number;
  next_offset: number;
  text: string;
  eof: boolean;
}

/** Read SSE frames from a response until `stop` says so (or `ms` passes). */
async function readFramesTdm74(
  res: Response,
  stop: (frames: SseFrame[]) => boolean,
  ms = 20_000,
): Promise<{ frames: SseFrame[]; closed: boolean }> {
  const reader = res.body!.getReader();
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  const deadline = Date.now() + ms;
  let closed = false;
  try {
    while (!stop(frames)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`stream: condition not met in ${ms} ms`);
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), left)),
      ]);
      if (next === "timeout") continue;
      if (next.done) {
        closed = true;
        break;
      }
      frames.push(...parser.push(decoder.decode(next.value, { stream: true })));
    }
  } finally {
    if (!closed) await reader.cancel().catch(() => undefined);
  }
  return { frames, closed };
}

describe.skipIf(!available)("trial log routes (TDM-74, local Postgres)", () => {
  let h: FreshDbTdm11;
  let ownerA: string;
  let ownerB: string;
  let runA: string;
  let runA2: string;
  let contenderA: string;
  let keyA: string;
  let keyB: string;
  let app: ReturnType<typeof createApp>;
  let deps: AppDeps;
  let repeat = 0;
  /** Each trial's chunk list, served by the fake reader. */
  const logs = new Map<string, { log: SyntheticLogTdm74; chunks: LogChunk[] }>();
  const reads: TrialLogRange[] = [];

  const reader: TrialLogReader = {
    async read(range) {
      reads.push(range);
      const entry = logs.get(range.trialId);
      if (!entry) return null;
      return fakeReaderTdm74(entry.log, () => entry.chunks).read(range);
    },
  };

  async function seedTrial(state: "running" | "done" = "running", attempt = 1) {
    const [t] = await h.db
      .insert(trials)
      .values({
        id: newId(TrialIdSchema),
        ownerId: ownerA,
        runId: runA,
        contenderId: contenderA,
        workloadId: "w-tdm74",
        repeat: repeat++,
        state,
        attempt,
      })
      .returning();
    return t!.id;
  }

  async function announce(trialId: string, chunks: LogChunk[]) {
    for (let i = 0; i < chunks.length; i += 100) {
      await appendEvents(
        h.db,
        runA as RunId,
        chunks.slice(i, i + 100).map((c) => logChunkEventTdm74(runA, trialId, c)),
      );
    }
  }

  function get(path: string, key: string | null = keyA, headers: Record<string, string> = {}) {
    return Promise.resolve(
      app.request(path, {
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      }),
    );
  }

  beforeAll(async () => {
    h = await freshMigratedDbTdm11({ max: 6 });
    const [a] = await h.db
      .insert(users)
      .values({ githubLogin: "tdm74-a", githubId: 7401 })
      .returning();
    const [b] = await h.db
      .insert(users)
      .values({ githubLogin: "tdm74-b", githubId: 7402 })
      .returning();
    ownerA = a!.id;
    ownerB = b!.id;
    const [r1] = await h.db
      .insert(runs)
      .values({ ownerId: ownerA, question: "tdm74?", budgetMicroUsd: 1_000_000n, state: "running" })
      .returning();
    const [r2] = await h.db
      .insert(runs)
      .values({ ownerId: ownerA, question: "tdm74 other?", budgetMicroUsd: 1_000_000n })
      .returning();
    runA = r1!.id;
    runA2 = r2!.id;
    const [kit] = await h.db
      .insert(kits)
      .values({ ownerId: ownerA, runId: runA, version: 1, spec: {}, hash: "h-tdm74" })
      .returning();
    const [c] = await h.db
      .insert(contenders)
      .values({ runId: runA, kitId: kit!.id, source: "github", role: "subject" })
      .returning();
    contenderA = c!.id;
    keyA = await seedApiKeyTdm67(h.db, ownerA, ["logs:read"]);
    keyB = await seedApiKeyTdm67(h.db, ownerB, ["logs:read"]);
    deps = {
      config: configTdm14(h.url, {
        RUNNER_TOKEN_SECRET: RUNNER_SECRET_TDM74,
        SESSION_SECRET: SESSION_SECRET_TDM74,
        EVENTS_POLL_INTERVAL_MS: "50",
        LOG_STREAM_AUTH_RECHECK_MS: "200",
      }),
      logger: silentLoggerTdm14(),
      db: h.db,
      sentry: recordingSentryTdm14(),
      trialLogs: reader,
    };
    app = createApp(deps);
  }, 60_000);

  afterAll(async () => {
    await h?.drop();
  });

  it("serves the right slice of a 50 MB log, and redacts every chunk (planted keys)", async () => {
    const trialId = await seedTrial("done");
    const runnerToken = mintRunnerToken(RUNNER_SECRET_TDM74, trialId, 1);
    const plants = new Map([
      [400_000, PLANTED_KEY_TDM74],
      [600_001, SESSION_SECRET_TDM74],
      [700_002, runnerToken],
    ]);
    const log = new SyntheticLogTdm74(820_000, plants); // 52,480,000+ bytes
    expect(log.size).toBeGreaterThan(50 * 1000 * 1000);
    const chunks = chunksTdm74(log.size, MIB);
    logs.set(trialId, { log, chunks });
    await announce(trialId, chunks);

    // A slice from the middle: starts where asked (a line start) and ends on a line end.
    const at = log.offsetOf(500_000);
    const res = await get(`/trials/${trialId}/log?offset=${at}&bytes=65536`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LogBody;
    expect(body.offset).toBe(at);
    expect(body.next_offset).toBe(at + 1024 * LINE); // 65536 bytes = 1024 whole lines
    expect(body.text).toBe(log.bytes(at, body.next_offset).toString());
    expect(body.eof).toBe(false);
    // Reads hit only the segment(s) covering the window, by name re-derived from the offset.
    const names = new Set(reads.filter((r) => r.trialId === trialId).map((r) => r.name));
    expect([...names]).toEqual([logChunkName("stdout", Math.floor(at / MIB) * MIB)]);

    // The ticket's spelling answers the same.
    const alias = await get(`/trials/${trialId}/logs?offset=${at}&bytes=65536`);
    expect(await alias.json()).toEqual(body);

    // Each planted secret's line, read through the API, comes back redacted.
    for (const [n, secret] of plants) {
      const r = await get(`/trials/${trialId}/log?offset=${log.offsetOf(n)}&bytes=4096`);
      const text = ((await r.json()) as LogBody).text;
      expect(text.startsWith(`line ${String(n).padStart(9, "0")} token=[REDACTED:`)).toBe(true);
      expect(text).not.toContain(secret);
    }
    // A request that lands inside the key is moved back to its start, never a key suffix.
    const keyAt = log.offsetOf(400_000) + "line 000400000 token=".length;
    const mid = (await (
      await get(`/trials/${trialId}/log?offset=${keyAt + 30}&bytes=128`)
    ).json()) as LogBody;
    expect(mid.offset).toBe(log.offsetOf(400_000) + "line 000400000 ".length);
    expect(mid.text.startsWith("token=[REDACTED:ANTHROPIC_API_KEY] end\n")).toBe(true);

    // The tail of the log: eof once the final trial's log is read to its end.
    const tail = (await (
      await get(`/trials/${trialId}/log?offset=${log.size - 1000}&bytes=65536`)
    ).json()) as LogBody;
    expect(tail.next_offset).toBe(log.size);
    expect(tail.eof).toBe(true);
  }, 60_000);

  it("is a 404 for another tenant's trial and for an unknown one (same answer)", async () => {
    const trialId = await seedTrial("done");
    const log = new SyntheticLogTdm74(100, new Map());
    const chunks = chunksTdm74(log.size, 1024);
    logs.set(trialId, { log, chunks });
    await announce(trialId, chunks);
    expect((await get(`/trials/${trialId}/log`)).status).toBe(200);
    const readsBefore = reads.length;
    const foreign = await get(`/trials/${trialId}/log`, keyB);
    expect(foreign.status).toBe(404);
    const unknown = await get(`/trials/${newId(TrialIdSchema)}/log`, keyB);
    expect(unknown.status).toBe(404);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("not_found");
    // The live tail too.
    expect((await get(`/trials/${trialId}/log/stream`, keyB)).status).toBe(404);
    // Nothing was read from storage for the foreign caller.
    expect(reads.length).toBe(readsBefore);
  });

  it("needs logs:read, and a run-scoped key only reaches its own run", async () => {
    const trialId = await seedTrial("done");
    expect((await get(`/trials/${trialId}/log`, null)).status).toBe(401);
    const noScope = await seedApiKeyTdm67(h.db, ownerA, ["runs:read"]);
    expect((await get(`/trials/${trialId}/log`, noScope)).status).toBe(403);
    const otherRun = await seedApiKeyTdm67(h.db, ownerA, ["logs:read"], [runA2]);
    expect((await get(`/trials/${trialId}/log`, otherRun)).status).toBe(403);
    const thisRun = await seedApiKeyTdm67(h.db, ownerA, ["logs:read"], [runA]);
    expect((await get(`/trials/${trialId}/log`, thisRun)).status).toBe(200);
    expect((await get(`/trials/${trialId}/log?bytes=${2 * MIB}`)).status).toBe(400);
  });

  it("never follows or returns a runner-provided URL, and serves only the current attempt", async () => {
    const trialId = await seedTrial("running", 2);
    const log = new SyntheticLogTdm74(40, new Map());
    const chunks = chunksTdm74(log.size, 640);
    logs.set(trialId, { log, chunks });
    // Attempt 1 wrote segments at 0 and 640, then failed; attempt 2 restarted at 0.
    await appendEvents(h.db, runA as RunId, [
      logChunkEventTdm74(runA, trialId, { offset: 0, bytes: 640 }),
      logChunkEventTdm74(runA, trialId, { offset: 640, bytes: 640 }),
      logChunkEventTdm74(runA, trialId, { offset: 1280, bytes: 640 }),
      phaseEventTdm74(runA, trialId, 1),
      logChunkEventTdm74(runA, trialId, { offset: 0, bytes: 640 }),
      // Not this trial's key: a link to elsewhere, and a sibling trial's object.
      logChunkEventTdm74(runA, trialId, { offset: 640, bytes: 640 }, "https://evil.example/x.log"),
      logChunkEventTdm74(
        runA,
        trialId,
        { offset: 1280, bytes: 640 },
        `artifact:${trialArtifactKey(runA, newId(TrialIdSchema), logChunkName("stdout", 1280))}`,
      ),
    ]);
    const res = await get(`/trials/${trialId}/log?bytes=65536`);
    const raw = await res.text();
    expect(raw).not.toContain("evil.example");
    expect(raw).not.toContain("artifact:");
    const body = JSON.parse(raw) as LogBody;
    expect([body.offset, body.next_offset, body.eof]).toEqual([0, 640, false]);
    // Past the first segment nothing valid exists yet (the bad events are ignored).
    const after = (await (await get(`/trials/${trialId}/log?offset=640`)).json()) as LogBody;
    expect([after.offset, after.next_offset, after.text]).toEqual([640, 640, ""]);
    const names = reads.filter((r) => r.trialId === trialId).map((r) => r.name);
    expect(names.every((n) => n === logChunkName("stdout", 0))).toBe(true);
  });

  it("live tail: follows new trial.log_chunk events, resumes by Last-Event-ID, ends when final", async () => {
    const trialId = await seedTrial("running");
    const log = new SyntheticLogTdm74(60, new Map([[30, PLANTED_KEY_TDM74]]));
    const all = chunksTdm74(log.size, 1024);
    const entry = { log, chunks: all.slice(0, 1) };
    logs.set(trialId, entry);
    await announce(trialId, entry.chunks);

    const res = await get(`/trials/${trialId}/log/stream?bytes=512`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const reached = (frames: SseFrame[], n: number) =>
      frames.some((f) => f.id !== undefined && Number(f.id) >= n);

    // While it streams, the next segments are uploaded and announced.
    const more = (async () => {
      await new Promise((r) => setTimeout(r, 300));
      entry.chunks = all;
      await announce(trialId, all.slice(1));
      await new Promise((r) => setTimeout(r, 300));
      await h.db.update(trials).set({ state: "done" }).where(eq(trials.id, trialId));
    })();
    const { frames } = await readFramesTdm74(res, (fs) => fs.some((f) => f.event === "end"));
    await more;
    expect(frames[0]!.retry).toBe(1000);
    const slices = frames
      .filter((f) => f.id !== undefined)
      .map((f) => JSON.parse(f.data) as LogBody);
    expect(slices.length).toBeGreaterThan(2);
    for (let i = 1; i < slices.length; i++)
      expect(slices[i]!.offset).toBe(slices[i - 1]!.next_offset);
    const text = slices.map((s) => s.text).join("");
    expect(text).not.toContain("PLANTED");
    expect(text).toContain("[REDACTED:ANTHROPIC_API_KEY]");
    expect(text.split("\n").length - 1).toBe(60);
    const end = frames.find((f) => f.event === "end")!;
    expect(JSON.parse(end.data)).toEqual({ next_offset: log.size });
    expect(reached(frames, log.size)).toBe(true);

    // Resume from an earlier frame's id: replays from there to the end.
    const mid = slices[1]!.next_offset;
    const again = await get(`/trials/${trialId}/log/stream?bytes=65536`, keyA, {
      "last-event-id": String(mid),
    });
    const resumed = await readFramesTdm74(again, (fs) => fs.some((f) => f.event === "end"));
    const first = resumed.frames.find((f) => f.id !== undefined)!;
    expect((JSON.parse(first.data) as LogBody).offset).toBe(mid);
  }, 60_000);

  it("live tail: a revoked key stops the stream at the next auth re-check", async () => {
    const trialId = await seedTrial("running");
    const log = new SyntheticLogTdm74(10, new Map());
    logs.set(trialId, { log, chunks: chunksTdm74(log.size, 1024) });
    await announce(trialId, chunksTdm74(log.size, 1024));
    const key = await seedApiKeyTdm67(h.db, ownerA, ["logs:read"]);
    const res = await get(`/trials/${trialId}/log/stream`, key);
    expect(res.status).toBe(200);
    const revoke = (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await h.db
        .update(apiKeys)
        .set({ revokedAt: sql`now()` })
        .where(eq(apiKeys.ownerId, ownerA));
    })();
    // Read until the server closes the response (a timeout throws).
    const out = await readFramesTdm74(res, () => false, 10_000);
    await revoke;
    expect(out.closed).toBe(true);
    const err = out.frames.find((f) => f.event === "error")!;
    expect(JSON.parse(err.data)).toMatchObject({ code: "unauthorized" });
    // Restore keyA for later tests (it was revoked with the rest of ownerA's keys).
    keyA = await seedApiKeyTdm67(h.db, ownerA, ["logs:read"]);
  }, 30_000);

  it("is 503 without a log reader", async () => {
    const trialId = await seedTrial("done");
    const bare = createApp({ ...deps, trialLogs: undefined });
    const res = await bare.request(`/trials/${trialId}/log`, {
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(res.status).toBe(503);
  });
});
