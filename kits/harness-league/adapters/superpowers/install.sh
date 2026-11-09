#!/usr/bin/env bash
# L1 install (snapshot build) for the superpowers contender (TDM-227 [21.1]): pinned Claude Code,
# then Superpowers as a Claude Code plugin, the way its README installs it for Claude Code
# (`/plugin install superpowers@<marketplace>`), through Claude Code's own CLI
# (`claude plugin marketplace add` / `claude plugin install`, user scope), at a pinned release.
#
# Pin: the README's two marketplaces do not give an exact, current release. The official
# marketplace (anthropics/claude-plugins-official) pins superpowers at sha bb92a777 (v7.0.0), and
# obra/superpowers-marketplace points at the default branch (no pin). The superpowers repo itself
# ships a marketplace manifest (.claude-plugin/marketplace.json, name superpowers-dev, source ./),
# so the marketplace added here is the repo at the release commit (v7.0.2): the same plugin, the
# same install mechanism, exact bytes.
#
# "~" is this contender's own home, $HOME/.anybench/homes/superpowers (adapters/tool-home/driver.sh
# says why). The README prescribes no CLAUDE.md text (the plugin's SessionStart hook loads its
# using-superpowers skill), so adapters/superpowers/CLAUDE.md has only the lines every setup gets.
#
# CLAUDE_CODE_VERSION and SUPERPOWERS_COMMIT pin it; the defaults must equal contenders[].versions
# in anybench.yaml (a kit test checks it). Runs as root with HOME kept (the env build chowns the
# home back to the eval user).
set -euo pipefail
commit="${SUPERPOWERS_COMMIT:-22f0b463e7a5e579904dd6211a520321035526f7}"
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-2.1.319}"

tool_home="$HOME/.anybench/homes/superpowers"
src="$tool_home/.anybench-src/superpowers"
rm -rf "$src"
mkdir -p "$src"
git -C "$src" init -q -b main
git -C "$src" remote add origin https://github.com/obra/superpowers.git
git -C "$src" fetch -q --depth 1 origin "$commit"
git -C "$src" reset -q --hard FETCH_HEAD
[[ "$(git -C "$src" rev-parse HEAD)" == "$commit" ]]
touch "$tool_home/.anybench-tool-home"

export HOME="$tool_home"
claude plugin marketplace add "$src" < /dev/null
claude plugin install superpowers@superpowers-dev --scope user < /dev/null
claude plugin list < /dev/null || true
