# Tandem headless as a harness driver (TDM-41 [4.9], 2026-11-08)

What we learned running Tandem headless for the harness driver, and how
`kits/tandem-vs-claude-code/adapters/tandem/run.sh` uses it. The versions are Tandem server
0.2.0 (GitHub release `v0.2.0`) and `@jaximus/tandem-mcp` 3.2.0 (npm). They were tested on
macOS arm64 (host) and in `node:22` (Debian, Node 22.23.4) on docker-local.

## Commands and what they printed

A server per trial, on its own port and data dir:

```
$ TANDEM_BIN=…/tandem_darwin_arm64 TANDEM_AUTOSTART=0 tandem-mcp up --foreground --no-open --port 47911 --data-dir $D &
[tandem] running …/tandem_darwin_arm64 on http://127.0.0.1:47911 (data: $D) — Ctrl-C to stop
tandem 0.2.0 — data in $D (db $D/tandem.db)
local mode (TANDEM_AUTH=none) — no sign-in; the browser is the owner
$ curl -s 127.0.0.1:47911/healthz      → {"ok":true,"version":"0.2.0"}
$ curl -s 127.0.0.1:47911/api/config   → {"auth":"none","local":true,"transcripts":true,"version":"0.2.0"}
$ ls $D                                 → images secret tandem.db tandem.db-shm tandem.db-wal
```

`init --write` in the workspace creates the canvas and writes two files there:

```
$ API_URL=http://127.0.0.1:47911 TANDEM_AUTOSTART=0 tandem-mcp init --write --name trial-x
  Canvas  trial-x / Code L38VYJDS / Board http://127.0.0.1:47911/c/L38VYJDS
  Wrote …/ws/.mcp.json (mcpServers.tandem).  Appended the queue snippet to AGENTS.md.
$ git status --short   → ?? .mcp.json  ?? AGENTS.md
$ cat .mcp.json        → {"mcpServers":{"tandem":{"command":"npx","args":["-y","@jaximus/tandem-mcp"],
                          "env":{"TANDEM_CANVAS_CODE":"L38VYJDS","API_URL":"http://127.0.0.1:47911"}}}}
```

The simulated human approves through the local-cookie path. `GET /` sets the `tandem_session`
cookie. `POST /api/mcp/auth {code}` with that cookie returns a human canvas token. Then
`POST /api/canvas/actions/<epic>/approve` returns `"approvedBy":"human"`, and the epic's tickets
become `approved_by: policy:epic`. With the cookie, `PATCH /api/canvases/<code>/approval-policy
{"approvalPolicy":"auto"}` returns `200 {"approvalPolicy":"auto","requireCrossModelReview":false}`.

We raced two MCP workers over stdio through the real gateway: `w2` claimed TDM-1, and `w1`'s
`task_claim` returned `{"claimed":false,"claimedBy":"w2","tapOut":true,"reason":"already_claimed"}`.
After that, `/api/metrics` counters read
`{"claims":2,"claim_conflicts":1,"ttl_expiries":0,"fenced_writes":1,…}`, and the ticket's row in
`tandem.db` held `payload.claim {generation:1, holder:"w2"}` and
`payload.contention [{kind:"lost_claim",agent:"w1",holder:"w2"},{kind:"fenced_write",…}]`.

## Facts the driver depends on

- **Running `tandem` with no data dir or port opens `~/.tandem` on 7891.** `tandem --version`
  is not a flag. It starts the server, and that would be the user's own board on a dev machine.
  run.sh always sets `TANDEM_DATA_DIR` and a free port, and never uses 7891. The health check
  never runs the binary, and the version comes from `/healthz`.
- `TANDEM_AUTOSTART=0` goes on the server, on `init` and on every agent session. Without it, an
  MCP gateway that can't reach its API starts a second server on the default port.
- **`init` writes `npx -y @jaximus/tandem-mcp` (unpinned) into `.mcp.json`.** The agents instead
  get `$EVAL_OUT/tandem/mcp.json`, which points at the installed, pinned gateway binary, with
  `--strict-mcp-config`.
