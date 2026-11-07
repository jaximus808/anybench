// docker-local end-to-end for the compiled runner (TDM-46 done condition). Opt-in:
//   pnpm -r build && pnpm --filter @anybench/runner build:bin && pnpm --filter @anybench/runner test:docker
//
// A plain debian container (no Node) gets the bun-compiled binary at ~/.anybench/bin/runner for a
// non-root user whose HOME is not /home/naive. One `docker exec` launches it with
// `setsid nohup ... &` and returns; later execs see it still running, then finished. A mock ingest
// on the host receives the event batches and the bundle upload.
//
// TDM-160 adds two trials in the same container: 5 MB of output streamed as live log chunks
// (reassembled byte-exact on the mock ingest, planted keys redacted) with the network probe, and a
// fake coding agent whose stream-json crosses the BYOK token cap.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NetworkProbeResultSchema,
  RunnerStatusSchema,
  type RunnerStatus,
  type TrialJobInput,
} from "../src/index.js";
import { phaseSequenceTdm46, startMockIngestTdm46, type MockIngest } from "./tdm46-mock-ingest.js";
import { logChunksTdm160, reassembleLogTdm160 } from "./tdm160-reassemble.js";

const enabled = process.env.RUNNER_DOCKER_E2E === "1";
const IMAGE = process.env.RUNNER_DOCKER_IMAGE ?? "debian:bookworm-slim";
const BIN = join(
  import.meta.dirname,
  "..",
  "dist",
  "bin",
  `runner-linux-${arch() === "arm64" ? "arm64" : "x64"}`,
);
const NAME = `anybench-runner-tdm46-${process.pid}`;
const USER = "evaluser";
const HOME = `/home/${USER}`;
const GOLDEN_OK = ["installing→warming", "warming→running", "running→collecting"];

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
}
const sh = (cmd: string, input?: string) =>
  docker(["exec", "-i", "-u", USER, NAME, "sh", "-c", cmd], input);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Raw bytes of a file in the container (big: 5 MB logs). */
const catBytes = (path: string): Buffer =>
  execFileSync("docker", ["exec", "-u", USER, NAME, "cat", path], {
    maxBuffer: 256 * 1024 * 1024,
  });

/** Launch the runner detached and poll status.json until it reaches a final phase. */
async function launchAndWaitTdm160(trialId: string, maxMs = 120_000): Promise<RunnerStatus> {
  sh(`setsid nohup ~/.anybench/bin/runner --trial ${trialId} >> ~/eval/runner.log 2>&1 &`);
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await sleep(500);
    let s: RunnerStatus;
    try {
      s = RunnerStatusSchema.parse(JSON.parse(sh("cat ~/eval/out/status.json")));
    } catch {
      continue; // not written yet for this attempt
    }
    if (s.trial_id !== trialId) continue;
    if (s.phase === "done" || s.phase === "failed" || s.phase === "cancelled") {
      // `done`/`failed` is written before the last flush; wait for the process to exit.
      for (let i = 0; i < 60; i++) {
        if (sh(`kill -0 ${s.pid} 2>/dev/null && echo alive || echo gone`).trim() === "gone") break;
        await sleep(500);
      }
      return s;
    }
  }
  throw new Error(`${trialId} did not finish in ${maxMs} ms`);
}

