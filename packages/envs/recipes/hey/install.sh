#!/usr/bin/env bash
# hey: upstream (rakyll/hey) publishes only a linux-amd64 binary and no checksums, so we take
# the Debian/Ubuntu package (apt-signed, both arches) and pin its upstream version.
set -euo pipefail
. "$RECIPE_LIB"

have apt-get || die "hey needs apt-get (Debian/Ubuntu)"
# apt_install refreshes the index first, so the candidate below is current.
apt_install ca-certificates >/dev/null
cand=$(apt-cache policy hey | awk '/Candidate:/ {print $2}')
up=${cand#*:}; up=${up%%-*}
[ "$up" = "$RECIPE_VERSION" ] || die "apt offers hey '$cand', recipe pins upstream $RECIPE_VERSION"
apt_install "hey=$cand"
log "hey $cand installed"
