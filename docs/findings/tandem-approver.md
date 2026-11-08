# Tandem approver: approval paths on a local Tandem (TDM-52 [5.7])

Probed on 2026-11-07 against `~/.tandem/bin/tandem` **0.2.0** (local mode, `TANDEM_AUTH=none`),
started as a throwaway server so the real board was never touched:

```sh
cp ~/.tandem/bin/tandem "$SCRATCH/tandem-bin"     # the sandbox SIGKILLs (exit 137) the binary in ~/.tandem/bin; a copy runs
TANDEM_DATA_DIR="$SCRATCH/data" PORT=17952 nohup "$SCRATCH/tandem-bin" > server.log 2>&1 &
curl -s http://127.0.0.1:17952/healthz            # {"ok":true,"version":"0.2.0"}
```

Careful: running the binary without `TANDEM_DATA_DIR` opens the real `~/.tandem/tandem.db` (it then
failed to bind :7891 because the real server holds it). Always set `TANDEM_DATA_DIR` and `PORT`.
The binary takes no `up --foreground` subcommand in 0.2.0; it runs as the server directly.

## Identities

- **Human** = a `tandem_session` cookie and no `X-Tandem-Agent` header. In local mode `GET /` (the
  SPA's HTML) mints the cookie for the fixed local user `00000000-0000-4000-8000-000000000001`.
- **Agent** = `X-Tandem-Agent: <name>`; provenance stamps `agent:<name>`.
- Every `/api/canvas/*` call also needs `Authorization: Bearer <token>` from
  `POST /api/mcp/auth {"code"}`. With the cookie it is the owner's token; without, an anonymous
  write token (local canvases are public + writable).

```text
GET /                                         → 200, Set-Cookie: tandem_session=…
POST /api/canvases {"name":"probe"} (cookie)  → {"code":"N7RN858V","ownerUserId":"0000…0001","approvalPolicy":"epic",…}
POST /api/mcp/auth {"code"}                   → {"token":"…","role":"write"}
```

## auto

```text
PATCH /api/canvases/N7RN858V/approval-policy {"approvalPolicy":"auto"} (cookie)
  → {"approvalPolicy":"auto","requireCrossModelReview":false}
POST /api/canvas/actions {"type":"epic",…} (agent planner-1)  → state "proposed"
POST /api/canvas/actions {"type":"task",payload.epicId} (agent) → state "approved", approvedBy "policy:auto"
```

The PATCH is owner-only (`requireCanvasOwner`): it needs the cookie, a bearer alone gets 401.
Epics stay `proposed` under `auto`: the human-sim session must approve each one.

## Epic approve (cookie + bearer)

```text
POST /api/canvas/actions/{epic}/approve  (bearer only)     → 403 {"error":"only a signed-in human can approve an action"}
POST /api/canvas/actions/{epic}/approve  (cookie + bearer) → 200 {"action":{…,"state":"approved","approvedBy":"human"}}
```

Tandem stamps `approvedBy: "human"` for our simulated human. **The board cannot tell it apart from a
real person**, so `approvals.jsonl` is the source of truth: those events say `simulated: true,
decided_by: "human-sim", board_stamp: "human"`. Under `epic`/`auto` the epic approval cascades
asynchronously (a goroutine) to its proposed tasks, stamped `policy:epic`.

## peer (llm-reviewer)

```text
PATCH …/approval-policy {"approvalPolicy":"peer","requireCrossModelReview":true} (cookie)
POST /api/canvas/agents {"name":"reviewer-1","role":"executor","model":"gpt-5"} (agent reviewer-1) → 201
POST …/{epic}/approve (agent reviewer-1)   → 403 {"error":"peer_epic_human_only",…}
POST …/{epic}/approve (cookie)             → 200 approvedBy "human"   (no cascade under peer)
POST …/{task}/approve (agent planner-1)    → 403 {"error":"peer_self_approval",…}
POST …/{task}/approve (agent reviewer-1)   → 200 approvedBy "agent:reviewer-1"
```

Agent roles are only `planner | executor` (400 otherwise). An unregistered agent name gets
`peer_agent_unregistered`. Rejects are human-only on every policy, so a reviewer "reject" goes
through the cookie session with the reviewer's reason.

## The approver end to end

`pnpm --filter @anybench/approver build`, then the CLI against a fresh server on :17953 while a
planner (curl as `planner-1`) proposed one epic and two tasks:

```text
$ node dist/bin.js --policy human-sim --tandem-url http://127.0.0.1:17953 --out $D/out --code-file $D/out/canvas.env --trial demo --contender tandem --poll-ms 300
TANDEM_CANVAS_CODE=YBEXT45D
(SIGTERM)
simulated approvals: 3, latency p50 222 ms, p95 308 ms
```

`approvals.jsonl` (one line shown):

```json
{"v":1,"simulated":true,"kind":"tandem","policy":"human-sim","config_hash":"0061df68d64c4a4c","trial_id":"demo","contender_id":"tandem","decision":"approve","target":{"type":"epic","id":"21bb1730-…","title":"E1"},"decided_by":"human-sim","board_stamp":"human","requested_at":"2026-11-08T03:17:09.173932Z","decided_at":"2026-11-08T03:17:09.481Z","latency_ms":308,"reason":"simulated approval (approve-all policy)"}
```

The live test runs all three policies (epic + 3 tasks each, all approved, 4 events logged each):

```text
$ TANDEM_BIN=$SCRATCH/tandem-bin pnpm --filter @anybench/approver exec vitest run test/tdm52-live-tandem.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
```
