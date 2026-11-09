# Harness league run 1: five setups on the whole-app task (TDM-229 [21.3], 2026-11-09)

Run `01a1c202-260f-7b8a-b8a6-49ac06cb995d` on the live app: `kits/harness-league`, workload
`project-tracker` (v1, 120 hidden tests), Claude Opus 5.5 (`claude-opus-5-5`) on Claude Code
2.1.319, the founder's Anthropic key, $25 and 3 h cap per trial, BYOK limit $190. Go at 20:31:47
UTC. It held in `paused_budget` at 22:14:54 ("BYOK tokens spent $178.27 ... 6 trial(s) not
started"), the founder settled, and it was delivered at 22:21:45. 19 trials ended (16 passed the
gate, 3 `failed_subject`), 6 were never started.

**Headline.** On this task every setup that was graded passed 120/120 in every trial. gstack and
Superpowers matched solo on wall time and cost to within about 3%, and in 9 trials the model
invoked none of their skills. Tandem took 2.1× solo's wall time and 4.0× its tokens. The
subagents setup scored 0%, but **that 0% is our bug, not a result**: the deployed runner is a
stale binary that over-counts spend 4 to 5×. It stopped B's three trials at the "$25 cap" when
they had spent $6.48 to $7.88, after they had finished, and before the driver could freeze the
workspace. The same bug inflated Tandem's cost by 1.6× and the run's Anthropic spend from
**$87.71 (real) to $184.80 (recorded)**, and that is why 6 trials never started.

## How the evidence was read

Read-only. Trial rows and events came from the API (`ANYBENCH_API_KEY` with `runs:read`, never
printed). The bundles (`out.tar.gz`) came from `ArtifactStore.createDownload`, configured from
`.env` (S3_*) in-process, never printed:

```sh
curl -s -H "authorization: Bearer $ANYBENCH_API_KEY" $ANYBENCH_API_URL/runs/$R/trials?limit=50
curl -s -H "authorization: Bearer $ANYBENCH_API_KEY" $ANYBENCH_API_URL/trials/<trial>        # x19
curl -s -H "authorization: Bearer $ANYBENCH_API_KEY" "$ANYBENCH_API_URL/runs/$R/events?after=<seq>&limit=500"   # 306 events
pnpm exec tsx --env-file=.env scripts/spikes/harness-league/download-bundles.ts $R <dir> <19 trial ids>
#  01a1c202-8a2f-7637-b74a-8f15194334f9 429530 (ticket 429530)   ... 19 bundles, sizes match the tickets
pnpm exec tsx scripts/spikes/long-horizon-calibration/analyze.ts <dir>/*    # per-session totals + buildTrialTrace
pnpm exec tsx scripts/spikes/harness-league/replay-meter.ts <bundle>/stdout.log ...
pnpm exec tsx scripts/spikes/harness-league/within-task-stats.ts <stats-input.json>
```

