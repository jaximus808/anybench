#!/usr/bin/env bash
# L7 do-less overlay (kind partial-oracle, TDM-233): the reference solution with work missing, so
# the proof shows the gate refuses a near miss, not just an empty repo. Replaces the contender's
# driver; no agent runs.
#
#   driver.sh run <task> <workspace>      (WORKLOAD or EVAL_WORKLOAD names the workload)
#
#   project-tracker     proof/oracle/project-tracker/ with feature area 8 (webhooks, its 9 routes)
#                       cut out of src/app.ts. Every webhooks hidden test fails, so the gate fails;
#                       the other areas still pass.
#   project-tracker-xl  the v1 oracle (proof/oracle/project-tracker/) as is: 12 of xl's 33 areas.
#
# Fails (exit 2) when the cut does not apply, so a changed oracle can't silently turn this
# overlay into the full oracle.
set -euo pipefail
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
verb="${1:-run}"
case "$verb" in
  start|ready|stop) exit 0 ;;
  run) ;;
  *) echo "unknown verb '$verb'" >&2; exit 2 ;;
esac
task="${2:-}"
ws="${3:-${EVAL_WS:?EVAL_WS is not set}}"
workload="${WORKLOAD:-${EVAL_WORKLOAD:?WORKLOAD is not set}}"
case "$workload" in
  project-tracker)
    WORKLOAD=project-tracker "$kit/proof/oracle/driver.sh" run "$task" "$ws"
    node - "$ws/src/app.ts" <<'JS'
const fs = require("node:fs");
const file = process.argv[2];
const src = fs.readFileSync(file, "utf8");
const from = "  // ---- 8. webhooks\n";
const to = "  // ---- 11. audit log\n";
const a = src.indexOf(from);
const b = src.indexOf(to);
if (a < 0 || b <= a || src.indexOf(from, a + 1) >= 0 || src.indexOf(to, b + 1) >= 0) {
  console.error(`partial-oracle: the webhooks section markers are not in ${file} exactly once`);
  process.exit(2);
}
const cut = src.slice(a, b);
if (!/route\("POST", "\/teams\/:teamId\/webhooks"/.test(cut)) {
  console.error("partial-oracle: the cut does not hold the webhook routes");
  process.exit(2);
}
fs.writeFileSync(file, src.slice(0, a) + "  // ---- 8. webhooks: cut by proof/do_less/partial-oracle\n\n" + src.slice(b));
JS
    ;;
  project-tracker-xl)
    WORKLOAD=project-tracker "$kit/proof/oracle/driver.sh" run "$task" "$ws"
    ;;
  *) echo "no partial oracle for workload '$workload'" >&2; exit 2 ;;
esac
