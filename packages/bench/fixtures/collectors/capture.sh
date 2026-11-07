#!/usr/bin/env bash
# Re-capture the real collector fixtures in throwaway containers (random names). Usage: capture.sh <outdir>
# SKIP_CLI=1 skips time and hyperfine. Copy the outputs you want into this directory by hand.
set -euo pipefail
OUT="$1"; mkdir -p "$OUT"
S=$(openssl rand -hex 4)
NET="tdm50-net-$S"; WEB="tdm50-web-$S"
cleanup() { docker rm -f "$WEB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ "${SKIP_CLI:-0}" != 1 ]; then
echo "== time"
docker run --rm --name "tdm50-time-$S" -v "$OUT":/out debian:bookworm-slim sh -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq time >/dev/null &&
  /usr/bin/time --version 2>&1 | head -1 > /out/time-version.txt;
  /usr/bin/time -v -o /out/time-v.txt sh -c "seq 1 2000000 | sort -n > /dev/null";
  /usr/bin/time -v -o /out/time-v-nonzero.txt sh -c "head -c 50000000 /dev/zero | gzip > /dev/null; exit 3" || true'

echo "== hyperfine"
docker run --rm --name "tdm50-hf-$S" -v "$OUT":/out debian:bookworm-slim sh -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null &&
  curl -fsSL https://github.com/sharkdp/hyperfine/releases/download/v1.19.0/hyperfine-v1.19.0-aarch64-unknown-linux-gnu.tar.gz | tar xz -C /tmp &&
  H=/tmp/hyperfine-v1.19.0-aarch64-unknown-linux-gnu/hyperfine && $H --version > /out/hyperfine-version.txt &&
  $H --warmup 1 --runs 6 --export-json /out/hyperfine.json "sleep 0.05" "seq 1 200000 | sort -n > /dev/null" &&
  $H --runs 4 --ignore-failure --export-json /out/hyperfine-failures.json "sh -c \"exit 2\""'

fi
echo "== web target"
docker network create "$NET" >/dev/null
docker run -d --rm --name "$WEB" --network "$NET" nginx:1.27-alpine >/dev/null
sleep 2

echo "== hey"
# The hey S3 release bucket answers 403 now (2026-11), so build the tagged release with Go.
docker run --rm --name "tdm50-hey-$S" --network "$NET" -v "$OUT":/out golang:1.24-bookworm sh -c "
  go install github.com/rakyll/hey@v0.1.4 >/dev/null 2>&1 && echo hey v0.1.4 > /out/hey-version.txt &&
  /go/bin/hey -n 400 -c 10 http://$WEB/ > /out/hey.txt &&
  /go/bin/hey -n 200 -c 5 http://$WEB/missing > /out/hey-404.txt"

echo "== k6"
cat > "$OUT/k6-script.js" <<JS
import http from 'k6/http';
import { check } from 'k6';
export const options = { vus: 5, duration: '3s', thresholds: { http_req_duration: ['p(95)<500'] } };
export default function () {
  const ok = http.get('http://$WEB/');
  check(ok, { 'status is 200': (r) => r.status === 200 });
  const miss = http.get('http://$WEB/missing');
  check(miss, { 'missing is 404': (r) => r.status === 404 });
}
JS
docker run --rm --name "tdm50-k6-$S" --network "$NET" -v "$OUT":/out grafana/k6:1.3.0 run --quiet --summary-export=/out/k6-summary.json /out/k6-script.js > "$OUT/k6-stdout.txt" 2>&1 || true
docker run --rm grafana/k6:1.3.0 version > "$OUT/k6-version.txt" 2>&1 || true

echo "== machine"
docker run --rm --name "tdm50-machine-$S" -v "$OUT":/out debian:bookworm-slim sh -c '
  apt-get update -qq >/dev/null && apt-get install -y -qq util-linux procps >/dev/null;
  uname -a > /out/machine-uname.txt; nproc > /out/machine-nproc.txt; lscpu > /out/machine-lscpu.txt;
  cat /proc/meminfo > /out/machine-meminfo.txt; cat /proc/loadavg > /out/machine-loadavg.txt;
  head -1 /proc/stat > /out/machine-stat-a.txt; sleep 1; head -1 /proc/stat > /out/machine-stat-b.txt'
echo done
