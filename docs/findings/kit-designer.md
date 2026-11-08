# Kit designer: generated cli kits, proof-driven repair (TDM-60 [6.6], 2026-11-08)

## What exists

- Role `packages/agents/kit-designer/{prompt.md, output.schema.json, config.json}`. The model is
  `anthropic/claude-sonnet-5.5` (harness `pi`, no tools). The per-task cap is 800,000 µ$, and
  each session gets a budget of `KIT_DESIGNER_BUDGET_MICRO_USD` = 800,000n. The model answers
  with a STRUCTURED draft (`@anybench/kit` `CliKitDraftSchema`) and writes no scripts.
  `output.schema.json` is generated from that zod schema; a test keeps the two equal. Regex
  `pattern`s and `$schema` are stripped for the provider, and zod still checks every field.
- `@anybench/agents` `kit-designer.ts` has three input builders. `buildKitDesignerInput` (mode
  `design`) sends the digest, the understanding, the research baselines, the user's intake
  contenders and the repo context. `buildKitDesignerFixInput` (mode `fix`) sends the draft plus
  our code's issues. `buildKitDesignerRepairInput` (mode `repair`) sends the previous spec, the
  previous draft and the proof checks, and nothing else.
- `@anybench/kit` `src/generate/` has four parts:
  - `cli-draft.ts`: the draft schema and its cross-checks. There is exactly one subject, on
    route `github_release`. There must be a baseline, because a captured reference needs an
    independent check. The subject's command holds `{extra_args}` exactly once. Network tools,
    sudo, our secrets file and `reference/`, `gates/` and `proof/` paths are refused in
    commands. Weights must sum to 100. Repeats are at least 5 and hyperfine runs at least 10
    (17.2 rule 3).
  - `pins.ts`: the pins, resolved in code. For the release tag (or the latest release) it picks a
    per-arch Linux asset: x86_64 prefers musl, then gnu; aarch64 takes gnu or musl. It skips
    deb, zip, darwin and side files. The sha256 comes from the published `<asset>.sha256` (checked
    against GitHub's asset `digest` when both exist), else from the digest, else from download +
    hash. Hashes are cached by URL in `~/.anybench/pins`. GNU baselines are pinned to the
    version Ubuntu 24.04's apt installs, which the healthcheck enforces, with the GNU source
    tarball's sha256 as L0.
  - `materialize-cli.ts`: the deterministic kit writer. It renders drivers, the gate, the cheat
    do-less, install and healthcheck scripts with the TDM-36 renderers. It adds
    `gates[].capture: {from: oracle}`, and the oracle is the pinned subject. Do-less variants
    are `truncated-output` (cheat) and the draft's flag (partial-oracle, via `AB_PARTIAL=1`).
    The regression is a planted `PLANTED_DELAY_S=0.3`. Workload text is seeded (mulberry32)
    and can be replicated inside its top directory. It also writes `design/{draft,pins,provenance}.json`
    and an empty `reference/<gate>/` (README only) for the proof stage to fill.
  - `lint.ts`: `noLeakIssues` and `validateGeneratedKit` (loadKit + comparability + no-leak).
- Server `orchestrator/kit-designer.ts`, `naiveKitDesigner`:
  - Only a supported `cli` understanding gets a kit. coding-agent and harness repos hold (see
    the follow-ups); other drivers hold with the understander's reason.
  - The kit is written to `ANYBENCH_GENERATED_KITS_DIR/<run>/v<n>` and returned as `files_dir`.
  - When validation fails, the designer is re-asked once (its own session key `…:fix1`). If the
    second draft also fails, the run goes to needs_human with the issues. A transient pin
    failure (429, 5xx, network) throws, so the job retries.
  - The skeptic seam is `KitSkeptic` (TDM-187), called between validate and return.
  - It is wired into `kitBuilderStages` as the default designer. The Tandem repo stays curated.
- Prereg (minimal 17.2 rule 6 guard; the full [16.9] ticket was not on main):
  `orchestrator/prereg.ts`. At auto-go, or before the first trial after an API Go,
  `stage_outputs.prereg` records the kit row, the spec hash, the sha256 of the kit's file tree,
  the weights, the primary and the repeats. Before the trials are created, the orchestrator
  recomputes them. Any difference holds the run: "the kit changed after it was preregistered at
  Go (…): prove it again before Go".

## Rule 6 in code: the repair loop never sees contender scores

`KitDesignerRepairInputSchema` is a strict object `{previous_spec, previous_draft, proof[]}`. Each
proof check is strict `{check, pass, reason, evidence}`. `buildKitDesignerRepairInput` parses its
argument, so an extra key (`scores`, `trials`, `metrics`) throws. The type has no such field
either: a `@ts-expect-error` test covers it. Reasons and evidence are also scrubbed of
`wall_s=…`, `median 9.5 s`, `1234 bytes` and similar values (TDM-44 already writes none).

`kit-designer-tdm60.test.ts` "repair" plants `wall_s 7.654321` / `peak_rss_bytes 98765432` on a
trial row of the run, and `wall_s=7.654321 median 7654.3 ms` in a proof evidence line. The repair
session's task message has exactly the keys `mode, note, previous_draft, previous_spec, proof`,
and none of the planted values. The repair writes `v2`.

## Generated kits through the real proof path (docker-local, no spend)

Drafts for ripgrep and fd (`packages/kit/test/tdm60-generate-fixtures.ts`) were materialized with
REAL pins from GitHub, then proved with TDM-44's e2e test pointed at the kit:

```
$ node <scratch>/materialize-real.mts rg <scratch>/kits      # real GitHub + ftp.gnu.org
ripgrep 14.1.1: x86_64 ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz 4cf9f274…4d8e (published .sha256)
                aarch64 ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz c827481c…ab2f (published .sha256)
gnu-grep 3.11: grep-3.11.tar.xz 1db2aedd…6eab (downloaded + hashed)
valid true [] []
$ node <scratch>/materialize-real.mts fd <scratch>/kits
fd v10.5.2 (latest): fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz / aarch64-unknown-linux-gnu (GitHub digest)
valid true [] []
```

These sha256 values are the same ones the hand-written example kit pins (packages/kit/examples/cli).

```
$ cd apps/server && PROOF_DOCKER_E2E=1 ANYBENCH_RUNNER_BIN_DIR=<repo>/packages/runner/dist/bin \
    PROOF_E2E_KIT_DIR=<scratch>/kits-docker/rg/v1 PROOF_E2E_LOG=<scratch>/docker-rg.json \
    pnpm exec vitest run test/proof-e2e-tdm44.test.ts
 Tests  1 passed | 1 skipped (2)
oracle_passes True  oracle 'ripgrep-reference' passed same-output on 2/2 workload(s); the gate gave the same verdict 3 times on literal-search, regex-search; captured reference(s) … confirmed on a fresh computer and by an independent baseline
do_less_fails True  'truncated-output' (cheat): got 1 line(s), expected 66; 'first-match-only' (partial-oracle): got 6 line(s), expected 66
smoke_passes True   'ripgrep' ran on literal-search on the real profile (base) with a gate verdict and every measured metric collected
regression_scores_lower True  'planted-delay' scored lower on wall (n=3 each)
baselines_in_range True  baseline 'gnu-grep' passed every gate on 2 workload(s)
no_secret_in_kit True  no secret in 25 kit file(s)
{infra: [], trials: 14, gateRuns: 16, computers: 30, destroyed: 30, build_ms: 46547, proof_ms: 63963}
```

fd vs GNU find: all six pass. `max-one-result` (partial) gives 1 line against the expected 40.
gnu-find agreed on both workloads. There were 108 kit files (two replicated trees), 30 of 30
computers were destroyed, and proof took 213 s.

The proof suite therefore accepts what the materializer writes, on the real trial path, with
captured references cross-checked by GNU baselines.

## Live designer sessions on Naïve (no computers)

```
$ cd apps/server && LOCAL_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench \
    NAIVE_LIVE=1 TDM60_LIVE=1 TDM60_LIVE_KITS=<scratch>/live-kits TDM60_LIVE_OUT=<scratch>/live-out.json \
    TDM60_TANDEM_DIR=<clone of jaximus808/tandem @ 05b4a022> node --env-file=<repo>/.env \
    ../../node_modules/vitest/vitest.mjs run test/kit-designer-naive-live-tdm60.test.ts --reporter=verbose
naive: POST /v1/sessions -> 429; retry 1 in 1169 ms      (Naïve at capacity; built-in retries)
TDM60-LIVE ripgrep understand  software / driver cli / ready, 5 verified claims          4,056 µ$
TDM60-LIVE message "designed kit v1: rg (ripgrep 15.2.0) vs gnu-grep (GNU grep 3.11)
  4 workloads, gate same-output (reference captured from rg), 5 repeats, weights {"wall":80,"rss":20}
  designer sessions cost 128646 µ$"
TDM60-LIVE tandem understand   harness / supported / ready, history minable (40 of 200 commits touch tests)   4,538 µ$
TDM60-LIVE tandem design {"ok":false,"reason":"automatic kits for harness repos need tasks mined from the repo's history (TDM-186), which is not built in yet"}
 Tests  2 passed (2)
```

The ripgrep draft (`design/draft.json`) validated on the FIRST draft, so no fix re-ask was
needed. What sonnet-5.5 chose:

- **Subject:** `rg --no-config --no-heading --no-ignore --hidden -a -n {extra_args} -e "$(cat pattern.txt)" tree`,
  pinned by code to ripgrep 15.2.0 (the latest release).
- **Baseline:** `LC_ALL=C grep -r -n -a -E -e "$(cat pattern.txt)" tree`. Its patterns use only
  ERE syntax both engines share (no `\w` or `-w`), and the gate sorts lines and accepts exit 0/1.
- **Workloads:** 4. The first is ~300 tiny files (50 replicas, including a hidden dir). The next
  two are single ~6 MB seeded files, one with a literal pattern and one with a regex that has no
  literal prefix. The last is 50 nested files with an alternation regex.
- **Partial do-less:** `--max-count 1`.
- **Weights and repeats:** wall 80 / rss 20, primary wall, 5 repeats × 10 hyperfine runs.

**The MODEL-designed kit, proved on docker-local** (same TDM-44 e2e test, `PROOF_E2E_KIT_DIR` =
the live kit dir): **all six checks pass.**

```
oracle_passes True  oracle 'rg-reference' passed same-output on 4/4 workload(s); the gate gave the same verdict 3 times …; captured reference(s) … confirmed on a fresh computer and by an independent baseline
do_less_fails True  'truncated-output' (cheat): got 1 line(s), expected 550; 'max-count-1' (partial-oracle): got 250 line(s), expected 550
smoke_passes True   'rg' ran on small-files-literal on the real profile (base) with a gate verdict and every measured metric collected
regression_scores_lower True  'planted-delay' scored lower on wall (n=3 each)
baselines_in_range True  baseline 'gnu-grep' passed every gate on 4 workload(s)
no_secret_in_kit True  no secret in 323 kit file(s)
{infra: [], trials: 20, gateRuns: 24, computers: 44, destroyed: 44, build_ms: 56900, proof_ms: 374301}
```

The Tandem hold costs nothing: no designer session runs. (The hold message now also names the
missing pieces. That message landed after this run started.)

### Mining Tandem's history (docker-local, no spend)

```
$ node <scratch>/scripts/mine-tandem.mts <clone> <scratch>/kit-tandem-mined out.json   # golang:1.26-bookworm, 4 vCPU
commits_scanned 393, candidates 46, verified 0
drop_counts: no_test_change 199, too_large 63, merge 52, no_runner 40, docs_only 19, deletes_or_renames 7, over_limit 6, tests_only 4, ...
  dropped: no_runner: Go tests without a root go.mod            (the module is apps/api/go.mod)
  dropped: no_runner: node --test on TypeScript test files needs a loader; not supported yet
```

So today the generated path cannot build a Tandem kit: the miner yields 0 runnable tasks. The
lead dispatched `tdm186-runners` (nested modules, a TS loader under node --test) to fix this.

## Diff note: the generated path on jaximus808/tandem vs kits/tandem-vs-claude-code

The curated kit is compared with what the generated agent/harness path would produce once step 6
lands (mined tasks → issue text → hidden-tests gate → pinned contenders).

| | curated kit (today) | generated path (designed) | verdict |
|---|---|---|---|
| Contenders | A Claude Code solo, B Claude Code + subagents, Tandem ×1/×3/×5 (`vary`); all on opus-5.5, Claude Code 2.1.319, pinned | the subject + plain Claude Code pinned exactly the same way; B only if the user asks | curated is **broader** (the subagents setup is the fair "best plain" rival); fairness is equal |
| Tasks | 3 hand-written synthetic tasks (todo-api, auth-refactor, bug-hunt) | tasks mined from Tandem's own history: fail-before/pass-after 3/3, dated against the model cutoff, ≥20 with ⅓ held out, else "on these N tasks" | generated is **better** on provenance and contamination (17.1 flags the synthetic tasks as saturating, with todo-api pre-split and an invented history), but today it has **0 tasks** |
| Gates | hidden tests + api-load p95 + a reviewed quality rubric | FAIL_TO_PASS + PASS_TO_PASS hidden tests | generated is **better** on regressions (curated has no PASS_TO_PASS) and **narrower** (no load test, no rubric) |
| Proof | the curated, signed-off offline proof (labelled "not proven" in the product); its only do-less is `do-nothing`, a no-op, which TDM-44's suite would FAIL as too weak; regression = "skip the tests" CLAUDE.md | the six checks on the real image: noop + partial-oracle do-less, mutation kill rate ≥90% on the hidden tests, determinism ×3 | generated is **better** |
| Caps | equal: 8M tokens, 3600 s, Naïve-proxy metered | copied from the curated kit (same model, CLI version, equal caps) | **same** |
| Weights / repeats | tests-pass 50, api-p95 10, wall 10, cost 10, quality 20, chosen by hand; 5 repeats | 17.4 core for agents (pass@1, cost per solved task, time-to-solve with failures at the cap), reviewed quality at weight 0; ≥10 repeats (17.2 rule 3) | generated is **better** aligned with rules 3 and 7; curated has the more product-specific metrics |

Bottom line: for Tandem the curated kit is still the only one that runs, and it covers more
setups and metrics. The generated design is the more defensible measurement (real tasks,
PASS_TO_PASS, a proof the gate discriminates, no hand weights). The curated kit's weakest point
is its no-op-only do-less, which its offline sign-off currently hides.

## Step 6: agent/harness kits from mined tasks (docker-local + FakeNaive, no spend)

Code:
- `@anybench/kit` `generate/agent-kit.ts`, `materializeAgentKit`:
  - Workloads come from `materializeMinedTask`.
  - instruction.md is the screened issue text.
  - The gate is `renderMinedGateScript`. It copies the hidden test files over a copy of the
    frozen workspace and runs the task's runner as the contender uid (`$AB_RUN`). Grading uses
    **the miner's own parsers**, embedded as compiled source (`minedVerdictProgram`). It passes
    only when every FAIL_TO_PASS and every PASS_TO_PASS test passes.
  - The oracle is the upstream fix, applied by `proof/oracle/driver.sh`.
  - Do-less variants are `no-op` (noop) and `partial-fix` (partial-oracle). The partial drops
    the largest hunk of the fix, or one file's change, or one added line of a one-hunk fix.
  - `proof/mutation/<w>.json` limits mutants to the lines the fix changed.
  - The contenders, adapters, regression, env and caps are copied from the template kit
    (`kits/tandem-vs-claude-code`: claude-code-solo + tandem, opus-5.5, Claude Code 2.1.319,
    equal caps). `vary` is cut to its middle value (TANDEM_WORKERS 3).
  - Repeats are 10 (17.2 rule 3). Weights are tests-pass 60, wall 20 and cost 20, with
    tests-pass as the primary metric.
  - The subject summary says "Results hold on these N tasks only" when N < 20.
  - `design/tasks.json` holds the commit dates against the cutoff, the held-out flags and the
    backlogs (`groupMinedTasks`).
- Proof suite changes: the mutation run honours `proof/mutation/<w>.json`, and it tries the next
  workload when one yields no mutant.
- The no-leak lint now compares each workload only with its own scoring files. A later task's
  starting repo legitimately contains an earlier task's fix.
- `@anybench/agents` `issue-writer` (deepseek-v4-flash, 50,000 µ$ per issue) works on
  `screenSymptoms` output. Test ids, test paths, the commit, assertion source lines and long
  literals are removed in code.
- Server `orchestrator/agent-kit-designer.ts`, `designMinedAgentKit`, runs one issue session per
  task. It drops a task when the writer says it is underspecified, or when the issue names a
  hidden test, a hidden test file or the commit. Then it materializes and validates.

Evidence:
- `packages/kit/test/tdm60-agent-kit-docker.test.ts` mines the TDM-186 fixture on docker-local
  node:22 (5 tasks) and materializes a kit from the Tandem template. It then runs the proof suite
  with host trials that apply the overlay dirs, and gates that run the generated check.sh with
  node --test:
  ```
  oracle_passes True   oracle 'upstream-fix' passed hidden-tests on 5/5 workload(s); the gate gave the same verdict 3 times
                       (e.g. "1/1 FAIL_TO_PASS and 5/5 PASS_TO_PASS tests pass on mined-68b22c2835")
  do_less_fails True   every do-less variant fails the gate ('no-op', 'partial-fix'); the hidden tests killed 3/3 oracle mutants
  no_secret_in_kit True
  (smoke, baselines, planted regression: need a real agent session; live window)
  ```
  Before the mutation-line limit, the same kit killed only 3 of 8 mutants. The 5 survivors were
  in `titleCase`, which the truncate fix never touched and its tests never call. Mutating the
  whole file measures the repo, not the task.
- `apps/server/test/agent-kit-designer-tdm60.test.ts` (Postgres + docker + FakeNaive): one issue
  says "underspecified" and is dropped; one quotes a test name and is dropped; the rest build a
  valid kit. No FAIL_TO_PASS id appears in any issue-writer task message.

**Jaximus808/tandem:** this path cannot build a real Tandem kit yet. The miner verified 0 of
46 candidates, because its runners do not handle the nested `apps/api/go.mod` or TypeScript under
`node --test`. The `tdm186-runners` follow-up fixes both. There is a second gap: the scoring image
has no Go toolchain, so Go hidden tests could not run there yet.

## End-to-end on Naïve (BurntSushi/ripgrep): not run yet

`apps/server/test/kit-designer-e2e-live-tdm60.test.ts` drives the production `run.advance` job
(defaultAgentStages + defaultPipeline from the real config) on local Postgres. It POSTs a run
with `auto_go: false` and expects `awaiting_go`. It stops before a second proof (a repair) unless
`TDM60_E2E_ALLOW_REPAIR=1`, to bound spend. The first attempt sat in `GET /v1/credits/balance -> 429` retries before
creating anything, and was stopped when the orchestrator paused all live computers (the
founder's 30-trial run held Naïve's capacity). It created 0 computers. Re-run it with:

```
cd apps/server && LOCAL_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench \
  NAIVE_LIVE=1 TDM60_E2E=1 TDM60_E2E_REPO=BurntSushi/ripgrep TDM60_E2E_OUT=<file> \
  ANYBENCH_RUNNER_BIN_DIR=<repo>/packages/runner/dist/bin node --env-file=<repo>/.env \
  ../../node_modules/vitest/vitest.mjs run test/kit-designer-e2e-live-tdm60.test.ts --reporter=verbose
```

Expected size: two image builds, plus about 44 proof computers for a kit like the live one above
(20 trials and 24 gate runs on docker-local).

## Live spend (Naïve)

| what | µ$ |
|---|---|
| understander, ripgrep | 4,056 |
| kit designer, ripgrep (1 session, valid first draft) | 128,646 |
| understander, Tandem | 4,538 |
| kit designer, Tandem | 0 (holds before any session) |
| e2e attempt 1 (stopped in 429 retries, nothing created) | 0 |
| model listing (`models.list`) | 0 |
| **total** | **137,240** |

Session costs are from `agent_sessions.cost_micro_usd`. No computers were created on Naïve.
