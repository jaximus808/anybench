# Binary ingest: running an untrusted binary's `--help` in Docker (TDM-35)

Context: `packages/kit/src/ingest/binary.ts` must capture `--help` / `-h` / `--version` of an
uploaded or downloaded binary without ever executing it on the host. Host: macOS arm64,
Docker Desktop 29.4.3 (`docker info --format '{{.Architecture}} {{.ServerVersion}}'` →
`aarch64 29.4.3`), load average ~50 from parallel workers.

## What runs

```sh
docker create --rm --name anybench-ingest-<12 hex> --network none --pull missing \
  --platform linux/amd64 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m --cap-drop ALL \
  --security-opt no-new-privileges --memory 256m --pids-limit 128 --user 65534:65534 \
  -e HOME=/tmp -e TERM=dumb -e COLUMNS=100 \
  -v <staged copy, mode 0755>:/bin/subject:ro debian:stable-slim /bin/subject --version
docker start -a anybench-ingest-<12 hex>     # under the 10 s timeout
docker rm -f anybench-ingest-<12 hex>        # only on timeout / failed start
```

Output for the ripgrep 15.2.0 x86_64 musl release on the arm64 Mac (amd64 emulation):

```
ripgrep 15.2.0 (rev e89fff89ac)

features:+pcre2
simd(compile):+SSE2,-SSSE3,-AVX2
simd(runtime):+SSE2,+SSSE3,+AVX2

PCRE2 10.45 is available (JIT is available)
docker start -a $N  0.02s user 0.02s system 2% cpu 1.477 total
exit 0
```

## Findings

1. **A single `docker run` under a 10 s timeout is wrong.** The first capture for
   `--platform linux/amd64` on an arm64 host timed out: the timeout covered the image pull
   (stderr: `Unable to find image 'debian:stable-slim' locally ... Pulling fs layer`). Splitting
   into `docker create` (5 min setup timeout, may pull) then `docker start -a` (10 s) charges the
   timeout to the subject only.
2. **Killing the `docker run` client leaves a container behind.** Under load a timed-out
   `docker run` left one in state `Created` (`docker ps -a --filter name=anybench-ingest-` →
   `0e21706424de anybench-ingest-675802f3d5c0 Created "/bin/subject --vers…"`): `docker rm -f`
   ran before the daemon finished creating it. With create-then-start the container always
   exists by name when we remove it.
3. **`--rm` removal is asynchronous.** Right after `docker start -a` returns, `docker ps -a` can
   still list the container; tests poll for up to 10 s.
4. **`--network none` still shows tunnel devices** in `/sys/class/net` (`bonding_masters erspan0
   gre0 ... lo sit0 tunl0`) on Docker Desktop's kernel, but no `eth*` and no routes
   (`tail -n +2 /proc/net/route | wc -l` → `0`). Tests assert on routes, not on the device list.
5. ripgrep's `--help` is larger than the 64 KiB capture cap (65516 chars kept, `truncated: true`).
6. Mach-O and PE binaries are never run (no sandbox for them); their captures are `skipped`.

Fixture: `packages/kit/test/fixtures/tdm35-ripgrep/ripgrep-15.2.0.json`, rebuilt by
`pnpm -C packages/kit build && node packages/kit/test/fixtures/tdm35-ripgrep/build.mjs`.
