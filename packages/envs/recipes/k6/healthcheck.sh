#!/usr/bin/env bash
# k6: pinned version, and a real (network-free) script run whose check must pass.
set -euo pipefail
. "$RECIPE_LIB"

k6 version | head -1 | grep -q "v$RECIPE_VERSION" || die "k6 version: $(k6 version | head -1)"
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
cat > "$d/s.js" <<'JS'
import { check } from "k6";
export const options = { vus: 1, iterations: 3, thresholds: { checks: ["rate==1"] } };
export default function () {
  check(1 + 1, { "math works": (v) => v === 2 });
}
JS
(cd "$d" && k6 run --quiet --no-color --summary-export "$d/sum.json" "$d/s.js" >/dev/null 2>"$d/err") \
  || die "k6 run failed: $(tail -20 "$d/err")"
grep -q '"checks"' "$d/sum.json" || die "no checks in k6 summary export"
echo "$(k6 version | head -1) ok"
