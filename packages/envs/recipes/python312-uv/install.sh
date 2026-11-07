#!/usr/bin/env bash
# python312-uv: pinned uv binary (sha256 from the release's .sha256 file), then
# `uv python install` of the pinned CPython. uv verifies the python-build-standalone archive
# against the sha256 compiled into that uv release.
set -euo pipefail
. "$RECIPE_LIB"

uv_dir="$ANYBENCH_OPT/uv-$ANYBENCH_UV_VERSION"
if [ -x "$uv_dir/uv" ] && "$uv_dir/uv" --version | grep -qx "uv $ANYBENCH_UV_VERSION.*"; then
  log "uv already at $uv_dir"
else
  need_cmds "curl:curl" "tar:tar"
  scratch
  fetch_verified "$RECIPE_URL" "$RECIPE_SHA256" "$SCRATCH/uv.tar.gz"
  as_root mkdir -p "$uv_dir"
  as_root tar -xzf "$SCRATCH/uv.tar.gz" -C "$uv_dir" --strip-components=1 --no-same-owner
fi
link_bin "$uv_dir/uv" uv
link_bin "$uv_dir/uvx" uvx

as_root mkdir -p "$UV_PYTHON_INSTALL_DIR"
# Downloads are off in the exported env (trials must not fetch interpreters); allow them here.
as_root env UV_PYTHON_INSTALL_DIR="$UV_PYTHON_INSTALL_DIR" UV_PYTHON_DOWNLOADS=automatic \
  UV_CACHE_DIR="$ANYBENCH_OPT/.uv-install-cache" \
  "$uv_dir/uv" python install --no-bin "$ANYBENCH_PYTHON_VERSION"
as_root rm -rf "$ANYBENCH_OPT/.uv-install-cache"
py=$(env UV_PYTHON_INSTALL_DIR="$UV_PYTHON_INSTALL_DIR" "$uv_dir/uv" python find --managed-python "$ANYBENCH_PYTHON_VERSION")
[ -x "$py" ] || die "uv python find returned '$py'"
link_bin "$py" python3.12
link_bin "$py" python3
log "uv $ANYBENCH_UV_VERSION, python $("$py" -c 'import platform;print(platform.python_version())') at $py"
