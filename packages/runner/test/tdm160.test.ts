// TDM-160: live log chunks, the BYOK token cap and the network probe.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnybenchEventSchema } from "@anybench/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactKeyFromUrl,
  estimateMicroUsd,
  LogChunker,
  logChunkName,
  NetworkProbeResultSchema,
  parseTrialJob,
  probeNetwork,
  probeUrlForHost,
  RUNNER_EXIT,
  RunnerStatusSchema,
  runnerPaths,
  runTrial,
  TokenMeter,
  usdTextToMicroUsd,
  type LogChunkPayload,
  type LogChunksConfig,
  type ProbeFetch,
  type TrialJobInput,
  type UploadedArtifact,
} from "../src/index.js";
import { phaseSequenceTdm46, startMockIngestTdm46, type MockIngest } from "./tdm46-mock-ingest.js";
import { logChunksTdm160, reassembleLogTdm160 } from "./tdm160-reassemble.js";

const SECRET = "sk-tdm160-PlantedSecretValue-9931";
/** A key the env file does not know: caught by the known-shape patterns. */
const PATTERN_KEY = "sk-ant-api03-tdm160PatternKeyAAAABBBBCCCC";
const quiet = () => undefined;

const homes: string[] = [];
let ingest: MockIngest | null = null;
afterEach(async () => {
  await ingest?.close();
  ingest = null;
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

async function setupHomeTdm160(job: Partial<TrialJobInput>, withIngest: MockIngest | null) {
  const home = mkdtempSync(join(tmpdir(), "tdm160-home-"));
  homes.push(home);
  const p = runnerPaths(home);
  await mkdir(p.configDir, { recursive: true });
  await mkdir(p.inDir, { recursive: true });
  await writeFile(p.envFile, `MODEL_KEY=${SECRET}\n`, { mode: 0o600 });
  const full: TrialJobInput = {
    version: 1,
    trial_id: "trial-tdm160",
    run_id: "run-tdm46",
    attempt: 1,
    driver: { type: "cli", run: "echo hello" },
    wall_clock_s: 60,
    heartbeat_s: 1,
    ingest: withIngest
      ? { url: withIngest.url, token: withIngest.token, flush_ms: 100, max_failures: 3 }
      : null,
    ...job,
  };
  await writeFile(p.trialJson, JSON.stringify(full));
  return { home, paths: p };
}

async function readEvents(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((l) => AnybenchEventSchema.parse(JSON.parse(l)));
}

// ------------------------------------------------------------------------------------------------

describe("TrialJob (TDM-160 fields)", () => {
  const base = {
    version: 1,
    trial_id: "t",
    run_id: "r",
    attempt: 1,
    driver: { type: "cli", run: "true" },
    wall_clock_s: 10,
  };

  it("keeps every new field optional", () => {
    const job = parseTrialJob(base);
    expect(job.log_chunks).toBeUndefined();
    expect(job.token_cap_micro_usd).toBeUndefined();
    expect(job.network).toBeUndefined();
  });

  it("fills defaults and reads money as a decimal micro-USD string", () => {
    const job = parseTrialJob({
      ...base,
      log_chunks: {},
      token_cap_micro_usd: "2500000",
      token_prices: { input: "1", output: "2", cache_read: "3", cache_creation: "4" },
      network: { allow: ["api.anthropic.com"] },
    });
    expect(job.log_chunks).toEqual({
      segment_bytes: 262144,
      segment_ms: 5000,
      streams: ["stdout", "stderr"],
      upload_tries: 3,
    });
    expect(job.token_cap_micro_usd).toBe(2_500_000n);
    expect(job.token_prices?.cache_creation).toBe(4n);
    expect(job.network).toEqual({
      allow: ["api.anthropic.com"],
      canary_url: "https://example.com",
      timeout_ms: 5000,
    });
  });

  it("rejects a float cap and a non-http canary", () => {
    expect(() => parseTrialJob({ ...base, token_cap_micro_usd: 1.5 })).toThrow(/token_cap/);
    expect(() => parseTrialJob({ ...base, network: { canary_url: "ftp://x.test" } })).toThrow(
      /canary_url/,
    );
  });
});

// ------------------------------------------------------------------------------------------------

describe("LogChunker", () => {
  const cfg = (over: Partial<LogChunksConfig> = {}): LogChunksConfig => ({
    segment_bytes: 1024,
    segment_ms: 60_000,
    streams: ["stdout"],
    upload_tries: 2,
    ...over,
  });

  function harness(config: LogChunksConfig, fail: (n: number) => boolean | "null" = () => false) {
    const dir = mkdtempSync(join(tmpdir(), "tdm160-chunks-"));
    homes.push(dir);
    const objects = new Map<string, Buffer>();
    const events: LogChunkPayload[] = [];
    const lines: string[] = [];
    let calls = 0;
    const chunker = new LogChunker({
      stream: "stdout",
      config,
      dir,
      retryDelayMs: 1,
      log: (l) => lines.push(l),
      emit: (p) => events.push(p),
      upload: async (name, path): Promise<UploadedArtifact | null> => {
        const f = fail(calls++);
        if (f === "null") return null;
        if (f) throw new Error("PUT 503");
        const body = await readFile(path);
        const key = `runs/r/trials/t/${name}`;
        objects.set(key, body);
        const sha256 = createHash("sha256").update(body).digest("hex");
        return { name, key, sha256, size_bytes: body.length, url: `artifact:${key}` };
      },
    });
    return { chunker, objects, events, lines };
  }

  it("cuts by size, keeps offsets contiguous and reassembles exactly", async () => {
    const h = harness(cfg());
    let all = "";
    for (let i = 0; i < 100; i++) {
      const line = `line ${i} ${"x".repeat(i)}\n`;
      all += line;
      h.chunker.write(line);
    }
    await h.chunker.close();
    expect(h.events.length).toBeGreaterThan(3);
    const asEvents = h.events.map((payload) => ({ type: "trial.log_chunk", payload }));
    expect(reassembleLogTdm160(asEvents, "stdout", h.objects).toString("utf8")).toBe(all);
    // Every segment but the last reached the size threshold; names carry the offset.
    for (const e of h.events.slice(0, -1)) expect(e.bytes).toBeGreaterThanOrEqual(1024);
    expect(artifactKeyFromUrl(h.events[1]!.url)).toBe(
      `runs/r/trials/t/${logChunkName("stdout", h.events[1]!.offset)}`,
    );
    expect(h.chunker.segments).toBe(h.events.length);
  });

  it("cuts by time after the segment's first byte", async () => {
    const h = harness(cfg({ segment_bytes: 1 << 20, segment_ms: 100 }));
    h.chunker.write("first\n");
    await new Promise((r) => setTimeout(r, 400));
    expect(h.events).toHaveLength(1);
    h.chunker.write("second\n");
    await h.chunker.close();
    expect(h.events.map((e) => [e.offset, e.bytes])).toEqual([
      [0, 6],
      [6, 7],
    ]);
  });

  it("retries a failed upload, then turns live chunks off without breaking offsets", async () => {
    // Segment 0: fails once then lands. Segment 1: fails twice → off.
    const h = harness(cfg({ segment_bytes: 1024 }), (n) => n === 0 || n === 2 || n === 3);
    h.chunker.write(`${"a".repeat(1100)}\n`);
    h.chunker.write(`${"b".repeat(1100)}\n`);
    h.chunker.write(`${"c".repeat(1100)}\n`);
    await h.chunker.close();
    expect(h.events.map((e) => e.offset)).toEqual([0]);
    expect(h.chunker.state).toBe("off");
    expect(h.chunker.error).toMatch(/failed 2 times: PUT 503/);
    expect(h.lines.some((l) => l.includes("chunks off"))).toBe(true);
  });

  it("turns off when there is no upload plan (file-only)", async () => {
    const h = harness(cfg(), () => "null");
    h.chunker.write("x".repeat(2000));
    await h.chunker.close();
    expect(h.events).toHaveLength(0);
    expect(h.chunker.error).toMatch(/file-only/);
  });
});

// ------------------------------------------------------------------------------------------------

describe("token meter", () => {
  it("converts USD number text to micro-USD with bigint math, rounding up", () => {
    expect(usdTextToMicroUsd("0")).toBe(0n);
    expect(usdTextToMicroUsd("2")).toBe(2_000_000n);
    expect(usdTextToMicroUsd("0.1234565")).toBe(123_457n);
    expect(usdTextToMicroUsd("0.000001")).toBe(1n);
    expect(usdTextToMicroUsd("1.5e-3")).toBe(1_500n);
    expect(usdTextToMicroUsd("3E2")).toBe(300_000_000n);
    expect(usdTextToMicroUsd("abc")).toBeNull();
  });

  it("estimates from usage once per message id and prefers a larger reported cost", () => {
    const fired: bigint[] = [];
    const meter = new TokenMeter(10_000_000n, undefined, (s) => fired.push(s.spent_micro_usd));
    const msg = (id: string, input: number, output: number) =>
      JSON.stringify({
        type: "assistant",
        message: { id, usage: { input_tokens: input, output_tokens: output } },
      });
    meter.line(msg("m1", 1000, 100));
    meter.line(msg("m1", 1000, 100)); // same message, another content block
    meter.line(msg("m2", 2000, 0));
    meter.line("not json");
    meter.line('{"type":"user","message":{"content":"hi"}}');
    // 3000 in × $3/M + 100 out × $15/M = 9000 + 1500 micro-USD
    expect(meter.snapshot()).toMatchObject({
      spent_micro_usd: 10_500n,
      source: "estimate",
      messages: 2,
      tokens: { input: 3000, output: 100 },
    });
    meter.line('{"type":"result","subtype":"success","total_cost_usd":0.25,"num_turns":2}');
    expect(meter.snapshot()).toMatchObject({ spent_micro_usd: 250_000n, source: "reported" });
    expect(fired).toEqual([]);
    meter.line('{"type":"result","subtype":"success","total_cost_usd":10}');
    meter.line('{"type":"result","subtype":"success","total_cost_usd":10}');
    expect(fired).toEqual([10_250_000n]);
    expect(meter.snapshot().exceeded).toBe(true);
  });

  it("prices every token class", () => {
    expect(
      estimateMicroUsd(
        { input: 1_000_000, output: 1_000_000, cache_read: 1_000_000, cache_creation: 1 },
        { input: 1n, output: 2n, cache_read: 3n, cache_creation: 1_000_000n },
      ),
    ).toBe(7n);
  });
});

// ------------------------------------------------------------------------------------------------

describe("network probe", () => {
  it("HEADs each allowed host and the canary, any HTTP status counts as reachable", async () => {
    const seen: { url: string; method: string | undefined }[] = [];
    const f: ProbeFetch = async (url, init) => {
      seen.push({ url, method: init.method });
      if (url.startsWith("https://api.ok.test")) return new Response(null, { status: 403 });
      if (url.startsWith("https://foo.test")) return new Response(null, { status: 200 });
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    };
    const r = await probeNetwork(
      {
        allow: ["api.ok.test", "*.foo.test", "down.test:8443"],
        canary_url: "https://canary.test",
        timeout_ms: 1000,
      },
      { fetch: f },
    );
    expect(NetworkProbeResultSchema.parse(r)).toMatchObject({
      allowed: { "api.ok.test": "ok", "*.foo.test": "ok", "down.test:8443": "failed" },
      canary: "blocked",
      canary_url: "https://canary.test",
    });
    expect(r.details.allowed["api.ok.test"]?.http_status).toBe(403);
    expect(r.details.canary.error).toContain("ENOTFOUND");
    expect(seen.every((s) => s.method === "HEAD")).toBe(true);
    expect(seen.map((s) => s.url).sort()).toEqual([
      "https://api.ok.test/",
      "https://canary.test",
      "https://down.test:8443/",
      "https://foo.test/",
    ]);
    expect(probeUrlForHost("*.x.example")).toBe("https://x.example/");
  });

  it("gives each target its own timeout", async () => {
    const hang: ProbeFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      });
    const t0 = Date.now();
    const r = await probeNetwork(
      { allow: ["a.test", "b.test"], canary_url: "https://c.test", timeout_ms: 200 },
      { fetch: hang },
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.canary).toBe("blocked");
    expect(r.allowed).toEqual({ "a.test": "failed", "b.test": "failed" });
    expect(r.details.canary.error).toMatch(/timeout after 200 ms/);
  });
});

