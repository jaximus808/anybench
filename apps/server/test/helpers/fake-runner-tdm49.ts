// TDM-49: a scripted runner on FakeProvider (status.json progression with heartbeats), for the
// trial.execute tests on Postgres. The richer version lives in packages/bench/test.
import type { FakeProvider } from "@anybench/providers";

const PHASES = ["prepare", "healthcheck", "warmup", "run", "collect", "freeze", "upload"] as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FakeRunnerLaunchTdm49 {
  trialId: string;
  attempt: number;
  token: string | null;
}

export function fakeRunnerTdm49(
  fake: FakeProvider,
  opts: { stepMs?: number; hangOnAttempt?: number } = {},
): FakeRunnerLaunchTdm49[] {
  const launches: FakeRunnerLaunchTdm49[] = [];
  const stepMs = opts.stepMs ?? 20;
  fake.onExec(/\.anybench\/bin\/runner' --trial/, async (ctx) => {
    const job = JSON.parse(ctx.readFile(`${ctx.home}/.anybench/trial.json`) ?? "{}") as {
      trial_id: string;
      run_id: string;
      attempt: number;
      ingest: { token: string } | null;
    };
    launches.push({
      trialId: job.trial_id,
      attempt: job.attempt,
      token: job.ingest?.token ?? null,
    });
    const started = new Date().toISOString();
    const write = (phase: string, result: unknown = null) => {
      const at = new Date().toISOString();
      ctx.writeFile(
        `${ctx.home}/eval/out/status.json`,
        JSON.stringify({
          trial_id: job.trial_id,
          run_id: job.run_id,
          attempt: job.attempt,
          runner_version: "fake",
          pid: 7,
          hostname: "fake",
          phase,
          trial_state: "running",
          started_at: started,
          updated_at: at,
          heartbeat_at: at,
          phases: [],
          push: { mode: "file_only", sent_batches: 0, failed_posts: 0, last_error: null },
          events: { count: 0, bytes: 0 },
          run: { exit_code: 0, signal: null, duration_ms: 1, timed_out: false },
          upload: null,
          result,
        }),
      );
    };
    for (const phase of PHASES) {
      write(phase);
      if (phase === "run" && opts.hangOnAttempt === job.attempt) return { exitCode: 137 };
      for (let i = 0; i < 2; i++) {
        await sleep(stepMs);
        if (ctx.readFile(`${ctx.home}/.anybench/cancel`) !== undefined) {
          write("cancelled", { outcome: "cancelled", reason: "cancel", failure_class: null });
          return { exitCode: 12 };
        }
        write(phase);
      }
    }
    write("done", { outcome: "ok", reason: null, failure_class: null });
    return { exitCode: 0 };
  });
  return launches;
}
