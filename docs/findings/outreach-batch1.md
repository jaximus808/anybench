# Outreach batch 1: 11 drafts in the review queue (2026-11-08)

Leads came from published contacts only, and the drafts sit in the **local dev DB**
(`localhost:55432/anybench`). Nothing was sent to a third party. One self-test went to our own
inbox.

## Spend
- **Naïve: 86,519 µ$ ($0.0865)** of the $1 budget. That's scout 75,626 + writer 10,893.
  - The account balance went from 225,428,834 to 225,342,315, which matches the sum exactly.
  - The scout re-run of 5 leads after the verifier fix replayed the same sessions (same idempotency keys), so it added no spend. Its report shows 29,933 µ$ because it re-counts those replayed sessions.
- **Monid: $0.001**, one `send-test` to `anybench-outreach@agentmail.to`.
- Context.dev, Hunter: none.

## Sources (all published by the project itself)
- A research pass found each address on the project's site or README, with the URL and a verbatim snippet. Nothing came from commits, profiles, LinkedIn or a finder.
- The CSV is imported with `anybench outreach import <csv> --source public_contact`. The URL and snippet live in `leads.signals.provenance.email`, and `review show` prints them.
- Trail-Code already had a lead from TDM-163 sourcing (no email). I attached its published contact (trailhq.com/about) to that row instead.

## Commands and what they printed
```
ab outreach import public-contacts.csv --source public_contact
→ imported 13 of 14 rows (source=public_contact); row 2: duplicate_repo (trailhq/Trail-Code)

ab outreach scout --lead … (14) --budget-micro-usd 100000 --run-cap-micro-usd 600000
→ scored: context-mode 88, token-optimizer 82, GitNexus 62, probe 80, kodus-ai 70, codebuff 62
  skipped below_threshold: crush 52, zed 30, kilocode 50
  error unmeasured_assertion: Trail-Code, caveman, rtk, headroom, claude-mem
scout: 14 leads, spend $0.0756 of $0.6000 cap

(TDM-166 verifier fix, then the same 5 again; replayed sessions)
→ Trail-Code 78, caveman 88, rtk 85, headroom 90, claude-mem 88: all scored

ab outreach draft --lead … (11) --budget-micro-usd 50000 --run-cap-micro-usd 300000
→ 8 model openings, 3 template (2 writer sessions "ended idle (error)", 1 rule-10 rejection:
  "46% fewer" after ", with" in a clause the filter can't attribute), lint ok on all 11
draft: 11 of 11 stored, Naïve spend $0.0109

ab outreach send-test 1db88dc8
→ self-test sent to anybench-outreach@agentmail.to (not to the lead), $0.0010
  read back: labels sent,outreach-self-test,received; List-Unsubscribe <mailto:anybench-outreach@agentmail.to?subject=unsubscribe>
```

## Findings
- **The scout's rule-10 check rejected 5 of 14 good leads.**
  - The cause: the live model summarises README numbers after a dash ("the README makes claims — 21–57% fewer tokens…"). The filter splits clauses at a spaced dash, so it loses the attribution.
  - `why` and `fit_reason` are internal and never mailed, so TDM-166 now drops the offending sentence and records it in `dropped`. If nothing honest is left, the field holds a placeholder.
  - Every email is still filtered in the writer and again at send.
- **Template openings that quote a markdown table row read badly** (`"| SRE incident debugging | 55,957 | …"`). The template now prefers a prose claim. I rewrote the 3 template openings and tidied 6 "alternatives" phrases by hand. Each edit was re-linted, and the drafts stay `draft`.
- **The footer doubled "Anybench,"** because `COMPANY_POSTAL_ADDRESS` already starts with the company name. Fixed in code and in the stored drafts.
- **Naïve writer sessions sometimes end `idle (error)`** (2 of 11, about 700 µ$ each). The template fallback covered them.

## Not drafted
- Skipped by the scout as below the fit threshold: crush (52), zed (30), kilocode (50). They can still be drafted with `ab outreach draft --lead <id> --allow-skipped` if wanted.
- Not imported:
  - Weak or excluded sources: OpenHands (address only in a docs config) and SWE-agent (academic authors).
  - Press-only addresses: OpenCode, Augment.
  - Too large: Warp.
  - No published address: distill, token-savior, openhuman, Cline, Continue, Aider.
