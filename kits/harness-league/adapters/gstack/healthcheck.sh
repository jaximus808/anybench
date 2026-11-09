#!/usr/bin/env bash
# L1 health check for the gstack contender, as the eval user: the tools every trial needs (as
# adapters/claude-code/healthcheck.sh), the pinned Bun, gstack at the pinned commit in its own home
# with its skills linked where Claude Code reads them, its bundled Chromium launching, the update
# check off, and nothing of gstack's in the eval user's real ~/.claude (so the other setups'
# trials never load it).
set -euo pipefail
commit="${GSTACK_COMMIT:-910093087dec4877f99dfaed6600784942ed7a7b}"
tool_home="$HOME/.anybench/homes/gstack"
dir="$tool_home/.claude/skills/gstack"
claude --version >/dev/null
node -e 'if (!process.features.typescript) process.exit(1)'   # Node 22.18+ type stripping
git --version >/dev/null
[[ "$(bun --version)" == "${BUN_VERSION:-1.4.2}" ]] || { echo "bun $(bun --version), want ${BUN_VERSION:-1.4.2}" >&2; exit 1; }
[[ -f "$tool_home/.anybench-tool-home" ]] || { echo "$tool_home is not a tool home" >&2; exit 1; }
[[ "$(git -C "$dir" rev-parse HEAD)" == "$commit" ]] || { echo "gstack at $(git -C "$dir" rev-parse HEAD), want $commit" >&2; exit 1; }
[[ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ]] || { echo "gstack checkout has local changes" >&2; exit 1; }
# Skills where Claude Code looks: the router and the workflow skills next to it (flat names).
for s in gstack review ship qa office-hours; do
  [[ -f "$tool_home/.claude/skills/$s/SKILL.md" ]] || { echo "skill $s is not installed in $tool_home/.claude/skills" >&2; exit 1; }
done
[[ "$(HOME="$tool_home" "$dir/bin/gstack-config" get update_check)" == false ]] || { echo "gstack update_check is not false" >&2; exit 1; }
HOME="$tool_home" "$dir/bin/gstack-browser-ensure" --check --quiet
[[ ! -e "$HOME/.claude/skills" && ! -e "$HOME/.gstack" ]] || { echo "gstack leaked into the real home ($HOME)" >&2; exit 1; }
echo "gstack $(cat "$dir/VERSION") at $commit; $(ls "$tool_home/.claude/skills" | wc -l | tr -d ' ') skill entries; bun $(bun --version)"
