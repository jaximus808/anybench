#!/usr/bin/env bash
# hey: pinned package version, and a real request run. Nothing listens on port 9 (discard), so
# hey must report the refused connections in its summary rather than crash.
set -euo pipefail
. "$RECIPE_LIB"

v=$(dpkg-query -W -f='${Version}' hey 2>/dev/null || true)
up=${v#*:}; up=${up%%-*}
expect_eq "hey package upstream version" "$RECIPE_VERSION" "$up"
out=$(hey -n 4 -c 2 -t 2 http://127.0.0.1:9/ 2>&1 || true)
printf '%s\n' "$out" | grep -q "Summary:" || die "hey produced no summary: $out"
printf '%s\n' "$out" | grep -q "Error distribution:" || die "hey reported no errors: $out"
echo "hey $v ok"
