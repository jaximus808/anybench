#!/usr/bin/env bash
set -euo pipefail
claude --version >/dev/null
npx --offline -y "@jaximus/tandem-mcp@${TANDEM_MCP_VERSION:-latest}" --help >/dev/null
node -e 'if (!process.features.typescript) process.exit(1)'
git --version >/dev/null
