#!/usr/bin/env bash
# claude-code: `npm install -g @anthropic-ai/claude-code@<pin>` into its own root-owned prefix.
# The package's postinstall puts the platform's native binary (an optional dependency, checked
# against the registry's sha512 integrity by npm) at bin/claude. The version is exact (rule: no
# floating tags): 2.1.319 is the build TDM-16 verified end to end against Naïve's Anthropic proxy.
set -euo pipefail
. "$RECIPE_LIB"

dest="$ANYBENCH_CLAUDE_CODE_HOME"
want="$CLAUDE_CODE_VERSION (Claude Code)"
if [ -x "$dest/bin/claude" ] && [ "$("$dest/bin/claude" --version 2>/dev/null)" = "$want" ]; then
  log "already installed at $dest"
else
  as_root rm -rf "$dest"
  npm_root_install "$dest" "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"
  as_root chmod -R a+rX "$dest"
fi
link_bin "$dest/bin/claude" claude
log "$("$dest/bin/claude" --version) installed"
