#!/usr/bin/env bash
# playwright: the pinned npm package in its own prefix, then `playwright install --with-deps
# chromium`, which apt-installs Chromium's libraries and downloads the Chromium build pinned by
# this Playwright release into PLAYWRIGHT_BROWSERS_PATH (readable by every user).
set -euo pipefail
. "$RECIPE_LIB"

dest="$ANYBENCH_PLAYWRIGHT_HOME"
pw="$dest/lib/node_modules/playwright/cli.js"
if [ -f "$pw" ] && [ "$("$NODE_HOME/bin/node" "$pw" --version)" = "Version $PLAYWRIGHT_VERSION" ]; then
  log "playwright already at $dest"
else
  as_root rm -rf "$dest"
  npm_root_install "$dest" "playwright@$PLAYWRIGHT_VERSION"
fi
have apt-get || die "playwright --with-deps needs apt-get"
(cd / && as_root env HOME=/root DEBIAN_FRONTEND=noninteractive \
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" PATH="$NODE_HOME/bin:$PATH" \
  "$NODE_HOME/bin/node" "$pw" install --with-deps --only-shell chromium)
as_root chmod -R a+rX "$dest" "$PLAYWRIGHT_BROWSERS_PATH"
log "playwright $PLAYWRIGHT_VERSION + chromium installed"
