// docker-local end-to-end for the compiled runner (TDM-46 done condition). Opt-in:
//   pnpm -r build && pnpm --filter @anybench/runner build:bin && pnpm --filter @anybench/runner test:docker
//
// A plain debian container (no Node) gets the bun-compiled binary at ~/.anybench/bin/runner for a
// non-root user whose HOME is not /home/naive. One `docker exec` launches it with
// `setsid nohup ... &` and returns; later execs see it still running, then finished. A mock ingest
// on the host receives the event batches and the bundle upload.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunnerStatusSchema, type RunnerStatus, type TrialJobInput } from "../src/index.js";
import { phaseSequenceTdm46, startMockIngestTdm46, type MockIngest } from "./tdm46-mock-ingest.js";

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
});
