# Collector fixtures (TDM-50)

Each file is the raw output a collector parser reads. "Real" files were captured by running the
tool in a throwaway Docker container with a random name on 2026-11-07 (arm64 Docker Desktop);
`*.synthetic.*` files were written by hand from the documented event shapes, because capturing
them for real costs money or needs a live key. Details and commands: docs/findings/collectors.md.

| File | Source | How |
| --- | --- | --- |
| time/time-v.txt | real | `debian:bookworm-slim`, GNU time 1.9: `/usr/bin/time -v -o /out/time-v.txt sh -c "seq 1 2000000 \| sort -n > /dev/null"` |
| time/time-v-nonzero.txt | real | same, `sh -c "head -c 50000000 /dev/zero \| gzip > /dev/null; exit 3"` |
| hyperfine/hyperfine.json | real | hyperfine 1.19.0 release binary (aarch64): `--warmup 1 --runs 6 --export-json ... "sleep 0.05" "seq 1 200000 \| sort -n > /dev/null"` |
| hyperfine/hyperfine-failures.json | real | `--runs 4 --ignore-failure --export-json ... 'sh -c "exit 2"'` |
| hey/hey.txt | real | hey v0.1.4 (`go install`, the S3 release bucket now answers 403) against `nginx:1.27-alpine`: `hey -n 400 -c 10 http://<nginx>/` |
| hey/hey-404.txt | real | `hey -n 200 -c 5 http://<nginx>/missing` |
| k6/k6-summary.json | real | `grafana/k6:1.3.0 run --quiet --summary-export=/out/k6-summary.json`, 5 VUs for 3 s, each iteration GETs `/` (200) and `/missing` (404), threshold `http_req_duration: p(95)<500` |
| machine/machine.json | real inputs, assembled | `uname -a`, `nproc`, `lscpu`, `/proc/meminfo`, `/proc/loadavg` and two `/proc/stat` samples 1 s apart in `debian:bookworm-slim`, assembled into the runner's MachineInfo shape (packages/runner/src/machine.ts, TDM-46) with the runner's steal formula |
| stream-json/success.synthetic.jsonl | **synthetic** | Claude Code 2.1.x stream-json event shapes (system init, assistant/user with tool_use/tool_result, system api_retry 429, rate_limit_event, result with usage, modelUsage and total_cost_usd). Not a real run: calling Claude costs money |
| stream-json/rate-limited.synthetic.jsonl | **synthetic** | a run that hits 429 twice, gets a rate-limit rejection and an `error: "rate_limit"` assistant message, then an `error_during_execution` result |
| naive-proxy/proxy-calls-page.synthetic.json | **synthetic** | one `client.proxy.calls()` page in the SDK's ProxyCallTrace shape (docs/reference/naive-sdk-proxy.md); reading real traces needs a live `audit:read` key |
