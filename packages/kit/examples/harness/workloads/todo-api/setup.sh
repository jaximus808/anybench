#!/usr/bin/env bash
# Prepares EVAL_WS: a clean git repo with the starter package.json.
set -euo pipefail
cp "$(dirname "$0")/input/package.json" "$EVAL_WS/package.json"
git -C "$EVAL_WS" init -q && git -C "$EVAL_WS" add -A && git -C "$EVAL_WS" commit -qm start
