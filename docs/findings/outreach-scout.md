# Outreach scout: live check on 2 public leads (TDM-164 [15.3a], 2026-11-08)

What the scout is: one Naïve session per lead (`packages/agents/scout/`, run through
`packages/naive` `runSession` with `output_schema`) → `verifyScoutOutput` (packages/outreach
`scout-brief.ts`) → a stored brief. No email was sent and no lead was written to the database
(`--repo` mode is always a dry run).

**Spend: 8,148 µ$ (≈ $0.008) of Naïve credit** for 2 briefs, against a $1 cap. The balance went
from 250,890,000 to 250,881,852 µ$, which is exactly the two sessions' `consumed_micro_usd`
(3,557 + 4,591). Two pre-flight refusals before that cost 0 (see below).

## Commands

```sh
# .env is loaded into process.env by a scratch wrapper that never prints keys, then:
anybench outreach scout --repo https://github.com/samuelfaj/distill \
  --repo https://github.com/Mibayy/token-savior \
  --budget-micro-usd 250000 --run-cap-micro-usd 1000000 --out <scratch>/live-report.json
```
```
lead repo:samuelfaj/distill ...: scored fit 90, 6 verified claims, 0 dropped, 3557 micro-USD
lead repo:Mibayy/token-savior ...: scored fit 91, 5 verified claims, 1 dropped, 4591 micro-USD
scout: 2 leads, Naïve spend $0.0081 of $1.0000 cap (per lead $0.2500), model deepseek/deepseek-v4-flash-0731
```

## Findings about Naïve

1. **`tools` needs `configs`.** `tools: {default_config: {permission: "deny"}}` is refused
   client-side by the SDK: `tools.configs: Invalid input: expected record, received undefined`.
   The scout uses `{default_config: {permission: "deny"}, configs: {}}` (no tools: everything it
   may quote is in the task message).
2. **The pre-flight quote is bigger than $0.25 for `google/gemini-3.5-flash`.** Both sessions
   were refused at create with `402 budget_exceeded`: "the remaining budget for this task is below
   the pre-flight quote". The quote is bounded by the model's `max_output_tokens` (32,768 for
   every model listed), and agents have no output cap to lower it. Nothing ran and nothing was
   debited: the balance was unchanged at 250,890,000. `runScout` now records this case as
   `budget_below_quote` with 0 spend (before the fix it conservatively counted the whole $0.25).
   `models.list` / `models.retrieve` return no prices, so a model's quote can only be found by
   trying it. That's free, because a refusal isn't charged.
3. **`deepseek/deepseek-v4-flash-0731` fits easily:** about $0.004 per brief with a ~25 KB
   README. It is now the default in `scout/config.json` (pinned, no `~latest`). The model docs
   describe it as "strict JSON output that must match a schema". Both sessions returned
   schema-valid output on the first try.
4. **Idempotency works end to end.** distill ran first as a probe (`--model deepseek/...`, agent
   v2), then again in the 2-lead run after config.json changed to the same model. The spec
   fingerprint was unchanged (`action: "unchanged"`) and the session key was the same, so
   `sessions.create` replayed `ses_6168zh0d6z9he33zjs3smqzd1f` instead of spending again.
5. The first `credits.show` right after the refused run got `429 rate_limited` ("the service is
   at capacity"). A retry a minute later worked.

## The briefs (abridged; full JSON was in the scratch report)

### samuelfaj/distill: fit 90, agent_harness, scored, `ses_6168zh0d6z9he33zjs3smqzd1f`, 3,557 µ$
Commit `21a8cb63174c1a63deb335bb51f569e09cb5a21e`. Each claim was checked mechanically against
its line. The links are permalinks at that commit.
- README.md#L34 "UltraSave cost 0.069x the credits of Normal on our 20-case benchmark,"
- README.md#L35 "and all 20 tasks still passed."
- README.md#L49 "UltraFast finished in 0.509x the wall time of Normal, about half,"
- README.md#L79 "Auto used 57% less total time and 77% fewer estimated LLM credits"
- README.md#L80 "than Normal; both passed 20/20 tasks in our paired benchmark."
- README.md#L98 "Distill benchmarks: same quality at up to 87% lower cost and up to 76% less time versus native GPT-6 Astra, GPT-6.1 Sol, Claude Opus 5.5 and DeepSeek V4.1 max baselines"

Measure: pass@1, pass^k, cost per solved task, time-to-solve (failures at cap), interventions
(the required core), plus audited quality. Gate: hidden per-task tests that the agent and harness
never see; a reference check against labelled answers; the repo's own `check.py` / `evaluate.py`
pattern decides pass/fail before cost or time is recorded. Compared against: Normal mode
(README.md#L34), the native model baselines the README names (README.md#L98), and Aider
(https://github.com/Aider-AI/aider). Caveats: needs paid model access; the 20-case benchmark is
their own; results depend on model versions; "estimated credits" depend on pricing assumptions.
Contact: `none` (no email known; a human must pick one).

> why: "The README claims UltraSave runs at 0.069x Normal's credits, UltraFast at 0.509x its wall
> time, and Auto at -57% time / -77% credits, each with 20/20 tasks passing ... We'd check those
> as cost per solved task and time-to-solve with a correctness gate of hidden tests ... An
> independent gated result would give the maintainers a third-party, reproducible check of their
> quantified cost and speed claims, which today rest on the project's own paired benchmark."

### Mibayy/token-savior: fit 91, agent_harness, scored, `ses_w1bt2jt68cq7q3xygqpyykgedp`, 4,591 µ$
Commit `770e055defd10b114591c4a426af67d9422e0330`.
- README.md#L7 "> One MCP server. One profile. **97.9% on tsbench at -80% tokens.**"
- README.md#L31 "| **Score** | 141 / 180 (78.3%) | **188 / 192 (97.9%)** |"
- README.md#L32 "| **Active tokens / task** | 17 221 | **3 395** (-80%) |"
- README.md#L33 "| **Wall time / task** | 110.6 s | **18.9 s** (-83%) |"
- README.md#L63 "| **Cost, 8 tasks** | $0.226 ± 0.011 | **$0.123 ± 0.020 (-45%, range -39% to -53%)** |"
- **Dropped (`quote_not_found`):** "Measured reduction: 97% fewer chars injected across 170+ real
  sessions." cited at README.md#L253. The real text spans two lines: L252 ends "…Measured" and
  L253 is "reduction: 97% fewer chars injected across 170+ real sessions." The model merged two
  rows, which the prompt forbids, so the verifier was right to drop it.

Measure: the agent_harness required core plus audited quality. Gate: a generated toy repo with
planted traps and expected/forbidden answer lists (the method the README describes); a sans_ts
control arm with the hooks neutralised; an assertion that Token Savior tools were actually called;
edit tasks graded by running the module's tests. Compared against: plain Claude Code
(README.md#L29), serena (https://github.com/oraios/serena), and its own profiles
(README.md#L283). Caveats include "The tsbench harness repository is not public and returns 404;
benchmark fixtures are not published". Contact: `none`.

## Wording check

No sentence in either brief tripped `unmeasuredAssertions`: every comparison is phrased as "the
README says…" or "we'd check…". Neither brief states a result.

## For downstream tickets
- 15.5a (writer): read `leads.brief` (`ScoutBriefSchema`, micro-USD as decimal strings). Draft only
  for `status = scored`, and skip `brief.contact.status = "none"` unless a human picks a contact.
  Quote `brief.claims[].text` with `source_url`; never add a claim that isn't in the brief.
- The model would be stronger if it could cite a range (`#L252-L253`) for claims that wrap. Not
  done: the verifier only accepts one line.
