# NaiveProvider against live Naïve (TDM-22 [3.1], 2026-11-08)

The shared ComputeProvider contract (`packages/providers/src/contract.ts`) run against the real Naïve API through `NaiveProvider` → `createNaiveClient` → `@usenaive-sdk/managed-agents` 0.12.3. The planner approved one run with a $0.50 hard cap. Read this together with `naive-hosting.md` (TDM-170), whose facts the provider is built on.

## Command

```
cd packages/providers
NAIVE_LIVE=1 node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs run naive-live --reporter=verbose
```

(`--env-file` loads `NAIVE_API_KEY` into the process without printing it; the equivalent is `NAIVE_LIVE=1 pnpm --filter @anybench/providers test naive-live` with the key exported.) Balance and leftover computers were read before and after with `credits.show()` + `computers.list()`.

## Result: 20/20 passed, nothing leaked

```
✓ declares sane capabilities                                         4ms
✓ create + waitReady yields a running computer with the spec and tags 0ms   (beforeAll: create → running, home link)
✓ inspect returns the same computer                                544ms
✓ rejects an invalid spec with a validation error                    2ms
✓ exec returns stdout and exit code 0                              579ms
✓ exec returns stderr and a non-zero exit code without throwing    941ms
✓ exec past its timeout resolves timedOut with exit 124           2443ms
✓ exec refuses a timeout over the provider cap                       1ms
✓ putFile/getFile round-trip text and bytes, and exec sees the file 7122ms
✓ exec writes are visible to getFile                              1284ms
✓ getFile of a missing file is not_found                           625ms
✓ file paths outside home are forbidden                              2ms
✓ execDetached returns at once and the command keeps running after it 5890ms
✓ list filters by exact tag and by run prefix                      480ms
✓ unknown ids are not_found                                        300ms
✓ snapshot + fork copies the filesystem and the fork is independent 18614ms
✓ fork of an unknown snapshot is not_found                         505ms
✓ pause stops it, exec on a paused computer resumes it           11066ms
✓ destroy removes it, is idempotent, and it leaves list           3516ms
✓ naive (live) detached-launch probe > measures both launch lines 36403ms
Test Files 1 passed (1) · Tests 20 passed (20) · Duration 98.92s
```

| | balance_micro_usd | computers listed |
|---|---|---|
| Before (2026-11-08T01:44:54Z) | 250,918,458 | `[]` |
| After (2026-11-08T01:47:01Z) | 250,890,000 | `[]` |

**Cost: 28,458 µ$ (≈ $0.028)** for one 2 vCPU / 4 GiB computer, its fork, and one 1 vCPU / 512 MiB probe computer, over about 100 s. That is in line with the prorated part-block model (`naiveComputerCostMicroUsd`): 27,600 µ$ per 10-minute block at 2/4, so ~100 s of two computers plus the small probe. The file's own `afterAll` found no `ab-<runId>-` computer left to destroy, and `computers.list()` afterwards was empty (destroyed computers are not listed).

## Detached launch: a backgrounded `mkdir && setsid …` list holds the exec

The probe ran both launch lines on the same computer, with `sleep 45` as the job:

```
exec "mkdir -p \"$(dirname '/home/naive/probe/shared.log')\" && setsid nohup sh -c 'sleep 45' >> '…/shared.log' 2>&1 < /dev/null & echo $!"   timeout_ms 20000
→ {"exitCode":124,"timedOut":true,"durationMs":27110,"roundTripMs":27616,"stdout":"1635\n","stderr":"command timed out after 20000ms"}

execDetached "sleep 45"   (line: mkdir -p "$(dirname LOG)" || exit 1; setsid nohup sh -c 'sleep 45' >> LOG 2>&1 < /dev/null & echo $!)
→ {"pid":1660,"roundTripMs":1862}

ps -eo pid,args | grep 'sleep 45'
   1635 bash -c mkdir -p "$(dirname '/home/naive/probe/shared.log')" && setsid nohup sh -c 'sleep 45' >> … & echo $!
   1638 sh -c sleep 45
   1639 sleep 45
   1660 sh -c sleep 45
   1661 sleep 45
```

1. **Yes, real Naïve waits, the same way FakeNaive does.** `a && b &` backgrounds the whole list in a bash subshell (pid 1635). That subshell keeps the exec's stdout open while it waits for `setsid`, so the exec ran until its 20 s timeout (27 s wall clock) and returned exit 124. Through `execDetached` that becomes a thrown "failed to start" for any job longer than the 30 s launch timeout, i.e. every in-VM runner.
2. The old line also printed the wrong pid: 1635 is the subshell, not the job (1638).
3. Only the setsid job goes in the background, with all fds redirected, and the exec returns in 1.9 s with the job's own pid (1660). The job survives the exec.
4. **Fixed in the shared helper.** `buildDetachedCommand` (packages/providers/src/helpers.ts), used by docker-local and NaiveProvider, now emits `mkdir -p "$(dirname LOG)" || exit 1; setsid nohup sh -c CMD >> LOG 2>&1 < /dev/null & echo $!`. That is the exact line the live run proved. The old form survives only as `legacyBackgroundedListCommand`, for the tests that document the hold.

## Other facts seen live

- **Home.** `ComputerInfo.home` is `/home/naive` (inspect's `home`). The provider's one-time home link (`[ "$HOME" = /home/naive ] || [ -e /home/naive ] || sudo -n ln -s "$HOME" /home/naive`, then a `readlink -f` equality check) succeeded on both the original and the fork. `cat /home/naive/…` in exec and `fs/read` agreed for every file in the contract. The fork from the snapshot already had the link.
- **putFile with verification** took 7.1 s for the contract's four file ops (three writes, one with mode 0600). Each write costs fs mkdir, fs write and one or more exec checks (`chmod` + `stat -c %s`). No file needed more than the check loop allows.
- **Errors as mapped:** `getFile` of a missing file came back as a Naïve 404, so `not_found`. An unknown `cmp_000…` id is 404 on get/exec, and an unknown `snp_000…` is 404 on create. A `/etc/passwd` path is refused before the call (`forbidden`).
- **exec timeout:** `sleep 30` with `timeout_ms: 1500` returned exit 124 and `timed_out: true` in 2.4 s round trip.
- **Pause:** `pause` → exec resumed it → `status: running`, all within 11 s.
- **Snapshot + fork:** 18.6 s for snapshot, create from `snapshot_id`, readiness, file checks, destroy and snapshot delete. The fork's `snapshot_id` was the snapshot's. Its tags came from its own name, not the source's.

## Re-running

The live file costs about $0.03 a run. Every computer it creates carries `ab-<runId>-`, its `afterAll` destroys only computers with that prefix, and it fails the file if any remain.
