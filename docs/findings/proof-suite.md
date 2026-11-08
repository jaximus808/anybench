# Proof suite: the six checks on the real trial path (TDM-44 [4.12], 2026-11-08)

Code: `packages/kit/src/proof/` (suite, port, secret scan, bundle, mutation operators),
`apps/server/src/jobs/proof-runner.ts` (ProofRunner over a ComputeProvider),
`apps/server/src/jobs/proof.ts` (PipelinePort.prove, wired into `defaultPipeline`).
Kit: `packages/kit/examples/cli` (ripgrep vs GNU grep; do-less `truncated-output` and
`first-match-only`; planted regression `planted-delay`).

## How a proof trial runs

The same path a contender trial takes, with no bench edits:

- **Trial.** bench `executeTrial` with a `MemoryTrialExecStore`, `ingest: null` and a
  `fallbackUpload` that keeps the bytes. It forks `env.env_id`, writes trial.json, launches the
  runner binary detached, follows status.json, pulls `out.tar.gz` by fs/read and destroys the
  computer. The job is `preparedJob` from `orchestrator/trial-source.ts`, plus the overlay's env.
  Only the overlay's own files (its `dir` and `driver_patch`) are written under `~/kit` on the
  fork.
- **Gate.** bench `runGates` on a fresh scoring computer, forked from
  `env.detail.scoring_snapshot_id` (on docker-local, a fresh base box). The scoring bundle is read
  from the kit dir at call time.
- **Metrics.** bench `collect()` over the frozen collector files. Only trial-level, unlabelled
  rows are kept.

Every computer goes through a `ComputerRegistry`. That gives it an `ab-<run>-<proof trial>` tag
and a `computers` row with null run/trial ids: proof compute is not billed to the run, and there
is no `trials` row for the foreign key. `sweep()` runs in `finally`.

## docker-local (no spend)

```
$ pnpm --filter @anybench/runner build:bin
$ cd apps/server && PROOF_DOCKER_E2E=1 PROOF_E2E_LOG=<file> pnpm exec vitest run test/proof-e2e-tdm44.test.ts
 Test Files  1 passed (1)
      Tests  1 passed | 1 skipped (2)
   Duration  112.96s
```

Summary (`PROOF_E2E_LOG`, abridged):

```
oracle_passes True | oracle 'grep-reference' passed same-matches on 2/2 workload(s); the gate gave the same verdict 3 times on literal-search
do_less_fails True | every do-less variant fails the gate ('truncated-output', 'first-match-only')
   - do-less 'truncated-output' (cheat): failed same-matches on literal-search: ... got 1 line(s), expected 4; 3 expected line(s) missing and none extra (output truncated?)
   - do-less 'first-match-only' (cheat): failed same-matches on literal-search: ... got 3 line(s), expected 4; 1 expected line(s) missing and none extra (output truncated?)
smoke_passes True | 'ripgrep' ran on literal-search on the real profile (base) with a gate verdict and every measured metric collected
regression_scores_lower True | planted regression 'planted-delay' scored lower on wall (n=3 each)
   - gate passes: honest 3/3, planted 3/3 on literal-search
   - wall: planted median worse than every honest sample
   - rss: planted median not worse than every honest sample
baselines_in_range True | baseline 'gnu-grep' passed every gate on 2 workload(s) with every measured metric present
no_secret_in_kit True | no secret in 19 kit file(s) (key patterns and the worker's exact secret values)
{'infra': [], 'trials': 10, 'gateRuns': 12, 'computers': 22, 'destroyed': 22, 'blocks': 22, 'build_ms': 54897, 'proof_ms': 55273}
```

That is 10 trials and 12 gate runs, so 22 computers, all destroyed. 0 containers were left
under the test label. The oracle overlay `grep-reference` has no patch and no env, so it IS
gnu-grep's plain run: the oracle and the baseline share one trial per workload. Each do-less
variant stops at the first workload it fails.

## Naïve live

Not achieved today. I made three attempts, 2026-11-08 05:44–06:05 UTC:

