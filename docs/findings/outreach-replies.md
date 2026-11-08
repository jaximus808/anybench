# Outreach replies: polling, classification, suppression, funnel (TDM-167 [15.8a], 2026-11-08)

What shipped: `anybench outreach poll` (alias `replies`) and `anybench outreach stats`.
Code: `packages/outreach/src/{replies,stats}.ts`, the account manager role in
`packages/agents/account-manager/`, migration `0007_outreach_replies`.

**The poller never sends or answers anything.** Interested, question and unclear replies get
`needs_founder = true`, and the founder answers them by hand. The only outbound call is the
optional Slack post for interested replies (`SLACK_WEBHOOK_URL`, our own channel, `--no-slack`
turns it off).

## Live check (read-only, our own inbox)

The DB was a scratch copy: `anybench_tdm167_evidence` on the local dev Postgres, migrated to 0007,
with the dev DB's `leads`/`outreach_messages`/`suppressions` rows copied in via `pg_dump --data-only`.
`.env` was loaded with `node --env-file`, which prints nothing.

```
node --env-file=.env apps/cli/dist/index.js outreach poll --no-slack --database-url postgres://…/anybench_tdm167_evidence
leads db: localhost:55432/anybench_tdm167_evidence · inbox anybench-outreach@agentmail.to · caps: $0.1000 Monid, $0.2000 Naïve
polled 2 received messages since the start: 0 inbound, 0 already stored, 0 new
new replies: interested 0, question 0, not_now 0, unsubscribe 0, bounce_or_auto 0, unclear 0
suppressed 0
needs founder 0 (nothing was answered automatically)
spent: $0.0000 Naïve (0 micro-USD), $0.0000 Monid (0 micro-USD)
```
- The 2 `received` messages are the TDM-162 spike's self-send and its threaded reply. Both are
  `from` our own address, so `isInboundReply` correctly drops them: 0 inbound.
- A self-send can't produce a test *inbound* reply, because the sender is always our inbox. So no
  self-send was made for this ticket. The classification paths are covered on fixture threads
  instead (FakeAgentMail).
- Spend: Monid 0 µ$ (`/list-messages` and `/messages/{id}` are PER_CALL 0; the client's cap was
  $0.10). Naïve 0 µ$: the classifier agent is created lazily and only for a reply the rules are
  unsure about, and there were none.

```
node --env-file=.env apps/cli/dist/index.js outreach stats --database-url postgres://…/anybench_tdm167_evidence
outreach funnel (distinct leads, counted from the DB)
  sourced       7
  scouted       0
  fit           0
  drafted       0
  approved      0
  sent          0
  replied       0
  interested    0
  unsubscribed  0
replies: 0 stored, 0 waiting for the founder, 0 bounces, 0 auto-replies
suppressions: 0
spend: Naïve 0 micro-USD ($0.0000; scout 0, replies 0), Monid email lookups 0 micro-USD, Context.dev credits not recorded in the DB (see `outreach source` output)
```

## How it works (what downstream tickets rely on)

- **Cursor:** `after = max(outreach_replies.received_at) − 1 h`, so the overlap is re-read for
  free, and the `agentmail_message_id` unique key dedupes it. List rows only carry `preview`, so
  every new message is fetched with `/messages/{id}` (free) for `extracted_text` and headers.
- **Quoted history is stripped before classifying.** Our own footer says "unsubscribe", so a
  classifier that read the quote would suppress everyone who replied. The poller uses
  `extracted_text`, and when that's missing it cuts at "On … wrote:", Outlook `From:` blocks and
  `>` lines.
- **Rules come first.** In order: bounce (mailer-daemon or a bounce subject), opt-out (subject or
  text: unsubscribe, remove me, stop on its own, opt me out, don't contact me…), auto-reply
  (Auto-Submitted / X-Autoreply / out-of-office wording), not_now (checked before interested,
  because "not interested" contains "interested"), interested, question ("?"). The Naïve
  account manager is asked only when the rules are unsure (`unclear`, or not_now combined with a
  question), within `OUTREACH_REPLY_MODEL_CAP_MICRO_USD` ($0.20/poll, $0.05/reply budget, model
  `deepseek/deepseek-v4-flash-0731`). Opt-outs and bounces never reach the model.
- **Linking a reply to its lead:** first `In-Reply-To`/`References` → `outreach_messages.agentmail_message_id`,
  then the sender → `leads.email`. A bounce suppresses the *lead's* address (from the cited
  message, or an address in the bounce body that matches a lead), never the mailer-daemon's.
  If nothing matches, it's marked for the founder.
- **One statement per reply** (CTEs): insert `outreach_replies`, `insert into suppressions … on
  conflict do nothing` (always, even if the reply was already stored), lead status
  (`interested | replied | not_now | unsubscribed | bounced`; `unsubscribed` is sticky), and the
  outbound message `sent → replied | bounced`. An opt-out can't be lost between two round trips.
- An unsubscribe from an address that matches no lead is still suppressed.

## For TDM-166 (sending)

- Before every send, call `LeadStore.suppressed([to])` (`PgLeadStore`) and refuse when the result
  is non-empty. Polling writes the same `suppressions` table (lowercased email, reason
  `unsubscribe` | `bounce`). Tests prove the address is reported as suppressed right after
  the poll.
- When a send succeeds, update the `outreach_messages` row to `status = 'sent'`,
  `sent_at = now()` and `agentmail_message_id = SentMessage.messageId` (the RFC id, e.g.
  `<…@email.amazonses.com>`). Replies are linked to the lead through that id, and `stats` counts
  `sent` from `sent_at`, `approved` from `approved_by`, and `drafted` from `kind = 'initial'` rows.
  A row only moves to `replied`/`bounced` while it is `sent`.
- Run `poll` before each send batch, so an opt-out that arrived since the last batch is honoured.
