# Worker deploy: the graphile worker on a Naïve computer (worker-naive, 13.11, 2026-11-08)

`scripts/deploy/worker.ts` deploys `apps/server/dist/worker.js` to a long-lived Naïve computer, so the worker no longer has to run on the founder's Mac. It follows the design in `naive-hosting.md` (section "11 h handoff") with one change: the handoff is blue/green **with a short gap**, so two workers never run at once.

**No live worker was started on Naïve for this ticket.** The founder's Mac worker is serving a live run tonight, and a second worker would compete with it. The evidence below comes from the dry run against the real `.env` (names only), 50 unit tests against an in-memory Naïve, and the real release running in Ubuntu 24.04 containers under both systemd and the setsid fallback, against a throwaway Postgres.

## Cutover (for the orchestrator)

```sh
# 1. stop the Mac worker loop (its heartbeat goes stale; trial.reattach moves its trials to the new worker)
# 2. from the main checkout (Node 22+, bun for the runner binaries if they are not built yet):
pnpm tsx scripts/deploy/worker.ts            # build, bundle, migrate dev, upload release, create + start, heartbeat gate
pnpm tsx scripts/deploy/worker.ts --status   # computers, supervisor state, heartbeat age
# rollback: pnpm tsx scripts/deploy/worker.ts --down   (stop + delete every worker computer), then restart the Mac loop
```

Re-running the deploy is a no-op while the newest worker computer runs the same release and env file, is younger than the rotation age and heartbeats. It also serves as the backstop if the on-host rotator ever misses its window.

## What it does

| Step | How |
|---|---|
| Inputs | `.env` is read in-process (never into `process.env`, argv or a log), with the worktree fallback from `api.ts`. zod reports every problem at once. Live billing, the `_PROD` Neon branch, a `-pooler` direct URL and missing `S3_*` are all refused. |
| Release | esbuild bundles `dist/worker.js` (the worker) and `dist/rotate.js` (the rotator). Workspace code is inlined and npm packages are installed on the host at the exact versions this checkout resolves. The release also ships `kits/`, `recipes/` (packages/envs), the agent role dirs (packages/agents, e.g. `understander/`) and `bin/runner-linux-{x64,arm64}`. All four `import.meta.url` file lookups in the bundle resolve against `<release>/dist/`. `checkResourceSites` fails the build if a fifth one shows up. |
| Release id | sha256 over (path, mode, content sha) for every file, 32 hex. The id names the release dir on the host, the `ab-infra-wb-…` tag and the artifact key `runs/infra/trials/worker-<id>/worker-release.tar.gz`. The 72 MB tarball is uploaded once per id; an unchanged re-run uploads nothing. |
| Computer | 1 vCPU / 2 GiB / 10 GB by default (`DEPLOY_WORKER_*`). Its name is `ab-infra-worker ab-infra-wb-<release12> ab-infra-we-<envfp12> :: anybench graphile worker …`. The computer reaper never touches `ab-infra-*`, and a test pins that. |
| Secrets | The env file goes to `~/.anybench/worker.env` by `computers.writeFile` (a request body) and is set to `chmod 600`. The presigned GET goes into a `curl -K` config, which is deleted after the download. Exec command lines carry only phase names and hex ids, because Naïve keeps exec history unredacted for 30 days. Tests assert that no secret and no presigned signature reaches an exec command or a log line. |
| Host | `bootstrap.sh install <id> <sha256>` installs Node 22.12.0 from nodejs.org if the image has no Node ≥ 22 (the Naïve image ships v24.22.1). It then fetches the release, checks its sha256, extracts it, runs `npm install --omit=dev`, links `current` to the new release and writes the units. |
| Supervisor | systemd `anybench-worker.service` with `Restart=always`, `RestartSec=5`, `TimeoutStopSec=120` (SIGTERM, so graphile drains) and logs in `~/anybench-worker/worker.log`, plus `anybench-worker-rotate.timer` every 15 min. Hosts without systemd get a `setsid` supervisor loop. `run-worker.sh` sets `ANYBENCH_KITS_DIR`, `ANYBENCH_RUNNER_BIN_DIR` and `ANYBENCH_GENERATED_KITS_DIR`, then runs `node --env-file=~/.anybench/worker.env`. |
| Health gate | A worker counts as healthy when `bootstrap.sh status` shows `active` and its `worker_heartbeats` row (host = hostname) has `ticks ≥ 2` and is younger than 60 s. |

## 12-hour lifetime

Naïve destroys a computer 12 h after `created_at`. The rotator (`dist/rotate.js`, run by the timer on the worker computer itself) works like this:

