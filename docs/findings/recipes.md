# Env recipes: base recipes on docker-local (TDM-25)

What the six base recipes (`packages/envs/recipes/*`) do when the generic runner
(`packages/envs/src/recipe.ts`) installs them on a computer, and what they rely on.

**Naïve live run pending.** The Naïve key's scopes are being fixed, so the recipes have not run
on a Naïve computer yet. Nothing here is Docker-specific: the runner uses only `exec` and
`putFile`, and the scripts need bash, `uname`, `mktemp` and either root or passwordless `sudo`.
Three recipes (`git-time`, `hey`, and `need_cmds` fetching curl/xz for the others) need
`apt-get`, so they assume a Debian or Ubuntu image.

## Result: all six healthy on docker-local (ubuntu:24.04, arm64)

```
$ cd packages/envs && ANYBENCH_RECIPES_LOG=<file> pnpm exec vitest run test/recipes-docker-tdm25.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  154.54s
```

The test makes one shared container (DockerLocalProvider, 2 vCPU / 2 GB, Docker Desktop on an
M-series Mac under heavy load from parallel workers). Machine: `aarch64`, `Ubuntu 24.04.5 LTS`.

| recipe | version | status | install s | health s |
|---|---|---|---|---|
| node22 | 22.23.4 | installed | 56.1 | 1.5 |
| python312-uv | 3.12.15-uv0.13.4 | installed | 11.5 | 1.0 |
| git-time | git2.43.0-time1.9 | installed | 30.9 | 0.2 |
| hyperfine | 1.21.0 | installed | 1.0 | 0.4 |
| hey | 0.1.4 | installed | 15.4 | 0.2 |
| k6 | 2.3.0 | installed | 5.2 | 0.6 |

node22's 56 s includes the first `apt-get update` and installing curl, ca-certificates and
xz-utils (the bare ubuntu image has none of them). Later recipes reuse the hourly apt stamp.

The same test also checks two things:
- **Second run on the same container:** every recipe is `skipped` because its health check
  already passes, and the exported env is the same. This is what a snapshot fork will see.
- **The unprivileged `naive` user**, after sourcing `renderRecipeEnv()` output, gets
  `node v22.23.4`, `Python 3.12.15`, `uv 0.13.4`, `git version 2.43.0`, `hyperfine 1.21.0`,
  `k6 v2.3.0` and `/usr/bin/hey`, and can make an offline uv venv and run Python in it.

Exported env (merged, install order):

```json
{"NODE_HOME": "/opt/anybench/node-v22.23.4", "UV_PYTHON": "3.12.15",
 "UV_PYTHON_INSTALL_DIR": "/opt/anybench/uv-python", "UV_PYTHON_DOWNLOADS": "never",
 "ANYBENCH_UV_VERSION": "0.13.4", "ANYBENCH_PYTHON_VERSION": "3.12.15",
 "ANYBENCH_GNU_TIME": "/usr/bin/time", "GIT_TERMINAL_PROMPT": "0", "K6_NO_USAGE_REPORT": "true"}
```

## Pins and checksums

Every download is pinned per arch in `recipe.json` and checked by `fetch_verified` (in
`_lib.sh`) before it is unpacked. A mismatch deletes the file and fails the install.

| recipe | source | sha256 from |
|---|---|---|
| node22 | nodejs.org `node-v22.23.4-linux-{x64,arm64}.tar.xz` | upstream `SHASUMS256.txt` |
| python312-uv | GitHub astral-sh/uv `0.13.4` `uv-{x86_64,aarch64}-unknown-linux-gnu.tar.gz` | upstream `<asset>.sha256` |
| python312-uv (CPython) | `uv python install 3.12.15` (python-build-standalone) | uv's built-in per-release hashes |
| hyperfine | GitHub sharkdp/hyperfine `v1.21.0` `*-unknown-linux-musl.tar.gz` | **no upstream checksum file**: the GitHub asset digest (`checksumSource: github-asset-digest`) |
| k6 | GitHub grafana/k6 `v2.3.0` `k6-v2.3.0-linux-{amd64,arm64}.tar.gz` | upstream `k6-v2.3.0-checksums.txt` |
| git-time | Ubuntu apt `git`, `time` | apt signatures; install fails unless upstream is 2.43.0 / 1.9 |
| hey | Ubuntu apt `hey` (universe) | apt signatures; install fails unless upstream is 0.1.4 |

The pins were picked on 2026-11-07, each from a release at least two weeks old: node v22.23.4
(2026-10-20), uv 0.13.4 (2026-10-20), hyperfine v1.21.0 (2026-10-05; v2.0.0 is newer but a
major bump), k6 v2.3.0 (2026-09-21).

I downloaded all 8 pinned files on the host and checked them against recipe.json:

