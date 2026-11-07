# Do-less: first match only

Sets `MAX_COUNT=1`, so ripgrep stops after the first matching line in each file.
`tree/src/power.c` matches on lines 3 and 4, so `same-matches` must fail.
