#!/usr/bin/env bash
# L1 install: snapshot build. Installs Claude Code and the Tandem CLI at the pinned ref.
set -euo pipefail
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:?set in contenders[].versions}"
git clone --depth 1 https://github.com/jaximus808/tandem /opt/tandem
(cd /opt/tandem && npm ci && npm run build && npm link)
