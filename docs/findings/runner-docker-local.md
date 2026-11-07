# In-VM runner on docker-local (TDM-46)

What we verified about the bun-compiled `anybench-runner` binary before it goes onto Naïve
computers. Date: 2026-11-07. Host: macOS arm64, Docker 29.4.3, bun 1.3.14.

## 1. bun cross-compiles both Linux targets from one machine

```sh
pnpm -r build
pnpm --filter @anybench/runner build:bin     # node scripts/build-bin.mjs → bun build src/cli.ts --compile --minify --target=bun-linux-{x64,arm64}
file packages/runner/dist/bin/*
```

```
runner-linux-arm64: ELF 64-bit LSB executable, ARM aarch64, ... interpreter /lib/ld-linux-aarch64.so.1
runner-linux-x64:   ELF 64-bit LSB executable, x86-64, ...   interpreter /lib64/ld-linux-x86-64.so.2
```

- The first build per target downloads that target's bun runtime (~37 MB) into bun's cache; later builds take ~0.5 s.
- Each binary is ~94 MB (bun runtime + 360 bundled modules; the AWS SDK comes in through
  `@anybench/envs`). They are glibc-linked: fine on Debian/Ubuntu profiles, not on Alpine/musl.
- Both run in a plain `debian:bookworm-slim` (no Node installed); x64 under `--platform linux/amd64` emulation:

```sh
docker run --rm --platform linux/amd64 -v "$PWD/dist/bin:/b:ro" debian:bookworm-slim /b/runner-linux-x64 --version
# 0.1.0
docker run --rm -v "$PWD/dist/bin:/b:ro" debian:bookworm-slim sh -c '/b/runner-linux-arm64 --trial x; echo exit=$?'
# ... runner: cannot read /root/.anybench/trial.json: ENOENT ...
# exit=2
```

## 2. `setsid nohup … &` outlives the launching exec

```sh
RUNNER_DOCKER_E2E=1 pnpm --filter @anybench/runner test:docker   # test/docker-e2e.test.ts
```

The test starts `debian:bookworm-slim` (with `--init`), adds a non-root user whose HOME is
`/home/evaluser` (not `/home/naive`, so nothing hardcodes the Naïve home), copies the binary to
`~/.anybench/bin/runner`, writes `~/.anybench/trial.json`, `~/.anybench/env` (0600) and
`~/eval/in/words.txt` via `docker exec -i … cat >`, then launches with one exec:

```sh
docker exec -u evaluser <c> sh -c 'setsid nohup ~/.anybench/bin/runner --trial trial-docker-1 >> ~/eval/runner.log 2>&1 &'
```

Output of the run (printed by the test):

```
"launch_exec_ms": 643,          ← the exec returned at once
"mid_phase": "warmup",          ← a later exec: status.json says warmup and `kill -0 <pid>` → alive
"final": { "phase": "done", "push": { "mode": "push", "sent_batches": 14, "failed_posts": 0 }, "events": { "count": 16 } },
"golden": ["installing→warming", "warming→running", "running→collecting"],
runner.log:
  runner 0.1.0: trial trial-docker-1 attempt 1 pid 56
  runner: phase prepare / healthcheck / warmup
  runner: phase run          (+4.2 s: the warm-up's sleep 4)
  runner: phase collect / freeze / upload
  runner: done (ok); push push, 16 events
```

The mock ingest on the host (`host.docker.internal`) received every event in order with
contiguous `batch_seq`, the final batch carried `status.phase = "done"`, the bundle PUT landed at
`runs/run-tdm46/trials/trial-docker-1/out.tar.gz`, and no request body contained the env secret
(`stdout.log` shows `key=[REDACTED:MODEL_KEY]`).

**Gotcha:** without an init process (`docker run` without `--init`, PID 1 = `sleep infinity`)
the finished runner stays a zombie and `kill -0` still succeeds. Real VMs have systemd as PID 1,
which reaps it. The worker should judge liveness by `status.json` phase + heartbeat age, not by
`kill -0` alone.

## Contract for downstream tickets

- Files: `~/.anybench/{trial.json,env,cancel}`, `~/eval/{in,ws,out,warmup}`, `~/eval/out/{status.json,events.jsonl,machine.json,stdout.log,stderr.log,manifest.json,artifacts/}`, bundle `~/eval/out.tar.gz`, launch log `~/eval/runner.log`.
- Ingest ([5.2]): `POST /v1/trials/:id/events` body `RunnerEventBatchSchema` (`trial_id, attempt, batch_seq, events[], status`), `Authorization: Bearer <token>`, `Idempotency-Key: <trial>:<attempt>:<batch_seq>`; 2xx or 409 = accepted; other 4xx (except 408/429) = runner goes file-only. Upload plan: `POST /v1/trials/:id/uploads` (`UploadPlanRequestSchema` → `{plan}`), then `POST /v1/trials/:id/uploads/complete` (`UploadCompleteRequestSchema`).
- Events: `seq` is the runner's per-attempt counter; the ingest assigns the run-wide seq. The runner reports `installing→warming→running→collecting` and the final failure edge (`→failed_subject|failed_infra|cancelled`); `collecting→gating` is the worker's.
- Cancel: write `~/.anybench/cancel` (checked every heartbeat and phase boundary) or SIGTERM the pid.
- A second launch for the same attempt is a no-op (finished or alive); one whose runner died exits 3: retry as a new attempt.
