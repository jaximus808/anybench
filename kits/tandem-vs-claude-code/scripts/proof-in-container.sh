#!/usr/bin/env bash
# Runs inside the node:22 container started by verify-proof.sh (kit at $KIT, read-only; results to
# $PROOF_OUT). For each workload it builds a fresh workspace with the workload's setup.sh, then:
#   oracle      proof/oracle/driver.sh, then both gates: must pass 100% of the hidden tests
#   do-nothing  proof/do_less/do-nothing/driver.sh, then both gates: must fail every hidden test
# plus: the starting repo's and the oracle's own `npm test`, and the bug-hunt planted-bug check.
#
# Gates run under the gate runner's convention (packages/bench gate.ts, TDM-51):
# `check.sh <frozen-out> <workload-id> <gate.json>`, contender code through $AB_RUN in $AB_RUN_DIR
# (a copy of the outputs, with workspace/ in it). Here $AB_RUN is scripts/ab-run-local.sh (clean
# env, no uid switch), and each gate gets its own fresh copy, as on a scoring computer.
set -uo pipefail
KIT="${KIT:-/kit}"
OUT="${PROOF_OUT:-/out}"
WORKLOADS=(todo-api auth-refactor bug-hunt)
mkdir -p "$OUT"
fail=0
note() { printf '%s\n' "$*"; }
bad() { printf 'FAIL: %s\n' "$*"; fail=1; }

export AB_RUN="$KIT/scripts/ab-run-local.sh"
# run_gate <gate> <workload> <workspace> <dir>: <dir>/out (frozen-out), <dir>/gate.json (verdict).
run_gate() {
  local gate="$1" w="$2" ws="$3" d="$4"
  mkdir -p "$d/out" "$d/run" "$d/home"
  cp -R "$ws" "$d/run/workspace"
  AB_RUN_DIR="$d/run" AB_RUN_HOME="$d/home" "$KIT/gates/$gate/check.sh" "$d/out" "$w" "$d/gate.json"
}

count() { node -e 'const s=require(process.argv[1]); console.log(`${s.passed} ${s.failed} ${s.total}`)' "$1"; }
own_tests() { # prints "pass fail" of the workspace's own test suite
  (cd "$1" && node --test --test-reporter=tap "test/**/*.test.ts" 2>/dev/null | awk '/^# pass /{p=$3} /^# fail /{f=$3} END{print p+0, f+0}')
}

note "node $(node --version), git $(git --version | awk '{print $3}'), network: $(node -e 'require("dns").lookup("registry.npmjs.org",e=>console.log(e?"none":"UP"))')"
rows=()
for w in "${WORKLOADS[@]}"; do
  for variant in oracle do-nothing; do
    ws="$(mktemp -d)/ws"
    "$KIT/workloads/$w/setup.sh" "$ws" || { bad "$w setup.sh failed"; continue; }
    start_commit="$(git -C "$ws" rev-parse --short HEAD)"
    if [[ "$variant" == oracle ]]; then
      WORKLOAD="$w" EVAL_WS="$ws" "$KIT/proof/oracle/driver.sh" run "$KIT/workloads/$w/instruction.md" "$ws" || bad "$w oracle driver failed"
    else
      WORKLOAD="$w" EVAL_WS="$ws" "$KIT/proof/do_less/do-nothing/driver.sh" run "$KIT/workloads/$w/instruction.md" "$ws" || bad "$w do-nothing driver failed"
    fi
    o="$OUT/$variant/$w"
    mkdir -p "$o"
    run_gate hidden-tests "$w" "$ws" "$o/hidden-tests" > "$o/hidden-tests.stdout" 2>&1 || bad "$w $variant hidden-tests grader error"
    run_gate api-load "$w" "$ws" "$o/api-load" > "$o/api-load.stdout" 2>&1 || bad "$w $variant api-load grader error"
    read -r passed failed total < <(count "$o/hidden-tests/out/hidden-tests.json")
    hidden_gate="$(node -p 'require(process.argv[1]).pass' "$o/hidden-tests/gate.json")"
    load_gate="$(node -p 'const g=require(process.argv[1]); g.applicable===false?"n/a":g.pass' "$o/api-load/gate.json")"
    p95="$(node -e 'try{const r=require(process.argv[1]); console.log(r.p95_ms.toFixed(1)+" ms")}catch{console.log("n/a")}' "$o/api-load/out/api-load.json")"
    read -r own_pass own_fail < <(own_tests "$ws")
    rows+=("| $w | $variant | $start_commit | $passed/$total | $failed | $hidden_gate | $load_gate | $p95 | $own_pass pass, $own_fail fail |")
    if [[ "$variant" == oracle ]]; then
      [[ "$passed" == "$total" && "$total" -gt 0 && "$hidden_gate" == true ]] || bad "$w oracle passed $passed/$total hidden tests"
      [[ "$own_fail" == 0 && "$own_pass" -gt 0 ]] || bad "$w oracle's own tests: $own_pass pass, $own_fail fail"
      if [[ "$w" == todo-api ]]; then [[ "$load_gate" == true ]] || bad "todo-api oracle api-load gate failed"; fi
    else
      [[ "$passed" == 0 && "$failed" == "$total" && "$hidden_gate" == false ]] || bad "$w do-nothing passed $passed/$total hidden tests"
      [[ "$load_gate" != true ]] || bad "$w do-nothing api-load gate passed"
      [[ "$own_fail" == 0 ]] || bad "$w starting repo's own tests fail ($own_fail)"
    fi
  done
