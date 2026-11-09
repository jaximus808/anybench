# kits/tandem-long-horizon

The long-horizon kit for Anybench (plan.md E18). Question: **on a whole-application build, does
Tandem (a planner plus 3 Claude Code workers on a shared board) beat plain Claude Code, solo or
with subagents?** One large task, graded by about 120 hidden tests that live outside the
starting repo.

## Pre-registered prediction

Recorded 2026-11-08, before any trial of this kit ran. It is published with the result, whether
the result agrees or not.

> **Founder's prediction (2026-11-08):** "Tandem's strength is building entire applications, which a single raw Claude Code, even with subagents, will probably struggle with."

What the prediction means in this kit's terms: Tandem (setup D) has a higher hidden-test pass rate
on `project-tracker` than Claude Code solo (A) and Claude Code with subagents (B), with the verdict
`better` under plan.md 17.2 rule 2 (Newcombe CI on the difference of pass rates, Holm-corrected).
"Indistinguishable" or "worse" means the prediction did not hold on this task. Cost per solved
task and time-to-solve are reported next to it and are not part of the prediction.

## Why this task

The first Tandem vs Claude Code run (run `01a1bae4`, `kits/tandem-vs-claude-code`, findings in
`docs/findings/trial-traces.md`) used three small, fully specified tasks. **Solo Claude Code won**:
94% vs 89% of hidden tests, about 7.5x cheaper and 3.3x faster. On a task one session finishes in
about a minute, a planner, a board and three workers are pure overhead (Tandem spent 68% of its
model time in board-only turns), and the one Tandem failure came from a planner-chosen debounced
write.

That run can't speak to the founder's claim, because nothing in it was large enough to stress a
single session. This kit exists to test the claim **fairly, so Tandem can win or lose**:

- **Large enough to matter.** `workloads/project-tracker` is a whole multi-user application: 12
  feature areas, about 50 routes, background webhook delivery with retries, a rate limiter, an
  on-disk format with a migration from a seeded 1.x file, and an audit log that touches every
  write. It is sized so that a strong solo Claude Code session needs roughly 1 to 3 hours and
  will likely have to compact its context along the way. That is where a single session is
  expected to struggle and where splitting work across workers could pay off.
- **Exact, so grading is about correctness, not interpretation.** `instruction.md` gives every
  route, field, status code, error code, check order, ordering rule and formula. The hidden tests
  (ticket 18.2) and the reference solution (ticket 18.4) are written **only** from
  `instruction.md`, so every hidden assertion traces to a sentence the contenders also read
  (plan.md 17.2 rule 9).
- **Deterministic.** Time-sensitive behaviour has injectable controls: a `now` clock for
  timestamps, token expiry and rate-limit windows; `retryDelaysMs` and `timeoutMs` for webhooks;
  webhooks go to a receiver on localhost that the tests start. Persistence must be on disk before
  the response (the 01a1bae4 failure mode is ruled out by the spec, not by luck). Nothing needs
  the network.
- **Splittable but coupled.** The areas have real seams (search, webhooks, migration and the
  audit log can be built in parallel once the core model exists) and real coupling (roles, the
  archived-project rule, error-check order, cascades and audit entries cut across every area).
  That tests planning as well as parallelism.
- **No planning handed out.** The instruction is one spec, not a ticket list. Every setup gets
  the same bytes; splitting the work is the harness's job (plan.md 17.1 "Task design").

The 01a1bae4 lesson also applies to how we read the result: a single large task is one task. A
win here supports "Tandem is better on this whole-app build", not "Tandem is better", until there
are enough tasks for a stratified claim (plan.md 17.2 rule 3).

## Two rungs: project-tracker and project-tracker-xl (added 2026-11-08)

