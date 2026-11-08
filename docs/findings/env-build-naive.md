# Env build and real trials on Naïve (demo-env-trials, 2026-11-08)

The `env_build` stage (`apps/server/src/orchestrator/env-build.ts`, generic part in
`packages/envs/src/build.ts`) run live on Naïve via the gated test
`apps/server/test/env-trials-naive-live-demo.test.ts`.

## Command

```
cd apps/server
LOCAL_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench NAIVE_LIVE=1 \
  node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs run test/env-trials-naive-live-demo.test.ts --reporter=verbose
```

(`.env`'s own LOCAL_DATABASE_URL points at another Postgres; override it as above.)

## What worked

**cli example kit, profile `base`** (2 vCPU / 4 GiB / 20 GB):

```
env: recipes installed ["node22:installed","python312-uv:installed","git-time:installed","hyperfine:installed","hey:installed","k6:installed"]
env: runner installed {"version":"0.1.0"}          (94 MB bun binary via S3 presigned GET + sha256 check)
env: subject files staged / contender installed {"name":"ripgrep"}
env: snapshot taken {"snapshotId":"snp_28e466762fb4452c9a02e43063f418fb"}
env build result ok, build_ms 95600
```

**Tandem kit smoke profile, profile `agent-cc`** (4 vCPU / 8 GiB / 20 GB), subject and scoring
images built in parallel:

```
env: recipes installed [... "eval-user:installed","claude-code:installed","tandem:installed"]
env: runner installed {"version":"0.1.0"}
env: subject files staged {"files":60}      (adapters/, workloads/, scripts/setup-workspace.sh)
env: contender installed {"name":"claude-code-solo"} (and tandem, via install.sh → install-tandem.sh)
scoring image: recipes installed [base 6], snapshot snp_ee3538ce5e6f486f96bbee97cfdc2462
env build result ok: env_id snp_dc1617e222c645d0aff730dabaee9ab9, build_ms 229406 (~3.8 min)
```

## What did not work yet

1. **Trial on the fork: `naive forbidden (403): path is outside the sandbox working directory`**,
   4 s after the fork of the agent-cc image, before the runner launched (failure_class
   `provider_forbidden`, retried as failed_infra). The fs path is not in the message. The
   TDM-22 contract fork (plain image) had no such error, so something the agent-cc build leaves
   in the home (a symlink? the root-run contender installs + `chown -R $HOME`?) trips Naïve's fs
   sandbox on the fork. Not root-caused yet.
2. **Naïve 429 "the service is at capacity"** on a create, once. buildEnvSnapshot now retries a
   retryable create (6 tries, 5 s doubling, max 60 s).
3. With `Promise.all`, a failed scoring build returned while the subject build was still running;
   the test process then exited and leaked `cmp_01a1b969a1e5711d8ac840c304b61fd3`
   (`ab-infra-envbuild-f829a736a17c`, outside the reaper's reach). Fixed: `Promise.allSettled`.

## Cost

Balance 250,215,477 → 250,028,526 µ$ over the three live runs: **186,951 µ$ (≈ $0.19)**, including
the leaked computer's time so far (and any other worker's spend in that window). No model tokens.
