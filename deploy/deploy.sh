#!/usr/bin/env bash
# Deploys a PuzzleLove release on the VPS. Run from the deploy directory (/opt/puzzlelove):
#   ./deploy.sh ghcr.io/<owner>/puzzlelove:sha-abc1234 ghcr.io/<owner>/puzzlelove-migrate:sha-abc1234 \n#               ghcr.io/<owner>/puzzlelove-backup:sha-abc1234
# On failure it redeploys the previous release and exits non-zero.
# Migrations are not rolled back: they must stay backward compatible with the previous release.
set -euo pipefail
cd "$(dirname "$0")"

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <app-image> <migrate-image> <backup-image>" >&2
  exit 2
fi

COMPOSE_FILES=(-f docker-compose.prod.yml)
# Set COMPOSE_EXTRA=docker-compose.local.yml to rehearse a deploy on Docker Desktop.
if [[ -n "${COMPOSE_EXTRA:-}" ]]; then COMPOSE_FILES+=(-f "$COMPOSE_EXTRA"); fi
compose() { docker compose "${COMPOSE_FILES[@]}" --env-file .env "$@"; }

STATE_FILE=.deployed-images
DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
ACME_CA_SERVER=$(grep -E '^ACME_CA_SERVER=' .env | cut -d= -f2- || true)

health_check() {
  local insecure=()
  # Staging certificates (and the local self-signed one) are not trusted.
  if [[ -z "$ACME_CA_SERVER" || "$ACME_CA_SERVER" == *staging* || -n "${COMPOSE_EXTRA:-}" ]]; then insecure=(-k); fi
  for _ in $(seq 1 10); do
    if curl -fsS "${insecure[@]}" --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null; then
      return 0
    fi
    sleep 3
  done
  return 1
}

release() {
  export APP_IMAGE=$1 MIGRATE_IMAGE=$2 BACKUP_IMAGE=$3
  echo "==> deploying $APP_IMAGE"
  if [[ -z "${COMPOSE_EXTRA:-}" ]]; then compose pull app migrate backup; fi
  compose up -d --remove-orphans --wait --wait-timeout 180 && health_check
}

previous=()
if [[ -f $STATE_FILE ]]; then read -r -a previous < "$STATE_FILE"; fi

if release "$1" "$2" "$3"; then
  echo "$1 $2 $3" > "$STATE_FILE"
  docker image prune -f >/dev/null
  echo "==> deployed $1"
  exit 0
fi

echo "==> deploy of $1 failed" >&2
compose logs --tail 50 app migrate >&2 || true
if [[ ${#previous[@]} -ge 2 ]]; then
  echo "==> rolling back to ${previous[0]}" >&2
  # Releases recorded before backups existed have no backup image; keep the new one.
  if release "${previous[0]}" "${previous[1]}" "${previous[2]:-$3}"; then
    echo "==> rollback succeeded" >&2
  else
    echo "==> ROLLBACK FAILED, manual intervention needed" >&2
  fi
else
  echo "==> no previous release to roll back to" >&2
fi
exit 1
