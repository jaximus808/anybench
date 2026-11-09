# Long-horizon calibration: one solo and one Tandem trial per rung (TDM-239 [18.18], 2026-11-09)

Before the full run (TDM-213), one trial of each setup on each rung of `kits/tandem-long-horizon`:
A `claude-code-solo` and D `tandem` (`TANDEM_WORKERS=3`), on `project-tracker` (120 hidden tests)
and `project-tracker-xl` (600). Claude Opus 5.5 (`claude-opus-5-5`), Claude Code 2.1.319, the
founder's Anthropic key, default effort, thinking on. Disclosure: `tokens: anthropic-key,
effort: default, thinking: on`.

**Headline: the flag is up.** Claude Code solo passed **599/600 on project-tracker-xl in 27 min
for $7.16**, with a peak context of 296k tokens and no compaction. xl is still too easy to
separate the setups on correctness: Tandem also scored 599/600 (it failed the same hidden test),
in 45 min for $30.81. The founder decides whether to scale the task again before TDM-213 spends
its budget.

## How the trials ran

**docker-local, not the golden path.** The golden path could not run these four trials without
the founder:

- Creating a run needs a session or an Anybench API key, and `POST /api-keys` takes a browser
  session only (`requireSessionActor`). No ops script mints a key or a session, and writing one
  was out of scope for this ticket.
- The curated path has no xl option: `curatedKitFor` + `"smoke"` gives `project-tracker` only
  (2 trials), and the kit's per-trial cap is $25 for both contenders. Calibrating xl needs a
  workload choice and a $40 cap.

What the founder's account would have been billed, had it run there: `jaximus808` is in
`ADMIN_GITHUB_LOGINS`, so `freeRunAtGo` skips the free starter run for an admin's run (the free
entitlement stays unused), and `billingGate` comps the run (`adminAutoComp`, an `interventions`
row, `runs.comped_by`). Nothing reaches the founder's card. The Naïve compute comes out of our
credit at cost.

So each trial ran on the founder's Mac with
`scripts/spikes/long-horizon-calibration/run-docker-local.ts`. That script is the TDM-212 smoke
script plus three things: the Tandem install, a `--workload` flag, and `--cpuset-cpus 0-1` on the
trial container and the gate container. It runs the exact TrialJob the worker builds
(`preparedJob`), the real runner binary (built from this branch: the meter fix below), the key
through stdin into `~/.anybench/env`, and then the hidden-tests gate in a fresh `node:22` with
`--network none`. Trials ran one at a time, each pinned to 2 CPUs.
`scripts/spikes/long-horizon-calibration/analyze.ts` turns each out dir into the rows below. It
uses Claude Code's own result lines and the server's trace builder (`buildTrialTrace`).

```sh
node --env-file=<main>/.env --import tsx scripts/spikes/long-horizon-calibration/run-docker-local.ts \
  --contender claude-code-solo|tandem --workload project-tracker|project-tracker-xl \
  [--cap-micro-usd 40000000] --out <dir>
