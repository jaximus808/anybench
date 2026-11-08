# packages/approver

The human stand-in for harnesses with a human gate (plan.md P3, ticket 5.7). Every decision is a
**simulated**, timed event in `EVAL_OUT/approvals.jsonl`; reports print
`simulated approvals: N, latency p50/p95`, never human minutes (plan.md 17.2 rule 10).

## Policies (`human_in_loop.policy`)

| Policy | Tandem | Naïve |
|---|---|---|
| `auto` | `PATCH approval-policy auto`; tasks born `policy:auto`; epics approved by the human-sim session | allow every tool call, fixed `default_answer` |
| `human-sim` | cookie + bearer session approves each epic (Tandem stamps `human`); tasks cascade `policy:epic` | same as auto, `decided_by: human-sim` |
| `llm-reviewer` | `peer` + `requireCrossModelReview`; a reviewer on a different model approves tasks as `agent:<name>`; epics and rejects go through the cookie session | the reviewer decides allow/deny and answers |

Epics are human-only in Tandem under every policy, so the human-sim session is always opened.
Details and the probes: `docs/findings/tandem-approver.md`.

## Interface for the harness driver / Tandem adapter (TDM-41)

```ts
import { approverConfigFromKit, createTandemApprover } from "@anybench/approver";

const config = approverConfigFromKit(kit.human_in_loop, { reviewer_model }); // once per run, every contender
const approver = createTandemApprover({ baseUrl, config, outDir: EVAL_OUT, trialId, contenderId, reviewer });
const { canvasCode } = await approver.prepare();     // export TANDEM_CANVAS_CODE
const stop = new AbortController();
const loop = approver.run({ signal: stop.signal, pollMs: 1000, onError: log });
// ... driver.sh run ...
stop.abort(); await loop;
approver.summary();                                   // ApprovalSummary
```

Or as a sidecar process (in the VM):

```sh
eval-approver --policy auto --tandem-url http://127.0.0.1:7891 --out "$EVAL_OUT" \
  --code-file "$EVAL_OUT/tandem/canvas.env" --trial "$TRIAL" --contender tandem &
# wait for the file, then: . "$EVAL_OUT/tandem/canvas.env"; run the driver; kill -TERM %1; wait
```

On exit it writes `approvals.summary.json` next to `approvals.jsonl`.

Naïve agents under test: `respondToNaiveSession({ api, sessionId, pending, config, log, requestedAt })`
with `api` = the SDK's `sessions.confirmTool` / `sessions.answer`.

## Fairness and leaks

- `config_hash` is on every event; `assertSameApproverForAll(events)` throws if two contenders got
  different approver configs (rule 4). The reviewer instruction is one constant.
- The approver reads only board text. Every outgoing string (reviewer prompt, reject reason, Naïve
  answer) passes `LeakGuard`, which refuses scoring paths (`gates/`, `reference/`, `proof/oracle/`),
  hidden-test talk and caller-supplied snippets.
- `llm-reviewer` refuses a reviewer whose model is a model under test.

## Tests

`pnpm --filter @anybench/approver test` runs against an in-memory fake Tandem. With `TANDEM_BIN` set
it also starts a real Tandem on a free port with a temp data dir and runs every policy live.
