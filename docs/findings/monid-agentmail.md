# Monid: AgentMail and lead sources through one key (2026-11-07)

Decision: outreach (E15) sends and reads email **through Monid** (provider `agentmail`), paid from Monid credit. No separate `AGENTMAIL_API_KEY` is needed.

## Auth
- Base URL `https://api.monid.ai`, header `Authorization: Bearer $MONID_API_KEY` (`monid_live_…`).
- Gotcha: `set -a; . ./.env` did not load the key correctly (401 Unauthorized). Reading the line with quotes and whitespace stripped worked. Load .env through the app's config loader, not a shell `source`.

## Discovery (what I ran)
```
curl -s -X POST https://api.monid.ai/v1/discover -H "Authorization: Bearer $K" \
  -H 'content-type: application/json' -d '{"query":"agentmail inbox create"}'
```
Results (price as returned by discover, USD; confirm with `POST /v1/inspect` before running):

| provider | endpoint | what | price |
|---|---|---|---|
| agentmail | `/create-inboxes` | create an inbox, address in `output.email` | PER_CALL 1 |
| agentmail | `/send-messages` | send from an inbox you own; returns message + thread ids | PER_RESULT 0.001 |
| agentmail | `/list-messages` | messages of an inbox, newest first, label/time filters | PER_CALL 0 |
| agentmail | `/list-threads`, `/threads/{id}` | threads across inboxes | PER_CALL 0 |
| agentmail | `/create-drafts` | compose without sending | PER_CALL 0 |
| agentmail | `/create-domains` | custom sending domain ($1/month), returns DNS records | PER_CALL 1 |
| agentmail | `/list-inboxes`, `/inboxes/{id}` | inbox metadata | PER_CALL 0 |
| hunterio | `/email-finder` | likely email from name + company | PER_RESULT 0.0245 |
| contactout | `/v1/people/enrich/work-email` etc. | person → work email | TIERED 0.02+ |
| anyapi | `/github.repository`, `/github.search_issues` | GitHub repo metadata, issue/PR search | PER_UNIT_MATRIX 0.0012–0.0024 |
| api.strale.io | `/x402/github-repo-analyze` | stack, docs quality, activity | PER_CALL 0.054 |

Running an endpoint: `POST /v1/run {"provider","endpoint","input":{...},"maxCost"}`. The input schema comes from `POST /v1/inspect`. Always pass `maxCost`.

## Consequences for E15
- 15.6a sending: one inbox ($1 once) + $0.001 per email; at `OUTREACH_DAILY_SEND_LIMIT=25`, about $0.75/month in sends.
- 15.8a replies: poll `/list-messages` (free).
- Email lookup for leads: Hunter `/email-finder` ($0.0245/result), used only for leads that pass the fit check. Context.dev `people-enrich` stays the first choice when its credits cover it.
- AgentMail's own free tier (3 inboxes, 100/day) is the documented fallback if Monid routing breaks.
- Money in code: Monid prices are USD floats in the API → convert to integer micro-USD at the boundary (zod transform), never store floats.

## Run-owner email (run.notify), first live send (2026-11-08)
Transactional "your benchmark is done" email (apps/server/src/jobs/run-notify.ts), same AgentMail-via-Monid client as outreach, from `anybench-outreach@agentmail.to`. One live send, to the founder's own account email for their own delivered run:
```
node --env-file=.env --import tsx scripts/ops/send-run-email.ts 01a1b9ee-a665-73d4-9511-3c24e921d864 --web-url https://anybench.vercel.app
run 01a1b9ee-…: state=delivered owner=jaximus808 to=j…@gmail.com from=anybench-outreach@agentmail.to web=https://anybench.vercel.app
{"kind":"sent","messageId":"<010001a1ba47b68d-…@email.amazonses.com>","subject":"Your Anybench result: tandem vs claude-code-solo: no detectable difference at n=3 tasks (4 vs 7 trials)","sendMs":3912,"at":"2026-11-08T08:30:26.481Z"}
```
- `/send-messages` through Monid took 3.9 s end to end. AgentMail hands off to Amazon SES (message id `@email.amazonses.com`).
- `/list-messages` (free) shows the copy labelled `sent` + our `run-notify` label, timestamp 08:30:24Z. AgentMail exposes no delivered/bounced label on the message, so inbox arrival has to be confirmed at the recipient.
- `--dry-run` renders without sending (it claims and then releases `stage_outputs.notified.<state>`).
- Exactly once: the job claims `runs.stage_outputs.notified.<state>` before sending and records `{sent_at, message_id}` after, so this run will not be emailed again for `delivered`.
