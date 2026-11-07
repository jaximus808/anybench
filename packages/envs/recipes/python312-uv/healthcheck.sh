#!/usr/bin/env bash
# python312-uv: pinned uv and python on PATH, and uv builds a venv and runs code in it offline.
set -euo pipefail
. "$RECIPE_LIB"

expect_eq "uv --version" "uv $ANYBENCH_UV_VERSION" "$(uv --version | cut -d' ' -f1-2)"
expect_eq "python3.12 version" "$ANYBENCH_PYTHON_VERSION" \
  "$(python3.12 -c 'import platform;print(platform.python_version())')"
expect_eq "python3 version" "$ANYBENCH_PYTHON_VERSION" \
  "$(python3 -c 'import platform;print(platform.python_version())')"
python3 -c 'import ssl, sqlite3, json, venv, hashlib; assert hashlib.sha256(b"x").hexdigest()'
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
UV_CACHE_DIR="$d/cache" uv venv --quiet --offline "$d/venv"
expect_eq "venv python" "$ANYBENCH_PYTHON_VERSION" \
  "$("$d/venv/bin/python" -c 'import platform;print(platform.python_version())')"
echo "uv $ANYBENCH_UV_VERSION python $ANYBENCH_PYTHON_VERSION ok"