Recorded 2026-11-08, after exactly one trial of this kit. The docker-local smoke trial of setup A
(TDM-212, `docs/findings/long-horizon-kit.md`) showed plain Claude Code solo (Opus 5.5, default
effort, thinking on) build all of `project-tracker`, 50 routes, and pass **120/120** hidden tests
in **724 s** for **$3.05**, with a peak context of 134k tokens of its 1M window and no compaction.
The kit was sized for "1 to 3 hours and likely compaction"; on Opus 5.5 it is neither. A solo
session that passes every test in 12 minutes leaves no room for Tandem to be better on
correctness, so `project-tracker` cannot test the founder's hypothesis that Tandem wins on
*entire applications*.

So the kit now has two rungs. `project-tracker` stays exactly as it was (the medium rung; its
instruction, areas, hidden tests and oracle are untouched). `workloads/project-tracker-xl` (v2) is
a separate, larger workload, about 5x v1: its contract is v1's (sections 0 to 11, same rules, the
error catalogue extended) plus 21 new areas, about 600 hidden tests over 166 routes. It is sized so
that a solo session needs hours and runs into context pressure: the instruction alone is about
144 KB (v1: 42 KB), and the features interact on purpose, because interacting features are what
punish a session that loses track of earlier decisions. Section 0.8 of its instruction defines one
change pipeline that every feature hooks into: an automation rule fires on a card event, changes
the card (labels, assignee, column, custom fields, sprint, archive), posts a comment whose
@mentions notify people, causes signed webhook deliveries, respects quotas, roles, WIP limits and
dependencies, and appears in the audit log (with `via`), the activity feed, card history, reports
and exports. A scheduler (section 0.9) runs due-date triggers, recurring cards and the trash purge
off the injectable clock, so every time-based behaviour stays deterministic.

**The prediction text is unchanged.** It was written about whole-application builds, not about
one workload, so it applies to both rungs; the result of each rung is reported on its own, and
`project-tracker-xl` is the rung the hypothesis is really tested on. Adding v2 after one trial is a
change to the kit, recorded here with its reason; no trial had run on v2 when it was added.

| Rung | Workload | Areas | Routes | Hidden tests | Instruction |
| --- | --- | --- | --- | --- | --- |
| medium | `project-tracker` | 12 | 51 | 120 | 42 KB |
| large | `project-tracker-xl` | 33 | 166 | about 600 | 144 KB |

`workloads/project-tracker-xl/areas.json` lists its areas with `tests_target` and a `half` (1 or
2, about 300 tests each), so its hidden tests can be written in two parallel tickets (18.15 and
18.16) without overlap; the oracle is 18.17. All three are written only from its `instruction.md`.
Until they land, `anybench.yaml` runs only `project-tracker`. The v2 starting repo is v1's with the
new options in `AppOptions`, and its `fixtures/tracker-v1.json` is v1's, byte for byte (no new
fixture: the migration contract is the same).

v2 areas (half 1, then half 2):

| Area | Section | Target | Half |
| --- | --- | --- | --- |
| `auth` | 1. Accounts and auth | 11 | 1 |
| `teams` | 2. Teams and roles | 13 | 1 |
| `projects` | 3. Projects | 9 | 1 |
| `boards` | 4. Boards and columns | 13 | 1 |
| `cards` | 5. Cards | 20 | 1 |
| `comments` | 6. Comments and mentions | 10 | 1 |
| `search` | 7. Search | 14 | 1 |
| `webhooks` | 8. Webhooks | 12 | 1 |
| `ratelimit` | 9. Rate limiting | 8 | 1 |
| `persistence` | 10.1 The data file | 8 | 1 |
| `migration` | 10.2 Loading a 1.x file | 9 | 1 |
| `audit` | 11. Audit log | 10 | 1 |
| `apikeys` | 12. API keys | 23 | 1 |
| `plans` | 13. Plans and quotas | 23 | 1 |
| `idempotency` | 14. Idempotency keys | 12 | 1 |
| `fields` | 15. Custom fields | 30 | 1 |
| `labels` | 16. Team labels | 18 | 1 |
| `dependencies` | 18. Dependencies | 22 | 1 |
| `sprints` | 19. Sprints and velocity | 33 | 1 |
| `checklists` | 17. Checklists | 15 | 2 |
| `templates` | 20. Card templates | 15 | 2 |
| `recurring` | 21. Recurring cards | 28 | 2 |
| `automation` | 22. Automation rules | 52 | 2 |
| `notifications` | 23. Notifications and watchers | 36 | 2 |
| `attachments` | 24. Attachments | 22 | 2 |
| `activity` | 25. Activity and card history | 15 | 2 |
| `views` | 26. Saved views | 16 | 2 |
| `exports` | 27. Import and export | 26 | 2 |
| `reports` | 28. Reports | 22 | 2 |
| `html` | 32. HTML pages | 12 | 2 |
| `invites` | 30. Invitations | 13 | 2 |
| `trash` | 31. Archive and trash | 15 | 2 |
| `time` | 29. Time tracking | 15 | 2 |
| | | **600** | half 1: 298, half 2: 302 |