1. If a newer worker computer exists, it waits. If this computer is younger than `DEPLOY_WORKER_ROTATE_AFTER_HOURS` (default 10 h, capped at 12 h − 45 min), it keeps it.
2. Otherwise it creates a successor with the same release and env file and provisions it without starting it.
3. It stops its own worker. graphile drains on SIGTERM, and in-flight trials re-attach through `trial.reattach` once the old heartbeat is stale.
4. It copies `~/.anybench/generated-kits` across. `kits.files_url` is a `file://` path under the same `$HOME`.
5. It starts the successor and waits for its heartbeat, then deletes its own computer last.
6. If the successor does not heartbeat within 4 min, the rotator starts its own worker again, deletes the successor, and the next tick retries. That gives about 1 h 15 min of retries before the platform kill.

If the rotator fails outright, the next `pnpm tsx scripts/deploy/worker.ts` replaces the expired computer. The deploy uses the same `handoff` code path.

## Cost (integer micro-USD, Naïve rate card: 8,400 µ$ per vCPU + 2,700 µ$ per GiB per 10-min block)

| Size | Per block | Compute per day | Handoff overhead per day (≤ 1 block × 3) | **Total per day** | Per 30 days |
|---|---|---|---|---|---|
| **1 vCPU / 2 GiB (default)** | 13,800 | 1,987,200 | 41,400 | **2,028,600 µ$ ≈ $2.03** | 60,858,000 µ$ ≈ $60.86 |
| 1 vCPU / 1 GiB (`DEPLOY_WORKER_MEMORY_MB=1024`) | 11,100 (measured in `naive-hosting.md`) | 1,598,400 | 33,300 | 1,631,700 µ$ ≈ $1.63 | 48,951,000 µ$ ≈ $48.95 |

The default is 2 GiB because the worker hashes and uploads ~95 MB runner binaries during env builds and runs 5 jobs at once. 1 GiB is enough for the heartbeat alone, but there is no measurement under load yet. Eval computers, agent sessions and the release upload to R2 are billed separately.

## Evidence

### Dry run against the real .env (secret names only, no network)

```
$ pnpm tsx scripts/deploy/worker.ts --dry-run --skip-build
[deploy:worker] env {"file":"…/anybench/.env","size":{"vcpu":1,"memoryMb":2048,"diskGb":10},"rotate_after_h":10}
[deploy:worker] release {"id":"4e17b17034fee93be76c7df00ef1c957","files":153,"bytes":191033395,"top":["bin","dist","kits","package.json","recipes","understander"],
  "dependencies":{"@aws-sdk/client-s3":"3.1164.0","@aws-sdk/s3-request-presigner":"3.1164.0","@sentry/node":"11.11.0","@usenaive-sdk/managed-agents":"0.12.3",
  "drizzle-orm":"0.45.4","graphile-worker":"0.18.0","hono":"4.13.17","pg":"8.23.1","pino":"10.4.0","yaml":"2.9.1","zod":"4.6.7"}}
[deploy:worker] dry run: worker env file (names only) {"path":"~/.anybench/worker.env (mode 600, written by the fs API)","names":["NODE_ENV","ANYBENCH_ENV","LOG_LEVEL",
  "DATABASE_URL","DATABASE_URL_DIRECT","BILLING_MODE","STRIPE_SECRET_KEY","NAIVE_API_KEY","NAIVE_BASE_URL","RUNNER_TOKEN_SECRET","PUBLIC_API_URL","S3_ENDPOINT","S3_REGION",
  "S3_BUCKET","S3_ACCESS_KEY_ID","S3_SECRET_ACCESS_KEY","TRIAL_PROXY_CAP_MICRO_USD","RUN_FEE_MICRO_USD","COMPUTE_MARKUP_BPS"],"bytes":1202}
[deploy:worker] dry run: computer {"name":"ab-infra-worker ab-infra-wb-4e17b17034fe ab-infra-we-22cda1d002e1 :: anybench graphile worker (scripts/deploy/worker.ts)",
  "vcpu":1,"memoryMb":2048,"diskGb":10,"rotate_after_h":10,"naive_lifetime_h":12}
[deploy:worker] dry run: release artifact {"runId":"infra","trialId":"worker-4e17b17034fee93be76c7df00ef1c957","name":"worker-release.tar.gz","commit":"b07457f42f66"}
[deploy:worker] dry run: bootstrap.sh {"phases":["install","start","stop","status","pack-kits","unpack-kits"],"bytes":7072,"bash_n":"ok",…}
[deploy:worker] dry run: cost (integer micro-USD) {"per_block_10min":"13800","compute_per_day":"1987200","handoffs_per_day":3,"handoff_overhead_per_day_max":"41400",
  "total_per_day":"2028600 ($2.0286)","total_per_30_days":"60858000 ($60.8580)"}
```

### The real release on Ubuntu 24.04 (Docker, arm64; throwaway postgres:16 migrated with `runMigrations`)

