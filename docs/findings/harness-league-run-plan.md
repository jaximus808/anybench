# Harness league run plan: v1, 5 setups, n = 5 (TDM-245 [21.5], 2026-11-09)

The founder's run: `kits/harness-league` on `project-tracker` (v1, 120 hidden tests), all five
setups (A Claude Code solo, B + subagents, G + gstack v1.98.0.0, S + Superpowers v7.0.2,
D Tandem ×3), 5 measured trials each, no warm-up: **25 trials**. This ticket made the live app
able to create that run and stop it at `awaiting_go`. Nothing was created or started here: no run,
no trial, no Anthropic tokens.

## How the run is selected

The run is a GitHub run on `jaximus808/tandem`. Its curated stages (apps/server
`orchestrator/curated.ts`) read the question:

| The question says | Kit | Workloads | Repeats |
| --- | --- | --- | --- |
| "harness league" or "skills league" (any case, space or hyphen) | `harness-league` | | |
| nothing about the rung | | `project-tracker` (v1) | |
| "project-tracker-xl", "xl" or "v2" | | `project-tracker-xl` | |
| "both workloads" / "both rungs", or names v1 and xl | | both | |
| "n=5", "5 repeats", "5 trials per setup", "repeats: 5" (1 to 10) | | | that number |
| "smoke" (and no number) | | | 1 |
| no number | | | the kit's own: 5 |

Without "harness league" / "skills league" the Tandem repo keeps its old default, the
long-horizon kit (E18: A and D only). A number outside 1 to 10 holds the run at kit design with
"the harness league runs 1 to 10 trials per setup; the question asks for N".

**It cannot fall back silently.** The question below is pinned by a test that reads it out of
this file (`apps/server/test/harness-league-run-tdm245.test.ts`): it must pick `harness-league`,
`project-tracker` only, and n = 5 (25 trials). The run page also says what was picked before Go:

```
using the curated harness league (harness-league): A · Claude Code solo, B · Claude Code + subagents, G · Claude Code + gstack, S · Claude Code + Superpowers, D · Tandem ×3 on E18's whole-app arena (tokens: anthropic-key, effort: default, thinking: on; headless policy headless-v1 ...)
league profile: 25 trials (5 setups × project-tracker × 5 repeats, no warm-up; each up to 3 h and $25 of tokens); workload from the question, repeats from the question
```

If the run page says `long-horizon profile`, `tandem-long-horizon`, `project-tracker-xl` or any
number other than 25 trials, cancel it before Go.

## The proof sign-off

`HARNESS_LEAGUE_PROOF_SIGNOFF` (apps/server `proof-score.ts`): source
`kits/harness-league/PROOF.md`, sha256 `4dfbaf54…` and commit `331eed4`, the same as
`LONG_HORIZON_PROOF_SIGNOFF`. The league's PROOF.md, workloads, hidden tests, gate, oracle and
do-less overlays are byte-identical copies of `kits/tandem-long-horizon`'s, so E18's offline proof
(oracle 120/120 three times, do-nothing 1/120, the partial oracle refused at 106/120; the same on
xl at 600/515) is the league's proof. The proof stage checks that again for every league run: it
imports the kit's own `scripts/sync-shared.mjs` and runs `diffShared()`; one differing byte (or a
missing or stale copy) holds the run with

```
the harness-league kit's arena is no longer a byte-identical copy of kits/tandem-long-horizon (1 difference(s): differs: gates/hidden-tests/check.sh); run node kits/harness-league/scripts/sync-shared.mjs; proof suite not available yet
```

The sign-off covers the whole kit and every cut the designer makes (3 workload choices ×
repeats 1 to 10). Anything else (another cap, a dropped setup, 11 repeats) is a different kit and
holds at proof. The run page reads `proof: curated (verified offline at 331eed4): oracle …;
do-nothing … (kits/tandem-long-horizon's proof: the arena is a byte-identical copy, checked now)`.

The report's disclosure is `HARNESS_LEAGUE_DISCLOSURE` (the analyst picks it from the stored
spec: the league's setups tell it apart from E18's), plus the per-setup line
`questions auto-answered (headless policy): …`.

