import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnybenchEventSchema } from "@anybench/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUNNER_EXIT,
  RunnerStatusSchema,
  runnerPaths,
  runTrial,
  type TrialJobInput,
} from "../src/index.js";
import { phaseSequenceTdm46, startMockIngestTdm46, type MockIngest } from "./tdm46-mock-ingest.js";

const SECRET = "sk-tdm46-SuperSecretValue-0042";
const UNSORTED = "pear\napple\nzebra\nmango\nbanana\n";

/** The golden trial.phase sequence for a successful trial. */
export const GOLDEN_OK = ["installing→warming", "warming→running", "running→collecting"];

const homes: string[] = [];
let ingest: MockIngest | null = null;

afterEach(async () => {
  await ingest?.close();
  ingest = null;
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

async function setupHome(job: Partial<TrialJobInput> = {}, withIngest: MockIngest | null = null) {
  const home = mkdtempSync(join(tmpdir(), "tdm46-home-"));
  homes.push(home);
  const p = runnerPaths(home);
  await mkdir(p.configDir, { recursive: true });
  await mkdir(p.inDir, { recursive: true });
  await writeFile(join(p.inDir, "input.txt"), UNSORTED);
  await writeFile(p.envFile, `# secrets\nexport SECRET_KEY="${SECRET}"\nOTHER='plain value'\n`, {
    mode: 0o600,
  });
  const full: TrialJobInput = {
    version: 1,
    trial_id: "trial-tdm46",
    run_id: "run-tdm46",
    attempt: 1,
    driver: {
      type: "cli",
      start: 'mkdir -p "$EVAL_WS/logs" && echo started > "$EVAL_WS/logs/start.log"',
      run: 'sort "$1/input.txt" > "$2/output.txt" && echo "using key $SECRET_KEY" && echo "phase=$EVAL_PHASE other=$OTHER"',
      stop: 'echo stopped >> "$EVAL_WS/logs/start.log"',
    },
    warmup_runs: 1,
    wall_clock_s: 30,
    heartbeat_s: 1,
    collect: ["logs/*.log"],
    ingest: withIngest
      ? { url: withIngest.url, token: withIngest.token, flush_ms: 100, max_failures: 2 }
      : null,
    ...job,
  };
  await writeFile(p.trialJson, JSON.stringify(full));
  return { home, paths: p };
}

async function readEvents(path: string) {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .map((l) => AnybenchEventSchema.parse(JSON.parse(l)));
}

const quiet = () => undefined;

describe("runTrial (cli trial: sort a fixture)", () => {
  it("runs every phase, pushes the golden event sequence and uploads the frozen bundle", async () => {
    ingest = await startMockIngestTdm46();
    const { home, paths } = await setupHome({}, ingest);
    const r = await runTrial({ trialId: "trial-tdm46", home, log: quiet, stealWindowMs: 10 });
    expect(r.exitCode).toBe(RUNNER_EXIT.ok);

    const status = RunnerStatusSchema.parse(JSON.parse(await readFile(paths.statusJson, "utf8")));
    expect(status.phase).toBe("done");
    expect(status.result?.outcome).toBe("ok");
    expect(status.phases.map((p) => p.phase)).toEqual([
      "prepare",
      "healthcheck",
      "warmup",
      "run",
      "collect",
      "freeze",
      "upload",
      "done",
    ]);
    expect(status.push.mode).toBe("push");
    expect(status.run?.exit_code).toBe(0);

    // The workload ran and the collectors picked up its files.
    expect(await readFile(join(paths.outDir, "output.txt"), "utf8")).toBe(
      "apple\nbanana\nmango\npear\nzebra\n",
    );
    expect(await readFile(join(paths.artifactsDir, "logs/start.log"), "utf8")).toBe(
      "started\nstopped\n",
    );
    const machine = JSON.parse(await readFile(paths.machineJson, "utf8")) as Record<
      string,
      unknown
    >;
    expect(machine).toMatchObject({
      runner_version: expect.any(String),
      nproc: expect.any(Number),
    });
    expect(machine).toHaveProperty("load_1m");
    expect(machine).toHaveProperty("steal_pct");

    // Secrets reach the driver but never a file the runner writes.
    const stdout = await readFile(paths.stdoutLog, "utf8");
    expect(stdout).toContain("[run] using key [REDACTED:SECRET_KEY]");
    expect(stdout).toContain("[warmup 0] phase=warmup other=[REDACTED:OTHER]");
    for (const f of await readdir(paths.outDir, { recursive: true })) {
      const text = await readFile(join(paths.outDir, f)).catch(() => Buffer.alloc(0));
      expect(text.includes(SECRET)).toBe(false);
      expect(text.includes(ingest.token)).toBe(false);
    }

    // events.jsonl and the pushed batches carry the same, golden, sequence.
    const fileEvents = await readEvents(paths.eventsJsonl);
    expect(phaseSequenceTdm46(fileEvents)).toEqual(GOLDEN_OK);
    expect(fileEvents.map((e) => e.seq)).toEqual(fileEvents.map((_, i) => i));
    expect(fileEvents.filter((e) => e.type === "trial.heartbeat").length).toBeGreaterThanOrEqual(2);
    expect(fileEvents.at(-1)?.type).toBe("trial.heartbeat");
    expect(
      fileEvents.every((e) => e.actor.kind === "runner" && e.source_id === "trial-tdm46"),
    ).toBe(true);

    const pushed = ingest.batches.flatMap((b) => b.events);
    expect(pushed.map((e) => e.seq)).toEqual(fileEvents.map((e) => e.seq));
    expect(phaseSequenceTdm46(pushed)).toEqual(GOLDEN_OK);
    expect(ingest.batches.map((b) => b.batch_seq)).toEqual(ingest.batches.map((_, i) => i));
    expect(ingest.batches.at(-1)?.status?.phase).toBe("done");
    for (const raw of ingest.rawBodies) {
      expect(raw).not.toContain(SECRET);
      expect(raw).not.toContain(ingest.token);
    }

    // Upload: plan requested with the bundle's sha256, bytes PUT, completion reported.
    expect(ingest.planRequests).toHaveLength(1);
    const bundle = await readFile(paths.bundle);
    const sha = createHash("sha256").update(bundle).digest("hex");
    expect(ingest.planRequests[0]).toMatchObject({ name: "out.tar.gz", sha256: sha });
    const key = "runs/run-tdm46/trials/trial-tdm46/out.tar.gz";
    expect(ingest.objects.get(key)?.equals(bundle)).toBe(true);
    expect(ingest.completions[0]).toMatchObject({ key, sha256: sha });
    expect(status.upload).toMatchObject({ state: "uploaded", artifacts: [{ key, sha256: sha }] });

    // The bundle is a valid tar.gz holding the outputs and the manifest.
    const listing = execFileSync("tar", ["-tzf", paths.bundle], { encoding: "utf8" });
    for (const f of ["output.txt", "machine.json", "manifest.json", "artifacts/logs/start.log"]) {
      expect(listing.split("\n")).toContain(f);
    }

    // A second launch for the same attempt does nothing.
    const again = await runTrial({ trialId: "trial-tdm46", home, log: quiet });
    expect(again.exitCode).toBe(RUNNER_EXIT.ok);
    expect(again.message).toMatch(/already finished/);
    expect((await readEvents(paths.eventsJsonl)).length).toBe(fileEvents.length);
  }, 30_000);

  it("falls back to file-only when the ingest keeps failing", async () => {
    ingest = await startMockIngestTdm46({ mode: "fail500" });
    const { home, paths } = await setupHome({ warmup_runs: 0 }, ingest);
    const lines: string[] = [];
    const r = await runTrial({
      trialId: "trial-tdm46",
      home,
      log: (l) => lines.push(l),
      stealWindowMs: 10,
    });
    expect(r.exitCode).toBe(RUNNER_EXIT.ok);
    const status = RunnerStatusSchema.parse(JSON.parse(await readFile(paths.statusJson, "utf8")));
    expect(status.phase).toBe("done");
    expect(status.push.mode).toBe("file_only");
    expect(status.push.failed_posts).toBeGreaterThanOrEqual(2);
    // Either never tried (already file-only) or tried and refused: never uploaded.
    expect(["skipped", "failed"]).toContain(status.upload?.state);
    expect(phaseSequenceTdm46(await readEvents(paths.eventsJsonl))).toEqual(GOLDEN_OK);
    expect(lines.some((l) => l.includes("file-only"))).toBe(true);
    expect(ingest.batches).toHaveLength(0);
  }, 30_000);

  it("goes file-only at once when the token is rejected", async () => {
    ingest = await startMockIngestTdm46({ mode: "unauthorized" });
    const { home, paths } = await setupHome({ warmup_runs: 0 }, ingest);
    const r = await runTrial({ trialId: "trial-tdm46", home, log: quiet, stealWindowMs: 10 });
    expect(r.exitCode).toBe(RUNNER_EXIT.ok);
    const status = RunnerStatusSchema.parse(JSON.parse(await readFile(paths.statusJson, "utf8")));
    expect(status.push).toMatchObject({ mode: "file_only", failed_posts: 1 });
    expect(status.push.last_error).toContain("401");
  }, 30_000);

  it("kills a run that overruns the wall-clock cap and fails it as the subject's fault", async () => {
    const { home, paths } = await setupHome({
      warmup_runs: 0,
      wall_clock_s: 1,
      driver: { type: "cli", run: "echo begin; sleep 30; echo never" },
    });
    const t0 = Date.now();
    const r = await runTrial({ trialId: "trial-tdm46", home, log: quiet, stealWindowMs: 10 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.exitCode).toBe(RUNNER_EXIT.failed_subject);
    const status = RunnerStatusSchema.parse(JSON.parse(await readFile(paths.statusJson, "utf8")));
    expect(status.phase).toBe("failed");
    expect(status.result).toMatchObject({
      outcome: "failed_subject",
      failure_class: "wall_clock_exceeded",
    });
    expect(status.run?.timed_out).toBe(true);
    // Evidence is still frozen: collect/freeze/upload ran before the failure was reported.
    expect(status.phases.map((p) => p.phase)).toContain("freeze");
    expect(await readFile(paths.stdoutLog, "utf8")).not.toContain("never");
    expect(phaseSequenceTdm46(await readEvents(paths.eventsJsonl))).toEqual([
      "installing→warming",
      "warming→running",
      "running→failed_subject",
    ]);
  }, 30_000);

  it("reports a failing health check from installing", async () => {
    const { home, paths } = await setupHome({ healthcheck: "exit 3" });
    const r = await runTrial({ trialId: "trial-tdm46", home, log: quiet, stealWindowMs: 10 });
    expect(r.exitCode).toBe(RUNNER_EXIT.failed_subject);
    expect(phaseSequenceTdm46(await readEvents(paths.eventsJsonl))).toEqual([
      "installing→failed_subject",
    ]);
  }, 30_000);

  it("cancels when the worker drops ~/.anybench/cancel", async () => {
    const { home, paths } = await setupHome({
      warmup_runs: 0,
      driver: { type: "cli", run: "sleep 30" },
    });
    setTimeout(() => void writeFile(paths.cancelFile, "cancel\n"), 1200);
    const t0 = Date.now();
    const r = await runTrial({ trialId: "trial-tdm46", home, log: quiet, stealWindowMs: 10 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.exitCode).toBe(RUNNER_EXIT.cancelled);
    const status = RunnerStatusSchema.parse(JSON.parse(await readFile(paths.statusJson, "utf8")));
    expect(status.phase).toBe("cancelled");
    expect(phaseSequenceTdm46(await readEvents(paths.eventsJsonl)).at(-1)).toBe(
      "running→cancelled",
    );
  }, 30_000);

  it("refuses a --trial that does not match trial.json, and a bad trial.json", async () => {
    const { home, paths } = await setupHome();
    const r = await runTrial({ trialId: "someone-else", home, log: quiet });
    expect(r.exitCode).toBe(RUNNER_EXIT.usage);
    await writeFile(paths.trialJson, JSON.stringify({ version: 1, trial_id: "trial-tdm46" }));
    const bad = await runTrial({ trialId: "trial-tdm46", home, log: quiet });
    expect(bad.exitCode).toBe(RUNNER_EXIT.usage);
    expect(bad.message).toMatch(/trial.json is invalid/);
  });

  it("refuses to rerun an attempt whose runner died", async () => {
    const { home, paths } = await setupHome();
    await mkdir(paths.outDir, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      paths.statusJson,
      JSON.stringify({
        trial_id: "trial-tdm46",
        run_id: "run-tdm46",
        attempt: 1,
        runner_version: "0",
        pid: 2 ** 22 + 12345,
        hostname: "h",
        phase: "run",
        trial_state: "running",
        started_at: now,
        updated_at: now,
        heartbeat_at: null,
        phases: [],
        push: { mode: "push", sent_batches: 0, failed_posts: 0, last_error: null },
        events: { count: 0, bytes: 0 },
        run: null,
        upload: null,
        result: null,
      }),
    );
    const r = await runTrial({ trialId: "trial-tdm46", home, log: quiet });
    expect(r.exitCode).toBe(RUNNER_EXIT.stale_attempt);
  });
});