`packages/kit/test/tdm235-long-horizon-xl-workload.test.ts` checks that v2's setup is
deterministic, its skeleton's tests pass, `areas.json` and `instruction.md` agree route for route
(every v1 route included), the halves balance, every error code is catalogued, the options table
matches `AppOptions`, the fixture is v1's, and nothing the agent sees points at a grader.

## Setups

Two setups (founder decision, 2026-11-08: the first run must be able to reach a statistically
significant result, so the token budget buys repeats rather than setups):

| | Contender | How |
| --- | --- | --- |
| A | `claude-code-solo` (baseline) | headless Claude Code, subagent (`Task`, `Agent`) and multi-agent `Workflow` tools disallowed |
| D | `tandem` with `TANDEM_WORKERS=3` (subject) | planner + 3 workers on a fresh Tandem canvas, approvals automatic; the same tools disallowed in every session |

`claude-code-subagents` (B: headless Claude Code with the implementer, test-writer and reviewer
subagents of `kits/tandem-vs-claude-code`) is the planned third setup if budget remains after the
first run. It is not in `anybench.yaml` yet, so the pre-registered prediction below is tested
against A only until it is.

Both setups use the adapters of `kits/tandem-vs-claude-code` (copied into `adapters/`), the same
pinned Claude Code `2.1.319`, the same Tandem commit (`05b4a022`, v0.2.0, tandem-mcp 3.2.0) and
the same pinned model, **`claude-opus-5-5`** (Claude Opus 5.5, the first-party id; it is an
undated snapshot id, so `packages/kit` counts it as pinned). Every model alias Claude Code
resolves (`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`) points at
the same id. Caps, equal for both: wall clock 3 hours per trial (`wall_clock_cap_s` and the
workload's `timeout_s`, 10800 s) and a spend cap of $25 per trial (`token_cap_micro_usd:
25000000`), which the runner enforces live from the stream's usage at Opus 5.5 list prices.
Repeats default to 5 per setup (`repeats`); the first full run (TDM-213) sizes them at 5 to 8 per
setup from the power plan and the $150 budget. No warm-up trials (`schedule.warmups: 0`): a
warm-up would be a whole 3 h trial.

### Tokens: our own Anthropic key (founder decision)

Model tokens come from our own Anthropic key (`AB_TOKEN_SOURCE=anthropic_key`, the BYOK path),
the same for every setup, at Claude Code's default effort with thinking on. The drivers unset every
Naïve proxy setting (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `MAX_THINKING_TOKENS`,
`CLAUDE_CODE_MODEL_CAPABILITIES`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`), so the proxy
handicap of the first kit (effort naive-min, thinking off) does not apply. Naïve credit now pays
only for the computers.

