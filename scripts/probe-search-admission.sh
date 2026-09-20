#!/usr/bin/env bash
# Probe the /api/search admission gate + latency under parallel load (OM-BL-2026-09-20-01).
#
# Fires 4 then 8 concurrent GET /api/search and reports per-request HTTP code + wall time,
# plus a summary (count of 200 vs 503, min/mean/max seconds). Use to VALIDATE a deploy:
#   - a working gate with ORACLE_SEARCH_MAX_INFLIGHT=N shows ~N×200 + rest×503 at parallel > N;
#   - fast-GPU embed routing shows per-200 times near the GPU embed latency, not the CPU 5x.
#
# READ-ONLY probe (GET). It does NOT restart, deploy, or mutate anything. Do NOT point it at a
# live seat during an unapproved window — it only issues search queries, but it does add load.
#
# Usage:
#   scripts/probe-search-admission.sh [BASE_URL] [QUERY]
#   BASE_URL default: http://127.0.0.1:47778   QUERY default: "oracle admission gate probe"
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:47778}"
QUERY="${2:-oracle admission gate probe}"
MODE="${PROBE_MODE:-hybrid}"
ENC_QUERY="$(printf '%s' "$QUERY" | sed 's/ /%20/g')"
URL="${BASE_URL%/}/api/search?q=${ENC_QUERY}&mode=${MODE}"

one() { # $1 = index; prints "idx CODE SECONDS"
  local code secs
  read -r code secs < <(curl -s -o /dev/null -w '%{http_code} %{time_total}\n' "$URL" || echo "000 0")
  printf '%s %s %s\n' "$1" "$code" "$secs"
}

run_batch() { # $1 = parallelism
  local n="$1" out
  echo "=== ${n}-parallel  ${URL} ==="
  out="$(mktemp)"
  local pids=()
  for i in $(seq 1 "$n"); do one "$i" >>"$out" & pids+=("$!"); done
  for p in "${pids[@]}"; do wait "$p"; done
  sort -n "$out" | while read -r idx code secs; do printf '  req %-2s → HTTP %s  %ss\n' "$idx" "$code" "$secs"; done
  awk '{c[$2]++; t+=$3; if($3>mx||NR==1)mx=$3; if($3<mn||NR==1)mn=$3} END{
    printf "  summary:"; for(k in c) printf " %s×%s", c[k], k; printf "  | time min=%.2fs mean=%.2fs max=%.2fs\n", mn, t/NR, mx }' "$out"
  rm -f "$out"
}

echo "probe target: $BASE_URL  (mode=$MODE)"
echo "expectation with ORACLE_SEARCH_MAX_INFLIGHT=M: ~M×200 + (n-M)×503 for n>M"
run_batch 4
run_batch 8
