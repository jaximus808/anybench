# Gate runner on a fresh scoring computer (TDM-51 [5.6])

What `packages/bench/src/gate.ts` does on a real Linux box, and what we learned running it on
docker-local (ubuntu:24.04 + the `naive` user, Docker Desktop on macOS arm64, 2026-11-07).

## Command

```sh
cd packages/bench
ANYBENCH_GATE_LOG=$SCRATCH/tdm51-gates.jsonl npx vitest run test/gate-docker-tdm51.test.ts
```

```
 Test Files  1 passed (1)
      Tests  12 passed (12)
   Duration  85.16s (tests 90%, import 7%, transform 3%)
```

Each contender's `out/` tree was bundled with `tar --format=ustar -czf` (the runner's bundle
layout) and scored on its own fresh container. The kit is `test/fixtures/gate-kit-tdm51`. The
`ANYBENCH_GATE_LOG` rows, shortened:

| contender | sum-tests | db-state | clean-room |
|---|---|---|---|
| honest | verdict, **pass**, "3/3 hidden cases pass" (288 ms) | not applicable, "workload add has no database" | pass |
| do-less (off by one) | verdict, FAIL, "3/3 hidden cases fail" | n/a | pass |
| forged-verdict (`gate.json` with pass inside its outputs) | verdict, FAIL, "3/3 hidden cases fail" | n/a | pass |
| tamper-tests (rewrites `$AB_KIT/reference/.../cases.txt`) | verdict, FAIL, "2/3 hidden cases fail" (write refused: kit is root-owned, read-only) | n/a | pass |
| late-writer (setsid daemon forges every `verdict/*/gate.json` after 3 s) | verdict, FAIL, "2/3 hidden cases fail" (daemon killed before the read) | n/a | pass |
| symlink-escape (`workspace/sum.sh -> /var/lib/anybench-score/kit/...`) | verdict, FAIL, "workspace/sum.sh is missing" (symlink dropped on unpack) | n/a | pass |
| hang (`sleep 600`) | timeout, FAIL, "check timed out after 8s (fail closed)" (10.2 s) | n/a | pass |
| corrupt (not a tarball) | no_outputs, FAIL, "the frozen outputs could not be unpacked (fail closed)" | same | same |

`clean-room` runs inside the sandbox and checks: not root, no `adapters/`, `workloads/`, `proof/`
or `anybench.yaml` in the kit, the kit and the pristine outputs not writable, the subject not
installed. It passed for every trial that had outputs, including the cheaters that ran code.
Every container had a registry row, ended `destroyed`, and the suite left none behind.

## Facts

- **docker-local `exec` is root; Naïve `exec` is a normal user with passwordless sudo**
  (docs/findings/naive-hosting.md). Every scoring script starts with
  `[ "$(id -u)" -ne 0 ] && exec sudo -n -- bash "$0"`, and root-only scripts under
  `/var/lib/anybench-score/bin` (mode 0700) are launched with `if [ "$(id -u)" -eq 0 ]; then bash F;
  else sudo -n -- bash F; fi`, because a non-root `bash F` can't even read them.
- ubuntu:24.04 already has everything the runner needs: `useradd`, `runuser`, `setsid`, `timeout`,
  `stat`, `realpath -m`, `sha256sum`, GNU `tar` + `gzip`. It has **no `curl`, `wget`, `python3`
  or `node`**, so the presigned-GET path (`kind: "url"`) fails there with exit 127. The docker test
  pushes the bundle with `putFile` instead (`kind: "bytes"`). **The `scoring` profile ([3.9]) must
  ship `curl`.**
- `runuser -u abgate -- sh -c 'kill -9 -1'` kills every process of the sandbox uid (and itself).
  It works without procps (`pkill` isn't in ubuntu:24.04). The runner runs it three times after
  each check, before reading the verdict.
- `timeout -k 10 8 runuser -u abgate -- ...` around a check whose child does `sleep 600` exits 124
  after about 8 s. The gate took 10.2 s in total, counting the killAll and the status write.
- GNU tar as a non-root uid, with `--no-same-owner --no-same-permissions`, unpacks the runner's
  bundle. Afterwards root drops FIFOs, sockets and devices, drops symlinks whose
  `realpath -m` leaves the tree, then `chown -R -h 0:0` and `chmod -R a-w`.

## Limits

- Until [16.1]: contender code that a check runs (hidden tests) runs as the check's own uid, so
  while the check is running it could write that check's `gate.json`. The late-writer case shows
  that anything still running after the check is killed before the read. A tight loop that
  rewrites the file during the check is not stopped yet. Closing that needs the grade harness to
  run contender code under its own uid (sudo rule or root broker), which is [16.1] (TDM-172).
- A scoring computer carries the trial's tag, but `trials.computer_id` names the subject's
  computer. So the reaper only spares it while `last_seen_at` is fresh. The runner `touch`es the
  registry on every exec (about every 2 s while polling). A single exec that blocks for more than
  15 min would be the only risk, and none does: checks run detached and are polled.
