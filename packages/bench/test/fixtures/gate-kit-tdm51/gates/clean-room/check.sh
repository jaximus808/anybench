#!/usr/bin/env bash
# L5 gate 'clean-room', TDM-51 test kit: asserts the scoring computer's isolation from inside a check.
set -u
out="$1" wl="$2" verdict="$3"
kit="$(cd "$(dirname "$0")/../.." && pwd)"
bad=""
[ "$(id -u)" != 0 ] || bad="$bad check-runs-as-root"
for d in adapters proof anybench.yaml; do [ ! -e "$kit/$d" ] || bad="$bad kit-has-$d"; done
touch "$kit/reference/x" 2>/dev/null && bad="$bad kit-writable"
touch "$AB_FROZEN/x" 2>/dev/null && bad="$bad frozen-writable"
[ ! -e "$out/workspace/summer-installed" ] || bad="$bad subject-installed"
command -v summer >/dev/null 2>&1 && bad="$bad subject-on-path"
# Contender code, run the only way a check may run it:
if [ -n "${AB_RUN:-}" ]; then
  cd "$AB_RUN_DIR"
  [ "$("$AB_RUN" id -u)" != "$(id -u)" ] || bad="$bad run-uid-is-check-uid"
  [ "$("$AB_RUN" id -u)" != 0 ] || bad="$bad run-uid-is-root"
  "$AB_RUN" cat "$kit/reference/sum-tests/add/cases.txt" >/dev/null 2>&1 && bad="$bad run-reads-reference"
  "$AB_RUN" sh -c 'echo x > "$1"' _ "$verdict" 2>/dev/null && bad="$bad run-writes-verdict"
  "$AB_RUN" kill -0 "$$" 2>/dev/null && bad="$bad run-signals-check"
  "$AB_RUN" sh -c 'env | grep -q "^AB_"' && bad="$bad run-sees-ab-env"
  "$AB_RUN" touch "$AB_RUN_DIR/run-writable" 2>/dev/null || bad="$bad run-dir-not-writable"
else
  bad="$bad no-AB_RUN"
fi
rm -f "$verdict"
if [ -z "$bad" ]; then
  printf '{"pass":true,"reason":"clean room","evidence":[]}\n' > "$verdict"
else
  printf '{"pass":false,"reason":"not a clean room:%s","evidence":[]}\n' "$bad" > "$verdict"
fi
