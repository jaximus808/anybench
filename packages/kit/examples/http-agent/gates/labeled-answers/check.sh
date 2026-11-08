#!/usr/bin/env bash
# L5 gate: labeled answers. Runs on the scoring computer in its own process and never talks to
# the agent: it scores the frozen transcripts against the labels in reference/<workload>/, which
# are never copied to the agent's computer. It fails closed (no labels, a missing label, a label
# with no input: pass false). Usage: check.sh <frozen-out> <workload-id> <gate.json>
set -euo pipefail
out="${1:?out}" workload="${2:?workload}" verdict="${3:?gate.json}"
kit="$(cd "$(dirname "$0")/../.." && pwd)"
"${ANYBENCH_HTTP_AGENT:-anybench-http-agent}" gate \
  --conversations "$kit/workloads/$workload/conversations" \
  --labels "$kit/gates/labeled-answers/reference/$workload" \
  --out "$out" --verdict "$verdict"
