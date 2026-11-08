#!/usr/bin/env bash
# eval-user: the user exists, is not root, owns its home, has no sudo, and we can run as it.
set -euo pipefail
. "$RECIPE_LIB"

u="$ANYBENCH_EVAL_USER"
id -u "$u" >/dev/null 2>&1 || die "user $u does not exist"
[ "$(id -u "$u")" -ne 0 ] || die "user $u is root"
expect_eq "home of $u" "$ANYBENCH_EVAL_HOME" "$(home_of "$u")"
expect_eq "owner of $ANYBENCH_EVAL_HOME" "$u" "$(stat -c %U "$ANYBENCH_EVAL_HOME")"
expect_eq "whoami as $u" "$u" "$(as_user "$u" id -un)"
expect_eq "HOME as $u" "$ANYBENCH_EVAL_HOME" "$(as_user "$u" sh -c 'echo $HOME')"
as_user "$u" sh -c 't=$(mktemp -p "$HOME") && rm "$t"' || die "$u cannot write its home"
if as_user "$u" sudo -n true >/dev/null 2>&1; then die "user $u has passwordless sudo"; fi
echo "user $u uid $(id -u "$u") ok"
