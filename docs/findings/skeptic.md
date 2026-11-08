# Skeptic: an independent audit of every test plan (TDM-187 [16.16], 2026-11-08)

The skeptic is the check between the kit designer and proof (the founder's methodology review,
Part 2 gap 4; the ABC checklist, arXiv 2507.02825). It runs in two layers. Deterministic code
runs first. Then one Naïve session runs on a model from a different family than the designer
and every contender. The final verdict is computed in code.

## What exists

- `packages/kit/src/skeptic/`:
  - `finding.ts`: `SkepticFindingSchema` `{id, severity: block|warn, check, evidence: "path:line", why, source: code|model}`,
    `SKEPTIC_CHECKS` and `decideSkepticVerdict`: no block → `pass`, a `contamination` block → `hold`, any other block → `repair`.
  - `checks.ts`: `runSkepticChecks(kitDir, {proof?, modelCutoffs?}) → {findings, material}`. It never throws for a bad kit.
  - `material.ts`: reads the kit's files, finds the hidden tests (`gates/<gate>/<workload>/`), and extracts test names, assertion literals and messages.
  - `family.ts`: `modelFamily(id)` and `checkSkepticModel(model, {designer, contenders})`.
- `packages/agents/skeptic/{prompt.md, output.schema.json, config.json}`: model `openai/gpt-5-mini`, harness `pi`, no tools, task cap 150,000 µ$.
  `packages/agents/src/skeptic.ts` holds:
  - `buildSkepticInput`: a strict schema with no field for contender scores.
  - `SkepticOutputSchema`.
  - `verifySkepticFindings`: the model's `path:line` and quote are checked mechanically. A wrong file, line or quote becomes a warning.
  - `finalizeSkepticReview` and `skepticModelFor`.
- `apps/server/src/orchestrator/skeptic.ts`:
  - `skepticReview({db, client}, {ctx, kitDir, spec, understanding?, proof?, attempt?})` → `StageResult<{verdict, findings, costMicroUsd, model, advisoryVerdict, summary}>`.
  - `kitSkeptic(deps)`: the kit designer's `KitSkeptic` seam. It is wired as the default in `kitBuilderStages`. `pass` → ok. `repair` → the blocking findings are re-asked once as fix issues (findings only, never scores). `hold`, or a review that could not run → the run holds.

## Deterministic checks

| check | block when | warn when |
|---|---|---|
| no-leak lint (TDM-60 `noLeakIssues`, reused) | an answer-named file or a file identical to a scoring file under workloads/; an instruction names a hidden test, quotes an asserted value, or points at gates/ / reference/ / proof/ | the quoted "value" is only a contract identifier (a route or code) |
| solution_leakage | an instruction copies an assertion message; quotes ≥2 asserted values (code spans or test literals); a bug ticket whose bullets restate ≥60% of the hidden tests' rules | one quoted value |
| answer_in_workloads | a shipped file (input/, instruction.md, setup.sh) names a hidden test or file, or holds a reference output | a kit-side note under workloads/ names them |
| noop_passable | proof says a do-less passed every gate (for a no-op, the tests already pass on the untouched input); a gate script with no failing path | |
| weak_do_less | no do-less, or only no-ops | |
| one_sided_assist | an instruction file (CLAUDE.md, AGENTS.md, ...) for some contenders of a driver type but not others; contender help that names a task, a hidden test or an asserted value | |
| one_sided_weight | a weighted vanity metric (17.4); weight on a metric whose collector only some contenders have | reviewed (LLM-judged) quality with weight (rule 8) |
| contamination | the reference is captured from the subject with nothing to cross-check it; a mined task dated on or before a contender's training cutoff | the reference is captured from the subject but a baseline must agree through the same gate; mined tasks with no known cutoff (no cutoffs are built in: pass `modelCutoffs` with a source) |
| comparability | the comparability validator's errors (reused through validateKitDir, not redone) | its warnings |
| ungated_measure | a measured requirement without a gate (double-check) | weighted reviewed quality without a gate |
| too_few_tasks | an agent kit text claims "beats" / "faster than" without "on these N tasks"; agent repeats < 4 | agent kit < 20 tasks; agent repeats < 10; software repeats < 5 |
| kit_invalid | any other validator error | |

## The model and the family rule

`checkSkepticModel` reads the family from the model id: a name pattern first (`claude` anywhere
→ anthropic, `gemini`/`gemma` → google, `gpt-`/`o3` → openai, ...), then the provider prefix. It
refuses:

- Anthropic, always;
- the designer's family: `packages/agents/kit-designer/config.json` is
  `anthropic/claude-sonnet-5.5`, plus DeepSeek (the understander's family) by default;
- every contender's family (`driver.model` and every `*MODEL*` env value);
- routers (`vetta/auto`) and moving aliases (`~x/y-latest`).

`skepticModelFor` takes the role's model, then `google/gemini-3.1-flash-lite`,
`qwen/qwen3.8-flash`, `mistralai/mistral-small-2603` and `z-ai/glm-5.3-flash`. If every
candidate is refused, the run holds before any session.

**Why gpt-5-mini.** `models.list` (live, 375 ids, command below) offers it at a 32,768-token
output cap. The live pre-flight quote was 66,900 µ$ (`span.model_request.start.quote_micro_usd`),
well under the 150,000 µ$ task cap. Compare TDM-164, where `google/gemini-3.5-flash` was refused
at a $0.25 cap. It is a reasoning model, it is not Anthropic or DeepSeek, and it is not in
the family of any contender in our kits.

```
node --env-file=<repo>/.env models.mts      # client.models.list({limit: 100}) paged
375 models; openai/gpt-5-mini 400000 ctx, 32768 out, efforts low/medium/high
```

## Known case: the reference Tandem kit (deterministic, no spend)

```
runSkepticChecks("kits/tandem-vs-claude-code") → repair
BLOCK solution_leakage workloads/bug-hunt/instruction.md:8  quotes 3 value(s) the hidden assertions use: "Acme, Inc." (csv-quoting.test.ts:8), "say "hi"", ""say ""hi"""" (csv-quoting.test.ts:12)
BLOCK solution_leakage workloads/bug-hunt/instruction.md:18 a bug ticket whose bullet list restates 8 of the 12 hidden tests' rules: the fix is spelled out
WARN  solution_leakage workloads/todo-api/instruction.md:25 no-leak lint: "/auth/register" (only contract identifiers, which the task must name)
WARN  answer_in_workloads workloads/bug-hunt/PROVENANCE.md:9 names the hidden test file csv-quoting.test.ts (kit-side note under workloads/)
BLOCK weak_do_less anybench.yaml:247 the only do-less 'do-nothing' is a no-op: add partial oracles
WARN  one_sided_weight anybench.yaml:289 reviewed 'quality' carries weight 20 before a judge panel is audited
WARN  too_few_tasks anybench.yaml:142 3 tasks: every claim must read "on these 3 tasks"
WARN  too_few_tasks anybench.yaml:291 repeats 5 < the agent default of 10
```

This matches the founder's review: bug-hunt's RFC 4180 rule list is solution leakage, there are
no partial oracles, three tasks are too few, and the 20 weight on unaudited quality is a risk.
todo-api and auth-refactor state their contract and are not flagged. The cli example has 0
findings. The TDM-60 generated cli kits pass with no block: kit-designer-tdm60.test.ts now runs
the default skeptic.

## Live run

```
cd apps/server && LOCAL_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench \
  NAIVE_LIVE=1 TDM187_LIVE_OUT=<scratch>/live.json \
  node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs \
  run test/skeptic-naive-live-tdm187.test.ts --reporter=verbose
```

**Run 1, 22:24.** `429 the service is at capacity` at ensureAgent. It retried with backoff for
158 s, then failed. Nothing was created and nothing was spent.

**Run 2, 22:32.**

```
tandem-vs-claude-code: repair (model openai/gpt-5-mini advised repair) 16550 µ$
  summary: The kit currently contains blocking issues that must be fixed before running: explicit
  solution leakage in the bug-hunt workload and an inadequate do-less variant. Several warnings
  (review weight, too few tasks/repeats, an answer-in-workspace note) should be addressed or
  disclosed in the report.
  [code] the 8 findings above; the model added none of its own
cli-example: HOLD skeptic review could not run (the skeptic agent session failed (idle, error))
live total: 16550 µ$  (+ 9,968 µ$ consumed by the failed cli session = 26,518 µ$)
```

Why the cli session failed (`client.stream(ses_7fk6zythbfpefx25nwckx91w77)`):

```
span.model_request.end  {model: openai/gpt-5-mini, token_usage: {input: 3766, output: 673, reasoning: 3840}, provider_ms: 30157, consumed_micro_usd: 9968}
message.completed       {content: "{ \"kit\": {...the task message echoed...}, \"verdict\": \"repair\", ... }"}
session.idle            {stop_reason: error, error: "the session requires a result matching its output schema and produced none: no `submit_output` call satisfied it"}
```

The model answered in a plain message, not with `submit_output`, and echoed the task message
first. Its findings showed why the code checks the evidence:

- It cited lines of the JSON message (`proof_plan/regression:104`) instead of kit files.
- It called a cli workload's missing `instruction.md` a block.
- It read "must score lower" as a contradiction.
- It called contenders pinned by `ref` / `sha256` unpinned.

Fixes, made after this run:

- The prompt tells the model to submit with `submit_output` once, never to cite the task-message
  JSON, and explains the cli, regression and pinning cases.
- The input now carries the numbered `anybench.yaml` (`manifest`), so manifest findings can cite
  real lines.
- `verifySkepticFindings` already turned every one of those citations into a warning, so none of
  them could have blocked the kit.

**Run 3, 22:40, after the prompt fix.** Naïve was at capacity again. ensureAgent got 20 × 429:
7 on `PATCH /v1/agents/agt_3jqn…` (the new prompt version) and 13 on `GET /v1/agents`, with
backoff up to 30 s, until the 600 s test timeout. No session was created and nothing was spent.
The orchestrator's hold asked for backing off rather than hard retries, so I did not run it
again. **The fixed prompt has not been verified live.** Re-run the command above when Naïve has
capacity.

## Spend

| run | µ$ |
|---|---|
| models.list | 0 |
| run 1 (429 at ensureAgent) | 0 |
| run 2: Tandem kit (end_turn) | 16,550 |
| run 2: cli example (no submit_output) | 9,968 |
| run 3 (429 at ensureAgent, no session) | 0 |
| **total** | **26,518** (≈ $0.027 of the $0.30 allotted) |

## Follow-ups

- Wire the reasons into the test plan page so the customer sees the findings before Go (the
  review asks for this). `skepticReview` returns them; nothing renders them yet.
- Training cutoffs for contender models: `modelCutoffs` is empty by default. Add cited cutoffs,
  then mined tasks before a cutoff block instead of warn.
- Agent kits: TDM-60 designs only cli kits today. The mined-task contamination and assist checks
  are ready for coding-agent / harness kits (TDM-186).
- A second model family as a second skeptic, taking the majority. Today it is one model plus
  code-verified evidence.
- The skeptic sees no proof results on the first pass, only on a repair. `noop_passable` from
  proof only fires on a repair visit.
