#!/usr/bin/env bash
# L1 health check: the tools every trial needs are on PATH.
set -euo pipefail
claude --version >/dev/null
node -e 'if (!process.features.typescript) process.exit(1)'   # Node 22.18+ type stripping
git --version >/dev/null
