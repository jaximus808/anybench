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
| tamper-tests (rewrites `kit/reference/.../cases.txt`) | verdict, FAIL, "2/3 hidden cases fail" (abrun can't even read the kit) | n/a | pass |
| late-writer (setsid daemon forges every `verdict/*/gate.json` after 3 s) | lingering, FAIL, "6 contender process(es) still running when the check exited (fail closed)" | n/a | pass |
| symlink-escape (`workspace/sum.sh -> /var/lib/anybench-score/kit/...`) | verdict, FAIL, "workspace/sum.sh is missing" (symlink dropped on unpack) | n/a | pass |
| hang (`sleep 600`) | timeout, FAIL, "check timed out after 8s (fail closed)" (10.2 s) | n/a | pass |
| corrupt (not a tarball) | no_outputs, FAIL, "the frozen outputs could not be unpacked (fail closed)" | same | same |

`clean-room` runs inside the sandbox and checks: not root, no `adapters/`, `proof/`
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

## Two uids: check vs contender code (review round 1)

The first version ran contender code as the check's own uid, and the reviewer's race-writer won:
a setsid loop rewrote `verdict/sum-tests/gate.json` between the check's write and the kill. Now:

- the check runs as `abgate`, and contender code runs only as `abrun`, through `"$AB_RUN" <cmd>`,
  inside `$AB_RUN_DIR`, which is its own writable copy of the outputs.
- **runuser/setpriv can't do this.** They need root, and the check is not root. A check running as
  root would hand contender code root whenever a kit forgot `$AB_RUN`. ubuntu:24.04 has no
  `sudo`, but util-linux `su` is setuid root there (`-rwsr-xr-x 1 root root 67744 /bin/su`). So
  `$AB_RUN` is `su abrun -s /bin/bash -c ...`, allowed by two PAM lines after `pam_rootok` in
  `/etc/pam.d/su`:

  ```
  auth [success=ignore default=1] pam_succeed_if.so quiet user = abrun   # anybench-gate
  auth sufficient pam_succeed_if.so quiet use_uid user = abgate          # anybench-gate
  ```

  I prototyped it in `docker run ubuntu:24.04`, and it printed:

  ```
  uid=998(abrun) gid=998(abrun) groups=998(abrun)
  bash: line 1: kill: (27) - Operation not permitted     # abrun can't signal abgate
  --- other user cannot su
  Password: su: Authentication failure
  --- abrun cannot su to abgate
  su: Authentication failure
  ```

  Setup self-tests both directions and fails (an infra error) if either is wrong.
- abrun gets a clean env (no `AB_*`), and `HOME=TMPDIR=$AB_RUN_HOME`.
- abrun can't read the kit (`root:abgate`, `o=`), so it can't read the reference or the hidden
  tests in `gates/`.
- abrun can't reach the verdict dir (`abgate` 0700) or the check's private copy, and it can't
  signal abgate.
- Dirs in `$AB_RUN_DIR` are `abgate:abrun 1775` (sticky). Files the check copies there, such as the
  harness kit's `.hidden-tests/`, stay read-only to abrun, and abrun can't delete them.
- When the check exits, every non-zombie process of abgate or abrun is counted (from `/proc`)
  **before** anything is killed. More than zero fails the gate closed (`lingering`). It is the
  contender's fault if an abrun process is left, and the kit's if an abgate process is left.
- `status/`, `logs/` and `bin/` are root 0700 and are read back through `sudo -n cat` on Naïve.
  Contender code can't read an earlier gate's log tail.

The e2e (15 tests) now also covers these cheaters, all FAIL with `kit_fault: false`:

- `race-writer` (the reviewer's loop): `lingering`.
- `sigstop` (SIGSTOP the check, rewrite the verdict, SIGCONT): EPERM, then "3/3 hidden cases fail".
- `peek-reference` (reads `cases.txt` for the answers): EPERM, then "3/3 hidden cases fail".
- `late-writer`: now `lingering`.

The `clean-room` gate checks every isolation property above from inside, and passes for every
contender, cheaters included.

## Who pays (review round 3)

These end in `failed_infra` (retried, never billed). Only failures that can be proven without the
contender's outputs count here:

- out.tar.gz not in the store: `failure_class infra`.
- GateInfraError on the 3rd job run (`GATE_INFRA_MAX_ATTEMPTS`): `failure_class infra`.
- A kit that doesn't load, or a GateKitError, which is raised before any output is touched (for
  example a check script missing from the bundle): `failure_class kit`.

Every outcome after the outputs were scored is the contender's: `failure_class gate`, counted
and billed. That includes a check that broke on them: non-zero exit with no verdict, no or invalid
gate.json, a lingering abgate process, or a lost status file. These set
`GateOutcome.kit_suspect` and emit a `trial.kit_suspect` event (gate, status, reason) so a
refund can be decided by hand. They are never a re-run, and they never erase another gate's FAIL.
The reviewer's repro shows why. A contender shipped `workspace/.hidden-tests` as a regular file,
the old harness check's `cp -R` aborted under `set -e`, and that would have been a free re-roll.
The e2e `planted-tests-file` cheater now:

- gets a FAIL verdict from the hardened check (`copy-tests`, the same pattern as the harness
  example);
- gets a counted `kit_suspect` FAIL from a deliberately fragile copy (`copy-tests-fragile`);
- ends up `classifyGateRecord(...).failureClass === "gate"`.

The harness example check (`packages/kit/examples/harness/gates/hidden-tests/check.sh`) now:

- does `rm -rf "$ws/.hidden-tests"` before copying;
- has an EXIT trap that writes a FAIL verdict whenever it would exit without one, once the outputs
  are involved;
- runs `node --test ".hidden-tests/**/*.test.js"`. Node 26 treats a bare directory argument as a
  module path: `MODULE_NOT_FOUND`, so the old `node --test .hidden-tests/` failed even the oracle;
- `packages/kit/test/tdm51-harness-check.test.ts` runs it on the host: oracle passes; a planted
  file, decoy tests or no workspace all FAIL with exit 0.

Two bash traps found on the way:

- An apostrophe inside `${VAR:?message}` opens a quote (`unexpected EOF while looking for matching
  "'"`), so that message must not contain one.
- `bash -n` every check.

## Rules for check authors

- **Write only under `$1` (your private copy) and `$3` (the verdict).** Never write into
  `$AB_RUN_DIR` after contender code has run there through `$AB_RUN`. abrun owns its files there
  and can plant symlinks, and a write by the check (abgate) would follow them into abgate's own
  files, the verdict dir included. `fs.protected_symlinks` doesn't help: it only covers sticky
  *world*-writable dirs, and these are `1775`. Copying tests in *before* running contender code
  is fine. The copy is `rm -rf` (which never follows a symlink) and then `cp -R`.
- Run contender code only as `"$AB_RUN" <cmd>`, from a cwd under `$AB_RUN_DIR`.
- Files copied from the kit keep its mode (0640, group abgate), so abrun can't read them. After
  `cp -R`, run `chmod -R a+rX` on the copy. The first e2e run without it failed the *honest*
  contender's copied tests.
- Every path that involves the outputs must end with a verdict. A verdict-less exit counts against
  the contender anyway, and only flags `kit_suspect`.

## Process counting: threads, not just pids

The leftover-process check counts **tasks**: `/proc/<pid>/task/<tid>`, owner uid plus `State`. A
thread-group leader that called `pthread_exit` shows `State: Z` on `/proc/<pid>` while its other
threads keep running. Counting only pids would miss such a "zombie leader". True zombies are
excluded (State Z or X): they run no code and hold no file descriptors.

Setup also refuses to proceed (an infra error) if either sandbox uid can become root:
`runuser -u <uid> -- su root -c true` must fail, and so must `runuser -u <uid> -- sudo -n true`
when sudo exists. Naïve images give their own user passwordless sudo, and a broad sudoers rule
would leak it.

## Limits

- In-process tampering inside a test runner (contender code patching `node:assert` in the same
  `node --test` process) is still possible. That is [16.1] (TDM-172).
- A check that runs contender code directly, not through `$AB_RUN`, gives it the check's uid. That
  is the kit's fault. The shipped examples (`harness/hidden-tests`) use `$AB_RUN`; `cli` and
  `http-agent` never run contender code. A proof check for it belongs in [16.10].
- A scoring computer carries the trial's tag, but `trials.computer_id` names the subject's
  computer. So the reaper only spares it while `last_seen_at` is fresh. The runner `touch`es the
  registry on every exec (about every 2 s while polling), and checks run detached.
