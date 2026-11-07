#!/usr/bin/env bash
# L1 install: snapshot build. Installs Claude Code and the Tandem CLI at the pinned ref.
set -euo pipefail
npm install -g @anthropic-ai/claude-code
git clone --depth 1 https://github.com/jaximus808/tandem /opt/tandem
(cd /opt/tandem && npm ci && npm run build && npm link)