describe.skipIf(!enabled)("runner on docker-local", () => {
  let ingest: MockIngest;

  beforeAll(async () => {
    if (!existsSync(BIN)) throw new Error(`${BIN} missing: run pnpm build:bin first`);
    ingest = await startMockIngestTdm46({ host: "0.0.0.0", publicHost: "host.docker.internal" });
    docker(["rm", "-f", NAME]);
    docker([
      "run",
      "-d",
      // A real VM's init reaps the orphaned runner; without one it would linger as a zombie.
      "--init",
      "--name",
      NAME,
      "--add-host",
      "host.docker.internal:host-gateway",
      IMAGE,
      "sleep",
      "infinity",
    ]);
    docker(["exec", NAME, "useradd", "-m", "-d", HOME, USER]);
    sh("mkdir -p ~/.anybench/bin ~/eval/in");
    docker(["cp", BIN, `${NAME}:${HOME}/.anybench/bin/runner`]);
    docker(["exec", NAME, "chown", "-R", `${USER}:${USER}`, `${HOME}/.anybench`]);
  }, 120_000);

  afterAll(async () => {
    if (!enabled) return;
    try {
      docker(["rm", "-f", NAME]);
    } catch {
      // already gone
    }
    await ingest?.close();
  });

  it("survives its launching exec and completes a cli trial with the golden event stream", async () => {
    const job: TrialJobInput = {
      version: 1,
      trial_id: "trial-docker-1",
      run_id: "run-tdm46",
      attempt: 1,
      driver: {
        type: "cli",
        // sleep keeps the run going well past the launching exec.
        run: 'sleep 4 && sort "$1/words.txt" > "$2/sorted.txt" && echo "key=$MODEL_KEY"',
      },
      warmup_runs: 1,
      wall_clock_s: 60,
      heartbeat_s: 1,
      ingest: { url: ingest.url, token: ingest.token, flush_ms: 200 },
    };
    sh("cat > ~/.anybench/trial.json", JSON.stringify(job));
    sh("umask 077 && cat > ~/.anybench/env", "MODEL_KEY=sk-docker-e2e-secret-value-77\n");
    sh("cat > ~/eval/in/words.txt", "delta\nalpha\ncharlie\nbravo\n");

    const t0 = Date.now();
    sh("setsid nohup ~/.anybench/bin/runner --trial trial-docker-1 >> ~/eval/runner.log 2>&1 &");
    const launchMs = Date.now() - t0;
    expect(launchMs).toBeLessThan(5000);

    // Later execs: still running...
    await sleep(2500);
    const mid = RunnerStatusSchema.parse(JSON.parse(sh("cat ~/eval/out/status.json")));
    expect(["warmup", "run"]).toContain(mid.phase);
    expect(sh(`kill -0 ${mid.pid} && echo alive`).trim()).toBe("alive");

    // ...then finished.
    let status: RunnerStatus | null = null;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const s = RunnerStatusSchema.parse(JSON.parse(sh("cat ~/eval/out/status.json")));
      if (s.phase === "done" || s.phase === "failed" || s.phase === "cancelled") {
        status = s;
        break;
      }
    }
    expect(status?.phase).toBe("done");
    // `done` is written before the last flush; the process exits right after it.
    let alive = "alive";
    for (let i = 0; i < 30 && alive === "alive"; i++) {
      await sleep(500);
      alive = sh(`kill -0 ${status!.pid} 2>/dev/null && echo alive || echo gone`).trim();
    }
    expect(alive).toBe("gone");
    expect(sh("cat ~/eval/out/sorted.txt")).toBe("alpha\nbravo\ncharlie\ndelta\n");
    expect(sh("cat ~/eval/out/stdout.log")).toContain("key=[REDACTED:MODEL_KEY]");
    expect(sh("cat ~/eval/out/machine.json")).toContain('"nproc"');

    const pushed = ingest.batches.flatMap((b) => b.events);
    expect(phaseSequenceTdm46(pushed)).toEqual(GOLDEN_OK);
    expect(pushed.filter((e) => e.type === "trial.heartbeat").length).toBeGreaterThanOrEqual(4);
    expect(ingest.batches.at(-1)?.status?.phase).toBe("done");
    for (const raw of ingest.rawBodies) expect(raw).not.toContain("sk-docker-e2e-secret-value-77");
    expect(ingest.objects.has("runs/run-tdm46/trials/trial-docker-1/out.tar.gz")).toBe(true);
    expect(status?.upload?.state).toBe("uploaded");

    console.log(
      JSON.stringify(
        {
          launch_exec_ms: launchMs,
          mid_phase: mid.phase,
          final: { phase: status?.phase, push: status?.push, events: status?.events },
          golden: phaseSequenceTdm46(pushed),
          batches: ingest.batches.length,
          runner_log: sh("cat ~/eval/runner.log"),
        },
        null,
        2,
      ),
    );
  }, 120_000);
  it("streams 5 MB of output as ordered, redacted live log chunks and probes the network (TDM-160)", async () => {
    const trialId = "trial-docker-chunks";
    const planted = "sk-ant-api03-tdm160DockerPatternKeyZZZZ";
    const run = [
      "head -c 1950000 /dev/urandom | base64 -w 100",
      'echo "planted env key=$MODEL_KEY"',
      `echo "planted pattern key=${planted}"`,
      "head -c 1950000 /dev/urandom | base64 -w 100",
      "sleep 6",
      "echo tail-after-pause",
    ].join("; ");
    const job: TrialJobInput = {
      version: 1,
      trial_id: trialId,
      run_id: "run-tdm46",
      attempt: 1,
      driver: { type: "cli", run },
      wall_clock_s: 120,
      heartbeat_s: 1,
      ingest: { url: ingest.url, token: ingest.token, flush_ms: 200 },
      log_chunks: {},
      network: { allow: ["example.org", "registry.npmjs.org"] },
    };
    sh("cat > ~/.anybench/trial.json", JSON.stringify(job));
    sh("umask 077 && cat > ~/.anybench/env", "MODEL_KEY=sk-docker-e2e-secret-value-77\n");

    const status = await launchAndWaitTdm160(trialId);
    expect(status.phase).toBe("done");

    const pushed = ingest.batches.filter((b) => b.trial_id === trialId).flatMap((b) => b.events);
    const stdoutLog = catBytes(`${HOME}/eval/out/stdout.log`);
    expect(stdoutLog.length).toBeGreaterThan(5_000_000);
    const rebuilt = reassembleLogTdm160(pushed, "stdout", ingest.objects);
    expect(rebuilt.equals(stdoutLog)).toBe(true);

    const chunks = logChunksTdm160(pushed, "stdout");
    // 256 KB segments: at least 19 full ones, then the 6 s pause makes the timer cut the rest.
    expect(chunks.length).toBeGreaterThanOrEqual(20);
    for (const c of chunks.slice(0, -2)) expect(c.bytes).toBeGreaterThanOrEqual(256 * 1024);
    const last = chunks.at(-1)!;
    expect(last.bytes).toBeLessThan(1024);
    // Event order = offset order.
    expect(chunks.map((c) => c.offset)).toEqual(
      [...chunks.map((c) => c.offset)].sort((a, b) => a - b),
    );

    const text = stdoutLog.toString("utf8");
    expect(text).toContain("planted env key=[REDACTED:MODEL_KEY]");
    expect(text).toContain("planted pattern key=[REDACTED:ANTHROPIC_API_KEY]");
    for (const [key, body] of ingest.objects) {
      if (!key.includes(`/${trialId}/`)) continue;
      expect(body.includes("sk-docker-e2e-secret-value-77")).toBe(false);
      expect(body.includes(planted)).toBe(false);
    }

    // Network probe: network.json is in the frozen bundle and went out as a trial.network event.
    const net = NetworkProbeResultSchema.parse(JSON.parse(sh("cat ~/eval/out/network.json")));
    expect(Object.keys(net.allowed).sort()).toEqual(["example.org", "registry.npmjs.org"]);
    expect(["blocked", "reachable"]).toContain(net.canary);
    expect(sh("tar -tzf ~/eval/out.tar.gz").split("\n")).toContain("network.json");
    const netEvent = pushed.find((e) => e.type === "trial.network");
    expect(netEvent?.payload).toEqual({
      allowed: net.allowed,
      canary: net.canary,
      canary_url: "https://example.com",
    });

    console.log(
      JSON.stringify(
        {
          stdout_bytes: stdoutLog.length,
          chunks: chunks.length,
          first: chunks[0],
          last,
          log_chunks_status: status.log_chunks,
          network: net,
        },
        null,
        2,
      ),
    );
  }, 180_000);

  it("stops a coding-agent trial whose stream-json crosses token_cap_micro_usd (TDM-160)", async () => {
    const trialId = "trial-docker-budget";
    const run = [
      "i=1; while [ $i -le 30 ]; do",
      `printf '{"type":"assistant","message":{"id":"msg_%s","usage":{"input_tokens":100000,"output_tokens":10000}}}\\n' $i;`,
      "sleep 0.5; i=$((i+1)); done;",
      `echo '{"type":"result","subtype":"success","total_cost_usd":9.0}'; echo never`,
    ].join(" ");
    const job: TrialJobInput = {
      version: 1,
      trial_id: trialId,
      run_id: "run-tdm46",
      attempt: 1,
      driver: { type: "coding-agent", run },
      wall_clock_s: 120,
      heartbeat_s: 1,
      ingest: { url: ingest.url, token: ingest.token, flush_ms: 200 },
      token_cap_micro_usd: "1000000",
    };
    sh("cat > ~/.anybench/trial.json", JSON.stringify(job));
    const t0 = Date.now();
    const status = await launchAndWaitTdm160(trialId);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(30_000);
    expect(status.phase).toBe("failed");
    expect(status.result).toMatchObject({ outcome: "failed_subject", failure_class: "budget" });
    expect(status.token_cap).toMatchObject({ spent_micro_usd: "1350000", exceeded: true });
    expect(sh("cat ~/eval/out/stdout.log")).not.toContain("never");

    const pushed = ingest.batches.filter((b) => b.trial_id === trialId).flatMap((b) => b.events);
    expect(phaseSequenceTdm46(pushed)).toEqual([
      "installing→warming",
      "warming→running",
      "running→failed_subject",
    ]);
    const edge = pushed.filter((e) => e.type === "trial.phase").at(-1)!;
    expect(edge.payload).toMatchObject({ failure_class: "budget" });
    console.log(
      JSON.stringify(
        { budget_ms: ms, result: status.result, token_cap: status.token_cap },
        null,
        2,
      ),
    );
  }, 120_000);
});