- **The board's `drained` is the completion signal.** `GET /api/canvas/epics` gives each epic
  `{state, tasks:{total, byState}, drained}`. `drained` means the epic is approved, has tasks, and
  every task is terminal (done or failed). The board is complete when at least one epic is
  approved, every approved epic has drained, nothing is proposed, and no unepiced ticket is open.
- `GET /api/metrics` is open (no token needed) and holds process-wide counters. That makes them
  trial-scoped, because the server is fresh per trial.
- No table records claims. Each ticket's payload carries a claim record (`generation` goes up on
  every takeover) and a contention trail of up to 20 coalesced events with `count`. The collector
  reads both from a copy of `tandem.db` through `node:sqlite` (Node ≥ 22.13). It falls back to
  the `GET /api/canvas/actions` dump.
- **The board can't tell a simulated approval from a real one** (human-sim is stamped `human`).
  So `simulated_approvals` and the approval latency come from `approvals.jsonl`, never from
  `approved_by`.
- `tandem-mcp up --foreground` exits cleanly on SIGTERM (`received terminated, shutting down… bye`),
  so the db copy taken after the stop is complete.

## How run.sh runs a trial

1. It sources `$HOME/.anybench/proxy.env` (the Naïve model proxy, TDM-16), the same file the
   Claude Code contenders get.
2. It starts the server on a free port, with a data dir under `$TMPDIR` (outside `EVAL_OUT`, so
   the JWT `secret` file is never frozen).
3. It runs `init --write`, and before that keeps a copy of everything in `scrub`.
4. It starts the approver sidecar. That is `eval-approver` from @anybench/approver (TDM-52;
   `TANDEM_APPROVER_BIN`, otherwise PATH) with `--canvas-code` and `--out $EVAL_OUT/tandem`. If
   it isn't installed, the built-in `board.ts approve` runs instead. It handles `auto` and
   `human-sim` and refuses `llm-reviewer` with exit 3.
5. It starts the planner (`claude -p`, stream-json), which proposes one epic and stops. Workers
   start only once approved work is on the board. There are `$TANDEM_WORKERS` of them, each a
   `claude -p` session with `--disallowedTools Task Agent`, so the parallelism under test is the
   board's and not subagents'.
6. It polls the board every `poll_s` until it is complete. Sessions then get `drain_grace_s` to
   exit, and the board is checked again. A hard deadline at `timeout_s` minus a collection reserve
   (`ANYBENCH_WALL_CAP_S` overrides `timeout_s`) gives outcome `timeout` and exit 124. A worker
   that dies while work is open is restarted up to `max_worker_restarts` times, and each restart
   gets its own transcript.
7. It stops everything (TERM, then KILL after `stop_grace_s`; every session is its own process
   group). Then it dumps the board and metrics, copies `tandem.db`, restores or removes the scrub
   list, and copies the workspace, without `.git` or `node_modules`, to `$EVAL_OUT/workspace/`
   for the scoring computer. It writes `tandem/run.json` with
   `{outcome, reason, workers, policy, canvas_code, tandem_version, wall_ms}`.

Each session's stdout goes through `board.ts tap`, which writes the whole transcript to
`tandem/streams/<session>.jsonl`. run.sh's own stdout gets only compact assistant-usage and
`result` lines, so the runner's BYOK token cap (TDM-160) still sees every session's spend.
Parallel lines don't interleave because each one is under PIPE_BUF.

The kit needs `ANYBENCH_HIL_POLICY` because run.sh can't read `anybench.yaml`.
`harnessDriverEnv(kit, contender, workload)` in `@anybench/kit` provides it, and bench
`trialJobFromKit` now merges it into the job env.

## Docker-local run (the done condition)

```
$ cd packages/bench && TDM41_DOCKER_LOG=<file> pnpm exec vitest run test/tdm41-harness-docker.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  264.98s
```

