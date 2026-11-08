#!/usr/bin/env bash
# eval-user: create the unprivileged user agents run as. No sudo, no extra groups: a trial's
# agent must not be able to change the computer outside its own home and workspace.
set -euo pipefail
. "$RECIPE_LIB"

u="$ANYBENCH_EVAL_USER"
h="$ANYBENCH_EVAL_HOME"
if id -u "$u" >/dev/null 2>&1; then
  log "user $u already exists"
else
  as_root useradd --create-home --home-dir "$h" --shell /bin/bash --user-group "$u"
fi
as_root chmod 0755 "$h"
log "user $u: $(id "$u")"
