#!/usr/bin/env bash
# tandem: the pinned server binary (sha256 from the release's SHA256SUMS), the paired MCP
# gateway installed globally, and the gateway warmed into the npx cache of the home's owner and
# of the eval user, so `npx --offline -y @jaximus/tandem-mcp@<pin>` (what an .mcp.json runs)
# never hits the network during a trial.
set -euo pipefail
. "$RECIPE_LIB"

bin="$ANYBENCH_TANDEM_HOME/tandem"
if [ -x "$bin" ] && [ "$(sha256_of "$bin")" = "$RECIPE_SHA256" ]; then
  log "binary already at $bin"
else
  scratch
  fetch_verified "$RECIPE_URL" "$RECIPE_SHA256" "$SCRATCH/tandem"
  as_root mkdir -p "$ANYBENCH_TANDEM_HOME"
  as_root install -m 0755 "$SCRATCH/tandem" "$bin.tmp"
  as_root mv "$bin.tmp" "$bin"
fi
link_bin "$bin" tandem

mcp="$ANYBENCH_TANDEM_MCP_HOME"
if [ -x "$mcp/bin/tandem-mcp" ] && "$mcp/bin/tandem-mcp" --version 2>/dev/null | grep -qF "$TANDEM_MCP_VERSION"; then
  log "tandem-mcp already at $mcp"
else
  as_root rm -rf "$mcp"
  npm_root_install "$mcp" "@jaximus/tandem-mcp@$TANDEM_MCP_VERSION"
  as_root chmod -R a+rX "$mcp"
fi
link_bin "$mcp/bin/tandem-mcp" tandem-mcp

# Warm npx for the home's owner (the exec user on Naïve; `naive` on docker-local, where exec is
# root) and for the eval user. Never as root: that would leave a root-owned ~/.npm behind.
for u in $(printf '%s\n' "$(stat -c %U "$HOME")" "$EVAL_USER" | sort -u); do
  [ "$u" = root ] && continue
  as_user "$u" npx -y "@jaximus/tandem-mcp@$TANDEM_MCP_VERSION" --version </dev/null >/dev/null
  log "npx cache warmed for $u"
done
log "tandem $TANDEM_VERSION + tandem-mcp $TANDEM_MCP_VERSION installed"
