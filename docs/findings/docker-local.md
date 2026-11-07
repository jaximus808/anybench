# docker-local provider (TDM-23)

What we learned building `DockerLocalProvider` (`packages/providers/src/docker.ts`).
Host: Docker 29.4.3, `linux/arm64` (Docker Desktop on macOS). Nothing in the provider
is macOS-specific: it only shells out to the `docker` CLI, so it runs the same on the
Linux arm64 worker VM and on amd64 CI.

## The base image has every tool the provider needs

```
$ docker run --rm ubuntu:24.04 sh -c 'for c in timeout setsid nohup runuser realpath useradd ps; do printf "%s: " $c; command -v $c || echo MISSING; done'
timeout: /usr/bin/timeout
setsid: /usr/bin/setsid
nohup: /usr/bin/nohup
runuser: /usr/sbin/runuser
realpath: /usr/bin/realpath
useradd: /usr/sbin/useradd
ps: /usr/bin/ps
```

ubuntu:24.04 already has a `ubuntu` user (uid 1000), so `naive` is created as uid 1001.
The derived image (`anybench-docker-local-base:<hash of its Dockerfile>`) is built once
from a stdin Dockerfile (`docker build -q -t <tag> -`, no build context) and cached.

## coreutils `timeout` kills the whole process group

```
$ docker run --rm ubuntu:24.04 sh -c 'timeout -k 2 1.000 sh -c "sleep 40 & sleep 41; wait"; echo exit=$?; sleep 0.5; for f in /proc/[0-9]*/cmdline; do tr "\0" " " < $f; echo; done | grep -c "^sleep 4"'
exit=124
0
```

So exec wraps every command in `timeout -k 2 <secs> sh -c <cmd>`: a timeout gives exit
124 (Naïve semantics) and leaves no child behind. Killing the host-side `docker exec`
client would not have killed anything inside the container. Use TERM, not KILL:

```
$ docker run --rm ubuntu:24.04 sh -c 'timeout -s KILL 1 sleep 5; echo exit=$?'
Killed
exit=137
```

Detached work (`buildDetachedCommand`: `setsid nohup … &`) leaves that process group,
so a timeout does not touch it. The container runs with `--init`, so orphans are reaped.

## `docker commit` copies the container's labels into the image

```
$ docker run -d --name ab-tdm23-probe --label anybench.x=1 ubuntu:24.04 sleep 60
$ docker commit ab-tdm23-probe ab-tdm23-probe:img
$ docker image inspect --format '{{json .Config.Labels}}' ab-tdm23-probe:img
{"anybench.x":"1","desktop.docker.io/ports.scheme":"v2","org.opencontainers.image.version":"24.04"}
```

A fork (container run from the snapshot image) would inherit the source's labels. So the
provider writes every `anybench.*` label explicitly on each `docker run` (tags are one
comma-joined `anybench.tags` label, never one label per tag), and a fork never inherits
the source's trial tag.

## A snapshot used by a live fork cannot be removed

```
$ docker rmi ab-tdm23-probe:img     # while a container runs from it
Error response from daemon: conflict: unable to delete ab-tdm23-probe:img (must be forced) - container c3a53fbbaeef is using its referenced image 035a9ab5b8b9
```

`deleteSnapshot` maps this to `ProviderUnavailableError` and does not force (forcing
untags the image and leaves a dangling layer nobody cleans up). Destroy the forks first.

## Conventions the provider sets

- Computer id = full 64-hex container id; snapshot id = `snap-<16 hex>`, stored as image
  `anybench-docker-local-snapshot:<snapshot id>`. Ids of any other shape are `not_found`.
- Only containers labelled `anybench.provider=docker-local` are visible: the provider
  never inspects, execs into or removes anything else.
- `exec` runs as root with `HOME=/home/naive` and cwd `/home/naive` (system setup goes
  through exec). Run as the naive user with `runuser -u naive -- <cmd>` or construct the
  provider with `execUser: "naive"`. `putFile` writes files and new parent dirs owned by
  `naive`; both `putFile` and `getFile` refuse paths that resolve (through symlinks)
  outside `/home/naive`.
- `--cpus`/`--memory` come from the spec, clamped to `docker info` NCPU/MemTotal. Disk is
  recorded in a label only (overlay2 has no portable per-container quota).
- Speed on a loaded laptop (load avg ~40): each docker CLI call is 0.1-0.5 s, an `exec` is
  two calls (inspect, then exec). The contract file runs in about 45-120 s.
