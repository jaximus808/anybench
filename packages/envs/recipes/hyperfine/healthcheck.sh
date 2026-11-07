#!/usr/bin/env bash
# hyperfine: pinned version, and a real benchmark that writes a JSON export with results.
set -euo pipefail
. "$RECIPE_LIB"

expect_eq "hyperfine --version" "hyperfine $RECIPE_VERSION" "$(hyperfine --version)"
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
hyperfine --runs 3 --warmup 1 --shell=none --style basic --export-json "$d/r.json" 'true' >/dev/null
grep -q '"results"' "$d/r.json" || die "no results in hyperfine JSON export"
grep -q '"mean"' "$d/r.json" || die "no mean in hyperfine JSON export"
echo "$(hyperfine --version) ok"
