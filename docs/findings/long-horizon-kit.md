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
   **Fixed in TDM-233**, see "The skeptic on this kit" below.
5. **BYOK key not stored yet.** Before a run on the server, store the founder's key once:
   `pnpm tsx scripts/ops/store-byok-key.ts --owner <github-login>` (needs `ANYBENCH_KEK` on the
   worker too). Both done in TDM-234; see the last section. The curated orchestrator (`apps/server/src/orchestrator/curated.ts`) still maps
   the Tandem repo to `kits/tandem-vs-claude-code` and its Naïve-proxy disclosure; pointing it at
   this kit and `tokens: anthropic-key, effort: default, thinking: on` is TDM-213's.
   **Done in TDM-233**: the Tandem repo now defaults to this kit (see below).

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

## The skeptic on this kit, and the curated default (TDM-233)

Before (`runSkepticChecks(kits/tandem-long-horizon)` from a scratch script on `packages/kit/dist`):

```
block solution_leakage    instruction.md copies the hidden assertion message "an attempt in flight is not counted"
block solution_leakage    instruction.md quotes 11 value(s) the hidden assertions use: "In progress", "?moveTo=", "?archived=false", …
block answer_in_workloads input/fixtures/tracker-v1.json: identical to the scoring file gates/hidden-tests/project-tracker/fixtures/tracker-v1.json
block answer_in_workloads instruction.md names the hidden test "deleting a card deletes its comments"
block weak_do_less        the only do-less variant 'do-nothing' is a no-op
```

Verdicts:

1. **Assertion message: false positive.** The sentence is the contract's definition of
   `attempts` ("counts finished attempts; an attempt in flight is not counted"). The test author
   traced the assertion to it, as plan.md 17.2 rule 9 asks. (Its evidence also pointed at line 5:
   `lineOfText` missed the phrase because it wraps. It now matches across whitespace: line 454.)
2. **11 quoted values: false positive.** They are routes (`POST /teams`), query parameters
   (`?moveTo=`, `?limit=`), the documented default column names, and the rate-limit example
   ("request 3"). That is the observable contract, not the oracle's code.
3. **Hidden test name: false positive.** "Deleting a card deletes its comments." is a contract
   bullet; the test is named after the requirement it checks.
4. **tracker-v1.json copy: false positive.** It is an input (the task is to migrate it, and
   "do not edit it"); the gate keeps its own byte-identical copy so a contender that edits the
   workspace copy can't change the grade (`gates/hidden-tests/grade.mjs`).
5. **weak_do_less: real.** Nothing showed that the gate refuses a near miss, only an empty repo.

Fixes: two explicit declarations in KitSpec, honored only when the kit makes them, and one real
proof variant.

- `workloads[].instruction_kind: contract`. For such a workload, test names, assertion messages
  and asserted values in its instruction are tallied, not blocked. In their place, the
  instruction may copy no line of the oracle's or the hidden tests' code (at least 24 chars with code
  punctuation, not already in the starting repo): 3 or more copied lines block. The bug-ticket
  rule-list check, scoring-path pointers and hidden test FILE names still block. Every
  declaration is reported as a `warn` finding: "1 hidden test name(s), 1 assertion message(s) and
  11 asserted value(s) appear … Checked instead: it copies no line of the oracle's code (1310 lines
  compared) or the hidden tests' code (1990 lines compared)".
- `gates[].fixtures: [gates/hidden-tests/*/fixtures/]`. Paths must be under `gates/<id>/`
  (KitSpecSchema refuses anything else, and `**`). A workload input file that is byte-identical to
  a declared fixture becomes a disclosed `warn`. Any other scoring file, or a fixture with an
  answer-shaped name (expected, golden, ...), still blocks. The `*` segment already covers
  `gates/hidden-tests/project-tracker-xl/fixtures/` (TDM-236), whether or not the manifest lists
  xl yet.
- `proof/do_less/partial-oracle/` (`kind: partial-oracle`): the oracle with feature area 8
  (webhooks, 9 routes) cut out of `src/app.ts`. It exits 2 if the cut doesn't apply. On
  project-tracker-xl it applies the v1 oracle. `scripts/verify-proof.sh --write` (Docker,
  `--network none`):

  ```
  | partial-oracle | 1 | cce5f9b | 106/120 | 14 | false | 5 s | 13 pass, 2 fail |
  partial-oracle (the oracle without the webhooks area) fails 14 hidden tests, every webhooks test among them.
  RESULT: PASS
  ```
  The 14 failures are all 11 webhooks tests, plus 2 persistence tests and 1 audit test that use
  webhooks.

After: 0 blocks. The remaining warnings are the contract declaration, the fixture copy,
`quality` weight before a judge audit, 1 task, and 5 repeats. Existing leakage fixtures
(`skeptic-tdm187`) still block.

Curated (`apps/server/src/orchestrator/curated.ts`): the Tandem repo now defaults to
`kits/tandem-long-horizon` (the whole kit; "smoke" gives 1 repeat per setup on project-tracker, 2
trials). `kits/tandem-vs-claude-code` is still selectable: name it in the question, say "short
tasks", or ask for the "null pilot" (that pilot is the short kit's A/A profile). The run page's
kit-designer message names the kit, its disclosure and how to pick the other one. The analyst's
disclosure follows the kit the spec came from: `tokens: anthropic-key, effort: default, thinking: on`
for this kit, the Naïve-proxy line for the short one. Proof uses this kit's own signed-off PROOF.md
(`LONG_HORIZON_PROOF_SIGNOFF` in proof-score.ts, sha256 `da916780…`): a regenerated PROOF.md
holds the run until someone signs it off again.

## The project-tracker-xl oracle and proof (TDM-238)

