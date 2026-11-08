# kits/tandem-vs-claude-code

The acceptance kit for Anybench (plan.md E14, ticket 14.2; the "What using it looks like" example
on the product page). Question: **does Tandem with 1, 3 or 5 workers beat plain Claude Code, solo or
with subagents?** Three coding tasks, graded by hidden tests that live outside the starting repos.

## Setups

| | Contender | Driver | How |
| --- | --- | --- | --- |
| A | `claude-code-solo` (baseline) | `coding-agent` | headless Claude Code, `--disallowedTools Task Agent` (both names of the subagent tool), `adapters/claude-code-solo/CLAUDE.md` |
| B | `claude-code-subagents` (competitor) | `coding-agent` | headless Claude Code with `adapters/claude-code-subagents/.claude/agents/` (implementer, test-writer, reviewer) |
| C | `tandem` with `TANDEM_WORKERS=1` (subject) | `harness` | planner + 1 worker on a fresh Tandem canvas; approvals automatic (`human_in_loop {kind: tandem, policy: auto}`) |
| D | `tandem` with `TANDEM_WORKERS=3` | `harness` | same, 3 workers |
| E | `tandem` with `TANDEM_WORKERS=5` | `harness` | same, 5 workers |

C, D and E are one contender expanded by `vary: {TANDEM_WORKERS: [1, 3, 5]}`. Convention this kit relies on:
a `vary` key expands only the contenders whose `driver.env` declares it (`tandem` declares
`TANDEM_WORKERS: "3"`), so A and B are not duplicated. Score setup ids look like
`tandem@TANDEM_WORKERS=3`.

### Comparable setups (plan.md 17.2 rule 4)

`validateKitDir` refuses a kit whose setups differ in anything but what is under test. Here every
setup runs:

- the same model, `anthropic/claude-sonnet-4.6` (a Naïve proxy id: the proxy refuses Anthropic's
  own ids). It is `driver.model`, passed to Claude Code as `CC_MODEL` and also set as every
  `ANTHROPIC_DEFAULT_*_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL`, so subagents and background calls
  run it too. The drivers refuse to run without it;
- the same Claude Code, `2.1.319` (`versions.CLAUDE_CODE_VERSION`, also the install scripts'
  default, so a runner that doesn't export `versions` still installs it). It is the version
  verified on the Naïve proxy (TDM-16) and the one that reads `CLAUDE_CODE_MODEL_CAPABILITIES`;
- the same token source: the Naïve model proxy (below);
- Tandem at commit `05b4a02` (tag `v0.2.0`) and `@jaximus/tandem-mcp@3.2.0` (tag `mcp-v3.2.0`, the same commit);
- the same caps: 3600 s wall clock and 8,000,000 tokens;
- no assist only one setup gets: approvals are automatic, since A and B have no approval step
  for an llm-reviewer to help with.

The contender order rotates per round (`schedule.order_seed`).

### Tokens: the Naïve model proxy (founder decision)

Every contender is paid through Naïve's Anthropic-compatible proxy
(`docs/findings/claude-code-naive-proxy.md`), with the same settings in each `driver.env`:
`AB_TOKEN_SOURCE=naive_proxy`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, `MAX_THINKING_TOKENS=0`
and `CLAUDE_CODE_MODEL_CAPABILITIES=-effort,-max_effort,-xhigh_effort,-per_turn_effort,-adaptive_thinking,-context_management,-rejects_disabled_thinking`.
The worker provisions a per-trial `proxy:write` key into `$HOME/.anybench/proxy.env`
(`provisionClaudeCodeProxyEnv` in packages/naive); the drivers source it, keep the kit's settings
over the file's, and unset any `ANTHROPIC_API_KEY`, so no contender can bypass the proxy. The kit
has no secrets, and the only model host on the allow-list is `api.vetta.sh`.

**Disclosure (goes with every result from this kit):**
`tokens: naive-proxy, effort: naive-min, thinking: off`. The proxy refuses client-chosen effort and extended thinking, so every setup runs
the model at its lowest published effort with thinking off. That is not first-party Claude Code at
its default effort: results compare these setups with each other, under the same handicap.

## Tasks

| Workload | Shape | Hidden tests | What it is |
| --- | --- | --- | --- |
| `todo-api` | splits cleanly (no ticket split is given: planning is the harness's job) | 16 | Build accounts, bearer auth, todo CRUD, cursor listing and JSON persistence on a `node:http` skeleton. |
| `auth-refactor` | tightly coupled, ~9 files | 14 | Move a cookie-session service to stateless HS256 JWT: config, types, middleware, every auth route, revocation. |
| `bug-hunt` | planted bug | 12 | Fix RFC 4180 CSV quoting. A planted bug with synthetic history, not mined history; the grader is the codec's removed tests (`workloads/bug-hunt/PROVENANCE.md`). |

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

Both gates use the gate runner's calling convention (packages/bench `gate.ts`, TDM-51):
`check.sh <frozen-out> <workload-id> <gate.json>`. Contender code runs only through `"$AB_RUN"`
(its own uid, clean env) in `$AB_RUN_DIR` (its own copy of the outputs, with `workspace/` in it);
the check writes only under `$1` and `$3`, and an EXIT trap turns any verdict-less exit into a FAIL.
Locally, `scripts/ab-run-local.sh` stands in for `$AB_RUN` (clean env, no uid switch).

- `hidden-tests` replaces `workspace/.hidden-tests/` with the workload's hidden tests (before any
  contender code runs), runs them offline through `$AB_RUN`, and scores every test in `tests.json`
  (a test that never reports counts as failed, so `process.exit(0)` on import fails them all). It
  passes only at 100%. Output: the verdict, and `hidden-tests.json`, `hidden-tests.log`,
  `hidden-tests.metrics.jsonl` in `<frozen-out>`.
- `api-load` re-runs the hidden tests and only if they all pass starts the app through `$AB_RUN`
  (`gates/api-load/serve.ts`, which exits when its stdin closes) and drives `GET /todos` /
  `POST /todos` at 50 req/s for 20 s, writing `api_p95_ms` to `api-load.metrics.jsonl`. Workloads
  without an API answer `{pass: false, applicable: false}`; `api-p95` is also scoped to
  `workloads: [todo-api]`.

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

## The Tandem adapter (TDM-41)

`adapters/tandem/driver.sh run` execs `run.sh`, configured by the flat `harness.yaml`. It starts a fresh
Tandem server per trial (own port and data dir), runs `tandem-mcp init --write`, starts the approver
sidecar for `human_in_loop.policy` (`eval-approver` from @anybench/approver, else a built-in one for
`auto` / `human-sim`), then a planner and `$TANDEM_WORKERS` workers as headless Claude Code sessions.
It stops when every approved epic has drained, or at the hard timeout. Outputs: `tandem/` (board
and `/api/metrics` dumps, `tandem.db`, `approvals.jsonl`, one stream-json per session, `run.json`)
and the scrubbed workspace in `workspace/` for the scoring computer. `install-tandem.sh` pins the
server (sha256-checked) and the gateway. The collectors are in `packages/kit/src/drivers/harness/`.
Details and the docker-local run: `docs/findings/harness-driver-tandem.md`.

## Not covered here

The claude-code adapter (`adapters/claude-code/driver.sh`) is written for the coding-agent driver
(ticket 4.7). Neither adapter has run against real Claude Code yet (the harness driver's
docker-local proof uses a Claude Code stand-in against a real Tandem): that happens in the smoke
run and in 14.4.
