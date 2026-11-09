# Long-horizon kit on our own Anthropic key (TDM-212 [18.5], 2026-11-08)

What we learned writing `kits/tandem-long-horizon/anybench.yaml` and running one docker-local
smoke trial of `claude-code-solo` on real Anthropic tokens. Host: macOS arm64, Docker, `node:22`
(Debian, Node v22.23.4), Claude Code 2.1.319, runner 0.1.0 (bun binary).

## The kit

- Two setups (founder decision 2026-11-08): A `claude-code-solo` (baseline) and D `tandem`
  with `TANDEM_WORKERS=3` (subject). `claude-code-subagents` is the planned third setup.
- Model `claude-opus-5-5` (the first-party id for Claude Opus 5.5). It has no dated variant:
  Anthropic's ids from Opus 4.6 / Sonnet 4.6 on are the snapshot. `packages/kit` used to refuse
  every undated `claude-*` id as a moving alias (`model_unpinned`); `UNDATED_MODEL_SNAPSHOTS`
  now lists the 4.6+ ids, and the bash `is_pinned_model` of the generated drivers follows it.
- `AB_TOKEN_SOURCE=anthropic_key` for both, no proxy capability switches (no
  `MAX_THINKING_TOKENS`, `CLAUDE_CODE_MODEL_CAPABILITIES`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`),
  so Claude Code runs at its default effort with thinking on. Disclosure:
  `tokens: anthropic-key, effort: default, thinking: on`.
- Caps: `wall_clock_cap_s` and workload `timeout_s` 10800, `token_cap_micro_usd` 25000000.
- `validateKitDir` passes with no errors; the skeptic has no `token_source_unequal` or other
  comparability finding, and no `horizon_mismatch` (the workload's cap is 3 h; TDM-215).

## Things the template kit did not need, and this one does

1. **The runner's spend cap could not see A's tokens.** The template's `claude-code/driver.sh`
   wrote stream-json only to `$EVAL_OUT/stream.jsonl`; the runner's BYOK meter reads the run
   verb's stdout. On the Naïve proxy that did not matter (the proxy key had its own cap). The
   copied driver now pipes the stream through `adapters/tandem/board.ts tap` (as Tandem's
   sessions already did): the whole transcript to the file, compact usage/cost lines to stdout.
2. **The meter priced every model as Sonnet.** `TrialJob.token_prices` defaults to $3/$15; the
   worker never set it. `packages/bench` `FIRST_PARTY_TOKEN_PRICES` now gives the runner Opus 5.5
   list prices ($4 in, $20 out, $0.20 cache read, $5 cache write per million).
3. **A timed-out A trial lost its workspace.** The runner kills the verb at the wall cap, before
   the driver's freeze step. The driver now stops Claude Code 60 s before `CC_WALL_CAP_S`.
4. **BYOK storage existed only as a table.** `apps/server/src/lib/byok.ts` adds the envelope
   encryption (AES-256-GCM data key, wrapped by `ANYBENCH_KEK`, owner and provider bound as
   AAD); the kit trial source decrypts the run owner's `anthropic` key into the trial's
   `ANTHROPIC_API_KEY` secret and refuses the trial when there is none.
   `scripts/ops/store-byok-key.ts --owner <login>` stores it from `.env`.
5. **Claude Code 2.1.319 has a `Workflow` tool** (multi-agent scripts) next to `Task`/`Agent`.
   The smoke's `system/init` listed it. Both setups now disallow `Task Agent Workflow`.

## Smoke trial

One trial, contender A, the exact TrialJob the worker builds (`preparedJob`), the real runner
binary in `node:22` (`--init`, non-root user `evaluser`), the runner's own BYOK cap set to $10
for the smoke (the kit's is $25), then the hidden-tests gate in a fresh `node:22` container with
`--network none`:

```sh
pnpm -r build && pnpm --filter @anybench/runner build:bin
node --env-file=.env --import tsx scripts/spikes/long-horizon-smoke/run-docker-local.ts --out <dir>
```

Runner log and the script's poll (every 30 s):

```
03:04:47 install: the kit's adapters/claude-code/install.sh (pinned Claude Code)
03:04:52 launch runner (wall cap 10800s, spend cap 10000000 micro-USD)
03:04:52 runner: phase prepare / healthcheck / warmup / run
03:05:22 phase run · 30s  · spend {"spent_micro_usd":"180721","source":"estimate"}
03:09:54 phase run · 302s · spend {"spent_micro_usd":"508742","source":"estimate"}
03:16:26 phase run · 694s · spend {"spent_micro_usd":"1223929","source":"estimate"}
03:16:42 runner: phase collect / freeze / upload; done (ok); push file_only, 52 events
03:16:56 phase done · 724s · spend {"spent_micro_usd":"3048356","source":"reported","exceeded":false}
gate: hidden-tests project-tracker: pass: 120/120 hidden tests passed
```

`system/init`: `"model":"claude-opus-5-5"`, `"apiKeySource":"ANTHROPIC_API_KEY"`,
`"claude_code_version":"2.1.319"`; no `Agent`/`Task` in the tool list (disallowed), but
`Workflow` was there (finding 5; this run predates the fix, and the transcript has 0 calls to it).
`versions.json`: `{"model":"claude-opus-5-5","setup":"claude-code-solo","token_source":"anthropic_key"}`.

| | |
| --- | --- |
| hidden tests | **120/120**, `hidden_test_fraction` 1.0, every `area_pass.<area>` 1.0, gate `pass: true` |
| wall | 724 s end to end (Claude Code `duration_ms` 706904, 46 turns) |
| tokens | input 74, output 88382 (thinking 20543), cache read 3044370, cache write 134309 |
| cost | **$3.05** (`total_cost_usd` 3.048355, `costBasis: list`, `modelUsage` only `claude-opus-5-5`) |
| peak context | 134311 tokens of a 1M window; no compaction |
| key | `key_leaks: []` over every file brought back (out/, gate/, trial.json, runner.log) |

The workspace was frozen by the driver (not the cap), and the agent wrote its own tests under
`test/` (10 files, one per area).

The smoke ran on `instruction.md` as of TDM-209 (1ad9703). TDM-211 (34af4a7) later added six
one-sentence clarifications that no hidden test depends on; the full run uses the newer text.

## For TDM-213

1. **The task does not stress one session.** Claude Code solo, at default effort with thinking
   on, built the whole app and passed 120/120 hidden tests in 12 minutes for $3.05, with a peak
   context of 134k tokens (no compaction). The kit was sized for "1 to 3 hours and likely
   compaction" (README); on Opus 5.5 it is neither. If A passes 100% every time, `tests-pass` and
   `tests-fraction` hit the ceiling and no repeat count can show Tandem better on them; only
   wall and cost can separate the setups. Decide before the full run: keep the prediction test
   as is (and expect "indistinguishable" on correctness), or make the workload harder (more
   areas, or a second phase), which is a change to the pre-registered kit and must be recorded
   as such. One trial is one sample, so run a second A trial first if budget allows.
2. **The runner's live spend estimate undercounts by about 2.5x.** Claude Code's stream-json
   `assistant` events carry the output-token count from the start of each message (the summed
   per-message usage gave 340 output tokens; the `result` line says 88382). The estimate read
   $1.22 at 694 s; the reported cost at the end was $3.05. The cap is max(estimate, reported),
   and `reported` arrives only when a session ends, so a runaway session can overshoot the $25
   cap before the runner stops it (Tandem: each session reports on its own exit). Budget TDM-213
   with that slack, or fix the meter (e.g. count output from the `result` lines of finished
   sessions plus a per-turn floor).
   **Fixed by TDM-231** (`docs/findings/token-cap-output-estimate.md`): output is now estimated
   from the emitted content and Claude Code's thinking-token events, spend is summed per session,
   and the cap keeps a 10% margin; the replay of this smoke reads +4.9% at the last message.
3. **A trial that ends `failed_subject` has no gate result.** A trial stopped by the wall cap or
   the spend cap, or whose driver exits non-zero, is final without `trial.gate`; the scorer then
   answers "no score: gate missing" for every gated requirement of the run
   (`packages/bench/src/score.ts` `judgedTrials`). With a 3 h cap and a $25 cap per trial that
   is a real risk for the first run.
   **Fixed by TDM-232**: the worker records `trials.frozen_workspace` from the runner's
   `manifest.json` when the runner ends; a `failed_subject` trial with workspace files in it is
   graded by `trial.gate` and keeps its outcome (the run waits for the grade). Its
   `hidden_test_fraction` counts as partial work; `gate_pass_rate`, wall (at the cap) and cost
   (against the solves) count it as failed. A subject failure with nothing to grade is a fail,
   never "gate missing". A failing hidden-tests verdict now also carries
   `hidden_test_fraction` / `hidden_tests_passed` / `hidden_tests_total` (before, only a passing
   verdict's metric rows were read, so a failed trial's fraction never reached `trials.metrics`).
   The report lists each such trial ("stopped at the token cap; graded on its frozen workspace
   (87 of 120 hidden tests)") and so does the trial drawer.
4. **The skeptic still blocks the kit**, on work outside this ticket: `solution_leakage` and
   `answer_in_workloads` on `instruction.md` and the byte-identical `tracker-v1.json` (TDM-208 /
   TDM-209; the fixture copy is identical by design), and `weak_do_less` (no partial oracles yet;
   TDM-211 shipped the full oracle and the no-op only).
   The curated path does not run the skeptic, but a kit upload would.
5. **BYOK key not stored yet.** Before a run on the server, store the founder's key once:
   `pnpm tsx scripts/ops/store-byok-key.ts --owner <github-login>` (needs `ANYBENCH_KEK` on the
   worker too). Both done in TDM-234; see the last section. The curated orchestrator (`apps/server/src/orchestrator/curated.ts`) still maps
   the Tandem repo to `kits/tandem-vs-claude-code` and its Naïve-proxy disclosure; pointing it at
   this kit and `tokens: anthropic-key, effort: default, thinking: on` is TDM-213's.

## Storing the BYOK key and getting the KEK to the deploys (TDM-234)

The founder's key was stored on 2026-11-08 (user `jaximus808`, the dev Neon branch both deploys
use, `round_trip: true`). Two gaps showed up doing it.

**The script did not run from the repo root.** `scripts/ops/store-byok-key.ts` imported
`drizzle-orm` itself, and the repo root has no `drizzle-orm` (only apps/server does), so:

```sh
$ pnpm tsx scripts/ops/store-byok-key.ts --owner jaximus808 --dry-run
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'drizzle-orm' imported from .../scripts/ops/store-byok-key.ts
```

The owner lookup moved into `apps/server/src/lib/byok.ts` (`findSecretOwner`), so every import
the script makes goes through apps/server and resolves from its node_modules. The other
`scripts/ops/*.ts` were already fine: they import only through `apps/server/src` or
`packages/*/src` (plus type-only imports, which tsx erases). Now, from the repo root (the
`.env` there is loaded for anything unset, like the server does), either form works:

```sh
$ pnpm tsx scripts/ops/store-byok-key.ts --owner jaximus808 --dry-run
{"owner":"jaximus808","user_id":"<uuid>","dry_run":true}
$ node --env-file=.env --import tsx scripts/ops/store-byok-key.ts --owner jaximus808 --dry-run
{"owner":"jaximus808","user_id":"<uuid>","dry_run":true}
```

(Both also print pg's `sslmode=require` deprecation warning on stderr.) `--dry-run` only reads
the users table. Without it the script seals `ANTHROPIC_API_KEY` under `ANYBENCH_KEK`, reads it
back and prints only `last4` and `round_trip`. A git worktree has no `.env`: use the
`node --env-file=<main checkout>/.env` form there.

**The deploys did not forward the KEK.** `scripts/deploy/lib/worker-plan.ts` and `api-plan.ts`
now read `ANYBENCH_KEK` and `ANYBENCH_KEK_PREVIOUS` from `.env`. Both are optional, but a set value
shorter than 32 characters is refused by name, the same floor `apps/server/src/config.ts` enforces
at boot. When set, they go into the worker's `~/.anybench/worker.env` and become owned API app
secrets. When unset, they are left out, so a re-deploy deletes a stale API secret. `--dry-run`
prints names only (`workerEnvPlanSummary`, `secretPlanSummary`). The worker's env fingerprint
changes when the KEK is added, so the next worker deploy replaces the computer.
