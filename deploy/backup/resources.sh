#!/usr/bin/env bash
# Resource guard. Runs inside the `backup` container (the host's ops container) on a schedule.
#
#   resources.sh            report, ping RESOURCES_PING_URL when everything fits, exit 1 when not
#   resources.sh FILE       same, reading the inventory from a TSV file instead of the Docker API
#                           (name<TAB>cgroup-parent<TAB>limit-bytes<TAB>reservation-bytes)
#
# The kernel already enforces each slice's ceiling (see deploy/ansible/roles/resources), so nothing
# here can be crowded out by a misbehaving app. What this catches is the other failure: an app whose
# declared limits no longer fit its slice's budget, which would have it throttled instead of served.
# Reads container limits through the read-only Docker socket proxy; the socket is never mounted here.
#
# SLICE_BUDGETS is "<slice>=<MiB>,..." and must match resource_slices in
# deploy/ansible/group_vars/vps.yml. A slice's number is how much declared container memory it may
# hold, which is not always its MemoryHigh: batch is sized so the pipeline can run at its ceiling.
set -euo pipefail

PROXY=${DOCKER_API:-http://socket-proxy:2375}
BUDGETS=${SLICE_BUDGETS:-}
DISK_WARN_PCT=${DISK_WARN_PCT:-85}

log() { echo "[resources] $(date -u +%FT%TZ) $*"; }
api() { wget -qO- "$PROXY$1"; }

# name <TAB> slice <TAB> limit-bytes <TAB> reservation-bytes, one line per container.
collect() {
  local id
  for id in $(api '/containers/json?all=1' | jq -r '.[].Id'); do
    api "/containers/$id/json" | jq -r '
      [ (.Name | ltrimstr("/")),
        (if (.HostConfig.CgroupParent // "") == "" then "(host)" else .HostConfig.CgroupParent end),
        (.HostConfig.Memory // 0),
        (.HostConfig.MemoryReservation // 0) ] | @tsv'
  done
}

main() {
  local inventory problems=0
  # A file argument skips the Docker API, which makes the thresholds testable.
  if [[ -n ${1:-} ]]; then inventory=$(cat "$1"); else inventory=$(collect); fi
  [[ -n $inventory ]] || { log "ERROR: no containers reported by $PROXY"; exit 1; }

  log "declared memory by slice (budgets: ${BUDGETS:-none configured})"
  # Sums limits and reservations per slice and compares them with the slice's budget in MiB.
  local report
  report=$(BUDGETS="$BUDGETS" awk -F'\t' '
    function mib(b) { return int(b / 1048576) }
    BEGIN {
      n = split(ENVIRON["BUDGETS"], pairs, ",")
      for (i = 1; i <= n; i++) if (split(pairs[i], kv, "=") == 2) budget[kv[1] ".slice"] = kv[2]
    }
    { limit[$2] += $3; reserved[$2] += $4; count[$2]++; if ($3 == 0) unbounded[$2]++ }
    END {
      for (s in count) {
        b = (s in budget) ? budget[s] : 0
        verdict = "ok"
        if (b > 0 && mib(limit[s]) > b) verdict = "OVER"
        else if (b == 0) verdict = "no-budget"
        printf "%s\t%d\t%d\t%d\t%d\t%s\t%s\n", s, count[s], mib(limit[s]), mib(reserved[s]), b, verdict, (unbounded[s] ? unbounded[s] " unbounded" : "-")
      }
    }' <<<"$inventory" | sort)

  printf '  %-18s %5s %9s %9s %8s  %-9s %s\n' SLICE CTRS LIMIT_MiB RESV_MiB BUDGET VERDICT NOTES
  while IFS=$'\t' read -r slice ctrs limit resv budget verdict notes; do
    printf '  %-18s %5s %9s %9s %8s  %-9s %s\n' "$slice" "$ctrs" "$limit" "$resv" "$budget" "$verdict" "$notes"
    [[ $verdict == OVER ]] && problems=$((problems + 1))
  done <<<"$report"

  # Containers outside every slice escape the group ceiling entirely: that is the leak to catch.
  local stray
  stray=$(awk -F'\t' '$2 == "(host)" { print $1 }' <<<"$inventory" | paste -sd, -)
  if [[ -n $stray ]]; then
    log "WARNING: not in any slice (no group ceiling applies): $stray"
    problems=$((problems + 1))
  fi

  local used
  used=$(df -P / | awk 'NR == 2 { for (i = 1; i <= NF; i++) if ($i ~ /%$/) { gsub(/%/, "", $i); print $i; exit } }')
  log "disk: ${used}% used (warn at ${DISK_WARN_PCT}%)"
  if (( used >= DISK_WARN_PCT )); then
    log "WARNING: disk above ${DISK_WARN_PCT}%"
    problems=$((problems + 1))
  fi

  if (( problems > 0 )); then
    # No ping: the Uptime Kuma push monitor goes down and alerts Discord.
    log "ERROR: $problems problem(s); not pinging"
    exit 1
  fi
  log "all slices within budget"
  if [[ -n ${RESOURCES_PING_URL:-} ]]; then wget -q -O /dev/null "$RESOURCES_PING_URL" || log "ping failed"; fi
}

main "$@"
