# cli driver on docker-local: GNU time, hyperfine and the output-diff gate (TDM-36)

Captured on 2026-11-07, Docker Desktop on arm64 (Apple silicon), ubuntu:24.04 via
DockerLocalProvider. Code: `packages/kit/src/drivers/cli/`. Example kit: `packages/kit/examples/cli/`.

## Run

```
$ cd packages/bench && TDM36_DOCKER_LOG=<file> pnpm exec vitest run test/tdm36-cli-driver-docker.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  148.34s
```

Two containers: a subject computer (recipes `git-time` + `hyperfine`, then each contender's
`install.sh` + `healthcheck.sh`) and a separate scoring computer that only gets `gates/`,
`reference/` and each trial's frozen tar. Most of the 148 s is the first `apt-get update` and the
GNU time install. The runs themselves take about a second each.

| case | workload | gate | wall_s (time -v) | peak RSS | hyperfine median |
|---|---|---|---|---|---|
| gnu-grep (oracle) | literal-search | pass | 0 | 3.0 MB | 3.0 ms |
| gnu-grep (oracle) | unicode-regex | pass | 0.01 | 2.9 MB | 1.2 ms |
| ripgrep | literal-search | pass | 0.33 | 5.5 MB | 6.4 ms |
| ripgrep | unicode-regex | pass | 0.10 | 5.7 MB | 28.7 ms |
| ripgrep + truncated-output | literal-search | **fail** | 0.03 | 5.5 MB | 21.2 ms |
| ripgrep + first-match-only | literal-search | **fail** | 0.01 | 5.5 MB | 23.1 ms |

Do-less reasons, verbatim from `gate.json`:

```
same-matches: literal-search failed: cli/stdout.txt differs from the reference: got 1 line(s), expected 4; 3 expected line(s) missing and none extra (output truncated?)
same-matches: literal-search failed: cli/stdout.txt differs from the reference: got 3 line(s), expected 4; 1 expected line(s) missing and none extra (output truncated?)
```

## What we learned

- **GNU time's wall clock only has 10 ms resolution** (`Elapsed (wall clock) time: 0:00.00`). For
  a CLI that finishes in milliseconds, `wall_s` reads 0, 0.01 or a cold-start outlier (ripgrep's
  first run here was 0.33 s, about 50 times its hyperfine median). Peak RSS and CPU from
  `time -v` are fine. hyperfine's median is the wall-time number worth scoring for fast tools. But
  bench's `trialMetricRecord` skips labelled rows, and every hyperfine row carries a `command`
  label, so today a requirement can't score `hyperfine_median_s`. That's a follow-up for bench,
  not for this driver.
- **`export -f` carries the subject into both tools.** `hyperfine --shell=bash ... subject` and
  `time -v bash -c subject` both see the exported `subject` function
  (`BASH_FUNC_subject%%` in the env), so the gated run and the timed runs execute the same code.
  hyperfine subtracts its measured shell spawn time, so the extra `bash -c` doesn't show up in its
  numbers. It does show up in `time -v`, the same for every contender.
- **`grep -P '\p{Greek}+'` needs a UTF-8 locale.** The bare container has no `LANG`, so the gnu-grep
  oracle runs `LC_ALL=C.UTF-8 grep -rnoP`. Without it the oracle fails its own reference.
- **ripgrep's `--sort path` forces one thread**, which would make the THREADS=1 planted regression
  a no-op. The driver doesn't sort. The gate sorts both sides (`sort_lines: true`, `LC_ALL=C`).
- **ripgrep 14.1.1 ships no aarch64 musl build.** `install.sh` picks
  `aarch64-unknown-linux-gnu` or `x86_64-unknown-linux-musl` by `uname -m`. It checks each one
  against the `.sha256` published with the release (`c827481c…ab2f`, `4cf9f274…4d8e`).
- The rendered scripts run under macOS bash 3.2 as well as bash 5, so the kit's host tests drive
  them with fake `time`/`hyperfine` and no Docker. With `set -u`, empty arrays need the
  `${a[@]+"${a[@]}"}` form in bash 3.2.
