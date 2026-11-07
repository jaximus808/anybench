# Collector outputs: what the tools actually print (TDM-50)

Captured on 2026-11-07, Docker Desktop on arm64 (Apple silicon), every container with a random
`tdm50-*-<hex>` name. Fixtures: `packages/bench/fixtures/collectors/` (see its PROVENANCE.md).
Parsers: `packages/bench/src/collectors/`.

## GNU time (`/usr/bin/time -v`)

```
docker run --rm --name tdm50-time-$S -v $OUT:/out debian:bookworm-slim sh -c '
  apt-get install -y time && /usr/bin/time -v -o /out/time-v.txt sh -c "seq 1 2000000 | sort -n > /dev/null"'
```

- Debian's package reports `time (GNU Time) UNKNOWN` for `--version`; it is 1.9.
- Lines are `<label>: <value>`, tab-indented. The elapsed label itself contains colons
  (`Elapsed (wall clock) time (h:mm:ss or m:ss): 0:00.69`), so split at the first `": "`.
- A non-zero exit adds a first line `Command exited with non-zero status 3`; `Exit status: 3` is
  also there. A signal gives `Command terminated by signal N`.
- `Percent of CPU` can be `?%` when the elapsed time is 0. Max RSS is in kbytes.

## hyperfine

```
curl -fsSL https://github.com/sharkdp/hyperfine/releases/download/v1.19.0/hyperfine-v1.19.0-aarch64-unknown-linux-gnu.tar.gz | tar xz
hyperfine --warmup 1 --runs 6 --export-json /out/hyperfine.json "sleep 0.05" "seq 1 200000 | sort -n > /dev/null"
```

- `{results: [{command, mean, stddev, median, user, system, min, max, times[], exit_codes[]}]}`,
  all in seconds. `parameters` appears with `-P`/`-L`.
- With `--ignore-failure`, `exit_codes` holds the real codes (`[2,2,2,2]`); without it, hyperfine
  aborts on the first failure and writes no JSON.

## hey

```
curl -fsSL -o hey https://hey-release.s3.us-east-2.amazonaws.com/hey_linux_amd64
curl: (22) The requested URL returned error: 403
```

The README's release bucket answers **403** now, so the `base` profile must build it:
`go install github.com/rakyll/hey@v0.1.4` (golang:1.24-bookworm). Against `nginx:1.27-alpine`:
`hey -n 400 -c 10 http://<nginx>/`. hey has no JSON summary; the text has sections `Summary:`,
`Response time histogram:`, `Latency distribution:` (`95% in 0.0531 secs`), `Details`,
`Status code distribution:` (`[200]\t400 responses`) and, only when there were transport errors,
`Error distribution:` (`[N]\t<message>`). A 404 is not an error to hey; it shows as a status.

## k6

```
docker run --rm --network $NET -v $OUT:/out grafana/k6:1.3.0 run --quiet --summary-export=/out/k6-summary.json /out/k6-script.js
```

- k6 1.3.0 still writes the legacy summary-export format: `metrics.<name>` with trends as
  `{avg, min, med, max, "p(90)", "p(95)"}` in **ms**, counters as `{count, rate}`, rates as
  `{passes, fails, value}`.
- `http_req_failed` reads backwards: `passes` is the number of requests that FAILED (the rate's
  value was true). With every other request a 404: `{"passes": 1366, "fails": 1366, "value": 0.5}`.
- Threshold booleans are true when the threshold was crossed: `"p(95)<500": false` while stdout
  printed `✓ 'p(95)<500' p(95)=16.94ms`.

## machine.json inputs

In `debian:bookworm-slim` under Docker Desktop: `lscpu` prints `Model name: -` and `Vendor ID:
Apple` on Apple silicon, so the machine collector falls back to the vendor. `/proc/stat` steal
was 0 over 1 s (no hypervisor steal reported by linuxkit). Load average inside the container is
the VM's (10.67 here, the Mac was busy with parallel workers): it is the signal the scheduler
uses to discard noisy trials.

## Claude Code stream-json (no run: it costs money)

The event shapes come from the zod schemas compiled into the installed CLI (2.1.319), read with
`strings -n 6 ~/.local/share/claude/versions/2.1.319` and a search for `type:C("result")`,
`subtype:C("api_retry")` and `rate_limit_event`:

- `{"type":"system","subtype":"api_retry","attempt","max_retries","retry_delay_ms","error_status": int|null,"error": <category>}`.
  A 429 retry has `error_status: 429, error: "rate_limit"`.
- When retries run out, an assistant event carries `error: "rate_limit"` (categories:
  `authentication_failed, billing_error, rate_limit, overloaded, invalid_request, server_error, ...`).
- `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"|"allowed_warning"|"rejected",...}}`
  (subscription limits).
- `result`: `subtype` (`success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, ...),
  `is_error`, `duration_ms`, `duration_api_ms`, `num_turns`, `total_cost_usd`, `usage`, `modelUsage`
  (`{<model>: {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, ...}}`),
  `permission_denials[]`. The CLI describes `usage` as "MAIN AGENT LOOP ONLY ... Prefer modelUsage
  for token/cost accounting", so the parser sums `modelUsage` first.
- Assistant events stream one content block each and repeat `message.id` and `usage`: count usage
  and turns once per id.

`total_cost_usd` is read from its JSON source text (`JSON.parse` reviver `context.source`, Node >= 22)
and converted to micro-USD with bigint math, so no float touches it.

## Naïve proxy.calls

Not called (needs an `audit:read` key and live credit). Shape from the SDK's `.d.ts`
(`@usenaive-sdk/managed-agents`, `proxy.calls`): `usage {input, cache_write, cache_read, output, reasoning}`,
`billed_micro_usd: number | null`, `vendor_cost_micro_usd`, `duration_ms`, `session_id`,
`tool_call_ids[]`, `response {tool_calls[], is_error?, error_class?}`, `created_at`. Money is already
integer micro-USD; the parser keeps the JSON source text and refuses a fractional value.