// ------------------------------------------------------------------------------------------------

describe("runTrial with TDM-160 features", () => {
  it("streams redacted log chunks the ingest can reassemble into the exact stdout.log", async () => {
    ingest = await startMockIngestTdm46();
    // ~700 KB of stdout with two planted keys in the middle, a pause (time cut) and some stderr.
    const run = [
      `awk 'BEGIN { for (i = 0; i < 6000; i++) printf "row %d %0100d\\n", i, i }'`,
      'echo "planted env key=$MODEL_KEY"',
      `echo "planted pattern key=${PATTERN_KEY}"`,
      "sleep 1",
      "echo tail-line",
      'echo "stderr key=$MODEL_KEY" >&2',
    ].join("; ");
    const { home, paths } = await setupHomeTdm160(
      {
        driver: { type: "cli", run },
        log_chunks: { segment_bytes: 64 * 1024, segment_ms: 300 },
      },
      ingest,
    );
    const r = await runTrial({ trialId: "trial-tdm160", home, log: quiet, stealWindowMs: 10 });
    expect(r.exitCode).toBe(RUNNER_EXIT.ok);

    const pushed = ingest.batches.flatMap((b) => b.events);
    const stdoutLog = await readFile(paths.stdoutLog);
    const stderrLog = await readFile(paths.stderrLog);
    expect(stdoutLog.length).toBeGreaterThan(600_000);
    expect(reassembleLogTdm160(pushed, "stdout", ingest.objects).equals(stdoutLog)).toBe(true);
    expect(reassembleLogTdm160(pushed, "stderr", ingest.objects).equals(stderrLog)).toBe(true);
    const chunks = logChunksTdm160(pushed, "stdout");
    expect(chunks.length).toBeGreaterThanOrEqual(10);
    // The 1 s pause lets the 300 ms timer cut a short segment holding just the tail.
    expect(chunks.at(-1)!.bytes).toBeLessThan(64 * 1024);

    // Redaction ran on every line before chunking.
    expect(stdoutLog.toString()).toContain("planted env key=[REDACTED:MODEL_KEY]");
    expect(stdoutLog.toString()).toContain("planted pattern key=[REDACTED:ANTHROPIC_API_KEY]");
    for (const [key, body] of ingest.objects) {
      if (!key.includes("/logs/")) continue;
      expect(body.includes(SECRET)).toBe(false);
      expect(body.includes(PATTERN_KEY)).toBe(false);
    }
    for (const raw of ingest.rawBodies) expect(raw).not.toContain(SECRET);

    // Each segment went through plan → PUT → complete.
    const segmentPlans = ingest.planRequests.filter((p) => p.name.startsWith("logs/"));
    expect(segmentPlans).toHaveLength(
      logChunksTdm160(pushed, "stdout").length + logChunksTdm160(pushed, "stderr").length,
    );
    expect(ingest.completions.filter((c) => c.name.startsWith("logs/"))).toHaveLength(
      segmentPlans.length,
    );

    // events.jsonl holds the same chunk events, in seq order, before the bundle froze them.
    const fileEvents = await readEvents(paths.eventsJsonl);
    expect(fileEvents.filter((e) => e.type === "trial.log_chunk")).toHaveLength(
      pushed.filter((e) => e.type === "trial.log_chunk").length,
    );
    const status = RunnerStatusSchema.parse(JSON.parse(await readFile(paths.statusJson, "utf8")));
    expect(status.log_chunks?.stdout).toMatchObject({ state: "live", bytes: stdoutLog.length });
  }, 60_000);

  it("stops a coding-agent trial whose stream-json crosses the token cap", async () => {
    ingest = await startMockIngestTdm46();
    // A stand-in for `claude -p --output-format stream-json`: each message costs $0.45 at the
    // default prices (100k in, 10k out), so a $1.00 cap is crossed on the third.
    const run = [
      "i=1; while [ $i -le 20 ]; do",
      `printf '{"type":"assistant","message":{"id":"msg_%s","usage":{"input_tokens":100000,"output_tokens":10000}}}\\n' $i;`,
      "sleep 0.3; i=$((i+1)); done;",
      `echo '{"type":"result","subtype":"success","total_cost_usd":9.0}'; echo never`,
    ].join(" ");
    const { home, paths } = await setupHomeTdm160(
      {
        driver: { type: "coding-agent", run },
        token_cap_micro_usd: "1000000",
      },
      ingest,
    );
    const t0 = Date.now();
    const r = await runTrial({ trialId: "trial-tdm160", home, log: quiet, stealWindowMs: 10 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.exitCode).toBe(RUNNER_EXIT.failed_subject);
    const status = RunnerStatusSchema.parse(JSON.parse(await readFile(paths.statusJson, "utf8")));
    expect(status.result).toMatchObject({ outcome: "failed_subject", failure_class: "budget" });
    expect(status.result?.reason).toMatch(/token cap exceeded during run: spent \$1\.35/);
    expect(status.token_cap).toMatchObject({
      cap_micro_usd: "1000000",
      spent_micro_usd: "1350000",
      exceeded: true,
    });
    const stdout = await readFile(paths.stdoutLog, "utf8");
    expect(stdout).toContain("msg_3");
    expect(stdout).not.toContain("msg_6");
    expect(stdout).not.toContain("never");

    const pushed = ingest.batches.flatMap((b) => b.events);
    expect(phaseSequenceTdm46(pushed)).toEqual([
      "installing→warming",
      "warming→running",
      "running→failed_subject",
    ]);
    const edge = pushed.filter((e) => e.type === "trial.phase").at(-1)!;
    expect(edge.payload).toMatchObject({ failure_class: "budget" });
    expect((edge.payload as { reason: string }).reason).toMatch(/token cap/);
    // Evidence still frozen and uploaded.
    expect(status.upload?.state).toBe("uploaded");
  }, 30_000);

  it("probes the network before run, writes network.json into the bundle and emits it", async () => {
    ingest = await startMockIngestTdm46();
    const probeFetch: ProbeFetch = async (url) => {
      if (url.startsWith("https://api.anthropic.com")) return new Response(null, { status: 404 });
      throw new TypeError("fetch failed");
    };
    const { home, paths } = await setupHomeTdm160(
      {
        driver: { type: "cli", run: 'test -f "$EVAL_OUT/network.json" && echo saw-network-json' },
        network: { allow: ["api.anthropic.com", "registry.npmjs.org"] },
      },
      ingest,
    );
    const r = await runTrial({
      trialId: "trial-tdm160",
      home,
      log: quiet,
      stealWindowMs: 10,
      probeFetch,
    });
    expect(r.exitCode).toBe(RUNNER_EXIT.ok);
    expect(await readFile(paths.stdoutLog, "utf8")).toContain("saw-network-json");
    const net = NetworkProbeResultSchema.parse(
      JSON.parse(await readFile(paths.networkJson, "utf8")),
    );
    expect(net).toMatchObject({
      allowed: { "api.anthropic.com": "ok", "registry.npmjs.org": "failed" },
      canary: "blocked",
      canary_url: "https://example.com",
    });
    const listing = execFileSync("tar", ["-tzf", paths.bundle], { encoding: "utf8" });
    expect(listing.split("\n")).toContain("network.json");

    const pushed = ingest.batches.flatMap((b) => b.events);
    const ev = pushed.find((e) => e.type === "trial.network");
    expect(ev?.payload).toEqual({
      allowed: { "api.anthropic.com": "ok", "registry.npmjs.org": "failed" },
      canary: "blocked",
      canary_url: "https://example.com",
    });
    expect(ev?.severity).toBe("warn");
    // Emitted before run: it precedes the warming → running edge's successor.
    const idx = pushed.findIndex((e) => e.type === "trial.network");
    const running = pushed.findIndex(
      (e) => e.type === "trial.phase" && (e.payload as { to: string }).to === "collecting",
    );
    expect(idx).toBeLessThan(running);
  }, 30_000);

  it("leaves live chunks off without an ingest, and the trial still passes", async () => {
    const lines: string[] = [];
    const { home } = await setupHomeTdm160({ log_chunks: {} }, null);
    const r = await runTrial({
      trialId: "trial-tdm160",
      home,
      log: (l) => lines.push(l),
      stealWindowMs: 10,
    });
    expect(r.exitCode).toBe(RUNNER_EXIT.ok);
    expect(lines.some((l) => l.includes("log_chunks needs ingest"))).toBe(true);
  }, 30_000);
});