The reference solution `kits/tandem-long-horizon/proof/oracle/project-tracker-xl/` (10 source
files, about 5,400 lines, zero dependencies, erasable TypeScript) started as TDM-237's throwaway
reference, written from `instruction.md` alone, which scored 593/600 through the real gate. Read
against the whole contract, three things had to change: its own tests imported
`../.hidden-tests/helpers.ts`, so `npm test` failed in any workspace the gate had not touched (now
`test/support.ts`, its own client, clock and webhook event log); a label rename rewrote the
`label` values of every saved view of the team, even views without that label; and a multiselect
`contains` condition accepted an array as well as one option. `src/main.ts` was dropped from the
overlay (identical to the starting repo's, which the skeptic blocks as a scoring file copied into
the workload); `.oracle-delete` removes the skeleton's `router.ts` and `http.ts`.

The 7 misses were bugs in half-1 TESTS, not the oracle (each contradicts the contract):

```
cards.test.ts       the due job emits card.due once, ...            fake clock past 24 h, default tokenTtlMs
cards.test.ts       the due job is rescheduled by a new dueDate, ...  same
persistence.test.ts pending jobs survive a restart ...             same (both apps)
migration.test.ts   a migrated card gets a due job only ...         same
sprints.test.ts     burndown has one entry per date ...             same
sprints.test.ts     burndown reads the current cards ...            same
audit.test.ts       failed requests, reads, /me routes, ...         watch with a token POST /me/password revoked
```

The six clock tests now start with `tokenTtlMs: LONG_TTL` (helpers-pipeline.ts's ten years); the
audit test logs in again and uses the new token. The webhook test "deleting a webhook cancels its
pending retries" relied on deleting the webhook inside an 800 ms real-timer retry window; it now
uses `retryDelaysMs: [3000]`, the same deadline polling. Gate on the fixed tests, on the host:

```
$ gate.sh fix1      # setup.sh, proof/oracle/driver.sh, check.sh with scripts/ab-run-local.sh
secs=56
600/600
```

The partial oracle on xl as TDM-233 wired it (the v1 oracle) applies cleanly but is no near miss:

```
67/600 hidden tests passed (apikeys 0/23, plans 0/23, fields 0/30, ... search 12/14)
```

It now cuts the 8 webhook routes out of the xl oracle's `src/r_basics.ts` (the same markers and
exit-2 guard as v1): 515/600 in Docker, gate fails, all 12 webhooks tests fail, and 73 tests of
other areas that observe events through a webhook (`eventLog`) fail with them.

Nine points no hidden test depends on are settled in `instruction.md` with one sentence each
(README "project-tracker-xl (TDM-238)"; `test/contract.test.ts` checks the oracle's reading):
an empty or non-ASCII `Idempotency-Key` is `400 invalid_header` (checked with a raw socket; fetch
refuses such a header); archived cards that follow `?moveTo` keep `completedAt`; a view's `label`
values are rewritten in place, not sorted, and views without the name are untouched; `PATCH
sprintId` naming a completed sprint is `400 invalid_body` before `409 sprint_state`; a multiselect
`contains` value is one option; `is_set` takes no value or `null`; `customFields` condition values
are normalised (text trimmed), `title` values are not; a broken CSV header reports only header
errors, and `not_found` / `duplicate_row` rows are checked but get no `field_required`; a
CSV-created card's `createdBy` is the caller.

`scripts/verify-proof.sh` now proves both workloads (`PROOF_WORKLOADS` narrows it) and takes
`PROOF_CPUSET` (`docker run --cpuset-cpus`), so the test runner sees and starts that many
processes; the default is unchanged. An oracle miss prints its failing tests. The first run, on
2 CPUs, overlapped the laptop sleeping:

```
project-tracker-xl oracle #1: 583/600 (8899 s: the machine slept mid-run)
project-tracker-xl oracle #2: 591/600 (318 s, host load ~19)
project-tracker-xl oracle #3: 600/600
```

The misses were not printed then (they are now). A diagnostic run of the same gate on the same
2-CPU container afterwards was 600/600 in 155 s, and on the host at `--test-concurrency=2`
600/600 in 83 s. The recorded run (`PROOF_CPUSET=0-1 scripts/verify-proof.sh --write`, host load
5.4):

```
project-tracker oracle #1..#3: 120/120, gate true, 27 s each
project-tracker do-nothing #1: 1/120
project-tracker partial-oracle #1: 106/120, gate false
project-tracker-xl oracle #1: 600/600, gate true, 159 s, own tests 19 pass 0 fail
project-tracker-xl oracle #2: 600/600, gate true, 166 s, own tests 19 pass 0 fail
project-tracker-xl oracle #3: 600/600, gate true, 219 s, own tests 19 pass 0 fail
project-tracker-xl do-nothing #1: 1/600, gate false, 7 s
project-tracker-xl partial-oracle #1: 515/600, gate false, 262 s
RESULT: PASS
```

What this says about the gate: with webhook retries and timeouts on real timers (section 0.6), a
starved machine (a laptop going to sleep, load ~19 on 2 CPUs) can cost a correct app a handful of
tests. On a scoring computer that has the CPUs to itself the xl gate has not missed. The kit
signs off this PROOF.md (`LONG_HORIZON_PROOF_SIGNOFF` in apps/server proof-score.ts).

`anybench.yaml` lists `project-tracker-xl` next to `project-tracker` (same gate, requirements,
3 h cap, `instruction_kind: contract`). `validateKitDir`: ok, no errors. `runSkepticChecks`: 0
blocks; the xl contract declaration is a warning ("copies no line of the oracle's code (3609 lines
compared) or the hidden tests' code (8910 lines compared)"), plus the fixture copy, `quality`
weight, 2 tasks and 5 repeats.
