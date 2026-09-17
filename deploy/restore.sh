#!/usr/bin/env bash
# Restores PuzzleLove backups from R2. Run from the deploy directory (/opt/puzzlelove).
# The age private key is read from stdin and never written to the server's disk. From your PC:
#
#   Get-Content key.txt | ssh luis@VPS "/opt/puzzlelove/restore.sh test"                  # safe drill
#   Get-Content key.txt | ssh luis@VPS "/opt/puzzlelove/restore.sh prod latest --yes"     # overwrites production
#
#   restore.sh list
#   restore.sh test [STAMP]            restore into a throwaway database and report row counts
#   restore.sh prod STAMP|latest --yes stop the app, restore Postgres + images, start the app again
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_FILES=(-f docker-compose.prod.yml)
if [[ -n "${COMPOSE_EXTRA:-}" ]]; then COMPOSE_FILES+=(-f "$COMPOSE_EXTRA"); fi
compose() { docker compose "${COMPOSE_FILES[@]}" --env-file .env "$@"; }

if [[ -f .deployed-release ]]; then
  read -r repo tag < .deployed-release
  [[ $repo == "-" ]] && repo=""
  export APP_IMAGE="${repo}puzzlelove:$tag" BACKUP_IMAGE="${repo}puzzlelove-backup:$tag"
elif [[ -f .deployed-images ]]; then
  read -r APP_IMAGE _ BACKUP_IMAGE < .deployed-images
  export APP_IMAGE BACKUP_IMAGE
fi

run_backup() { compose run --rm --no-deps -T backup backup.sh "$@"; }

case "${1:-}" in
  list)
    run_backup list
    ;;
  test)
    run_backup test-restore "${2:-latest}"
    ;;
  prod)
    [[ -n "${2:-}" && "${3:-}" == --yes ]] || { echo "usage: $0 prod STAMP|latest --yes" >&2; exit 2; }
    echo "==> stopping app (players will be disconnected)"
    compose stop app
    status=0
    compose run --rm --no-deps -T -e CONFIRM=yes backup backup.sh restore "$2" || status=$?
    echo "==> starting app"
    compose up -d --no-deps app
    exit $status
    ;;
  *)
    echo "usage: $0 list | test [STAMP] | prod STAMP|latest --yes" >&2
    exit 2
    ;;
esac
