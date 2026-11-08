# Outreach sourcing: live pass (TDM-163 [15.2a], 2026-11-08)

One live sourcing run through the real CLI command (`runOutreach`), writing to the **local dev DB only** (`localhost:55432/anybench`). The caps were 10 Context.dev credits, $1 of Monid, and 15 GitHub calls. Nobody was emailed.

## Setup
The local dev DB had no tables, so I migrated it first:
```
cd apps/server && DATABASE_URL_DIRECT=postgres://anybench:anybench@localhost:55432/anybench pnpm exec drizzle-kit migrate
→ [✓] migrations applied successfully!
```
Balances before the run (free calls: `GET /org/usage`, `GET /v1/wallet/balance`, `GET /rate_limit`):
```
context.dev credits_remaining 521
monid wallet {"value":18.898,"currency":"USD"} held {"value":0.1,"currency":"USD"}
github core {"limit":60,"remaining":25,"reset":1794106186,"used":35}     ← shared IP, other workers already used 35
```

## Run
```
npx tsx scripts/spikes/outreach/source-live.ts harness-perf 5 --github-budget 15 --cache-dir <scratch>/ghcache
```
(The script loads keys from `.env` via `lib.ts`, forces `--database-url` to the local DB, and passes `--credit-cap 10 --monid-cap-micro-usd 1000000`.)
```
leads db: localhost:55432/anybench · caps: 10 Context.dev credits, $1.0000 Monid
  search "site:github.com ("faster than" OR benchmark OR "fewer tokens") ("Claude Code" OR "coding agent") harness" → 20 results, 2 credits
  skip fork https://github.com/aarora79/agentic-coding-harness-benchmarks
  lead https://github.com/akitaonrails/llm-coding-benchmark <…@akitaonrails.com> (3 claims)
  lead https://github.com/VILA-Lab/Dive-into-Claude-Code (11 claims)
  lead https://github.com/samuelfaj/distill (5 claims)
  skip not_repo_root https://github.com/Heretek-AI/harness-benchmark/issues/59
  skip not_repo_root https://github.com/Heretek-AI/harness-benchmark/issues/65
  lead https://github.com/trailhq/Trail-Code (11 claims)
  lead https://github.com/tinyhumansai/openhuman (11 claims)
wrote 5 leads (1 with email), skipped 3, stopped by limit
spent: 2 Context.dev credits, 13 GitHub calls, $0.0245 Monid (2 Hunter lookups, 1 found)
```
Balances after the run:
```
context.dev credits_remaining 519          (−2, matches the report)
monid wallet {"value":18.8735,...}         (−$0.0245 = one Hunter hit; the miss was free)
github core remaining 10                   (−15: 13 ours + 2 from other workers)
```

