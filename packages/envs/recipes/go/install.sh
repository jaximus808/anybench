#!/usr/bin/env bash
# go: unpack the pinned official tarball (sha256 from go.dev/dl/?mode=json), link go and gofmt,
# and make the module/build caches writable by every user (the gate runs tests as another uid).
set -euo pipefail
. "$RECIPE_LIB"

dest="$GOROOT"
if [ -x "$dest/bin/go" ] && "$dest/bin/go" version | grep -q "go$RECIPE_VERSION "; then
  log "already unpacked at $dest"
else
  need_cmds "curl:curl" "tar:tar"
  scratch
  fetch_verified "$RECIPE_URL" "$RECIPE_SHA256" "$SCRATCH/go.tar.gz"
  as_root mkdir -p "$ANYBENCH_OPT"
  as_root rm -rf "$dest.tmp"
  as_root mkdir -p "$dest.tmp"
  as_root tar -xzf "$SCRATCH/go.tar.gz" -C "$dest.tmp" --strip-components=1 --no-same-owner
  as_root rm -rf "$dest"
  as_root mv "$dest.tmp" "$dest"
fi
for b in go gofmt; do link_bin "$dest/bin/$b" "$b"; done
as_root mkdir -p "$GOMODCACHE" "$GOCACHE"
as_root chmod 1777 "$GOPATH" "$GOMODCACHE" "$GOCACHE"
log "$("$dest/bin/go" version) installed"
