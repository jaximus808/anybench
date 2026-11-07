#!/usr/bin/env bash
# node22: the pinned version is first on PATH, npm runs, and node executes real code.
set -euo pipefail
. "$RECIPE_LIB"

expect_eq "node on PATH" "/usr/local/bin/node" "$(command -v node)"
expect_eq "node --version" "v$RECIPE_VERSION" "$(node --version)"
npm --version >/dev/null
npx --version >/dev/null
out=$(node -e 'const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update("anybench").digest("hex").slice(0,8)+" "+process.arch)')
case "$RECIPE_ARCH" in x64) want_arch=x64 ;; arm64) want_arch=arm64 ;; esac
expect_eq "node -e" "$(printf anybench | sha256_of /dev/stdin | cut -c1-8) $want_arch" "$out"
echo "node $(node --version) npm $(npm --version) ok"
