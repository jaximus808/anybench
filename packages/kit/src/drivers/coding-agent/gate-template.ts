// TDM-39 [4.7]: `gates/<id>/check.sh` for the hidden-tests gate of a coding agent.
//
// Runs only on the scoring computer, under the gate runner's contract (TDM-51):
//   check.sh <frozen-out> <workload-id> <gate.json>
// with `$AB_RUN` (run a command as the contender uid) and `$AB_RUN_DIR` (that uid's own copy of
// the frozen outputs). The hidden tests live in the kit at `gates/<id>/<workload>/` and never
// reached the subject computer; they are copied into `$AB_RUN_DIR/workspace/.hidden-tests/`
// (replacing anything the contender put there) and run there through `$AB_RUN`, so contender
// code never shares the check's uid. The TAP summary decides: pass only when the test command
// exits 0, no test failed, and at least `min_tests` passed.
//
// Exit status: 0 whenever a verdict was written (pass or fail); 2 for a usage or kit error (bad
// workload id, no hidden tests for it, no $AB_RUN), with no verdict.
import { CLI_SCRIPT_SHEBANG, shQuote } from "../cli/shell.js";
import { CODING_AGENT_GENERATED_MARKER } from "./claude-code.js";
import { CodingAgentGateTemplateSchema, type CodingAgentGateTemplateInput } from "./options.js";
import { CODING_AGENT_OUTPUT_PATHS as P } from "./outputs.js";

const BODY = `usage() { echo "check.sh: $*" >&2; exit 2; }
[ "$#" -eq 3 ] || usage "usage: check.sh <frozen-out> <workload-id> <gate.json>"
out="$1" workload="$2" verdict="$3"
printf '%s' "$workload" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,63}$' || usage "bad workload id: $workload"
[ -d "$out" ] || usage "frozen outputs not found: $out"
tests="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/$workload"
[ -d "$tests" ] || usage "no hidden tests for workload $workload (gates/$gate_id/$workload/)"
[ -n "\${AB_RUN:-}" ] || usage "AB_RUN is not set: contender code would run as the check's uid"
[ -n "\${AB_RUN_DIR:-}" ] && [ -d "$AB_RUN_DIR" ] || usage "AB_RUN_DIR is not a directory"
log="$out/$gate_id.tap"

json_str() { printf '"%s"' "$(printf '%s' "$1" | tr -d '\\000-\\037' | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')"; }
write_verdict() {
  printf '{"pass":%s,"reason":%s,"evidence":[%s]}\\n' "$1" "$(json_str "$2")" "$3" > "$verdict.tmp"
  mv "$verdict.tmp" "$verdict"
}
# From here on the outputs are involved: whatever they make go wrong is a FAIL verdict, never a
# verdict-less exit (which would read as a broken check).
fail_closed() {
  local rc=$?
  [ -s "$verdict" ] || write_verdict false "$gate_id: the hidden tests could not run on these outputs (exit $rc)" ""
  exit 0
}
trap fail_closed EXIT

ws="$AB_RUN_DIR/${P.workspace}"
if [ -L "$ws" ] || [ ! -d "$ws" ]; then
  write_verdict false "$gate_id: the outputs have no ${P.workspace}/ (the driver did not freeze one)" ""
  exit 0
fi
# The contender may have shipped its own .hidden-tests (a file, a symlink, fake tests): replace it.
rm -rf "$ws/.hidden-tests"
cp -R "$tests" "$ws/.hidden-tests"
# The kit is readable by the check uid only; the contender uid must read its copy.
chmod -R a+rX "$ws/.hidden-tests"
rc=0
(cd "$ws" && "$AB_RUN" bash -c "$test_command" < /dev/null > "$log" 2>&1) || rc=$?

count() { awk -v k="$1" '$1 == "#" && $2 == k && $3 ~ /^[0-9]+$/ { n = $3 } END { print n + 0 }' "$log"; }
passed="$(count pass)" failed="$(count fail)" total="$(count tests)"
evidence='"'"$gate_id"'.tap"'
if [ "$rc" -eq 0 ] && [ "$failed" -eq 0 ] && [ "$passed" -ge "$min_tests" ] && [ "$passed" -eq "$total" ]; then
  write_verdict true "$gate_id: $passed/$total hidden tests pass on $workload" "$evidence"
elif [ "$total" -eq 0 ]; then
  write_verdict false "$gate_id: no hidden test reported on $workload (exit $rc)" "$evidence"
else
  write_verdict false "$gate_id: $passed/$total hidden tests pass on $workload ($failed failed, exit $rc)" "$evidence"
fi
`;

/** Render `gates/<gate_id>/check.sh` for a hidden-tests gate over a frozen coding-agent workspace. */
export function renderCodingAgentGateScript(input: CodingAgentGateTemplateInput): string {
  const g = CodingAgentGateTemplateSchema.parse(input);
  return [
    CLI_SCRIPT_SHEBANG,
    `# L5 gate '${g.gate_id}' (kind: hidden-tests) for driver.type: coding-agent.`,
    `# ${CODING_AGENT_GENERATED_MARKER} renderCodingAgentGateScript (TDM-39): regenerate it, do not edit by hand.`,
    "#",
    "# Usage: check.sh <frozen-out> <workload-id> <gate.json>   (env: AB_RUN, AB_RUN_DIR from the gate runner)",
    `# Runs only on the scoring computer. The hidden tests are gates/${g.gate_id}/<workload>/ in the kit; they`,
    `# run as the contender uid ("$AB_RUN") in its copy of ${P.workspace}/, never as this script's uid.`,
    "# Exit 0 = a verdict was written (pass or fail). Exit 2 = usage or kit error, no verdict.",
    "set -euo pipefail",
    "export LC_ALL=C",
    "",
    `gate_id=${shQuote(g.gate_id)}`,
    `test_command=${shQuote(g.test_command)}`,
    `min_tests=${g.min_tests}`,
    "",
    BODY,
  ].join("\n");
}
