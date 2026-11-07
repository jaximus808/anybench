#!/usr/bin/env bash
# node22: unpack the pinned official tarball (sha256 from nodejs.org SHASUMS256.txt).
set -euo pipefail
. "$RECIPE_LIB"

dest="$NODE_HOME"
if [ -x "$dest/bin/node" ] && [ "$("$dest/bin/node" --version)" = "v$RECIPE_VERSION" ]; then
  log "already unpacked at $dest"
else
  need_cmds "curl:curl" "xz:xz-utils" "tar:tar"
  scratch
  fetch_verified "$RECIPE_URL" "$RECIPE_SHA256" "$SCRATCH/node.tar.xz"
  as_root mkdir -p "$ANYBENCH_OPT"
  as_root rm -rf "$dest.tmp"
  as_root mkdir -p "$dest.tmp"
  as_root tar -xJf "$SCRATCH/node.tar.xz" -C "$dest.tmp" --strip-components=1 --no-same-owner
  as_root rm -rf "$dest"
  as_root mv "$dest.tmp" "$dest"
fi
for b in node npm npx corepack; do link_bin "$dest/bin/$b" "$b"; done
log "node $("$dest/bin/node" --version) installed"