```
$ cd apps/server && NAIVE_LIVE=1 PROOF_LIVE=1 node --env-file=<repo>/.env \
    ../../node_modules/vitest/vitest.mjs run test/proof-e2e-tdm44.test.ts -t "Naïve"
PROOF-E2E balance before {"balanceMicroUsd":"249439504","mode":"live"}
PROOF-E2E scoring image: env build create retry {"attempt":1,...,"err":"ProviderCapacityError: naive rate_limited (429): the service is at capacity"}
PROOF-E2E scoring image: env build create retry {"attempt":3,...}
PROOF-E2E env: recipes installed {"recipes":["node22:installed","python312-uv:installed","git-time:installed","hyperfine:installed","hey:installed","k6:installed"]}
PROOF-E2E env: env build computer destroy FAILED {"id":"cmp_…","err":"ProviderCapacityError: naive rate_limited (429): the service is at capacity"}
EnvBuildError: env build failed at runner: naive network_error: Naïve request failed: fetch failed
```

All three attempts stopped the same way: in `buildEnvSnapshot`'s runner step, before any proof
trial ran. Attempt 1 pushed the runner as bytes; attempts 2 and 3 went through S3 and a presigned
GET, as production does. Naïve was answering 429 "at capacity" to most creates and destroys at
the time.

**Leaks, and what was done about them.** Each time, `buildEnvSnapshot` failed to destroy its own
build computers (a 429 on destroy, with no retry), and the scoring build was cut off when the test
exited. That left 2 computers per attempt (`ab-infra-envbuild-tdm44-*`). I destroyed all six by id
with a script that checks each computer's tag first (scratchpad `naive-destroy-ids.mts`, 429
backoff). Afterwards `computers.list()` returned `[]`.

**Spend.** The balance went from 249,439,504 to 249,309,879 µ$, so **129,625 µ$ (≈ $0.13)** over
the window. That includes the leaked computers' time, and any other worker's spend in the same
window. No model tokens were used.

Follow-ups for packages/envs (not this ticket): retry a destroy that gets a retryable 429, and
find out why the runner step's Naïve call fails with `fetch failed` while Naïve is under capacity
pressure. The proof path itself is the same code that passes on docker-local above. Re-run the
command above once Naïve has capacity.

## What we learned

- **One thread is no regression on a tiny tree.** The example's old planted regression was
  `THREADS=1`. ripgrep is no slower with one thread on four files, and GNU time's wall clock only
  has 10 ms resolution, so the check would rightly have said "did not score lower". The example
  now plants a deterministic 0.3 s delay (`PLANTED_DELAY_S`, inside the subject function, so the
  gated run and every hyperfine run pay it). Plan 17.2 rule 9 asks for "deterministic planted
  regressions".
- **A no-op do-less is detected by kind.** `proof.do_less[].kind` is one of `noop`,
  `partial-oracle` or `cheat`. When it is absent, it is inferred from ids like `no-op` or
  `do-nothing`. A kit whose only do-less variants are no-ops fails `do_less_fails`.
- **The mutation kill rate uses the real hidden tests.** The suite mutates the oracle's source
  (`proof/oracle/<workload>/`), finds where each file landed in the oracle's frozen outputs (by
  identical bytes), plants each mutant there and re-runs only the hidden-tests gate. The
  operators are: flip a comparison, drop an error branch, off-by-one, return before persist, and
  drop a statement or chained call (one contract clause). On the coding-agent example (slugify,
  node --test on the host), the real gate killed **6/6**. A weak gate (7 tests that only check
  the return type) killed 0/6, and the check fails with the survivors listed.
- **Proof reasons never carry a contender metric value** (plan 17.2 rule 6, the repair loop
  reads them). Reasons are check-level, and regression evidence says only "planted median worse
  than every honest sample". An un-overlaid contender's gate reason (smoke, baseline, regression
  samples) is withheld, because it can carry a score. A test plants distinctive metric values
  and checks that none of them appears.
- **A secret-holding kit never reaches a computer.** `no_secret_in_kit` runs first. When it
  fails, the other five checks are "not run" and the runner is never called. Findings name the
  file, line and pattern (`ANTHROPIC_API_KEY in adapters/ripgrep/install.sh:23`), never the value.
  A more specific pattern wins over an overlapping generic one (sk-ant- is not also reported as
  sk-).
