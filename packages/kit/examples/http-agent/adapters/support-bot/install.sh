#!/usr/bin/env bash
# L1 install. The stub agent has no dependencies; it needs Node >= 22.6 (type stripping) and the
# anybench-http-agent command (from @anybench/kit) that posts the conversation set.
set -euo pipefail
node --version
command -v "${ANYBENCH_HTTP_AGENT:-anybench-http-agent}" > /dev/null