The key: the kit lists `secrets: [ANTHROPIC_API_KEY]`. The worker decrypts the run owner's
stored key (apps/server `user_secrets`, provider `anthropic`, envelope-encrypted under
`ANYBENCH_KEK`, `apps/server/src/lib/byok.ts`) right before each trial and writes it to the trial
computer's `~/.anybench/env` (0600); a trial whose owner has no stored key is refused, never run
on another key. Store it with `pnpm tsx scripts/ops/store-byok-key.ts --owner <github-login>`
(reads `ANTHROPIC_API_KEY` and `ANYBENCH_KEK` from `.env`, prints only the last 4 characters).
The drivers read the key from the env or `EVAL_SECRETS`, never echo it, and pass every transcript
and stderr line through `adapters/tandem/board.ts` (`tap`, `redact`), which replaces `sk-ant-…`
and the key's value with `[REDACTED]`; the runner redacts it from its own logs and events.

**Disclosure (goes with every result from this kit):**
`tokens: anthropic-key, effort: default, thinking: on`. First-party Claude Code at its default
effort, on our own key; the cost numbers are list-price token spend (Claude Code's
`total_cost_usd`).

What changed in the copied adapters, and why:

- `adapters/claude-code/driver.sh`: token source `anthropic_key` only (refuses anything else and
  Naïve model ids); Claude Code is stopped 60 s before the wall cap (`CC_WALL_CAP_S`) so the
  workspace is always frozen and partial work is graded; the stream goes through
  `board.ts tap`, so the runner's spend cap sees A's usage live (the first kit wrote it only to a
  file, which the proxy-side cap did not need).
