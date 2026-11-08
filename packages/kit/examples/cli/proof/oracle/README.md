# Oracle: GNU grep

The oracle overlay runs the `gnu-grep` contender unchanged. `grep -rnoP` (UTF-8) is the reference
implementation, so its sorted stdout must equal `reference/same-matches/<workload>/stdout.txt` for every workload.
