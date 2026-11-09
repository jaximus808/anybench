# The BYOK spend cap and Claude Code's per-message usage (TDM-231, 2026-11-08)

TDM-212's docker-local smoke (`docs/findings/long-horizon-kit.md`) showed the runner's live spend
estimate at $1.22 shortly before a session that cost $3.05 ended. This note is what the smoke's
stream says about why, and what the meter (`packages/runner/src/token-cap.ts`) does now.

## What Claude Code 2.1.319 writes (`-p --output-format stream-json --verbose`)

Measured on the smoke's own transcript (`out/stream.jsonl`, 337 lines, Opus 5.5, thinking on) with
a throwaway `python3 -I` script: per message id the max `usage.output_tokens`; Σ `len(text)` and
Σ `len(name) + len(json.dumps(input, separators=(",", ":"), ensure_ascii=False))` over content
blocks; Σ `estimated_tokens_delta`. It printed:

```
lines: system/thinking_tokens 191, assistant 96, user 45, system/init 1, result 1, ...
messages 37   sum of per-message output_tokens 340
text chars 3772   tool_use chars (name + input JSON) 158715   thinking chars 0
thinking_tokens estimated_tokens_delta sum 22066
result: output_tokens 88382 (thinking_tokens 20543), total_cost_usd 3.0483550000000004
per-message input/cache sums = result's: 74 / 3044370 / 134309
```

1. **One `assistant` line per content block, all repeating the usage of the message's first stream
   event.** Input and cache counts there are final (their per-message sums equal the `result`'s
   exactly), but `output_tokens` is the count at message start (3 to 20). Nothing in the stream
   carries a running or final output count per message; only `result.usage` does, at the end of
   the session (`usage.iterations` holds only the last call).
2. **Thinking text is empty** (`"thinking":""`, with a signature); instead Claude Code writes
   `{"type":"system","subtype":"thinking_tokens","estimated_tokens":N,"estimated_tokens_delta":D}`
   while a thinking block streams (`estimated_tokens` resets per block). Σ delta 22066 vs 20543 real.
3. **Content chars per output token.** (3772 + 158715) / (88382 − 20543) = **2.40** chars per
   token, counting tool input as compact `JSON.stringify` (what the model wrote). An earlier Naïve-proxy
   solo trial (thinking off): 20307 / 9018 = 2.25. Tandem workers through the proxy read
   1.26 to 1.69, but there per-message usage is all zeros and the proxy key has its own cap; not
   used for calibration.

## The meter now

- Per session (`session_id`): output = max(Σ per-message usage output, ⌈content chars / 2.20⌉ +
  max(Σ thinking deltas, ⌈thinking chars / 2.20⌉)). 2.20 (`OUTPUT_CHARS_PER_TOKEN_X100 = 220`) is
  below both measurements, so it errs high.
- spent = Σ sessions of (the session's own `result` cost once it has one, else its estimate).
  Before, Tandem's parallel sessions got max(Σ estimate, Σ reported): one finished session's report
  hid the others' running spend. Lines without `session_id` are still one session with
  max(estimate, reported).
- The cap trips when spent + margin > cap, margin = `token_cap_margin_pct` (TrialJob, default 10)
  percent of the sessions that have not reported. A reported cost carries no margin.
- `kits/tandem-long-horizon/adapters/tandem/board.ts tap` forwards `session_id`, per-line
  `output_chars` / `thinking_chars` (each block once) and the thinking events, so the runner never
  sees content. `kits/tandem-vs-claude-code` keeps its TDM-160 tap (Naïve proxy, zero usage).

Replay of the smoke through the new tap and meter
(`packages/runner/test/fixtures/tdm231-smoke-tap.jsonl`, Opus 5.5 list prices):

| at the last assistant line | micro-USD | vs real 3048356 |
| --- | --- | --- |
| TDM-160 meter (per-message usage) | 1287515 | −57.8% |
| new estimate (`spent_micro_usd`) | 3199195 | **+4.9%** |
| estimate + 10% margin (what the cap compares) | 3519115 | +15.4% |

With a $2.50 cap the replay trips on line 220 of 288 (estimate $2.28 + $0.23 margin), before the
session's result line; the TDM-160 meter would only have stopped on the result.

Limits: a content block is visible only once it is complete, so the estimate lags by up to one
block (a large Write); the ratio is two samples on one model. Recheck it when the model or Claude
Code version changes (the same sums against a new transcript's `result`).

## Sessions with several results (TDM-239)

One `claude -p` session can write several `result` lines with the same `session_id` (Tandem
workers on 2.1.319: up to 4, numbered by `result_index`). Each line's `usage` covers only the turns
since the previous result; `total_cost_usd` is the running total. The meter summed them and read
$17.44 on a $10.18 Tandem trial. It now takes a session's latest total plus the estimate of the
turns after it (open, with margin). Details and the replay test are in
`docs/findings/long-horizon-calibration.md`.
