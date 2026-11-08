# tdm39-stream-json

`slugify.synthetic.jsonl` is a synthetic Claude Code `-p --output-format stream-json --verbose`
transcript for the `slugify` workload of `examples/coding-agent`. It is synthetic because a real
run costs money; its event shapes follow a real Claude Code 2.1.319 stream captured on
2026-11-07 with an invalid key (no spend, see docs/findings/coding-agent-driver.md) and the
TDM-50 fixtures in packages/bench/fixtures/collectors/stream-json/.

What it contains, for the metric assertions in packages/bench/test/tdm39-coding-agent-stream.test.ts:
5 turns, 4 tool calls (Read, Write, Bash, Edit), 1 tool error, one 429 `api_retry`,
`total_cost_usd` 0.04213 (42130 micro-USD), modelUsage 9 in / 1820 out / 48210 cache read /
6120 cache write tokens, and an `init` event pinned to anthropic/claude-sonnet-4.6 (a Naïve id: the
example kit runs on the Naïve proxy) on Claude Code 2.1.319 (the example kit's pins).