## Counts and cost
| | |
|---|---|
| Search results | 20 (1 search, `numResults` = limit × 3 rounded up to 10, which is 20) |
| Leads written | 5, all `source=context_dev`, `query=harness-perf`, `status=new` |
| Leads with email | 1 (Hunter score 96; the domain came from the owner's GitHub `blog`) |
| Skipped | 1 fork, 2 issue pages (`not_repo_root`) |
| Context.dev | 2 credits |
| GitHub | 13 REST calls: 6 repos + 5 READMEs + 2 users. The fork was rejected before its README was fetched. |
| Monid | $0.0245 (24,500 micro-USD): 2 Hunter lookups, 1 hit |

Cost per lead: 0.4 Context.dev credits and about 2.6 GitHub calls. Cost per emailable lead: $0.0245.

## What the rows look like
- Every lead has `signals.provenance` with the query id and text, `searchedAt`, `searchRequestId`, `rank` and `resultUrl`, plus `claims[]`. Each claim has its `text` and `url` (`https://github.com/<repo>/blob/<branch>/<path>#L<n>`) and `from: readme | search_snippet`. A lead with an email also carries `provenance.email = {source: hunter, via: monid, domain, score, verification, runId, costMicroUsd}`.
- The claim lines are clean. The HTML and badge false positives from the spike are gone: distill now yields `L32 "93% cheaper"`, `L34 "…0.069x the credits…"`, `L47 "~2x faster"`, `L49`, `L79`, and no `<td width="25%">` rows. openhuman yields its benchmark table rows (`Wall time (p50) 19.8 s (2.3x faster)`, `Tokens 167k (2.6x fewer)`).
- `signals.domain` is set only when the repo homepage names a company (trailhq.com, tinyhumans.ai). That field is the dedupe key across leads.

## Findings for downstream tickets
- **Organization repos get no email.** Hunter needs a person's name plus a domain, and we don't take names from commits or contributors. 3 of the 5 leads are orgs (VILA-Lab, trailhq, tinyhumansai). Their routes are the opt-in CSV or a human picking a contact. If a written list of team members is wanted, Hunter `/domain-search` via Monid would list the published addresses on a domain, but that wasn't tried.
- **User repos need a personal domain.** Of the 2 lookups, the one on the owner's blog domain hit. The other missed (free), and the owner's company (`smartplan-br`) isn't a domain.
- **VILA-Lab/Dive-into-Claude-Code is a survey/paper repo.** Its README "claims" are citations of other products' numbers (Cursor, Codex, Opus). The regex can't tell "our tool is 2x faster" from "X reports 2x". The scout (15.3a) should reject leads whose claims aren't about the repo's own project.
- **GitHub is the bottleneck, not money.** With 60/h shared, a 5-lead run used 13 calls. Results are cached for 24 h on file (`~/.anybench/cache/outreach-github`), so a re-run costs 0 GitHub calls for repos already seen. Once the budget or the rate limit runs out, repo metadata falls back to Monid anyapi `/github.repository` ($0.0012, no README). That fallback wasn't triggered in this run.
- Context.dev returned 2 issue pages for one repo (Heretek-AI). Both were dropped, as were awesome lists, topics and blobs.

## Commands
- `anybench outreach queries`: lists the saved claim queries (`harness-perf`, `token-savings`, `agent-benchmark`, `cli-faster`).
- `anybench outreach source --query <id> --limit N [--dry-run] [--no-email] [--credit-cap N] [--monid-cap-micro-usd N] [--github-budget N] [--database-url URL] [--json]`
- `anybench outreach import <csv> --source hackathon_optin [--dry-run] [--json]`: header `name,email,repo`. `repo` may be blank, `owner/repo`, or a github.com URL. Rows that are suppressed, or whose email or repo already has a lead, are skipped with a reason.
- Env: `CONTEXT_DEV_API_KEY`, `OUTREACH_CONTEXT_DEV_CREDIT_CAP` (300), `MONID_API_KEY`, `OUTREACH_SOURCING_MONID_CAP_MICRO_USD` (2,000,000 = $2), and an optional `GITHUB_TOKEN`. DB: `--database-url`, else `DATABASE_URL`, else `LOCAL_DATABASE_URL`, else the local dev DB.

## Review fixes (TDM-163 review, 2026-11-08)
- **Race-safe dedupe.** Migration `0004_leads_unique_email_repo.sql` adds partial unique indexes: `leads_email_lower_uniq` on `lower(email)` WHERE email IS NOT NULL, and `leads_github_url_lower_uniq` on `lower(github_url)` WHERE github_url IS NOT NULL. `PgLeadStore.insert` now uses `on conflict do nothing returning id`. When no row comes back, the result is `{duplicate: "email" | "repo"}`, and sourcing/import record it as a `duplicate_email` or `duplicate_repo` skip with the detail `insert conflict`. `apps/server/test/leads-unique-tdm163.test.ts` checks this on a fresh migrated Postgres: of 8 concurrent inserts of one email, 1 wins; two concurrent imports of the same CSV write each row once. The local dev DB was migrated to 0004; the live leads already had no duplicates.
- **Unknown Monid charges stop spending.** When a Monid run ends with no terminal run body (POLL_TIMEOUT, a transport error after the POST, a 5xx without a run body, or a run body we can't parse), the client books the full `maxCostMicroUsd` as spent, sets `MonidError.chargeUnknown`, and **halts**: every later `run` fails with `HALTED` before any request is sent. The default is `haltOnUnknownCharge: true`. Sourcing then stops Hunter lookups (`emailStoppedBy: "monid_charge_unknown"`, `monidHalted` in the report), and the GitHub client skips the anyapi fallback, so the run ends `github_exhausted` once GitHub runs out. A documented 4xx (`MAX_COST_EXCEEDED`, 400/401/402/404/429) is still booked at 0.
- **Cheap provenance.** `signals.provenance.readme = {path, blobSha, commitSha}`. `blobSha` comes from the `/readme` response at no extra cost. Claim URLs are pinned to a commit (`blob/<commitSha>/…`) only when `GITHUB_TOKEN` is set: that takes one `GET /repos/{o}/{r}/git/ref/heads/{branch}` (ref only, no author data). Without a token, claim URLs use the branch name, and the blob SHA records exactly which text was cited.
- **Hunter last.** Before paying for Hunter, sourcing now checks the contact domain (the homepage domain, or the owner's blog domain). It skips the lead when another lead already has that domain (as company domain, contact domain or email domain), or when any suppressed address is at that domain (`suppressed`, "an address at X unsubscribed"). The exact-email suppression and dedupe still run after a hit. Webmail domains (gmail.com etc.) never count as a company domain.
