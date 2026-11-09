#!/usr/bin/env bash
# L2 driver for the skill-pack contenders (gstack, superpowers), type coding-agent: the shared
# adapters/claude-code/driver.sh (byte-identical to kits/tandem-long-horizon's, so A and these
# setups run the same driver), started with HOME set to the contender's own home, through
# adapters/headless-policy/driver.sh, the same headless policy A and B run under (TDM-228).
#
#   driver.sh run <task> <workspace>
#
# Why a home of its own: one env snapshot serves every contender of the kit, and each skill pack's
# install writes the user-level Claude Code config its README prescribes (~/.claude/skills,
# ~/.claude/plugins, hooks in ~/.claude/settings.json, the tool's own state such as ~/.gstack).
# Installed into the eval user's real home, those would load in every other contender's trial too.
# So each install.sh runs the tool's documented install with HOME=$HOME/.anybench/homes/<tool>,
# and this driver points HOME there for that contender only. Claude Code, the Bash tool and the
# tool's own scripts then see exactly the layout the README describes (~ is that home).
#
# Env (from the kit): CC_TOOL_HOME (required) names the home under ~/.anybench/homes/; everything
# else (CC_SETUP, CC_MODEL, AB_TOKEN_SOURCE, ...) is the shared driver's.
set -euo pipefail
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="${CC_TOOL_HOME:?CC_TOOL_HOME is not set: the kit names the contender home in driver.env}"
[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "CC_TOOL_HOME must be a plain name, got '$name'" >&2; exit 2; }
case "${1:-run}" in start|ready|stop) exit 0 ;; esac
tool_home="$HOME/.anybench/homes/$name"
[[ -f "$tool_home/.anybench-tool-home" ]] ||
  { echo "$tool_home is not an installed tool home (adapters/$name/install.sh did not run)" >&2; exit 2; }
# The secrets file and the runner's paths are absolute; git identity, if the image has one, follows.
[[ -f "$HOME/.gitconfig" && ! -e "$tool_home/.gitconfig" ]] && cp "$HOME/.gitconfig" "$tool_home/.gitconfig"
export HOME="$tool_home"
exec "$kit/adapters/headless-policy/driver.sh" "$@"
