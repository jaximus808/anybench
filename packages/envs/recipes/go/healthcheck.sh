#!/usr/bin/env bash
# go: pinned version, and a real module that builds and passes `go test -json`.
set -euo pipefail
. "$RECIPE_LIB"

expect_eq "go version" "go$RECIPE_VERSION" "$(go version | awk '{print $3}')"
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
cat > "$d/go.mod" <<'MOD'
module example.com/hc

go 1.22
MOD
printf 'package hc\n\nfunc Add(a, b int) int { return a + b }\n' > "$d/hc.go"
printf 'package hc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("bad")\n\t}\n}\n' > "$d/hc_test.go"
(cd "$d" && go test -count=1 -json ./... | grep -q '"Action":"pass","Package":"example.com/hc","Test":"TestAdd"') || die "go test -json did not report TestAdd passing"
echo "$(go version) ok"