The run used two `node:22` containers. The subject computer ran `install-tandem.sh` as the
`naive` user, which downloaded and verified the v0.2.0 linux_arm64 sha256 and installed gateway
3.2.0 from npm. Then it ran the runner stub (`planHarnessStubTrial`). The scoring computer ran the
toy kit's `hidden-tests` check with `$AB_RUN` = `runuser -u abrun`. Claude Code is a stand-in
(`packages/kit/test/fixtures/harness-tdm41/fake-claude/`) that speaks MCP to the real gateway.
From the log:

| trial | run.json | gate | board (tandem.db) | sessions |
|---|---|---|---|---|
| Tandem ×2 | `completed`, 39.0 s, policy auto, tandem 0.2.0 | **pass** ("all hidden tests pass") | 1 epic, 2 tickets done, 2 claims by 2 claimants, 0 conflicts; approvals `human` 1 (the epic), `policy:auto` 2 | planner + worker-1 + worker-2, `cost_micro_usd` 37,500 (3 × the stand-in's 0.0125 USD) |
| no-op do-less | (no harness) | **fail** ("hidden tests failed") | none: 0 claims | none |

The frozen workspace held `FAKE_PLAN.json README.md package.json src/add.ts src/mul.ts`, with no
`.mcp.json` and no `AGENTS.md`.

## With the real approver (@anybench/approver `eval-approver`, after TDM-52 merged)

On the host (macOS arm64), with Tandem 0.2.0, gateway 3.2.0, the Claude Code stand-in, 2 workers
on the toy workload, and `TANDEM_APPROVER_BIN` pointing at a shim for
`node packages/approver/dist/bin.js`:

| policy | run.json | `approvals.summary.json` |
|---|---|---|
| auto | `completed`, 30.6 s | approvals 3 (`human-sim` 1 = the epic, `policy:auto` 2), latency p50 0 ms, p95 974 ms |
| human-sim | `completed`, 20.6 s | approvals 3 (`human-sim` 1, `policy:epic` 2), latency p50 847 ms, p95 850 ms |

`approver.log` ends with `simulated approvals: 3, latency p50 … ms, p95 … ms`. Both approvers
write the same `approvals.jsonl` fields (`simulated`, `decision`, `target`, `decided_by`,
`latency_ms`), so the collector reads either one.

## Gates in the flagship kit

`gates/hidden-tests/check.sh` and `gates/api-load/check.sh` now follow the gate runner contract
(TDM-51) whenever `$AB_RUN` is set: `check.sh <frozen-out> <workload> <gate.json>`. The graded
tree is `$AB_RUN_DIR/workspace`. `node --test` and the app under load run only through `$AB_RUN`.
The reporter is copied next to the hidden tests so the contender uid can read it. Results come
back over the test runner's stdout and stderr, not through a file the contender could write, and
the api-load server child is inline `node -e`, so the contender uid never reads a kit file.
Without `$AB_RUN`, the old proof-script signature still works. On the host, the todo-api oracle
scored 16/16 in `$AB_RUN` mode, an empty workspace scored 0/16, a missing `workspace/` failed
closed, and api-load on the oracle passed (p95 99.8 ms at 50 req/s over 150 requests).

## Open

- The flagship's `human_in_loop.policy: llm-reviewer` needs `eval-approver` on the subject
  computer (an env recipe has to install @anybench/approver), plus `TANDEM_APPROVER_ARGS`
  (`--reviewer-model … --reviewer-agent-id … --review-budget-micro-usd …`). Without it, run.sh fails the trial (`approver_failed`)
  rather than approve automatically. TDM-184 moves the kit to `auto`.
- The real runner (TDM-46) doesn't run `workloads/<id>/setup.sh` and doesn't copy `EVAL_WS` into
  the bundle. The harness driver copies the workspace itself (`$EVAL_OUT/workspace/`). The
  coding-agent driver (TDM-39) needs to do the same for the hidden-tests gate.
