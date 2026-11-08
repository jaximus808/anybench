#!/usr/bin/env bash
# L5 gate 'db-state' (kind: db-state), TDM-51 test kit: only applies to workloads with a database.
set -u
out="$1" wl="$2" verdict="$3"
if [ ! -f "$out/db/state.json" ]; then
  printf '{"pass":false,"applicable":false,"reason":"workload %s has no database","evidence":[]}\n' "$wl" > "$verdict"
  exit 0
fi
printf '{"pass":true,"reason":"db state present","evidence":["db/state.json"]}\n' > "$verdict"