## Metrics wiring: questions_auto_answered

`trial.gate` now reads the trial's bundle (`out.tar.gz`) before it writes the verdict, runs bench's
stream-json collector over `stream.jsonl` and writes `questions_auto_answered` and
`auto_answer_cap_reached` into `trials.metrics` in the same update
(`orchestrator/trial-metrics.ts` `autoAnswerMetricsFromBundle`). The trace build reuses the same
bytes, so the bundle is still downloaded once per trial. A transcript without the policy (Tandem's
sessions live under `tandem/`; every other kit) clears the two keys; an unreadable bundle keeps
what was stored and never changes the score. Not scored: no requirement reads them, and the
stream is written on the trial computer (plan.md 17.2 rule 5). A `failed_subject` trial that froze
no workspace is never gated, so it has no count; the report line says "n in k trials" with k the
trials that have one.

## Caps

Every setup: `token_cap_micro_usd: 25000000` ($25 on the owner's Anthropic key, where the runner
stops the trial) and `wall_clock_cap_s: 10800` (3 h). Calibration: Tandem v1 cost $10.18, solo
$3.31 (`docs/findings/long-horizon-calibration.md`). The test above asserts the caps on the stored
kit.

## BYOK token hard stop (new)

The budget (TDM-242) limits only what we bill. Tokens on the owner's own key were reported
(`byok_token_micro_usd`) and never stopped anything: 25 trials × $25 = **$625 worst case**. A run
now takes `byok_token_limit_micro_usd` (`anybench run --byok-limit <usd>`, `POST /runs`, raised by
`POST /runs/:id/resume`), stored in `runs.byok_token_limit_micro_usd` (migration 0016). With it
set, `orchestrator/budget.ts` holds BYOK tokens like the budget:

- **BYOK spent**: every trial's runner-metered spend on the key (`trials.token_spend_micro_usd`,
  written when its runner ends, failed_infra attempts included); a finished or grading trial with
  no reading counts at its cap.
- **BYOK committed**: each BYOK trial in flight at its full cap.
- **Launch**: a trial launches only if BYOK spent + committed + its own cap ≤ the limit (checked
  under the run's lock in the trial store, and by the advance loop's pick). Otherwise it stays
  queued.
- **Hold**: queued trials, none fits, nothing in flight → `paused_budget`, e.g. "BYOK tokens spent
  $55.00 + $0.00 committed to running trials at their caps + $25.00 for the next trial at its cap
  would pass the $70.00 BYOK token limit. 2 trial(s) not started. Raise the BYOK token limit to
  run them, or settle to score the 3 finished".
- **Hard stop**: BYOK spent alone past the limit while trials run → `paused_budget` with a budget
  stop; the runners stop their subjects and what they did is graded (TDM-232).

So the run can never spend more than the limit on the key, give or take the runner's own overshoot
on its last turn (each trial is cut at its cap, and the admission reserved the full cap).

## Estimate

### Anthropic tokens (the founder's key; not billed by us)

