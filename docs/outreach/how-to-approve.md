# How to review, approve and send outreach drafts

Nothing is emailed until **you** approve a draft and then **you** run the send command with
`--send`. Agents never pass `--send` or `--yes` unless you tell them to.

## 0. Setup (once per terminal)

```sh
cd /Users/jaxon/coding-project/anybench
docker compose -f docker-compose.dev.yml up -d postgres     # the drafts live in the local dev DB
export OUTREACH_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench
export OUTREACH_APPROVER=Jaxon                              # recorded as approved_by + in interventions
ab() { node --env-file=/Users/jaxon/coding-project/anybench/.env \
  /Users/jaxon/coding-project/anybench/apps/cli/dist/index.js "$@"; }
```
If `ab` says a command is unknown, rebuild the CLI: `pnpm --filter "anybench..." build`.

## 1. Review

```sh
ab outreach review                 # the queue: id, status, recipient, subject, lint problems
ab outreach review walk            # easiest: shows each draft, then [a]pprove [e]dit [r]eject [s]kip [q]uit
```
Or one at a time:
```sh
ab outreach review show <id>       # the full email, where the address was published, the README lines it quotes
ab outreach review edit <id>       # opens $EDITOR; keep "Subject: ..." on line 1, then a blank line
ab outreach review approve <id>    # asks "Approve ...? [y/N]"; refuses a draft that fails lint
ab outreach review reject <id> --note "why"
```
`<id>` can be the first 8 characters. Approve and reject each write an `interventions` row.
Editing an approved draft sends it back to `draft`, so it needs approving again.

Before you approve, check:
- The address is the project's published contact. `show` prints the page it came from, so open it.
- The email claims nothing we haven't measured. It only quotes their README, and it never says Tandem won or lost.
- The offer of a free benchmark is one you're happy to honour.

## 2. Check how it renders (optional; goes only to our own inbox)

```sh
ab outreach send-test <id>         # sends to anybench-outreach@agentmail.to only, $0.001
```

## 3. Send (you run this)

```sh
ab outreach send                   # DRY RUN: what would go out today; nothing is sent
ab outreach send --send            # asks you to type "send", then sends the approved drafts
```
- Only approved drafts go out. Each is linted again first: postal address, unsubscribe line, link, and rule 10.
- Suppressed addresses are skipped.
- Sending stops at `OUTREACH_DAILY_SEND_LIMIT` (25) per UTC day.
- It sends from `anybench-outreach@agentmail.to` through AgentMail via Monid, at $0.001 per email, with `List-Unsubscribe: <mailto:anybench-outreach@agentmail.to?subject=unsubscribe>`.

## 4. After sending

```sh
ab outreach poll                   # read replies; "unsubscribe" and bounces are suppressed immediately
ab outreach stats                  # the funnel: leads → scored → drafted → sent → replied
```
Answer interested replies yourself from the inbox.

## If you'd rather an agent sends

Tell the orchestrator something like "send the approved outreach drafts". That explicit instruction
is the only case where an agent runs `ab outreach send --send --yes`.
