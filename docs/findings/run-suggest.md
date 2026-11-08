# Run suggest: one Naïve session reads a repo for the New run screen

2026-11-07. `POST /runs/suggest` (apps/server/src/routes/suggest.ts, lib/suggest.ts) reads a
GitHub repo's README and file tree via the GitHub REST API (no clone on a request path), then
runs one `run-suggester` session on Naïve with `RunSuggestionSchema` as the output_schema.
TODO(TDM-56): the understander replaces this module.

## Live check

Command (from `apps/server`, `.env` loaded, a throwaway script calling `createRunSuggester`
with `createNaiveClientFromEnv`; default model `deepseek/deepseek-v4-flash-0731`, window
`immediate`, per-session budget 50_000 micro-USD):

```
tsx zz-live-suggest.mts   # suggest({ github: "https://github.com/BurntSushi/ripgrep" })
```

Printed (trimmed):

```
"ms": 14255,
"cost_micro_usd": "5186",
"session": "ses_bmm1g5dn8gh71cvd9v01a8a2pf",
"questions": [
  "Is ripgrep faster than GNU grep at searching a large codebase recursively for a regex pattern?",
  "Is ripgrep faster than The Silver Searcher (ag) on a recursive code search over a large repository with default filtering?",
  "Is ripgrep faster than ugrep at searching a single large file for a pattern with no literal optimizations?"
],
"alternatives": GNU grep, The Silver Searcher (ag), ugrep, ack, git grep (each with a reason)
"options": { "runs_per_setup": 10, "approvals": "reviewer" }
```

## What we learned

- The model id `deepseek/deepseek-v4-flash-0731` is served and keeps to the schema on the first
  try (structured output parsed by the `runSession` gate).
- One call cost **$0.0052** (5_186 micro-USD), about a tenth of the $0.05 cap.
- Wall clock was **14.3 s**, including `ensureAgent` (first call creates the agent) and the two
  GitHub reads. The route's deadline is 30 s; the web client gives up at 35 s and carries on by
  hand.
- Unauthenticated GitHub REST allows 60 requests an hour per IP and each suggest makes 2; set
  `GITHUB_TOKEN` on the API in production.
- The rate limit (10 per user per 10 minutes) is in process, so each API instance counts on its
  own. The per-call and monthly ($10) Naïve caps bound spend regardless.