node --import tsx scripts/spikes/long-horizon-calibration/analyze.ts <dir>...
```

Caps: $25 per trial on `project-tracker` (the kit's own), $40 on xl (`--cap-micro-usd 40000000`).
Order: A pt, D pt, A xl, D xl. Before each trial, the spend so far plus the next trial's cap was
checked against the $80 budget.

## The four trials

| | A solo · project-tracker | D Tandem ×3 · project-tracker | A solo · project-tracker-xl | D Tandem ×3 · project-tracker-xl |
| --- | --- | --- | --- | --- |
| outcome | ok, workspace frozen by the driver | ok (`completed`: 1 epic, 11 tickets done) | ok | ok (`completed`: 1 epic, 18 tickets done) |
| hidden tests | **120/120** | **120/120** | **599/600** | **599/600** |
| `hidden_test_fraction` | 1.0 | 1.0 | 0.99833 | 0.99833 |
| `area_pass` | all 12 areas 1.0 | all 12 areas 1.0 | 32 areas 1.0, `exports` 0.962 (25/26) | 32 areas 1.0, `exports` 0.962 (25/26) |
| gate verdict | pass | pass | fail (100% only) | fail (100% only) |
| wall (runner `running` to done) | 815 s (13.6 min) | 1327 s (22.1 min) | 1629 s (27.2 min) | 2685 s (44.8 min) |
| cost (Claude Code `total_cost_usd`, latest per session) | **$3.31** (3,308,249 µ$) | **$10.18** (10,177,854 µ$) | **$7.16** (7,158,184 µ$) | **$30.81** (30,812,010 µ$) |
| runner meter at the end | $3.31 (reported) | $17.44 with the old meter; $10.18 with the fix | $7.16 (reported) | $32.23 (mixed, fixed meter); the old meter would have read $43.25, over the $40 cap |
| sessions | 1 | 4 (planner + 3 workers), 10 result lines | 1 | 4, 10 result lines |
| turns (Σ `num_turns`) | 47 | 63 | 46 | 219 |
| peak context (largest input + cache read + cache write of one call) | 143,264 | 198,587 (worker-1) | 295,970 | 420,159 (worker-1) |
| compactions | 0 | 0 | 0 | 0 |
| tokens: input / output / cache read / cache write | 70 / 97,357 / 3,222,595 / 143,262 | 340 / 205,967 / 17,085,694 / 528,003 | 82 / 207,886 / 7,601,478 / 295,968 | 618 / 512,170 / 66,871,542 / 1,438,366 |
| Tandem phases (setup / planning / work / teardown) | | 3 / 120 / 1188 / 14 s | | 3 / 197 / 2465 / 20 s |
| model time summed over sessions | 788 s | 3165 s, of which **2137 s (68%) in board-only turns** | 1607 s | 6871 s, of which **3838 s (56%) in board-only turns** |
| board-only wall time (only board calls or waits in flight) | 0 | 60.6 s | 0 | 0.2 s |
| blocked in `queue_wait` (summed) | | 240 s | | 180 s |
| board calls / test runs | 0 / 8 | 63 / 31 | 0 / 10 | 99 / 63 |
| key leaks in everything brought back | none | none | none | none |

The board-only definitions are the trace parser's (`docs/findings/trial-traces.md`). A
"board-only turn" is a model turn whose only tool calls went to `mcp__tandem__*`. Its model time
counts in full, including the thinking that led to the board call.

Gate runtime on 2 CPUs: 25 s (project-tracker), 138 s and 157 s (xl). Neither xl gate timed out.

### The one hidden test both setups failed

Both xl trials failed the same test, `exports.test.ts`: "a row with the wrong number of cells or
an unterminated quote is the only error reported, and parsing stops there". They failed it in
different ways:

- **Solo** reported the malformed row as `row: 3` instead of `row: 2`. The CSV has a short row 2
  and an unterminated quote on row 3.
- **Tandem** also reported row 1's `not_found` next to the `malformed` error. The contract
  (section 27.3) says the malformed row "is the only error reported".

The test follows `instruction.md` word for word, and the oracle passes it, so the test is correct.
This is the hardest corner the agents met, not a grading bug.

## What this says for TDM-213

1. **Correctness is at the ceiling on both rungs.** Solo got 120/120 (as in TDM-212's smoke:
   $3.05, 724 s) and 599/600. With 1 trial per cell nothing is significant. Still, a solo session
   that builds 166 routes and passes 99.8% of 600 tests in 27 minutes leaves `tests-fraction`
   (the pre-registered primary) almost no room. On this evidence "indistinguishable" is the
   likely correctness verdict on both rungs. Wall and cost do separate the setups, both in solo's
   favour:

   | | Tandem / solo, project-tracker | Tandem / solo, project-tracker-xl |
   | --- | --- | --- |
   | wall | 1.63× | 1.65× |
   | cost | 3.08× | 4.30× |

2. **No session came near its context window.** The peaks were 143k, 199k, 296k and 420k tokens
   of 1M, with no compaction in any trial. The kit's premise ("a single session has to compact")
   did not hold at 5× either. Going from v1 to xl doubled solo's peak context and wall and roughly
   doubled its cost.
3. **Flag (explicit): solo scores >= 95% on xl in under 1 h. YES: 99.83% in 27.2 min.** By this
   ticket's rule, xl is still too easy, and the founder decides whether to scale again before the
   full run. On this evidence, a run that keeps xl as it is tests wall and cost, not the
   pre-registered prediction.
4. **The kit's $25 cap would stop xl Tandem trials.** This trial cost $30.81. `token_cap_micro_usd`
   is per contender, not per workload. Raise it to 40000000 for both contenders before TDM-213
   (it is a recorded change to the kit), or give xl a cap of its own.
5. **Deploy the fixes below before TDM-213.** The worker release ships `kits/` and
   `bin/runner-linux-*`. Without a worker deploy from a main that has these commits, every live
   xl trial exits 126 in a second, and every live Tandem trial's cap reads 40 to 70% high.
6. **The curated path cannot run TDM-213's shape yet.** It has no workload selector (xl only, or
   both rungs at n per setup) and no per-rung repeats. Its "smoke" option is project-tracker
   only. The full kit (`repeats: 5`, both workloads) is 20 trials, which fits only the $400
   budget below.

## Budget table for TDM-213

Measured cost of one round (one trial per setup) per rung:

- project-tracker: $3.31 + $10.18 = **$13.49**
- project-tracker-xl: $7.16 + $30.81 = **$37.97**
- both rungs: **$51.46**

Each cell is one sample. TDM-212's A on project-tracker cost $3.05 against $3.31 here, and
Tandem's spread is unknown, so the table also plans at 1.5× the measured cost.

The largest n per setup per rung that fits:

| Budget (Anthropic tokens) | project-tracker only: n at 1.0× / 1.5× | xl only: n at 1.0× / 1.5× | both rungs: n at 1.0× / 1.5× |
| --- | --- | --- | --- |
| **$150** | 11 / **7** | 3 / 2 (n ≥ 5 does not fit) | 2 / 1 (does not fit) |
| **$250** | 18 / **12** | 6 / 4 (**n = 5 fits at $190 measured, $285 at 1.5×**) | 4 / 3 (does not fit) |
| **$400** | 29 / **19** | 10 / **7** | 7 / **5** ($257 measured, $386 at 1.5×) |

With n ≥ 5 per setup per rung:

- **$150** buys project-tracker only: n = 7 with headroom ($94 measured).
- **$250** buys xl only at n = 5 ($190 measured, with $60 of slack, less than the 1.5× plan) or
  n = 6 ($228). Or it buys project-tracker at n = 12.
- **$400** buys both rungs at n = 5 ($257 measured, $386 at 1.5×), or xl only at n = 7 to 10.

The worst case is every trial hitting its cap. That is $50 per round on project-tracker ($25 + $25)
and $80 per round on xl ($40 + $40), so n = 5 costs $250, $400 and $650 respectively. The caps
bound the overshoot; the plans above assume they are rarely hit. None of the four trials came
within 20% of its cap.

Naïve compute on the golden path: the kit's profile is 4 vCPU / 8 GiB, which is 55,200 µ$ per
10-min block (8,400 per vCPU + 2,700 per GiB). Trial computer plus scoring computer come to about
17 blocks per both-rungs round at these walls, **about $0.94 per round**, so $4.70 at n = 5. That
fits under $10. On Naïve each trial gets 4 vCPU instead of the 2 pinned here, so walls should be
the same or shorter, Tandem's most of all (four Claude Code processes and their test runs shared
2 CPUs here).

## Infra found and fixed (own commits)

### 1. The xl instruction did not fit on argv: every xl trial exited 126 (24fecec)

The first xl solo attempt failed in 1 s, `failed_subject: run exited 126`, 1/600, $0.
`instruction.md` for xl is 153,646 bytes. Both drivers passed the task as one argument
(`claude -p "$(cat task)"`), and Linux caps a single argv string at 128 KiB (`MAX_ARG_STRLEN`).
Tandem's `run.sh` does the same for the planner and worker prompts, which embed the task. The
live product would have hit this on every xl trial, solo and Tandem alike.

Checked in `node:22` with Claude Code 2.1.319 and a 150 KB prompt:

```
150054 p.md
argv_rc=126
bash: line 1: /usr/local/bin/claude: Argument list too long
stdin_rc=0
"type":"result",...,"result_index":0,"model_usage_since_last_result":{...}
"text":"OK
```

Fix: `adapters/claude-code/driver.sh` and `adapters/tandem/run.sh` pass `-p` with no prompt
argument and feed the prompt file on stdin, so the bytes are the same. The fake-claude test in
`packages/kit/test/tdm212-long-horizon-kit.test.ts` now runs the driver on the real xl
instruction. It asserts the prompt arrives on stdin byte for byte with no argument over 1 KiB,
and that neither driver puts the task on argv. The retry ran clean (trial 3 above). The
short-task kit (`kits/tandem-vs-claude-code`) still uses argv. Its tasks are a few KB, so it is
not affected.

### 2. The BYOK cap meter summed a session's cumulative cost (46f82a5)

The Tandem project-tracker trial ended with the runner at 17,439,516 µ$ ($17.44). Claude Code's own
numbers add up to $10.18. One `claude -p` session can write several `result` lines: workers wrote
up to 4 each (2 to 4 on project-tracker), under the same `session_id`, with `result_index` counting them. Each line's `usage`
and `duration_ms` cover only the turns since the previous result, but `total_cost_usd` is the
process's running total. Measured on worker-2:

```
msgs 10 seg in/cr/cw [24, 439800, 50701]  | result usage = same, out 3896  | result cost 0.4195
msgs  3 seg in/cr/cw [8, 181925, 2143]    | result usage = same, out 1029  | result cost 0.4872  (= 0.4195 + 0.0677)
msgs 18 seg in/cr/cw [38, 1594165, 52468] | result usage = same, out 22410 | result cost 1.5167
msgs  5 seg in/cr/cw [12, 582641, 4687]   | result usage = same, out 2487  | result cost 1.7065
```

`TokenMeter` added every result (`s.reported += micro`). That read +71% on this trial. On the xl
Tandem trial it would have read $43.25 against a real $30.81, so the old meter would have stopped
that trial at its $40 cap while the real spend was still around $28.

Now a named session's reported cost is its latest (largest) total. The estimate of turns that
arrived after that result is added on top as open spend, with the margin, until the next result
covers it. The new tests in `packages/runner/test/tdm231-token-cap.test.ts` replay
`fixtures/tdm239-tandem-tap.jsonl`: this trial's four transcripts through `board.ts tap`, with no
content. Spent equals Σ latest totals (10,177,855 µ$). The tail between two results is within 25%
of what the next result adds. A $15 cap does not trip.

The collectors were already right: `packages/kit` `summarizeSession` and the stream-json
collector take the last result's cost. The xl Tandem trial ran on the fixed binary.

### 3. Trial traces kept only the last result's tokens (b893c50)

`apps/server/src/lib/trial-trace/parse.ts` kept the last result's `usage` and `duration_ms`. For a
multi-result session that is only the final segment. The trace now sums them and keeps the latest
cost (test in `apps/server/test/trial-trace.test.ts`).

## Spend

| | Anthropic tokens |
| --- | --- |
| A · project-tracker | $3.31 |
| D · project-tracker | $10.18 |
| A · xl, attempt 1 (argv, exit 126) | $0.00 |
| stdin check (one 150 KB prompt, 1 turn) | about $0.17 (estimate: ~33k cache-write tokens) |
| A · xl | $7.16 |
| D · xl | $30.81 |
| **Total** | **about $51.63 of the $80 budget** |

Naïve compute: $0. Everything ran docker-local on the founder's Mac, one trial at a time, on
2 CPUs. No full run was started.

## Not covered

- One trial per cell: no verdict, no variance. The budget table plans at 1.5× for that reason.
- The golden path on the live deploy was not exercised (see "How the trials ran"). The two driver
  bugs above would have broken it for xl.
- The 2-CPU pin slows Tandem (4 sessions plus their test runs) more than solo. Walls on Naïve
  (4 vCPU) should favour Tandem slightly more than these do.
