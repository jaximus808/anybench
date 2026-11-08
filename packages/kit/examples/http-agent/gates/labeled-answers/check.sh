#!/usr/bin/env bash
# L5 gate: labeled answers. Runs on the scoring computer in its own process and never talks to
# the agent: it scores the frozen transcripts against the labels in the conversation files.
# Usage: check.sh <frozen-out> <workload-id> <gate.json>
set -euo pipefail
out="${1:?out}" workload="${2:?workload}" verdict="${3:?gate.json}"
kit="$(cd "$(dirname "$0")/../.." && pwd)"
"${ANYBENCH_HTTP_AGENT:-anybench-http-agent}" gate \
  --conversations "$kit/workloads/$workload/conversations" --out "$out" --verdict "$verdict"
