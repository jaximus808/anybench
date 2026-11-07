#!/usr/bin/env bash
# git-time: apt packages, signed by the distro. The upstream versions are pinned below and the
# install fails if the repo offers anything else (the Debian revision may move with security
# updates; the upstream version may not).
set -euo pipefail
. "$RECIPE_LIB"

GIT_UPSTREAM=2.43.0
TIME_UPSTREAM=1.9

pin() { # pin <pkg> <upstream>: print pkg=<candidate> if the candidate's upstream matches
  cand=$(apt-cache policy "$1" | awk '/Candidate:/ {print $2}')
  up=${cand#*:}; up=${up%%-*}
  [ "$up" = "$2" ] || die "$1: apt offers '$cand', recipe pins upstream $2"
  printf '%s=%s' "$1" "$cand"
}

have apt-get || die "git-time needs apt-get (Debian/Ubuntu)"
apt_install ca-certificates >/dev/null
git_pkg=$(pin git "$GIT_UPSTREAM")
time_pkg=$(pin time "$TIME_UPSTREAM")
apt_install "$git_pkg" "$time_pkg"
log "git $(git --version | cut -d' ' -f3), GNU time $(dpkg-query -W -f='${Version}' time)"
