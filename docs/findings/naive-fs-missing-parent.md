# Naïve fs/read: a missing parent directory is 403, not 404 (fix-fork-403, 2026-11-08)

## Symptom

Every real trial on the agent-cc env image failed about 4 s after the fork, before the runner
launched, with `naive forbidden (403): path is outside the sandbox working directory`
(failure_class `provider_forbidden`, see `env-build-naive.md`). The proxy key was never minted.

## Root cause

It has nothing to do with the fork, the snapshot, the `/home/naive` symlink, the root-run installs
or the `chown -R`. The executor's first fs op on a fresh trial computer is `readStatus()`, a
`getFile(~/eval/out/status.json)` that expects `not_found` (no runner yet). `~/eval` does not exist
on a fresh fork, and **Naïve answers an fs/read whose parent directory is missing with 403
"path is outside the sandbox working directory"** instead of 404. The executor only treats
`not_found` as "no status yet", so the 403 became an infra failure. The TDM-22 contract never read
a missing file under a missing directory, and the FakeNaive returned 404 for it, so nothing caught it.

## Probe (plain 1 vCPU / 1 GiB computer, no fork)

`scratchpad/probe/missing-probe.ts`: raw `NaiveClient.computers` (no provider), before and after
`sudo -n ln -s "$HOME" /home/naive`. Both rounds printed the same:

```
fs read /home/naive/missing.txt: ERR 404 not_found no such file or directory
fs read /home/naive/eval/out/status.json (no eval dir): ERR 403 forbidden path is outside the sandbox working directory
fs read /home/naive/.anybench/trial.json (no .anybench): ERR 403 forbidden path is outside the sandbox working directory
fs write /home/naive/nodir/x (no mkdir): ok
fs write /home/naive/top.txt: ok
fs mkdir /home/naive/a/b: ok
fs read /home/naive/a/b/missing: ERR 404 not_found no such file or directory
```

Also seen: **fs/write creates missing parent directories** on live Naïve (FakeNaive is stricter and
refuses; callers mkdir first anyway). Computer `cmp_01a1b986a998797cb0cc0f8c7fc09bf9`, destroyed.

## Fix

- `NaiveProvider.getFile`: on a 403 for a path inside the home, `test -e <path> || test -L <path>`
  through exec; exit 1 (nothing there) becomes `not_found`, anything else keeps the 403.
- FakeNaive `fs/read`: 403 with the live message when the parent directory is missing, 404 when
  only the file is. Regression tests in `packages/providers/test/naive-provider.test.ts`
  ("fork-403"): an env-build-style image is snapshotted and forked, and `getFile` of
  `~/eval/out/status.json` / `~/.anybench/trial.json` is `not_found` (it was `forbidden` before).

## Capacity

During this session Naïve answered `429 the service is at capacity` to `credits.show`, `create`
and `get` for minutes at a time; a 1 vCPU create took ~4 min to get through, and one build probe
never reached `running` + exec within ~15 min (killed, its computer destroyed by hand).

## Live proof after the fix

`apps/server/test/env-trials-naive-live-demo.test.ts` (same command as `env-build-naive.md`, with
`DEMO_PROXY_CAP_MICRO_USD=1500000`): a fresh agent-cc env build (snapshot
`snp_e731f9cd24a14fa39423a779e8c332fa`), then one trial of contender A (claude-code-solo) on
todo-api on a fork of it, through trial.execute and trial.gate:

```
trial after execute {"state":"collecting","attempt":1,"failure":null,"exit":0,"proxyKeyId":"key_985g0emws3sks940ar506e9p1x","ms":150360}
proxy key revoked {"reason":"trial_end","detail":"attempt collected","ok":true}
trial after gate {"state":"reviewing", gates: api-load pass "p95 2.1 ms at 50 req/s over 1000 requests, 0 errors";
  hidden-tests status "lingering": log "16/16 hidden tests passed" but fail-closed because
  "2 contender process(es) still running when the check exited"}
computers: trial fork + scoring computer, both destroyed, 27,600 µ$ each
balance 249,887,401 → 249,458,676 µ$ (428,725 µ$ ≈ $0.43 for the run, model tokens included)
✓ 1 passed (593.7 s)
```

The first attempt of that run died at the recipes step with `naive network_error: fetch failed`, and
both build computers' destroys failed the same way; they were destroyed by hand right after.

Still open, and not part of this fix: the hidden-tests gate fails closed on lingering contender
processes even though all 16 hidden tests passed.