```
$ for each downloads[arch] in recipes/*/recipe.json: curl -sSL $url | shasum -a 256
OK   x64 hyperfine-v1.21.0-x86_64-unknown-linux-musl.tar.gz
OK   arm64 hyperfine-v1.21.0-aarch64-unknown-linux-musl.tar.gz
OK   x64 k6-v2.3.0-linux-amd64.tar.gz
OK   arm64 k6-v2.3.0-linux-arm64.tar.gz
OK   x64 node-v22.23.4-linux-x64.tar.xz
OK   arm64 node-v22.23.4-linux-arm64.tar.xz
OK   x64 uv-x86_64-unknown-linux-gnu.tar.gz
OK   arm64 uv-aarch64-unknown-linux-gnu.tar.gz
```

### Why hey comes from apt

rakyll/hey publishes a linux-amd64 binary only (on an S3 bucket that now answers 403, see
TDM-50), no arm64 binary and no checksums. The v0.1.5 GitHub release has no assets. Ubuntu
ships `hey` 0.1.4 for both arches:

```
$ docker run --rm ubuntu:24.04 sh -c 'apt-get update -qq; apt-cache policy hey git time'
hey:
  Candidate: 0.1.4-2ubuntu0.24.04.3
     0.1.4-2ubuntu0.24.04.3 500  noble-updates/universe arm64, noble-security/universe arm64
     0.1.4-2build1 500           noble/universe arm64
git:
  Candidate: 1:2.43.0-1ubuntu7.4
time:
  Candidate: 1.9-0.2build1
```

The apt route is signed and works on both arches. Building `go install github.com/rakyll/hey@v0.1.4`
(module checksums via sum.golang.org) is the fallback for a non-Debian image, but it would need
a pinned Go toolchain first.

## Gotchas found

- **Ubuntu's GNU time prints no version:** `/usr/bin/time --version` prints
  `time (GNU Time) UNKNOWN`. The git-time health check matches `(GNU Time)` and reads the
  version from `dpkg-query -W time` (`1.9-0.2build1`).
- **Shell helpers must use `local`.** The first run failed `node on PATH: want
  '/usr/local/bin/node', got ''` because `fetch_verified` set a global `dest`, which overwrote
  install.sh's own `dest`, so node was unpacked to the wrong place. Every `_lib.sh` function
  now declares its variables `local`.
- `uv python install` (0.8+) also writes a `python3.12` shim to `~/.local/bin` by default.
  Run as root with `HOME=/home/naive`, that would leave a root-owned dir in the naive home, so
  the recipe passes `--no-bin` and links `/usr/local/bin/python3.12` and `python3` itself.
  The exported `UV_PYTHON_DOWNLOADS=never` keeps trials from fetching other interpreters.
- **x64 under emulation:** I ran each install.sh + healthcheck.sh by hand in `docker run
  --platform linux/amd64 ubuntu:24.04` (qemu on Apple silicon) with the x64 RECIPE_* env.
  Results: `node22 PASS 288s node v22.23.4 npm 10.9.9 ok`; `git-time PASS 112s git 2.43.0,
  rss_kb=10016 wall_s=0.05 exit=0 ok`; `hyperfine PASS 5s hyperfine 1.21.0 ok`;
  `k6 PASS 73s k6 v2.3.0 (commit/e088784614, go1.26.8, linux/amd64) ok`. Two binaries crash
  under qemu after a good install. uv died with `qemu: uncaught target signal 11
  (Segmentation fault)` right after `sha256 ok`. hey (`hey_0.1.4-2ubuntu0.24.04.3_amd64.deb`
  installed fine) crashed in its health check with a Go runtime register dump. Both look like
  qemu limitations, not recipe faults: the downloads verified and the same recipes pass
  natively on arm64. The real x64 check is this test on amd64 CI (ubuntu-latest has Docker)
  and later on Naïve.

## Contract summary (for downstream tickets)

- `recipes/<name>/recipe.json` holds `name` (= dir), `version`, `description`, `deps`,
  `arch` (`x64`|`arm64`), `env` (no `PATH`, no `RECIPE_*`), `path` (PATH prefixes),
  `downloads.{x64,arm64}` = `{url (https), sha256, checksumSource}`, and optional
  `timeouts.{installMs,healthcheckMs}`.
- Scripts run as `cd <home>/.anybench/recipes/<name>@<version> && PATH=… <env> RECIPE_* bash
  ./install.sh`. Each one sources `_lib.sh` (`as_root`, `apt_install`, `need_cmds`,
  `fetch_verified`, `link_bin`, `expect_eq`). Install exec is capped at
  `min(600 s, provider maxExecTimeoutMs)`.
- `runRecipes(provider, computerId, names, opts)` emits `computer.recipe` events with phases
  `started|installed|healthy|skipped|failed`, returns `{arch, results, env, path}`, and throws
  `RecipeRunError` on the first failure.