The release was built by `bundleWorkerRelease` + `writeReleaseTarball`: 72,367,230 bytes, written in 5.5 s. Files were placed where the fs writes put them, and the exact `bootstrapCommand` strings were run.

```
# no systemd (setsid fallback), no node on the image
$ … bootstrap.sh install a0ca01ca… c8d3554a…                       (36 s)
[bootstrap] installing node v22.12.0 (arm64)
[bootstrap] installed a0ca01ca6fd832710bc9d5589e57adac with node v22.12.0 (supervisor: setsid)
$ … bootstrap.sh start; sleep 40; bootstrap.sh status
{"host":"d911a3b3b21c","worker":"active","supervisor":"setsid","release":"a0ca01ca6fd832710bc9d5589e57adac"}
worker.log: "worker booting" … "worker started" jobs [worker.heartbeat, computer.reap, run.advance, run.sweep, trial.execute, trial.reattach, trial.gate]
psql: d911a3b3b21c:2418 | ticks 3 | age 00:00:09
$ kill -9 <worker pid>; sleep 8            → a new worker pid 2456 (supervisor restarted it)
$ bootstrap.sh stop → status "inactive", no worker process; worker.log: {"signal":"SIGTERM","msg":"shutting down"}
$ bootstrap.sh pack-kits → 202 bytes (generated-kits/0190-run/v1/anybench.yaml) · unpack-kits → restored · start → active
$ run-worker.sh rotate (no NAIVE/S3 in this env file) → [worker:rotate] failed {"error":"env: missing NAIVE_API_KEY, S3_ENDPOINT, …"}   (bundle boots, refuses by name)
checkHeartbeat(host) → {"healthy":true,"detail":{"worker_id":"d911a3b3b21c:2639","ticks":3,"heartbeat_age_ms":4389}}

# systemd as PID 1, user tenki with passwordless sudo (like the Naïve image)
[bootstrap] installed a0ca01ca… with node v22.12.0 (supervisor: systemd)
{"host":"85e20f19e55e","worker":"active","supervisor":"systemd",…}
systemctl show anybench-worker → Restart=always MainPID=226 User=tenki ActiveState=active
list-timers → anybench-worker-rotate.timer, next in 14 min · ~/.anybench/bundle.curl removed after install
psql: 85e20f19e55e:226 | ticks 2 | age 00:00:03
sudo kill -9 MainPID; sleep 8 → MainPID=260 NRestarts=1 ActiveState=active
bootstrap.sh stop → inactive · systemctl start anybench-worker-rotate.service → runs rotate.js as a oneshot (exits 1 on the missing env, as above)
```

All containers, the network and the image were removed afterwards.

### Unit tests (scripts/deploy, 50 passed)

`test/worker-plan-worker-naive.test.ts`, `test/worker-reconcile-worker-naive.test.ts` and `test/worker-bundle-worker-naive.test.ts` cover the following:

- Env refusals, reported by name only.
- Env-file round-trips through node's own parser.
- Tag round-trips, and the reaper's `ab-infra-` guard.
- The keep/replace/rotate decisions and the 12 h cap.
- Cost in bigint.
- `bash -n` on bootstrap.sh, with no secret in it.
- A first deploy, an unchanged re-run (no create), and the env-change order (`create → install → stop old → pack/unpack kits → start new → delete old`).
- Rollback when the successor never heartbeats, and when install fails.
- Rotation (keep / hand off with self deleted last / wait for a newer worker).
- The `import.meta.url` layout guard.

## Not verified / known limits

- **Not run on Naïve.** Every Naïve call the deploy makes (`create`, `get`, `list`, `inspect`, `mkdir`, `writeFile`, `readFile`, `exec`, `delete`) goes through `@anybench/naive`'s computers client with the 429 retry. All of them were used live by the TDM-170 spike and the env build. systemd as PID 1 and passwordless sudo on the Naïve image come from that spike. The first live deploy should be watched with `--status`.
- **Kits generated on the Mac do not move.** `kits.files_url` holds the Mac's absolute `file:///Users/…` path. A run whose generated kit was written on the Mac fails its env build on the Naïve worker, so let such runs finish before cutover or restart them. Box-to-box handoffs copy the kits, because `$HOME` is the same on every computer.
- `PUBLIC_API_URL` is passed through from `.env` (`DEPLOY_WORKER_PUBLIC_API_URL` overrides it). It must be an ingest URL the eval computers can reach. Otherwise the runners stay file-only, as they do from the Mac today.
- Binary ingest through Docker (`packages/kit/src/ingest/binary.ts`) cannot work, because the Naïve image has no Docker. git and tar are present.
- A laptop deploy and an on-host rotation running at the same minute could race. The window is one rotation tick, roughly every 10 h, and at worst the deploy's next run cleans up.
