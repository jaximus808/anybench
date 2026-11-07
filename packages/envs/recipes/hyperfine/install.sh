#!/usr/bin/env bash
# hyperfine: upstream publishes no checksum file, so recipe.json pins the sha256 GitHub
# reports for the release asset (checked against a local download, docs/findings/recipes.md).
set -euo pipefail
. "$RECIPE_LIB"

dest="$ANYBENCH_OPT/hyperfine-$RECIPE_VERSION"
if [ -x "$dest/hyperfine" ] && "$dest/hyperfine" --version | grep -qx "hyperfine $RECIPE_VERSION"; then
  log "already unpacked at $dest"
else
  need_cmds "curl:curl" "tar:tar"
  scratch
  fetch_verified "$RECIPE_URL" "$RECIPE_SHA256" "$SCRATCH/hf.tar.gz"
  as_root mkdir -p "$dest"
  as_root tar -xzf "$SCRATCH/hf.tar.gz" -C "$dest" --strip-components=1 --no-same-owner
fi
link_bin "$dest/hyperfine" hyperfine
log "$("$dest/hyperfine" --version) installed"
