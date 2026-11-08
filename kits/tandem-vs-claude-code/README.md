# kits/tandem-vs-claude-code

The acceptance kit for Anybench (plan.md E14, ticket 14.2; the "What using it looks like" example
on the product page). Question: **does Tandem with 3 or 5 workers beat plain Claude Code, solo or
with subagents?** Three coding tasks, graded by hidden tests that live outside the starting repos.

## Setups

| | Contender | Driver | How |
| --- | --- | --- | --- |
| A | `claude-code-solo` (baseline) | `coding-agent` | headless Claude Code, `--disallowedTools Task`, `adapters/claude-code-solo/CLAUDE.md` |
| B | `claude-code-subagents` (competitor) | `coding-agent` | headless Claude Code with `adapters/claude-code-subagents/.claude/agents/` (implementer, test-writer, reviewer) |
| C | `tandem` with `TANDEM_WORKERS=3` (subject) | `harness` | planner + 3 workers on a fresh Tandem canvas; approvals by `human_in_loop {kind: tandem, policy: llm-reviewer}` |
| D | `tandem` with `TANDEM_WORKERS=5` | `harness` | same, 5 workers |

C and D are one contender expanded by `vary: {TANDEM_WORKERS: [3, 5]}`. Convention this kit relies on:
a `vary` key expands only the contenders whose `driver.env` declares it (`tandem` declares
`TANDEM_WORKERS: "3"`), so A and B are not duplicated. Score setup ids look like
`tandem@TANDEM_WORKERS=3`.

## Tasks

| Workload | Shape | Hidden tests | What it is |
| --- | --- | --- | --- |
| `todo-api` | splits cleanly into 5 tickets | 16 | Build accounts, bearer auth, todo CRUD, cursor listing and JSON persistence on a `node:http` skeleton. |
| `auth-refactor` | tightly coupled, ~9 files | 14 | Move a cookie-session service to stateless HS256 JWT: config, types, middleware, every auth route, revocation. |
| `bug-hunt` | from a reverted commit | 12 | Re-fix RFC 4180 CSV quoting; the grader is the tests from the reverted fix commit (`workloads/bug-hunt/PROVENANCE.md`). |

Every starting repo is Node/TypeScript with **zero dependencies**: Node 22.18+ runs `.ts` directly
(type stripping) and tests use `node:test`, so everything runs offline with no `npm install`.

## Layout

```
anybench.yaml                     the kit (KitSpec v2)
rubric.md                         L6 code-quality rubric (reviewed requirement, scale 1–4)
adapters/                         L1 install + health check, L2 drivers (claude-code, tandem)
workloads/<id>/input/             L3 starting repo (becomes a one-commit git repo in EVAL_WS)
workloads/<id>/instruction.md     the task the agent gets
workloads/<id>/setup.sh           builds EVAL_WS from input/ (deterministic commit)
gates/hidden-tests/               L5 gate: check.sh → grade.mjs; <id>/*.test.ts + tests.json
gates/api-load/                   L5 gate: p95 at 50 req/s on todo-api, only after hidden tests pass
proof/oracle/<id>/                L7 reference solution overlays (+ driver.sh that applies them)
proof/do_less/do-nothing/         L7 no-op harness
proof/regression/skip-tests/      L7 planted regression ("skip the tests" CLAUDE.md)
scripts/verify-proof.sh           runs the proof in Docker; results in PROOF.md
```

## Gates and scoring

- `hidden-tests` copies the frozen workspace into a sandbox, drops in the workload's hidden tests
  as `.hidden-tests/`, runs them offline with a scrubbed env, and scores every test in `tests.json`
  (a test that never reports counts as failed). It passes only at 100%. Output: `gate.json`,
  `metrics.jsonl` (`hidden_tests_passed`, `hidden_tests_total`, `hidden_tests_passed_ratio`, all
  diagnostic), `hidden-tests.json`, `hidden-tests.log`.
- `api-load` re-runs the hidden tests and only if they all pass starts the app and drives
  `GET /todos` / `POST /todos` at 50 req/s for 20 s, writing `api_p95_ms`. Workloads without an
  API answer `pass: false, "not applicable"`; `api-p95` is scoped to `workloads: [todo-api]`, so
  those trials leave the requirement and the api-load tally.

| Requirement | Metric | Target | Gate | Weight |
| --- | --- | --- | --- | --- |
| Hidden tests pass (42 tests across 3 tasks) | `gate_pass_rate` | at least 1.0 | hidden-tests | 50 |
| API p95 latency at 50 req/s (todo-api) | `api_p95_ms` | under 120 ms | api-load | 10 |
| Wall-clock time (failures count at the task's `timeout_s`) | `wall_s` | relative | hidden-tests | 10 |
| Cost per solved task (all spend ÷ solves) | `cost_micro_usd` | relative | hidden-tests | 10 |
| Code quality (reviewed) | `rubric.md` | 1–4 | hidden-tests | 20 |

Scoring (`packages/bench` `scoreKit`) counts a metric only from trials whose gate passed, except
that cost charges every trial's spend to the solves and time counts a failed trial at the cap. Every
setup is scored over the same tasks: a task a setup never solves is a 0, not a dropped task.

## Proof

```sh
kits/tandem-vs-claude-code/scripts/verify-proof.sh          # print the summary
kits/tandem-vs-claude-code/scripts/verify-proof.sh --write  # and rewrite PROOF.md
```

It runs in `node:22` with `--network none`: the oracle passes 42/42 hidden tests, do-nothing fails
42/42. See `PROOF.md`. Schema and layout checks run in `pnpm -r test`
(`packages/kit/test/tdm128-*.test.ts`, `packages/bench/test/tdm128-*.test.ts`).

## Not covered here

The adapters (`adapters/*/driver.sh`) are written for the coding-agent and harness drivers (tickets
4.7, 4.9) and the approver sidecar (5.7). They have not been run against real Claude Code or Tandem:
that happens in the smoke run and in 14.4.