Measured on v1 (one trial each, `long-horizon-calibration.md`): A $3.31 (TDM-212's smoke: $3.05),
D $10.18. B, G and S have never run v1; their 1-turn smokes cost $0.031 (A), $0.036 (B), $0.060
(G), $0.052 (S), and Superpowers built through three small tasks for $1.29. Assumed per trial:

| Setup | low | plan | high | basis |
| --- | --- | --- | --- | --- |
| A solo | $3.05 | $3.31 | $5.00 | measured twice |
| B + subagents | $4.00 | $6.00 | $10.00 | A plus three fresh-context subagents |
| G + gstack | $4.00 | $6.00 | $10.00 | A plus skill loads (2× A on the smoke) |
| S + Superpowers | $4.50 | $7.00 | $10.00 | A plus brainstorm, plan, TDD, subagent review |
| D Tandem ×3 | $10.18 | $10.18 | $15.00 | measured once |
| **one round (5 trials)** | **$25.73** | **$32.49** | **$50.00** | |
| **25 trials (n = 5)** | **$129** | **$162** | **$250** | |

Target ≤ $150 with ~$200 left this month. The plan figure is above $150, so the limit matters:
**set `--byok-limit 150`**. What it does to this run:

- It caps the key at $150, whatever the setups cost.
- Every launch reserves $25. With $S spent and k trials in flight the next one needs
  S + 25k + 25 ≤ 150, so parallelism drops as spend grows: 5 trials at once (the worker's 5
  slots) while S ≤ $25, 4 while S ≤ $50, 3 while S ≤ $75, 2 while S ≤ $100, 1 while S ≤ $125, and
  **nothing launches once S > $125**.
- At the low figure ($5.15 a trial) all 25 fit ($129). At the plan figure ($6.50 a trial) about
  20 trials run before S passes $125, and the run holds in `paused_budget` with about 5 trials of
  the last round unstarted: those setups get n = 4. At the high figure ($10) about 13.
- The round order rotates (`schedule.order_seed`), so the unstarted trials are the last round's,
  spread over setups, not one setup's.
- When it holds: settle (score what finished: `POST /runs/<id>/settle`), or raise the limit with
  `POST /runs/<id>/resume {"byok_token_limit_micro_usd": "<micro-USD>"}` if the month allows.

If the founder wants all 25 at the plan figure, the limit has to be about $190 ($162 spent plus the
last trial's $25 reservation). Lowering the per-trial cap would also help (each reservation is the
cap), but it changes the kit's caps, which are what the proof signed off; not done here.

### Naïve compute (our credit; the run is comped for an admin)

`scripts/ops/harness-league-estimate.ts` (packages/billing `estimateRunCost`, the number Go checks
against the budget), with the .env.example pricing:

```
$ pnpm exec tsx scripts/ops/harness-league-estimate.ts
  "trials": 25, "workloads": ["project-tracker"], "repeats": 5, "warmups": 0,
  "est_trial_seconds": 10800,
  "estimate": { "run_fee_micro_usd": "2000000", "computers": 25, "blocks": "450",
    "block_price_micro_usd": "55200", "price_source": "naive_rate",
    "compute_cost_micro_usd": "24840000", "compute_charge_micro_usd": "37260000",
    "total_micro_usd": "39260000" },
  "byok_token_ceiling_micro_usd": "625000000"
```

- The estimate is the worst case: every trial for its full 3 h on a 4 vCPU / 8 GiB computer
  (18 blocks × $0.0552): **$24.84 of Naïve compute, $39.26 with the fee and markup**. The budget
  must be at least that, so **`--budget 60`**.
- `jaximus808` is in `ADMIN_GITHUB_LOGINS`: the billing gate comps the run at Go, nothing reaches
  the card; the compute comes out of our Naïve credit at cost.
- Expected at the calibration walls (15 to 45 min a trial, plus boot and a 1-block gate
  computer): about 4 to 6 blocks a trial, **about $6 to $8 of Naïve compute**, plus the env build
  before Go (one snapshot with every setup installed) and the worker computer that is up anyway.

### Wall time

`WORKER_CONCURRENCY` defaults to 5 trial slots per worker (gates use their own 2 control slots).
Trials take about 15 min (A), 22 min (D) and an unknown 15 to 45 min (B, G, S) on 2 CPUs; on
Naïve's 4 vCPU the same or less. Five waves of five, each as long as its slowest trial, plus
about 5 min of boot and install per trial and the gate:

- **expected: about 3 to 4 hours**, plus up to an hour at the end when the BYOK limit lets only
  one or two trials run at a time;
- worst case (every trial to its 3 h cap): 15 h. The worker computer rotates at 10 h and running
  trials re-attach (`docs/findings/worker-deploy.md`).

### Hard stops, in one place

| What | Where | Stops at |
| --- | --- | --- |
| Anthropic tokens per trial | runner token cap | $25 |
| Anthropic tokens per run | `byok_token_limit_micro_usd` (this ticket) | $150 |
| Wall clock per trial | runner | 3 h |
| What we bill (compute, fee) | run budget (TDM-242) | $60 (comped) |
| Belt and braces | Anthropic Console: a spend limit on the key's workspace | the founder's choice |

## The founder's commands

Before: this branch merged, the API and worker deployed from it (`pnpm tsx scripts/deploy/api.ts`,
`pnpm tsx scripts/deploy/worker.ts`; both migrate, which adds `runs.byok_token_limit_micro_usd`),
and the account's Anthropic key stored (web: /settings → Model keys; or
`node --env-file=.env --import tsx scripts/ops/store-byok-key.ts --owner jaximus808`).