"Claude Code's total" below is the session's latest `result.total_cost_usd` (list price,
`costBasis: "list"`, Opus 5.5 at $4 / $20 / $0.20 / $5 per Mtok, the same prices bench's
`FIRST_PARTY_TOKEN_PRICES` gives the runner), summed over sessions. "Metered" is what the app
stored (`trials.metrics.byok_token_cost_micro_usd`, from the runner's meter). The Anthropic Console
was not read.

## Per setup

| | A solo | B + subagents | G + gstack | S + Superpowers | D Tandem ×3 |
| --- | --- | --- | --- | --- | --- |
| trials measured (planned 5) | 4 | 3 | 5 | 4 | 3 |
| hidden tests | 120/120 ×4 | **not graded** ("the outputs have no workspace/"); report: 0 | 120/120 ×5 | 120/120 ×4 | 120/120 ×3 |
| full-pass trials | 4/4 | 0/3 in the report (artifact) | 5/5 | 4/4 | 3/3 |
| wall, median (range) | 647 s (630–701) | 914 s (841–1170), ungated | 665 s (625–720) | 649 s (622–705) | 1338 s (1268–1615) |
| tokens per trial, Claude Code's total: mean (range) | $2.63 (2.46–2.88) | $7.06 (6.48–7.88) | $2.68 (2.37–2.93) | $2.71 (2.53–2.89) | $10.58 (8.52–12.25) |
| tokens per trial, as metered by the app | $2.63 | **$32.67** (31.54–34.07) | $2.68 | $2.71 | **$17.33** (13.63–21.31) |
| report's "cost per solved task" (tokens + compute) | $2.68 | n/a | $2.74 | $2.77 | $17.41 (corrected: $10.66) |
| sessions / result lines per trial | 1 / 1 | 1 / 4–5 | 1 / 1 | 1 / 1 | 4 / 7–10 |
| model turns (Σ `num_turns`) | 35–45 | 36–49 (lead) | 25–42 | 27–40 | 153–197 |
| peak context (one call) | 120k–129k | 121k–129k | 120k–131k | 124k–135k | 202k–215k |
| compactions | 0 | 0 | 0 | 0 | 0 |
| `Skill` tool calls | 0 | 0 | **0** | **0** | 0 |
| subagent (`Agent`) calls | disallowed | 4–5 per trial, all `run_in_background` | 0 | 0 | disallowed |
| hooks fired | none | none | none | `SessionStart:startup` 4/4 | n/a |
| questions auto-answered (headless-v1) | 0* | 0* | 0* | 0* | n/a |

\* The policy did not run in any trial (see "Headless policy" below). On each trial's final
message the policy's own `decide()` returns `no-question`, so it would not have fired either.

Retries: B repeat 1 and G repeat 4 each lost attempt 1 at `installing` to "naive internal_error
(500): the sandbox request failed" (`failed_infra`, $0 of tokens) and ran again as attempt 2.
Unstarted (cancelled at settle): A ×1, B ×2, S ×1, D ×2.

## 1. Subagents: where did the work go? The 0% is an artifact

**The work was in the graded workspace, and it was finished. The workspace was never frozen,
because our runner killed the driver first. "0%" is not a score. B's hidden-test result is
unknown.**

- **No worktrees, no other directory.** All 5 `system/init` lines of each B session have
  `cwd: /home/tenki/eval/ws`. There are 0 `EnterWorktree`/`ExitWorktree` calls, and the `Agent`
  inputs carry only `description, prompt, subagent_type[, run_in_background]` (no isolation).
  Every `Write`/`Edit` by the lead and by the subagents targets `/home/tenki/eval/ws/...`
  (lead 15 / 5 / 18, subagents 10 / 5 / 13 writes per trial). The only other paths are scratch
  probes in `/tmp` (`/tmp/probe/p1.ts`, `/tmp/pt/d.json.v1.bak`).
- **The sessions finished.** Final messages: "I've built the whole project-tracker 2.0 API on
  `node:http`. `npm test` passes all 164 tests, and three full runs in a row gave the same
  result" (r0), and summaries with known limits for r1 and r2. `terminal_reason: completed` on
  every result.
- **What stopped it.** With background subagents, Claude Code 2.1.319 writes one `result` per
  lead turn ("Waiting on the four agents...", "Still waiting on the three test-writers.", ...,
  then the final summary). In r0 all five come at the very end of the stream, after the last
  timestamped line (21:32:05.267). Each carries the session's running total, `total_cost_usd:
  6.8140478`. The runner on the trial computer added them up: the 4th one crossed $25, and it
  killed the verb.

  ```
  21:32:06.023 trial.phase running → failed_subject: token cap exceeded during run: spent $27.26
               (27256192 micro-USD, reported) over the $25.00 cap (25000000 micro-USD); tokens in 186
               out 2945 cache_read 4696969 cache_write 359766
  ```

  4 × $6.8140478 = $27.256191 → 27,256,192 µ$ (rounded up), exactly. The final record is
  5 × = 34,070,240 µ$, the trial's `byok_token_cost_micro_usd`. Same for r1
  (4 × 6.483708 = 25,934,832 tripped, 5 × = 32,418,540 recorded) and r2 (4 × 7.884146 =
  31,536,584). `coding-agent/driver.sh` copies the workspace into `$EVAL_OUT/workspace/` only
  after `claude` exits, and the kill landed first. The manifest (`frozen_at` 21:32:05.343) lists
  `claude.stderr.log, machine.json, stderr.log, stdout.log, stream.jsonl, versions.json` and no
  `workspace/`.
- **Why "frozen_workspace present, workspace_files 3, grading graded".** bench `frozen.ts`
  counts every manifest file that is not the runner's own as a workspace file, so the driver's
  `stream.jsonl`, `versions.json` and `claude.stderr.log` read as "3 workspace files, present".
  `trial.gate` then graded that, and the gate refused it: `trial.gate {"passed": false,
  "summary": "the outputs have no workspace/"}` (1.0 to 1.2 s, no evidence). The verdict has no
  `hidden_test_fraction`, and the scorer counts a trial without the metric "as its gate's verdict
  (... fail = 0)" (score.ts `all_trials`). That gives 0 pts. (`gate: null` in `GET /trials/:id`
  holds for every trial in this run, including the 16 passing ones. The verdicts are in the
  `trial.gate` events.)
- **What we can say about B.** It ran the roster as designed: an implementer (in 2 of the 3
  trials), 2 to 4 test-writers and a reviewer, in the background, plus 3 to 6 `ScheduleWakeup` calls.
  Its own tests passed locally (164 in r0, 89/89 at the reviewer's check). It cost $6.48 to
  $7.88 by Claude Code's totals (2.7× solo) and ran 841 to 1170 s. None of that is gated, so
  none of it is a result. The trial computers are destroyed, so the workspaces are gone. **B has
  to run again** on a fixed runner.

## 2. The cap overshoot: a stale runner binary, not invisible subagent usage

**Subagent usage is in the parent's stream-json, live. The overshoot is the production runner,
which is the TDM-160 meter from 2026-11-07 and sums every `result`'s cumulative total.** The
fixes from TDM-231 (output estimate) and TDM-239 (e3e4b93, "latest total, not the sum") never
reached production.

- **Live visibility.** Each B session has 52 to 56 subagent messages (`parent_tool_use_id`
  set), each with `usage`, timestamped while the subagent runs. In r0 the implementer's lines run
  21:18:07 to 21:19:39, and the last test-writer's 21:24:39 to 21:31:07. Claude Code's
  `modelUsage` (203,754 output, 4,696,969 cache read, $6.81) includes them. The parent's own
  `usage` (65,031 output) does not.
- **The current meter gets it right.** `replay-meter.ts` feeds each bundle's `stdout.log` (the
  runner's input) through this branch's `TokenMeter` with the worker's prices:

  | trial | runner said (prod) | recorded | current meter at end | its live estimate before results | trips $25? |
  | --- | --- | --- | --- | --- | --- |
  | B r0 `…94334f9` | $27.26 at the 4th result | $34.07 | $6.81 (reported) | $6.60 | never |
  | B r1 `…7548a8` | $25.93 at the 4th result | $32.42 | $6.48 | $6.30 | never |
  | B r2 `…48c3e1` | $31.54 at the 4th (last) result | $31.54 | $7.88 | $7.35 | never |
  | D r0 `…f8c2e6` | | $17.05 | $12.25 | $12.09 | never |
  | D r1 `…17357d` | | $13.63 | $8.52 | $8.51 | never |
  | D r3 `…dc3ee6` | | $21.31 | $11.13 (10.97 + open tail) | $11.09 | never |

- **It is the old code.** The production reason string is a0bad55's (TDM-160) `budgetReason`
  word for word, with no "with a $X margin (N% of M unreported session(s))" clause, and the
  "out 2945" is the per-message start-of-message count that TDM-231 replaced. The binaries the
  deploy ships are `packages/runner/dist/bin/runner-linux-{x64,arm64}`, dated **Nov 7 21:19**
  on the deploying Mac. They contain `token cap crossed` but none of `thinking_tokens`,
  `output_chars`, `estimateAtResult`, `margin_pct`:

  ```sh
  for s in "token cap crossed" thinking_tokens output_chars estimateAtResult margin_pct; do
    printf '%s: ' "$s"; LC_ALL=C grep -a -c "$s" packages/runner/dist/bin/runner-linux-x64; done
  # token cap crossed: 1  thinking_tokens: 0  output_chars: 0  estimateAtResult: 0  margin_pct: 0
  ```

  `scripts/deploy/worker.ts` runs `build:bin` only `if (!bins.every((f) => existsSync(f)))`.
  The binaries existed, so every deploy since Nov 7 shipped the Nov 7 runner, and the env
  snapshot (its hash includes the runner's sha256) was built with it.
- **Per trial, recorded ÷ real:** B 5.00×, 5.00×, 4.00×; D 1.39×, 1.60×, 1.94×; A, G, S 1.00×
  (one result each). By setup: B $98.03 recorded vs $21.18 real, D $51.99 vs $31.74, A/G/S
  equal.

## 3. Were the skills used? No

| | G gstack (5 trials) | S Superpowers (4 trials) |
| --- | --- | --- |
| loaded (`system/init`) | 78 skills, 106 slash commands incl. `gstack`, `office-hours`, `review`, `qa`, `ship`, `autoplan`, `browse` | 31 skills incl. 15 `superpowers:*`; plugin `superpowers` |
| `Skill` tool calls | **0** | **0** |
| slash commands in the transcript | 0 | 0 |
| `Agent` / subagent dispatch | 0 | 0 |
| hooks | none fired | `SessionStart:startup` once per trial (exit 0, about 3.6k chars of output) |
| mentions in what the model wrote | 1: `ls ~/.anybench/homes/gstack/.claude/projects/.../memory/` (a memory-dir check) | 1: "The spec is complete and precise, so I'll go straight to implementation (no design questions to brainstorm)." (r3) |
| questions auto-answered | 0 (no question asked) | 0 |

The tool sequences match solo's: Write ×5–26 and Bash ×11–19, one session, no plan files, no TDD
loop beyond what solo does. So **"no difference vs solo" here means "installing the pack changed
nothing because Claude Code did not invoke it on a fully specified task"**. It is not "the skills
were used and did not help". The headless-policy smokes saw the same thing (TDM-228: Superpowers
built through without brainstorming in 3 of 3 runs).

### Headless policy: it did not run

No Claude Code trial's `stream.jsonl` has `system/anybench_headless_policy`. The shim writes
that event first on every policy run, before Claude Code's `init`. So `questions_auto_answered`
is absent from all 19 trials' metrics (the collector clears it when the policy is missing), and
the report has no auto-answer line. Most likely cause, from the code (not reproduced on a
computer): apps/server `subjectPlan` stages every kit file with
`mode: f.path.endsWith(".sh") ? 0o755 : 0o644`. `adapters/headless-policy/bin/claude` is a bash
script without `.sh`, so it lands non-executable. Bash's `PATH` lookup skips it, and the driver
runs the real `claude` with no shim. Effect on this run: none on outcomes. `decide()` from
`policy.mjs`, run over each of the 16 Claude Code trials' final `result`, returns
`would_fire=false reason=no-question` every time. But the report's disclosure ("headless policy
headless-v1 for every Claude Code setup ...") describes a policy that was not in effect.

## 4. Tandem: where the time and tokens went

Trace builder (`buildTrialTrace`, via analyze.ts) over the 4 transcripts of each trial:

| per trial | r0 `…f8c2e6` | r1 `…17357d` | r3 `…dc3ee6` | avg | solo avg |
| --- | --- | --- | --- | --- | --- |
| wall | 1269 s | 1337 s | 1615 s | 1407 s (2.14×) | 657 s |
| phases: planning / work / teardown | 239 / 1024 / 2 s | 145 / 1081 / 106 s | 275 / 1276 / 58 s | 220 / 1127 / 55 s | |
| model call in flight (wall) | 1224 s | 1225 s | 1509 s | 1319 s | 632 s |
| only board calls or waits in flight | 30.3 s | 0.1 s | 32.6 s | 21 s | 0 |
| nothing running | 6.6 s | 110.6 s | 63.0 s | 60 s | 2.5 s |
| model time summed over sessions | 2693 s | 3161 s | 3699 s | 3184 s | |
| of which board-only turns | 1533 s (57%) | 2149 s (68%) | 2328 s (63%) | 2003 s (63%) | |
| blocked in `queue_wait` (summed) | 240 s | 0.05 s | 120 s | 120 s | |
| board calls / test runs | 72 / 30 | 48 / 20 | 64 / 21 | | 0 / 7 |
| tickets done, by worker | 12: w2 5, w3 4, w1 3 | 9: **w1 7**, w2 1, w3 1 | 10: w3 5, w2 4, w1 1 | | |
| lost claims | 3 | 3 | 5 | 3.7 | |
| cost: planner / w1 / w2 / w3 (Claude Code) | 0.91 / 3.44 / 4.24 / 3.66 | 0.57 / 4.88 / 1.70 / 1.38 | 1.05 / 1.82 / 4.34 / 3.76 | $10.58 (4.0×) | $2.63 |
| cache-read tokens | 22.5M | 13.4M | 18.4M | 18.1M | 2.4M |

The pattern is E18's (`trial-traces.md`, `long-horizon-calibration.md`). Almost all of the wall
time has a model call in flight. Two thirds of the summed model time goes to turns whose only
tool calls are board calls. Each worker re-reads its own ~100k to 200k context on every turn,
which is where the 7.5× cache reads come from. Parallelism is uneven: in r1 one worker did 7 of
the 9 tickets (78 turns) while the others did 1 each (3 turns each). Every Tandem session
reported a result, so the token figures are complete.

## 5. Statistics, for the record

The report compares each setup to solo `task_paired` over tasks. With 1 task, the exact test
"can't go below p=1.000", so every p and every Holm p in the report is 1 by construction
(family 20). Within the one task, each gated setup's trials vs solo's, using bench's own
`permutationMeanTest` (exact, two-sided, difference in means), `mannWhitney` as a check, and
`holmAdjust` across the family. B is excluded: none of its trials has a passing gate, and the
product rule is no speed or cost number without one.

```
$ pnpm exec tsx scripts/spikes/harness-league/within-task-stats.ts stats-input.json
skip B subagents: 3 of 3 trials have no passing gate

family: wall_s + cost_reported_micro_usd (6 comparisons vs A solo, Holm)
setup          metric                        n       mean ratio  perm p   MW p     floor    Holm p
G gstack       wall_s                        5 vs 4       1.023  0.5079   0.5556   0.0159   1.0000
G gstack       cost_reported_micro_usd       5 vs 4       1.020  0.6825   0.5556   0.0159   1.0000
D tandem       wall_s                        3 vs 4       2.143  0.0286   0.0571   0.0571   0.1714
D tandem       cost_reported_micro_usd       3 vs 4       6.488  0.0286   0.0571   0.0571   0.1714
S superpowers  wall_s                        4 vs 4       0.999  0.9714   1.0000   0.0286   1.0000
S superpowers  cost_reported_micro_usd       4 vs 4       1.032  0.5429   0.4857   0.0286   1.0000

family: wall_s + cost_claude_code_micro_usd (6 comparisons vs A solo, Holm)
D tandem       cost_claude_code_micro_usd    3 vs 4       3.972  0.0286   0.0571   0.0571   0.1714
(G, S and D wall rows identical to the family above)
```

Cost here is per trial: compute share plus tokens, either metered or Claude Code's. Correctness
needs no test: every gated trial is 120/120, so `fisherExact` on full passes and the
hidden-fraction permutation are both p = 1.

**Smallest p reachable at these n's.** A two-sided exact two-sample test over n1 vs n2 trials
has C(n1+n2, n1) splits. The most extreme data reach 2/C (`minMannWhitneyP`), or 1/C for the
permutation-on-means test when n1 ≠ n2 and only one tail is that extreme:

| vs solo (n=4) | splits | floor, two-sided | Holm floor over 6 comparisons |
| --- | --- | --- | --- |
| G, n=5 | 126 | 0.0079 to 0.0159 | 0.048 to 0.095 |
| S, n=4 | 70 | 0.0286 | 0.171 |
| D, n=3 | 35 | 0.0286 to 0.0571 | 0.171 to 0.343 |

D's 0.0286 is the most extreme split possible: all 3 Tandem trials slower and dearer than all 4
solo trials. After Holm over the six it is 0.171. At these n's **no comparison except G's could
reach significance under Holm, whatever the data**, and G's only with every gstack trial beyond
every solo trial. The bench docstring for `permutationMeanTest` gives the floor as 2/C, but with
unequal n it can be 1/C (D: 0.0286 < 2/35).

## Total spend

| | |
| --- | --- |
| **Anthropic tokens, real** (Claude Code's session totals, list price, 19 trials) | **$87.71**: A $10.52, B $21.18, D $31.74, G $13.42, S $10.86 |
| Anthropic tokens, as the app recorded (`runs.byok_token_micro_usd`) | $184.80 (184,802,762 µ$): B and D inflated by the stale meter |
| the 2 `failed_infra` attempts | $0 (failed at `installing`) |
| Naïve trial computers (registry `blocks_billed`, 21 computers incl. the 2 failed attempts) | 43 blocks × $0.0552 = **$2.37** at Naïve's rate |
| the run's ledger (billed, comped for an admin) | compute $1.70 (= $1.13 at cost × 1.5), run fee $2.00, total $3.70; nothing reached the card |
| scoring computers (19 gates) and env build | not in the run's events; env build was a cache hit ("already built for this kit; reusing the snapshot") |

The run held at "BYOK tokens spent $178.27 + ... $25.00 for the next trial at its cap would pass
the $190.00 BYOK token limit". At real spend ($87.71 for all 19) the 6 unstarted trials
(about $41 at the measured means) would have fit easily.

## What we can and cannot claim (for the blog and the X thread, TDM-230)

We **can** say, about this one task (a fully specified multi-user project-tracker API, 12 areas,
120 hidden tests), Claude Opus 5.5 on Claude Code 2.1.319, 3 to 5 trials per setup:

1. **Plain Claude Code solved it every time.** 4 of 4 trials passed all 120 hidden tests, in a
   median 10 m 47 s for about $2.63 of tokens at list price.
2. **gstack (v1.98.0.0) and Superpowers (v7.0.2), installed per their READMEs, made no measurable
   difference.** They passed 120/120 in every trial (5 and 4), wall within 3% of solo
   (permutation p 0.51 and 0.97), tokens within 2 to 3% (p 0.68 and 0.54). **And Claude never
   invoked them: 0 skill calls in 9 trials.** The skills were loaded, and Superpowers' startup
   hook ran in every trial, but the model built the app directly. One Superpowers session said
   "no design questions to brainstorm". The honest line is "on a fully specified task the skill
   packs sat unused". It is not "skills don't help".
3. **Tandem ×3 got the same 120/120, slower and dearer:** 2.1× the wall time (23.5 vs 11 min)
   and 4.0× the tokens ($10.58 vs $2.63) on average, across 3 vs 4 trials. Every Tandem trial
   was slower and dearer than every solo trial (exact permutation p = 0.029 for each, the
   smallest possible at 3 vs 4; 0.17 after Holm over six comparisons). This is the same
   direction and size as the E18 calibration (1.6× wall, 3.1× cost on this task). About two
   thirds of Tandem's model time went to turns that only talked to the board.
4. Correctness is at the ceiling on this task, so it cannot separate setups.

We **cannot** say:

1. **Anything about Claude Code + subagents.** The report's 0% is our bug: the runner stopped
   those trials after they had finished and before their code was saved, so they were never
   graded. Their cost ($6.48 to $7.88 a trial, about 2.7× solo) and wall (14 to 20 min) are
   ungated and must not be quoted as results. They have to run again.
2. **That any difference is statistically significant.** It is one task. The report's own
   comparisons are p = 1 by construction. Within the task, the best adjusted p is 0.17, and at
   these n's only gstack could have reached significance at all.
3. **That this generalises** beyond this task, this model, this Claude Code version, or to
   underspecified work where planning or brainstorming skills are meant to matter.
4. **Tandem's cost as the report prints it ($17.41 per solved task)**, or "$184.80 spent".
   Both are inflated by the meter bug. Use $10.66 per solved task (tokens + compute) and $87.71.
5. **That the headless policy was applied.** It was not in effect. No final message would have
   triggered it, so the results stand, but the disclosure line is wrong for this run.
6. **That each setup had n = 5.** It had 4, 3, 5, 4, 3 (6 trials never started because of the
   inflated spend).

## Bug tickets to file

1. **Worker deploy ships stale runner binaries.**
   Surface: `scripts/deploy/worker.ts` (`build:bin` only when the files are missing),
   `scripts/deploy/lib/worker-bundle.ts`. Done: the deploy always rebuilds
   `packages/runner/dist/bin/*` from the commit it deploys, or refuses when they are older than
   `packages/runner/src`. The release manifest records the runner's commit, and the runner
   reports it in `status.json` and on the trial (`versions` or an event). A test covers a stale
   binary. Then redeploy, and confirm a live trial's cap reason carries TDM-231's "with a $X
   margin" clause.
2. **A token-cap stop loses the frozen workspace.**
   Surface: `packages/runner` (`runner.ts` budget stop / `exec.ts` abort) and
   `kits/*/adapters/claude-code/driver.sh`. Done: when the cap (or the run's budget stop) kills
   the subject, the workspace is still frozen. Either the runner sends TERM to `claude` only and
   gives the driver a grace period to copy `$EVAL_WS`, or the runner itself freezes `EVAL_WS`
   into `$EVAL_OUT/workspace/` when the driver did not. Shown by a runner test that trips the
   cap mid-run and finds `workspace/` in the bundle and a graded `hidden_test_fraction`.
3. **frozen_workspace counts driver outputs as workspace files.**
   Surface: `packages/bench/src/frozen.ts` (`frozenWorkspaceFromManifest`). Done: for a kit whose
   gate reads `$EVAL_OUT/workspace/`, only `workspace/**` entries count. B's manifest (6 files,
   no `workspace/`) gives `present: false, workspace_files: 0`, so the trial is not "graded" on
   nothing.
4. **A trial whose workspace our infra lost is scored 0 as a subject failure.**
   Surface: `apps/server` `trial.gate` (a "the outputs have no workspace/" verdict) and bench
   `score.ts` (`all_trials`: a missing metric counts as the gate's fail). Done: a trial that
   ended by our runner's stop with no workspace is reported as "not graded (infra)". It is kept
   out of every requirement, the report names it, and run 01a1c202's B reads "not graded", not
   0 pts. Rescore the run (`scripts/ops/rescore-run.ts`) after 3 and 4.
5. **Recorded BYOK spend comes from the runner's live meter, not the session totals.**
   Surface: `apps/server/src/orchestrator/trial-metrics.ts` (`byok_token_cost_micro_usd`), the
   BYOK limit (`budget.ts`) and `scripts/ops/backfill-trial-metrics.ts`. Done: once the bundle
   is read, a trial's scored and limit-counted spend is the stream-json collector's figure (each
   session's latest `total_cost_usd`). The live meter stays only for the in-flight hard stop. A
   backfill of run 01a1c202 gives $87.71 total and D $8.52 / $10.97 / $12.25.
6. **The headless-policy shim is staged non-executable, and nothing notices.**
   Surface: `apps/server/src/orchestrator/env-build.ts` `subjectPlan` (mode from the `.sh`
   suffix only), `kits/harness-league/adapters/headless-policy/driver.sh`. Done: kit files keep
   their executable bit (or `bin/*` is 0755). The league driver exits 2 when `command -v claude`
   is not its own wrapper. A league trial's stream starts with `system/anybench_headless_policy`,
   every Claude Code trial has `questions_auto_answered` (0 or more), and the report shows the
   auto-answer line. The report must not print the headless-v1 disclosure for a trial without
   the policy event.
7. **Single-task reports have no within-task test.**
   Surface: `packages/bench/src/decide.ts` (the `task_paired` path at 1 task) and
   `apps/server` `proof-score.ts`. Done: with one task, the report also gives the exact
   within-task two-sample permutation (`permutationMeanTest`) per comparison with Holm over the
   family, and states each pair's floor. The answer says "within this task" in place of p = 1.
   Run 01a1c202 rescored reads D vs A wall p = 0.029 (Holm 0.17).
8. **The permutation floor is stated as 2/C.**
   Surface: `packages/bench/src/stats.ts` (`permutationMeanTest` doc) and `decide.ts`'s
   "too small to tell" floor. Done: the floor used for "too few trials" is the test's real
   minimum: 1/C(n1+n2, n1) when n1 ≠ n2 can make one tail unique, else 2/C. A test covers
   3 vs 4 (1/35).
9. **Trial compute share misses the computer's last block.**
   Surface: `packages/bench/src/executor.ts` `costShare` (read before `destroyComputer`).
   Done: a trial's `cost_micro_usd` equals what the registry bills for its computer.
   Run 01a1c202: trials store 55,200 µ$ (1 block) where `computer.destroyed` says
   `blocks_billed: 2`, and 82,800 where it says 3. The run's ledger shows $1.13 at cost against
   $2.37 of blocks.
10. **`GET /trials/:id` returns `gate: null` for gated trials.**
    Surface: apps/server `routes/trials.ts`. Done: the trial's gate verdict (pass, summary, the
    hidden-test counts) is in the trial response, as the `trial.gate` event has it.

## Files

- `scripts/spikes/harness-league/download-bundles.ts`: presigned download of a run's bundles.
- `scripts/spikes/harness-league/replay-meter.ts`: a bundle's stdout through the current
  `TokenMeter`.
- `scripts/spikes/harness-league/within-task-stats.ts`: the within-task permutation, Mann-Whitney
  and Holm table above.
- The report JSON as delivered: `GET /runs/01a1c202-260f-7b8a-b8a6-49ac06cb995d/report`
  (`generated_at` 2026-11-09T22:21:45.424Z).
