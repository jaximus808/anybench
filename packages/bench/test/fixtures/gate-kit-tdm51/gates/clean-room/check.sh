#!/usr/bin/env bash
# L5 gate 'clean-room', TDM-51 test kit: asserts the scoring computer's isolation from inside a check.
set -u
out="$1" wl="$2" verdict="$3"
kit="$(cd "$(dirname "$0")/../.." && pwd)"
bad=""
[ "$(id -u)" != 0 ] || bad="$bad check-runs-as-root"
for d in adapters workloads proof anybench.yaml; do [ ! -e "$kit/$d" ] || bad="$bad kit-has-$d"; done
touch "$kit/reference/x" 2>/dev/null && bad="$bad kit-writable"
touch "$AB_FROZEN/x" 2>/dev/null && bad="$bad frozen-writable"
[ ! -e "$out/workspace/summer-installed" ] || bad="$bad subject-installed"
command -v summer >/dev/null 2>&1 && bad="$bad subject-on-path"
if [ -z "$bad" ]; then
  printf '{"pass":true,"reason":"clean room","evidence":[]}\n' > "$verdict"
else
  printf '{"pass":false,"reason":"not a clean room:%s","evidence":[]}\n' "$bad" > "$verdict"
fi
