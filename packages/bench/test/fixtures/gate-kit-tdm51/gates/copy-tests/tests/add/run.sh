# Hidden tests for workload add; run as the contender uid inside its workspace.
fail=0
[ "$(bash ./sum.sh 2 3)" = 5 ] || fail=1
[ "$(bash ./sum.sh 10 -4)" = 6 ] || fail=1
exit "$fail"
