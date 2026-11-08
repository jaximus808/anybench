# Trial traces: what a trial bundle holds, and what it says about run 01a1bae4

2026-11-08. Run `01a1bae4-3254-7ab0-a68a-46d90aa060f7` (tandem-vs-claude-code, 36 trials:
claude-code-solo × 18, tandem ×3 workers × 18, tasks auth-refactor / bug-hunt / todo-api).

## How the bundles were read

`trials.logs_url` is `artifact:runs/<run>/trials/<trial>/out.tar.gz`. Downloaded all 36 with a
presigned GET from `ArtifactStore.createDownload` (config loaded in-process with
`tsx --env-file=.env`, never printed):

```
01a1bae4-5066-7da3-bc5f-40ea32b25644 27e77fea-… todo-api done 23859      (solo: ~12–30 KB)
01a1bae4-5066-7dc0-b1fb-be46663700e2 af031210-… todo-api done 125822     (tandem: ~75–125 KB)
```

## Bundle layout

Solo (claude-code-solo), out.tar.gz:

| File | What it is |
| --- | --- |
| `manifest.json` | `{trial_id, attempt, frozen_at, files: [{path, sha256, size_bytes}]}` |
| `events.jsonl` | the runner's own trial events (`trial.heartbeat`, `trial.phase` installing → warming → running → collecting) with `at` |
| `versions.json` | `{"claude_code":"2.1.319 (Claude Code)","node":"v22.23.4","model":"anthropic/claude-opus-5.5","setup":"claude-code-solo"}` |
| `stream.jsonl` | the Claude Code `--output-format stream-json` transcript |
| `stdout.log`, `stderr.log` | empty for solo (the transcript is `stream.jsonl`) |
| `machine.json` | hostname, uname, lscpu, … |
| `workspace/**` | the final workspace (no `.git`, no `node_modules`) |

Tandem (kits/tandem-vs-claude-code/adapters/tandem/run.sh), out.tar.gz adds `tandem/`:

| File | What it is |
| --- | --- |
| `tandem/streams/planner.jsonl`, `worker-{1,2,3}.jsonl` | one stream-json transcript per `claude -p` session (+ empty `*.stderr.log`) |
| `tandem/actions.json` | the board dump: the epic and its tasks, `claimedAt`, `claimedBy`, `payload.contention[]` (`lost_claim` with `at`, `agent`, `holder`), `state`, `updatedAt` |
| `tandem/approvals.jsonl` | the approver sidecar: `{"at":…,"decision":"approve","target":{"type":"epic"},"decided_by":"human-sim",…}` |
| `tandem/run.json` | `{"outcome":"completed","workers":3,"policy":"auto","wall_ms":250230,…}` |
| `tandem/agents.json`, `epics.json`, `gate.json`, `metrics.json` | board roster, epic summary, approval-gate metrics, the board server's route latencies |
| `tandem/server.log`, `init.log` | the Tandem server log (every HTTP call) and `tandem-mcp init` output |
| `tandem/tandem.db` | a copy of the board's SQLite database |
| `tandem/*-prompt.md` | the planner and worker prompts |
| `stdout.log` | only the compact `[run] {"type":"assistant","message":{"id":…,"usage":…}}` lines the runner's token cap reads |

### What the transcripts carry (and don't)

- Every `assistant` / `user` line has an ISO `timestamp` (written when the line is emitted). The
  `system/init` and `result` lines have none.
- One model response is split over several `assistant` lines, one per content block, sharing
  `message.id`. Tool results come back as `user` lines with `tool_result` blocks, `is_error`, and
  for Bash a top-level `tool_use_result` (stdout, and `bashEditDiff.files[].filePath` for files the
  command changed).
- **Per-turn usage is all zeros** (`"usage":{"input_tokens":0,"output_tokens":0,…}` on every
  assistant line, through the Naïve model proxy). Only the session's `result` line has real totals:
  `usage` (input, output, cache read, cache creation), `total_cost_usd` (Claude Code's list-price
  estimate, `costBasis: "list"`), `duration_ms`, `num_turns`.
- Board MCP calls carry the board session token as an `input.session` JWT; the trace drops it.
- The gate's evidence files (`hidden-tests.json`/`.log`) are **not** stored: they stay on the
  scoring computer, which is destroyed. `trials.gate` keeps each gate's `reason` (with the first
  failing test and message) and a 2000-char `log_tail`.
- Four of the 54 Tandem worker sessions in this run have no `result` line: they were still in
  `queue_wait` when the board drained and run.sh stopped them. Their tokens are unknown.

## Timing model used by the parser

`apps/server/src/lib/trial-trace/parse.ts`:

- t = 0 is the runner's `running` phase; the end is `collecting`. Same clock as the transcripts
  (both on the eval computer).
- A session starts at (last timestamp − `result.duration_ms`); e.g. solo: 11:24:57.079 − 73.71 s
  = 11:23:43.369, vs `running` at 11:23:41.700 (1.7 s of runner/CLI startup).
- A model turn runs from the previous line of its lane to the last block of its `message.id`; a
  tool call from its `tool_use` line to its `tool_result` line.
- Wall split: each 10 ms counts once, as the busiest thing running across all sessions (model >
  tool > board call/wait > nothing).
- A model turn whose only calls went to `mcp__tandem__*` is a "board-only turn"
  (`model_board_ms`). `queue_wait` is "waiting on the board".

## What run 01a1bae4 shows (backfilled traces, n = 18 per setup)

`scripts/ops/backfill-trial-traces.ts --run 01a1bae4-…` →
`{"dry_run":false,"traced":36,"no_bundle":0,"errors":0}`. `max(trials.updated_at)` for the run was
`2026-11-08 12:16:24.664+00` before and after (backfill at ~13:05 UTC): no trial row changed.

| per trial (avg) | claude-code-solo | tandem ×3 |
| --- | --- | --- |
| wall | 1m 11s | 3m 57s (3.3×) |
| model call in flight | 65.4 s | 182.5 s |
| only board calls / waits in flight | 0 | 33.5 s |
| nothing running (startup, teardown) | 2.2 s | 16.2 s |
| sessions | 1 | 4 |
| model turns | 4.8 | 42.2 |
| model time summed over sessions | 65.4 s | 377.8 s, of which 257.6 s (68%) in board-only turns |
| blocked in `queue_wait` (summed) | 0 | 110.3 s |
| lost claims | 0 | 3.2 |
| cache-read tokens (summed) | 116k | 1.98M (n=14 with every session reporting) |

Tandem phases (avg): setup 3.6 s, planning 34.9 s (planner alone; workers start when the epic is
approved), work 186.2 s, teardown 12.6 s.

Failing trial `01a1bae4-5066-7dc0-b1fb-be46663700e2` (tandem, todo-api): hidden test
`persistence.test.ts › the data file stores a password hash, never the password` fails with ENOENT
on `data.json`. The trace's top lead is worker-3's `Write src/store.ts` at 1:37; that file's
`persist()` schedules the write with `setTimeout(…, 50)` ("debounced atomic JSON persistence" in
the epic summary), and the planner's epic body (also a lead) asked for debounced writes. The
hidden test reads the file right after `POST /auth/register` returns, before the 50 ms flush.
