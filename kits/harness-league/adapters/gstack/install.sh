#!/usr/bin/env bash
# L1 install (snapshot build) for the gstack contender (TDM-227 [21.1]): pinned Claude Code, the
# Bun gstack's README requires, then gstack exactly as its README installs it, at a pinned commit:
#
#   git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
#   cd ~/.claude/skills/gstack && ./setup
#
# "~" is this contender's own home, $HOME/.anybench/homes/gstack (adapters/tool-home/driver.sh
# says why: one snapshot serves every contender, so gstack's skills, hooks and ~/.gstack state must
# not load in the other setups' trials). The clone is the pinned commit on a branch named main with
# origin/main at the same commit, i.e. what the README's depth-1 clone gave on release day.
# ./setup runs without a terminal, so it takes its documented non-interactive defaults (flat skill
# names, no plan-tune hooks, the default Stop hook). On Linux the README's browser skills use
# gstack's bundled Chromium; ./setup downloads it, but a bare image lacks the system libraries it
# needs, so gstack's own `bin/gstack-browser-ensure --with-deps` (documented for this) installs
# them. One setting is changed, to keep the pin:
# update_check false (gstack-config's documented key: no "upgrade available" prompts mid-trial;
# auto_upgrade and telemetry are already off by default).
#
# CLAUDE_CODE_VERSION, BUN_VERSION and GSTACK_COMMIT pin it; the defaults must equal
# contenders[].versions in anybench.yaml (a kit test checks it). Runs as root with HOME kept (the
# env build chowns the home back to the eval user).
set -euo pipefail
commit="${GSTACK_COMMIT:-910093087dec4877f99dfaed6600784942ed7a7b}"
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-2.1.319}"
# gstack's README: Bun v1.4.2+ (the tested version; bin/gstack-bun-version.sh GSTACK_BUN_TESTED).
npm install -g --no-audit --no-fund "bun@${BUN_VERSION:-1.4.2}"

tool_home="$HOME/.anybench/homes/gstack"
dir="$tool_home/.claude/skills/gstack"
# The pinned Bun must win over any Bun the image already has on PATH (a Naïve trial computer
# ships Bun 1.3.x ahead of npm's global bin). Link npm's Bun into this home's bin, which
# healthcheck.sh and adapters/tool-home/driver.sh put first on PATH for this contender only.
mkdir -p "$tool_home/bin"
ln -sf "$(npm prefix -g)/bin/bun" "$tool_home/bin/bun"
export PATH="$tool_home/bin:$PATH"
[[ "$(bun --version)" == "${BUN_VERSION:-1.4.2}" ]] || { echo "bun $(bun --version) after install, want ${BUN_VERSION:-1.4.2}" >&2; exit 1; }
rm -rf "$dir"
mkdir -p "$dir"
git -C "$dir" init -q -b main
git -C "$dir" remote add origin https://github.com/garrytan/gstack.git
git -C "$dir" fetch -q --depth 1 origin "$commit"
git -C "$dir" update-ref refs/remotes/origin/main FETCH_HEAD
git -C "$dir" reset -q --hard FETCH_HEAD
git -C "$dir" branch -q --set-upstream-to=origin/main main
[[ "$(git -C "$dir" rev-parse HEAD)" == "$commit" ]]
touch "$tool_home/.anybench-tool-home"

(cd "$dir" && HOME="$tool_home" ./setup < /dev/null)
HOME="$tool_home" "$dir/bin/gstack-browser-ensure" --with-deps
HOME="$tool_home" "$dir/bin/gstack-config" set update_check false
echo "update_check: $(HOME="$tool_home" "$dir/bin/gstack-config" get update_check)"
echo "gstack $(cat "$dir/VERSION")"