done

# bug-hunt planted-bug check (synthetic history, workloads/bug-hunt/PROVENANCE.md): the starting repo
# == oracle + hidden tests with that commit reverted; the "fix" added exactly the hidden tests.
r="$(mktemp -d)/revert"
export GIT_AUTHOR_NAME=kit GIT_AUTHOR_EMAIL=kit@anybench.invalid GIT_COMMITTER_NAME=kit GIT_COMMITTER_EMAIL=kit@anybench.invalid
export GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z
git init -q -b main "$r"
cp -R "$KIT/workloads/bug-hunt/input/." "$r/"
git -C "$r" add -A && git -C "$r" commit -q -m "report-export 1.3.0 (before the fix)"
before_tree="$(git -C "$r" rev-parse HEAD^{tree})"
cp -R "$KIT/proof/oracle/bug-hunt/." "$r/"
for f in $(node -e 'for (const f of new Set(require(process.argv[1]).tests.map(t=>t.file))) console.log(f)' "$KIT/gates/hidden-tests/bug-hunt/tests.json"); do
  cp "$KIT/gates/hidden-tests/bug-hunt/$f" "$r/test/$f"
done
git -C "$r" add -A && git -C "$r" commit -q -m "fix(csv): quote and unquote fields per RFC 4180 (#212)"
added="$(git -C "$r" diff --name-status HEAD~1 HEAD | awk '$1=="A"{print $2}' | sort | tr '\n' ' ')"
fix_tests_pass="$(cd "$r" && node --test --test-reporter=tap test/csv-quoting.test.ts test/orders-roundtrip.test.ts 2>/dev/null | awk '/^# pass /{p=$3} /^# fail /{f=$3} END{print p+0 "/" p+f}')"
git -C "$r" revert --no-edit HEAD >/dev/null
after_tree="$(git -C "$r" rev-parse HEAD^{tree})"
expected_added="test/csv-quoting.test.ts test/orders-roundtrip.test.ts "
revert_ok=true
[[ "$before_tree" == "$after_tree" ]] || { bad "revert tree $after_tree != starting tree $before_tree"; revert_ok=false; }
[[ "$added" == "$expected_added" ]] || { bad "fix commit added '$added', expected '$expected_added'"; revert_ok=false; }
[[ "$fix_tests_pass" == "12/12" ]] || { bad "fix commit's tests: $fix_tests_pass"; revert_ok=false; }

{
  echo "| workload | variant | start commit | hidden tests passed | failed | hidden-tests gate | api-load gate | api p95 | workspace's own tests |"
  echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  printf '%s\n' "${rows[@]}"
  echo
  echo "Planted-bug check (bug-hunt, synthetic history): fix commit added \`${added% }\`, its tests passed $fix_tests_pass, and \`git revert\` of it gives tree \`${after_tree:0:12}\` = starting tree \`${before_tree:0:12}\`: $revert_ok."
} > "$OUT/summary.md"
cat "$OUT/summary.md"
if [[ "$fail" == 0 ]]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
echo "$fail" > "$OUT/exit_code"
exit "$fail"