- `adapters/tandem/run.sh`: step 0 is the same `anthropic_key` check; the key is loaded only into
  the planner and worker sessions; session stderr is redacted. `harness.yaml` `timeout_s` is
  10800 (the driver's `ANYBENCH_WALL_CAP_S` overrides it anyway).
- `adapters/tandem/board.ts`: `tap` redacts, and a new `redact` line filter.

## Workload

| Workload | Shape | Hidden tests | What it is |
| --- | --- | --- | --- |
| `project-tracker` | whole application, 12 areas | about 120, tagged by area | Build a multi-user project tracker API (accounts, teams and roles, projects, boards, cards, threaded comments with @mentions, search, signed webhooks with retries, rate limiting, versioned persistence with a 1.x migration, audit log) on a `node:http` skeleton that only serves `GET /health`. |
| `project-tracker-xl` | whole application, 33 areas (v1's 12 plus 21) | about 600, tagged by area, in two halves | The same tracker grown about 5x: v1's contract plus API keys with scopes, plans and quotas, idempotency keys, custom fields, team labels, checklists, dependencies, sprints and velocity, templates, recurring cards, an automation rule engine, notifications and watchers, attachments, activity and card history, saved views, CSV/JSON import and export, reports, time tracking, invitations, an archive with a trash, and HTML pages. Added 2026-11-08 (see above); hidden tests and oracle to come. |

The feature areas and their test-count targets are in `workloads/project-tracker/areas.json`
(machine-readable; the hidden tests use these area ids as tags):

| Area | Section of `instruction.md` | Target tests |
| --- | --- | --- |
| `auth` | 1. Accounts and auth | 11 |
| `teams` | 2. Teams and roles | 13 |
| `projects` | 3. Projects | 9 |
| `boards` | 4. Boards and columns | 11 |
| `cards` | 5. Cards | 15 |
| `comments` | 6. Comments and mentions | 10 |
| `search` | 7. Search | 12 |
| `webhooks` | 8. Webhooks | 11 |
| `ratelimit` | 9. Rate limiting | 7 |
| `persistence` | 10.1 The data file | 6 |
| `migration` | 10.2-10.3 Loading a 1.x file | 8 |
| `audit` | 11. Audit log | 7 |
| | | **120** |

The starting repo is Node/TypeScript with **zero dependencies**: Node 22.18+ runs `.ts` directly
(type stripping) and tests use `node:test`, so everything runs offline with no `npm install`.

## Layout

```
workloads/project-tracker/input/            L3 starting repo (becomes a one-commit git repo in EVAL_WS)
workloads/project-tracker/input/fixtures/   tracker-v1.json, the seeded 1.x data file to migrate
workloads/project-tracker/instruction.md    the task every contender gets
workloads/project-tracker/setup.sh          builds EVAL_WS from input/ (deterministic commit)
workloads/project-tracker/areas.json        feature areas, routes and test-count targets (kit-side)
workloads/project-tracker-xl/                v2 (about 5x): input/, instruction.md, setup.sh, areas.json with halves
scripts/setup-workspace.sh                  the deterministic workspace builder setup.sh calls
scripts/gen-seed-v1.mjs                     regenerates tracker-v1.json (fixed salts and times; --check)
scripts/ab-run-local.sh                     local stand-in for the gate runner's $AB_RUN (no uid switch)
gates/hidden-tests/check.sh                 the hidden-tests gate (L5), scoring computer only
gates/hidden-tests/grade.mjs                copies the tests in, runs them, scores them, writes the verdict and metrics
gates/hidden-tests/project-tracker/         120 hidden tests, one file per area, tests.json, fixtures/tracker-v1.json
anybench.yaml                               the kit (KitSpec v2): setups, caps, requirements
adapters/                                   copied from kits/tandem-vs-claude-code (see Setups)
rubric.md                                   the code-quality review rubric (requirement `quality`)
proof/oracle/driver.sh                      applies proof/oracle/<workload>/ (the reference solution)
proof/oracle/project-tracker/               the reference solution: an overlay on the starting repo
proof/do_less/do-nothing/driver.sh          the no-op harness
proof/do_less/partial-oracle/driver.sh      the oracle with the webhooks area cut out (a near miss; xl: the v1 oracle)
proof/regression/skip-tests/CLAUDE.md       the planted regression ("skip the tests")
scripts/verify-proof.sh                     the offline proof (Docker, node:22, --network none); writes PROOF.md
```

Requirements, all on the `hidden-tests` gate (no number without a correctness gate):
`tests-fraction` (`hidden_test_fraction`, aggregate `all_trials`: partial credit, every trial;
the preregistered primary), `tests-pass` (`gate_pass_rate`, the 100% verdict), `wall` (`wall_s`,
failed trials at the 3 h cap), `cost` (`cost_micro_usd` per solved task), `cost-per-test`
(`cost_micro_usd`, aggregate `per_test_passed`) and `quality` (reviewed, `rubric.md`).

Still to come in E18: the first full run (TDM-213).

## Hidden tests and partial credit

`gates/hidden-tests/project-tracker/` holds 120 tests over HTTP (`node:test`, no dependencies),
one file per area of `areas.json`, at exactly each area's `tests_target`. `tests.json` lists every
test with its `area`. Every assertion traces to `instruction.md`. The tests use the contract's own
controls: a fake `now` clock, small `retryDelaysMs` and `timeoutMs`, webhook receivers on
127.0.0.1 ephemeral ports, and waits that poll with a deadline instead of fixed sleeps. The
`migration` tests use the gate's own copy of `tracker-v1.json` (byte-identical to
`input/fixtures/`), so editing the workspace's copy changes nothing.

The gate (copied from `kits/tandem-vs-claude-code` and extended) puts the tests into
`<workspace>/.hidden-tests/` before any contender code runs, and scores every test in
`tests.json`. A test that never reports counts as failed. It writes `hidden-tests.metrics.jsonl`:

| Metric | Value |
| --- | --- |
| `hidden_test_fraction` | passed / total, 0..1: the partial-credit correctness metric (TDM-210) |
| `hidden_tests_passed`, `hidden_tests_total` | counts |
| `area_pass.<area>` | that area's passed / total, 0..1, one row per area |

The verdict stays **pass only at 100%**. Partial credit is a metric, never a pass.

## Checks

```sh
kits/tandem-long-horizon/workloads/project-tracker/setup.sh /tmp/ws && (cd /tmp/ws && npm test)
node kits/tandem-long-horizon/scripts/gen-seed-v1.mjs --check
# the hidden-tests gate on a workspace in <run>/workspace:
AB_RUN=kits/tandem-long-horizon/scripts/ab-run-local.sh AB_RUN_DIR=<run> \
  kits/tandem-long-horizon/gates/hidden-tests/check.sh <out> project-tracker <out>/gate.json
# the proof (oracle 120/120 three times, do-nothing only /health, partial-oracle fails the gate
# with >= 100/120 passing); --write rewrites PROOF.md:
kits/tandem-long-horizon/scripts/verify-proof.sh --write
```

`packages/kit/test/tdm209-long-horizon-hidden-tests.test.ts` checks that `tests.json` matches the
test files and the area targets, the fixture copy is identical, the metric rows and the
100%-only verdict, and that the gate on the 18.1 skeleton scores 1/120 (only `GET /health`).

`packages/kit/test/tdm208-long-horizon-workload.test.ts` (in `pnpm -r test`) checks that setup is
deterministic and yields one commit, the skeleton's own tests pass, `areas.json` and
`instruction.md` agree route for route, the targets sum to 120, the fixture's documented passwords
verify, and this README carries the prediction.

`packages/kit/test/tdm211-long-horizon-proof.test.ts` checks the proof layout, that the oracle is
zero-dependency erasable TypeScript, that PROOF.md records a passing run, and runs the oracle
through the real gate (120/120); its `validateKitDir` test skips until `anybench.yaml` exists.

## Proof

`PROOF.md` is the output of `scripts/verify-proof.sh --write`: in a `node:22` container with no
network, the reference solution passes 120/120 hidden tests on three fresh workspaces and its own
`npm test`, and the untouched starting repo passes only `GET /health` (1/120). No hidden test
was changed to fit the oracle.

The reference solution (`proof/oracle/project-tracker/`, about 2,400 lines of source in 7 files) is
written from `instruction.md` alone, uses Node built-ins only and runs by type stripping. Writing
it found six points `instruction.md` left open. No hidden test depends on any of them; each is now
settled in `instruction.md` by one sentence, and the oracle's own tests check the reading:

| Open point | Settled as | Section |
| --- | --- | --- |
| A listed query parameter with an empty value (`?limit=`) | Present, not absent: checked by its own rule, so `?limit=`, `?cursor=`, `?archived=`, `?includeArchived=` are `400 invalid_query`; an empty filter matches nothing; `q` blank means no condition | 0.1 |
| Cursors after a restart | A cursor belongs to the app that issued it: after a restart it is `400 invalid_query` | 0.5 |
| Whether deleting a project frees its key | It does: a new project in the team may reuse it | 3 |
| Mentions of a user who leaves and rejoins | Leaving changes no comment's `mentions`, so after rejoining they are listed again | 6 |
| When a webhook attempt counts as answered | When the status line and headers arrive; the body is not waited for and never changes the outcome | 8 |
| Whether `createApp` creates a missing data file | It does not; the first successful state-changing request does | 10.1 |

## What the skeptic says about this kit (TDM-233)

`runSkepticChecks` passes this kit with no blocking finding. Two of its rules meet content that is
correct by design here, and the kit declares both, so they show as warnings instead:

- `workloads[].instruction_kind: contract`: `instruction.md` is the contract the hidden tests
  check, exact routes, bodies and error codes included (plan.md 17.2 rule 9 wants every assertion
  to trace to it). The test names and asserted values it shares with the tests are the contract,
  not a leak. The skeptic checks instead that it copies no line of the oracle's or the tests' code.
- `gates[].fixtures: [gates/hidden-tests/*/fixtures/]`: the gate's `tracker-v1.json` is a
  byte-identical copy of the input the task ships, kept so the grade never reads the workspace's
  copy. It is an input, not an expected output.

The third block was real: the only do-less was a no-op, so nothing showed that the gate refuses
a near miss. `proof/do_less/partial-oracle/` fixes that (PROOF.md: 106/120 hidden tests pass, and
the gate fails).
