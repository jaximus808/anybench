#!/usr/bin/env bash
# k6: pinned tarball, sha256 from the release's k6-v<version>-checksums.txt.
set -euo pipefail
. "$RECIPE_LIB"

dest="$ANYBENCH_OPT/k6-$RECIPE_VERSION"
if [ -x "$dest/k6" ] && "$dest/k6" version 2>/dev/null | grep -q "v$RECIPE_VERSION"; then
  log "already unpacked at $dest"
else
  need_cmds "curl:curl" "tar:tar"
  scratch
  fetch_verified "$RECIPE_URL" "$RECIPE_SHA256" "$SCRATCH/k6.tar.gz"
  as_root mkdir -p "$dest"
  as_root tar -xzf "$SCRATCH/k6.tar.gz" -C "$dest" --strip-components=1 --no-same-owner
fi
link_bin "$dest/k6" k6
log "$("$dest/k6" version | head -1) installed"
