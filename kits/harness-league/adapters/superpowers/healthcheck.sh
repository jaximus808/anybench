#!/usr/bin/env bash
# L1 health check for the superpowers contender, as the eval user: the tools every trial needs (as
# adapters/claude-code/healthcheck.sh), the Superpowers plugin installed and enabled at the pinned
# release in its own home, and nothing of it in the eval user's real ~/.claude.
set -euo pipefail
commit="${SUPERPOWERS_COMMIT:-22f0b463e7a5e579904dd6211a520321035526f7}"
version="${SUPERPOWERS_VERSION:-7.0.2}"
tool_home="$HOME/.anybench/homes/superpowers"
claude --version >/dev/null
node -e 'if (!process.features.typescript) process.exit(1)'   # Node 22.18+ type stripping
git --version >/dev/null
[[ -f "$tool_home/.anybench-tool-home" ]] || { echo "$tool_home is not a tool home" >&2; exit 1; }
src="$tool_home/.anybench-src/superpowers"
[[ "$(git -C "$src" rev-parse HEAD)" == "$commit" ]] || { echo "superpowers source at $(git -C "$src" rev-parse HEAD), want $commit" >&2; exit 1; }
node -e '
  const fs = require("fs"), home = process.argv[1], want = process.argv[2];
  const s = JSON.parse(fs.readFileSync(home + "/.claude/settings.json", "utf8"));
  if (s.enabledPlugins?.["superpowers@superpowers-dev"] !== true) throw new Error("superpowers@superpowers-dev is not enabled");
  const inst = JSON.parse(fs.readFileSync(home + "/.claude/plugins/installed_plugins.json", "utf8"));
  const rows = [].concat(inst.plugins?.["superpowers@superpowers-dev"] ?? []);
  if (!rows.some((r) => r.version === want)) throw new Error("installed: " + JSON.stringify(rows) + ", want version " + want);
  const p = rows.find((r) => r.version === want).installPath;
  for (const f of ["skills/using-superpowers/SKILL.md", "hooks/hooks.json"])
    if (!fs.existsSync(p + "/" + f)) throw new Error(p + "/" + f + " is missing");
  console.log("superpowers " + want + " enabled at " + p);
' "$tool_home" "$version"
[[ ! -e "$HOME/.claude/plugins" && ! -e "$HOME/.claude/settings.json" ]] || { echo "a plugin leaked into the real home ($HOME)" >&2; exit 1; }
