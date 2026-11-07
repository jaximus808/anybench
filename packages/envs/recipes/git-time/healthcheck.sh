#!/usr/bin/env bash
# git-time: pinned versions, a real commit round-trip, and GNU (not shell builtin) time output.
set -euo pipefail
. "$RECIPE_LIB"

expect_eq "git version" "2.43.0" "$(git --version | cut -d' ' -f3)"
# Ubuntu's build prints "time (GNU Time) UNKNOWN", so the version comes from the package.
tv=$(/usr/bin/time --version 2>&1 | head -1)
case "$tv" in *"(GNU Time)"*) ;; *) die "/usr/bin/time is not GNU time: $tv" ;; esac
tp=$(dpkg-query -W -f='${Version}' time 2>/dev/null || true)
up=${tp#*:}; up=${up%%-*}
expect_eq "time package upstream version" "1.9" "$up"

d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
git -C "$d" init -q -b main
printf 'hi\n' > "$d/a.txt"
git -C "$d" -c user.email=hc@anybench.invalid -c user.name=hc add a.txt
git -C "$d" -c user.email=hc@anybench.invalid -c user.name=hc commit -q -m hc
expect_eq "git log" "hc" "$(git -C "$d" log -1 --format=%s)"

/usr/bin/time -f 'rss_kb=%M wall_s=%e exit=%x' -o "$d/t" sh -c 'exit 0'
grep -Eq '^rss_kb=[0-9]+ wall_s=[0-9.]+ exit=0$' "$d/t" || die "unexpected GNU time output: $(cat "$d/t")"
echo "git $(git --version | cut -d' ' -f3), $(cat "$d/t") ok"
