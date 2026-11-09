#!/usr/bin/env bash
# Runs inside the node:22 container started by verify-proof.sh (kit at $KIT, read-only; results to
# $PROOF_OUT). For each workload (project-tracker, then project-tracker-xl; PROOF_WORKLOADS narrows
# it) it builds a fresh workspace with setup.sh, then:
#   oracle      proof/oracle/driver.sh, then the hidden-tests gate: must pass every hidden test
#               (120/120, 600/600), and the solution's own `npm test` must pass. Repeated
#               ORACLE_REPEATS times (default 3), each on a fresh workspace, so a flaky test or a
#               timing-dependent oracle shows up.
#   do-nothing  proof/do_less/do-nothing/driver.sh, then the gate: under 1% of the hidden tests may
#               pass, and only the GET /health one (the skeleton serves /health and nothing else).
#               The starting repo's own tests must pass (it is a working repo, just missing the app).
#   partial-oracle  proof/do_less/partial-oracle/driver.sh (the oracle with the webhooks area cut
#               out, TDM-233 / TDM-238), then the gate: it must FAIL, every webhooks test must fail,
#               and at least PARTIAL_MIN hidden tests must still pass (a near miss, not an empty repo).
# The oracle may not add dependencies or touch the 1.x fixture (checked on its diff).
#
# The gate runs under the gate runner's convention (packages/bench gate.ts, TDM-51):
# `check.sh <frozen-out> <workload-id> <gate.json>`, contender code through $AB_RUN in $AB_RUN_DIR
# (a copy of the outputs, with workspace/ in it). Here $AB_RUN is scripts/ab-run-local.sh (clean
# env, no uid switch), and each gate run gets its own fresh copy, as on a scoring computer.
set -uo pipefail
KIT="${KIT:-/kit}"
OUT="${PROOF_OUT:-/out}"
WORKLOADS="${PROOF_WORKLOADS:-project-tracker project-tracker-xl}"
REPEATS="${ORACLE_REPEATS:-3}"
HEALTH_TEST="GET /health answers { ok: true } without auth and carries no rate-limit headers"
mkdir -p "$OUT"
fail=0
bad() { printf 'FAIL: %s\n' "$*"; fail=1; }

export AB_RUN="$KIT/scripts/ab-run-local.sh"
# run_gate <workload> <workspace> <dir>: <dir>/out (frozen-out), <dir>/gate.json (verdict).
run_gate() {
  local w="$1" ws="$2" d="$3"
  mkdir -p "$d/out" "$d/run" "$d/home"
  cp -R "$ws" "$d/run/workspace"
  AB_RUN_DIR="$d/run" AB_RUN_HOME="$d/home" "$KIT/gates/hidden-tests/check.sh" "$d/out" "$w" "$d/gate.json"
}
count() { node -e 'const s=require(process.argv[1]); console.log(`${s.passed} ${s.failed} ${s.total}`)' "$1"; }
passing() { node -e 'for (const t of require(process.argv[1]).tests) if (t.status === "pass") console.log(t.name)' "$1"; }
# area_passing <workload> <summary> <area>: hidden tests of that area (tests.json) that passed
area_passing() {
  node -e 'const s = require(process.argv[1]), t = require(process.argv[2]);
    const area = new Map(t.tests.map((x) => [x.name, x.area]));
    for (const x of s.tests) if (x.status === "pass" && area.get(x.name) === process.argv[3]) console.log(x.name)' \
    "$2" "$KIT/gates/hidden-tests/$1/tests.json" "$3"
}
own_tests() { # prints "pass fail" of the workspace's own test suite
  (cd "$1" && node --test --test-reporter=tap "test/**/*.test.ts" 2>/dev/null | awk '/^# pass /{p=$3} /^# fail /{f=$3} END{print p+0, f+0}')
}

