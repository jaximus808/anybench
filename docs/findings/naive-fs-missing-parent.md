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

## Race: the runner creates ~/eval/out between the read and the check (hotfix, 2026-11-09)

### Symptom

Live run `01a1c1f2-4988-7854-b655-f9f77dcea767` (kits/harness-league, all five setups BYOK, the
first run whose BYOK trials got past `putFile(trial.json)` after e88629d): every trial of A
(claude-code-solo) went `installing -> failed_infra` about 4 s in, failure_class
`provider_forbidden`, reason `naive forbidden (403): path is outside the sandbox working directory`.
B, S and D went on to `warming` / `running`.

### Root cause

A TOCTOU in the fix above. `prepareAndLaunch` removes `~/eval/out`, launches the runner detached,
and the executor's very next poll is `readStatus()`: fs/read of `~/eval/out/status.json`. The runner
starts in the same fraction of a second and its first act is `mkdir ~/eval/out` + the atomic
status.json write (`packages/runner/src/runner.ts` `execute()`). When fs/read lands before the
mkdir it is the missing-parent 403; `NaiveProvider.getFile` then asked the shell
`test -e <path> || test -L <path>`, and when the runner had written status.json in between, that
answered exit 0, so the 403 was **kept** (`packages/providers/src/naive.ts`, getFile: anything but
exit 1 rethrew the 403) and the executor's catch-all failed the trial as `provider_${code}`.

Nothing in the worker's path depends on the contender: with the league kit's own `preparedJob`
(trial-source.ts) every setup does byte-identical fs ops (same paths, no `prepared.files` for a
kit trial, no proxy key for BYOK; the `proof.regression` env `CLAUDE_MD_OVERLAY` reaches only the
proof runner's overlay trial, not a run's trials). Whether a trial loses is timing: fs/read has to
land within one exec round trip before the runner's mkdir. The most likely reason it was A every
time: A is first in the launch order, so its first poll ran with the least worker / DB contention
(earliest fs/read), and each retry of a failed_infra attempt is launched on its own, which keeps it
fast and in the window. The fake test below shows that every setup hits the same 403 under that
interleaving.

### Reproduction (FakeNaive, the real executor, the league kit's job)

`apps/server/test/fork-403-status-race.test.ts`: a FakeNaive computers API whose "runner" (on the
detached `~/.anybench/bin/runner --trial` launch) creates `~/eval/out` and writes a finished
status.json right after the worker's fs/read of it was refused for the missing directory, i.e.
before the provider's shell check. Before the fix:

```
$ cd apps/server && pnpm exec vitest run test/fork-403-status-race.test.ts
 × A (claude-code-solo) is collected, not failed_infra provider_forbidden
 × claude-code-subagents takes the same path and is collected too
 × gstack takes the same path and is collected too
 × superpowers takes the same path and is collected too
 × tandem takes the same path and is collected too
AssertionError: trial infra failure naive forbidden (403): path is outside the sandbox working directory: expected 'provider_forbidden' to be null
      Tests  5 failed (5)
```

After the fix: `Tests  5 passed (5)`.

### Fix

`NaiveProvider.getFile`: on a 403 inside the home, the shell check's exit 1 is still `not_found`;
exit 0 (the path exists now) reads the file **again**: its content if it is readable now,
`not_found` if it went away, and the original 403 only if it is still refused. Any other exit
keeps the 403. No executor or runner change, so every setup's trial behaves as before apart from
not losing this race. Tests: `packages/providers/test/naive-provider.test.ts` ("race: the file
appears between the 403 and the shell check, so it is read again", and "a 403 for a path that
does exist stays forbidden" now refuses both reads) and the five above. No live Naïve or Anthropic
spend.