1. **API key.** Sign in at https://anybench.jaxonp.com/settings → API keys → name
   `league-cli`, scopes `runs:read` and `runs:write` → Create key. The secret is shown once.
   (POST /api-keys takes a browser session only, so the key comes from the web, not a script.)

2. **Create the run.** It stops at `awaiting_go` (`--no-auto-go` sends `auto_go: false`, whatever
   the account's "start runs automatically" setting says):

   ```sh
   export ANYBENCH_API_KEY=ab_live_...   # from step 1
   pnpm --filter anybench... build
   node apps/cli/dist/index.js run --repo github.com/jaximus808/tandem --question "Harness league on project-tracker (v1), n=5: do Claude Code skill packs and harnesses (subagents, gstack, Superpowers, Tandem x3) beat plain Claude Code on a whole-app build?" --budget 60 --byok-limit 150 --no-auto-go --json
   ```

   It prints `run_id`, `state: intake`, `byok_token_limit_micro_usd: "150000000"`,
   `auto_go: false` and the run URL. The run then goes intake → understand → research →
   kit_draft → env_build (Naïve builds the env snapshot; no Anthropic tokens: the health checks
   only run `claude --version`) → proof → `awaiting_go`.

3. **Check before Go.** On the run page: the two kit-designer lines above (25 trials,
   project-tracker), the proof line (`verified offline at 331eed4`), state `awaiting_go`. And:

   ```sh
   API=https://anybench-api-sj1arspaf10q.vercel.app
   curl -s -H "authorization: Bearer $ANYBENCH_API_KEY" $API/runs/<run_id> | jq '.run | {state, budget_micro_usd, byok_token_limit_micro_usd, estimate_micro_usd}'
   curl -s -H "authorization: Bearer $ANYBENCH_API_KEY" $API/runs/<run_id>/estimate
   ```

   Expect `awaiting_go`, `60000000`, `150000000` and an estimate of about `39260000` (the deployed pricing env decides the exact figure).

4. **Go.** Press Go on the run page, or:

   ```sh
   curl -s -X POST -H "authorization: Bearer $ANYBENCH_API_KEY" $API/runs/<run_id>/go
   ```

5. **While it runs.** `byok_token_micro_usd` on the run is the key's spend so far (updated as
   trials end). To stop early: settle (`POST /runs/<run_id>/settle`, scores what finished) or
   cancel.

## Open before the results go public

- **The scored cost of a BYOK trial is compute only.** `trials.cost_micro_usd` is compute plus
  the Naïve proxy spend (`orchestrator/trial-metrics.ts`); a trial on the owner's key has no proxy
  spend, so the `cost` and `cost-per-test` requirements would rank the setups by computer time,
  not tokens. The runner's metered spend (`trials.token_spend_micro_usd`, Claude Code's own
  `total_cost_usd`) is recorded but deliberately not scored (plan.md 17.2 rule 5: it comes from
  the trial computer). Before the league's cost numbers are published, either score it (a recorded
  decision) or read the spend provider-side (Anthropic's usage API for the key). Not changed here.
- The env build for this kit has run docker-local only (`harness-league-contenders.md`), never on
  Naïve: gstack's Bun and Chromium dependencies are the likeliest to fail. A failure holds the run
  at env_build (needs_human) before any trial; nothing is spent on the key.
- A retried trial attempt overwrites `trials.token_spend_micro_usd`, so a trial that hit
  failed_infra after real token use and then ran again under-counts the first attempt's spend.
  Rare (an infra failure mid-run); the per-trial cap still bounds each attempt.