echo "node $(node --version), git $(git --version | awk '{print $3}'), network: $(node -e 'require("dns").lookup("registry.npmjs.org",e=>console.log(e?"none":"UP"))')"
: > "$OUT/summary.md"
for W in $WORKLOADS; do
  TOTAL="$(node -p 'require(process.argv[1]).tests.length' "$KIT/gates/hidden-tests/$W/tests.json")"
  case "$W" in
    project-tracker) PARTIAL_MIN=100 ;;
    *) PARTIAL_MIN=$((TOTAL * 4 / 5)) ;;
  esac
  rows=()
  oracle_files="" dn_pass="" po_failed=""
  runs=()
  for ((i = 1; i <= REPEATS; i++)); do runs+=("oracle:$i"); done
  runs+=("do-nothing:1" "partial-oracle:1")
  for run in "${runs[@]}"; do
    variant="${run%%:*}" n="${run##*:}"
    ws="$(mktemp -d)/ws"
    "$KIT/workloads/$W/setup.sh" "$ws" > /dev/null || { bad "$W setup.sh failed"; continue; }
    start_commit="$(git -C "$ws" rev-parse --short HEAD)"
    if [[ "$variant" == oracle ]]; then
      WORKLOAD="$W" EVAL_WS="$ws" "$KIT/proof/oracle/driver.sh" run "$KIT/workloads/$W/instruction.md" "$ws" || bad "$W oracle driver failed"
    else
      WORKLOAD="$W" EVAL_WS="$ws" "$KIT/proof/do_less/$variant/driver.sh" run "$KIT/workloads/$W/instruction.md" "$ws" || bad "$W $variant driver failed"
    fi
    changed="$(git -C "$ws" status --porcelain --untracked-files=all | cut -c4- | sort | tr '\n' ' ')"
    o="$OUT/$W/$variant/$n"
    mkdir -p "$o"
    t0="$(date +%s)"
    run_gate "$W" "$ws" "$o/hidden-tests" > "$o/hidden-tests.stdout" 2>&1 || bad "$W $variant #$n hidden-tests grader error"
    secs="$(($(date +%s) - t0))"
    read -r passed failed total < <(count "$o/hidden-tests/out/hidden-tests.json")
    gate="$(node -p 'require(process.argv[1]).pass' "$o/hidden-tests/gate.json")"
    read -r own_pass own_fail < <(own_tests "$ws")
    rows+=("| $variant | $n | $start_commit | $passed/$total | $failed | $gate | ${secs} s | $own_pass pass, $own_fail fail |")
    echo "$W $variant #$n: $passed/$total, gate $gate, ${secs} s, own tests $own_pass pass $own_fail fail"
    # An oracle miss names its failing tests (and their first error line), so a flake can be traced.
    if [[ "$variant" == oracle && "$passed" != "$total" ]]; then
      node -e 'for (const t of require(process.argv[1]).tests) if (t.status !== "pass") console.log(`  miss: ${t.file} :: ${t.name} :: ${String(t.error ?? "").split("\n")[0].slice(0, 200)}`)' \
        "$o/hidden-tests/out/hidden-tests.json"
    fi
    if [[ "$variant" == oracle ]]; then
      [[ "$passed" == "$total" && "$total" == "$TOTAL" && "$gate" == true ]] || bad "$W oracle #$n passed $passed/$total hidden tests"
      [[ "$own_fail" == 0 && "$own_pass" -gt 0 ]] || bad "$W oracle #$n own tests: $own_pass pass, $own_fail fail"
      [[ " $changed " != *" package.json "* && " $changed " != *" fixtures/tracker-v1.json "* ]] ||
        bad "$W oracle changes package.json or the 1.x fixture: $changed"
      oracle_files="$changed"
    elif [[ "$variant" == partial-oracle ]]; then
      [[ "$gate" == false && "$total" == "$TOTAL" && "$passed" -lt "$total" && "$passed" -ge "$PARTIAL_MIN" ]] ||
        bad "$W partial-oracle passed $passed/$total hidden tests (gate $gate): want a failing gate with at least $PARTIAL_MIN passing"
      po_webhooks="$(area_passing "$W" "$o/hidden-tests/out/hidden-tests.json" webhooks)"
      [[ -z "$po_webhooks" ]] || bad "$W partial-oracle passed webhooks tests without the webhook routes: $po_webhooks"
      po_failed="$failed"
    else
      [[ -z "$changed" ]] || bad "$W do-nothing changed the workspace: $changed"
      [[ "$total" == "$TOTAL" && "$((passed * 100))" -lt "$total" && "$gate" == false ]] || bad "$W do-nothing passed $passed/$total hidden tests"
      dn_pass="$(passing "$o/hidden-tests/out/hidden-tests.json")"
      [[ -z "$dn_pass" || "$dn_pass" == "$HEALTH_TEST" ]] || bad "$W do-nothing passed tests other than /health: $dn_pass"
      [[ "$own_fail" == 0 && "$own_pass" -gt 0 ]] || bad "$W starting repo's own tests: $own_pass pass, $own_fail fail"
    fi
  done
  {
    echo "### $W"
    echo
    echo "| variant | run | start commit | hidden tests passed | failed | hidden-tests gate | gate time | workspace's own tests |"
    echo "| --- | --- | --- | --- | --- | --- | --- | --- |"
    printf '%s\n' "${rows[@]}"
    echo
    echo "Files the oracle overlay adds or changes: \`${oracle_files% }\`."
    echo
    if [[ -n "${dn_pass:-}" ]]; then echo "Hidden tests do-nothing passes: \`$dn_pass\`."; else echo "Hidden tests do-nothing passes: none."; fi
    echo
    echo "partial-oracle (the oracle without the webhooks area) fails ${po_failed:-?} hidden tests, every webhooks test among them."
    echo
  } >> "$OUT/summary.md"
done
cat "$OUT/summary.md"
if [[ "$fail" == 0 ]]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
echo "$fail" > "$OUT/exit_code"
exit "$fail"
