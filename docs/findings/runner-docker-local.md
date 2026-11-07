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

## 3. Live log chunks, BYOK token cap, network probe (TDM-160)

Date: 2026-11-07. Same host, bun 1.3.14, `debian:bookworm-slim` (no `ca-certificates` package installed).

```sh
pnpm -r build && pnpm --filter @anybench/runner build:bin
cd packages/runner && RUNNER_DOCKER_E2E=1 npx vitest run test/docker-e2e.test.ts --silent=false
```

Trial `trial-docker-chunks` (`log_chunks: {}` = 256 KB / 5 s defaults, `network.allow: [example.org, registry.npmjs.org]`),
run = `head -c 1950000 /dev/urandom | base64 -w 100` twice with an env secret and an `sk-ant-…` key echoed in between, then `sleep 6; echo tail-after-pause`:

```
"stdout_bytes": 5564121, "chunks": 23,
"first": { "offset": 0, "bytes": 262150, "url": "artifact:runs/run-tdm46/trials/trial-docker-chunks/logs/stdout/000000000000.log", "sha256": "86cb…" },
"last":  { "offset": 5564098, "bytes": 23, ... }            ← the 5 s timer cut the partial segment during the sleep; the tail is its own segment
"log_chunks_status": { "stdout": { "segments": 23, "bytes": 5564121, "state": "live" } }
"network": { "allowed": { "example.org": "ok", "registry.npmjs.org": "ok" }, "canary": "reachable", ... "ms": 147 }
```

- The mock ingest concatenated the 23 objects in offset order and got `stdout.log` back byte for byte
  (sha256 per segment checked). No uploaded object contained either planted key; `stdout.log` shows
  `[REDACTED:MODEL_KEY]` and `[REDACTED:ANTHROPIC_API_KEY]`. Segments are cut at write boundaries
  (whole lines), so a "256 KB" segment is 256 KB plus at most one line.
- **bun's `fetch` does HTTPS from a container without `ca-certificates`**: bun ships its own root
  store, so the probe works on minimal images. Docker's default bridge has open egress, so the
  canary is `reachable` here, which is what we expect on Naïve too (declared, not enforced).

Trial `trial-docker-budget` (`driver.type: coding-agent`, `token_cap_micro_usd: "1000000"`), a fake
`claude -p --output-format stream-json` printing one assistant message (100k in, 10k out) every 0.5 s:

```
"budget_ms": 4552,
"result": { "outcome": "failed_subject", "failure_class": "budget",
  "reason": "token cap exceeded during run: spent $1.35 (1350000 micro-USD, estimate) over the $1.00 cap (1000000 micro-USD); tokens in 300000 out 30000 cache_read 0 cache_write 0" }
golden: installing→warming, warming→running, running→failed_subject
```

### Contract for downstream tickets (TDM-160)

- TrialJob, all optional (absent = feature off, so TDM-46 jobs are unchanged):
  `log_chunks: {segment_bytes=262144, segment_ms=5000, streams=[stdout,stderr], upload_tries=3}` (needs `ingest`);
  `token_cap_micro_usd: "<decimal string>"` plus optional `token_prices: {input, output, cache_read, cache_creation}`
  (micro-USD per million tokens, decimal strings; default = Sonnet list price $3/$15/$0.30/$3.75);
  `network: {allow: [...EnvSpec.network.allow], canary_url="https://example.com", timeout_ms=5000}`.
- Segments upload as artifact `logs/<stream>/<offset, 12 digits>.log` through the same
  `POST …/uploads` → PUT → `POST …/uploads/complete` flow as the bundle. The `trial.log_chunk`
  payload is `{stream, offset, bytes, url, sha256}`; `url` is the completion response's `url` when
  the ingest returns one, else `artifact:<key>` (`artifactUrl` / `artifactKeyFromUrl`). Offsets are
  byte offsets into the redacted `stdout.log`/`stderr.log` (verb tags included). If a segment fails
  `upload_tries` times, or the sink is file-only, live chunks stop for that stream (status
  `log_chunks.<stream>.state = "off"`); the full log is still in the bundle.
- Token cap: the meter reads only warm-up and `run` stdout. Spend = max(token estimate over unique
  assistant `message.id`s, sum of `result.total_cost_usd`), all bigint micro-USD (the cost is read
  from the JSON text, never through a float). Crossing it kills the verb's process group and
  reports `→failed_subject` with `failure_class: "budget"`; status.json carries `token_cap`.
  This is a minimal incremental parser, not TDM-50's `parseStreamJson` (which landed during this
  ticket): that one parses a finished transcript, and importing `@anybench/bench` would bundle
  kit/naive/providers into the runner binary. Rounding differs on purpose: the cap rounds up
  (stop early), the collector rounds half away from zero. (bun 1.3.14 does pass `context.source`
  to JSON.parse revivers: `bun -e 'JSON.parse("{\"a\":0.1}", (k,v,c)=>…)'` printed `{"source":"0.1"}`.)
- Network probe: runs right before the `run` verb (in parallel with the machine probe), writes
  `EVAL_OUT/network.json` (`NetworkProbeResultSchema`) and emits the new core event
  `trial.network {allowed: host→ok|failed, canary: blocked|reachable, canary_url}` (warn when an
  allowed host failed). Any HTTP status counts as reachable. It never fails the trial.
