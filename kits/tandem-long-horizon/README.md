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

## Setups

Same contenders, adapters, pinned model and pinned Claude Code version as
`kits/tandem-vs-claude-code` (epic E18):

| | Contender | How |
| --- | --- | --- |
| A | `claude-code-solo` | headless Claude Code, subagent tool disallowed |
| B | `claude-code-subagents` | headless Claude Code with the implementer, test-writer and reviewer subagents |
| D | `tandem` with `TANDEM_WORKERS=3` | planner + 3 workers on a fresh Tandem canvas, approvals automatic |

Model tokens come from our own Anthropic key (`AB_TOKEN_SOURCE=anthropic_key`) at Claude Code's
default effort with thinking on, the same for every setup, so the Naïve proxy handicap of the
first kit (effort naive-min, thinking off) does not apply. Wall-clock cap: 3 hours per trial, equal
for every setup. Budget for the first full run: $150 of Anthropic tokens, hard stop on overrun.

## Workload

| Workload | Shape | Hidden tests | What it is |
| --- | --- | --- | --- |
| `project-tracker` | whole application, 12 areas | about 120, tagged by area | Build a multi-user project tracker API (accounts, teams and roles, projects, boards, cards, threaded comments with @mentions, search, signed webhooks with retries, rate limiting, versioned persistence with a 1.x migration, audit log) on a `node:http` skeleton that only serves `GET /health`. |

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
scripts/setup-workspace.sh                  the deterministic workspace builder setup.sh calls
scripts/gen-seed-v1.mjs                     regenerates tracker-v1.json (fixed salts and times; --check)
scripts/ab-run-local.sh                     local stand-in for the gate runner's $AB_RUN (no uid switch)
gates/hidden-tests/check.sh                 the hidden-tests gate (L5), scoring computer only
gates/hidden-tests/grade.mjs                copies the tests in, runs them, scores them, writes the verdict and metrics
gates/hidden-tests/project-tracker/         120 hidden tests, one file per area, tests.json, fixtures/tracker-v1.json
proof/oracle/driver.sh                      applies proof/oracle/<workload>/ (the reference solution)
proof/oracle/project-tracker/               the reference solution: an overlay on the starting repo
proof/do_less/do-nothing/driver.sh          the no-op harness
proof/regression/skip-tests/CLAUDE.md       the planted regression ("skip the tests")
scripts/verify-proof.sh                     the offline proof (Docker, node:22, --network none); writes PROOF.md
```

Still to come in sibling tickets of E18: the kit file `anybench.yaml` with the adapters (copied
from `kits/tandem-vs-claude-code`).

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
# the proof (oracle 120/120 three times, do-nothing only /health); --write rewrites PROOF.md:
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
