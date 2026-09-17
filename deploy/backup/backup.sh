#!/usr/bin/env bash
# PuzzleLove backups. Runs inside the `backup` container.
#
#   backup.sh run                    dump Postgres + archive Garage images, encrypt, upload to R2, apply retention
#   backup.sh list                   list backups in R2
#   backup.sh test-restore [STAMP]   restore into a throwaway Postgres inside this container and report row counts
#   backup.sh restore STAMP|latest   restore into PRODUCTION (requires CONFIRM=yes; stop the app first)
#
# Backups are encrypted to AGE_RECIPIENT (public key). Restores read the age private key from stdin,
# so the key never has to live on the server:  cat key.txt | docker compose run --rm -T backup backup.sh test-restore
set -euo pipefail

R2="r2:${R2_BUCKET:-}"
RETENTION_DAYS=${RETENTION_DAYS:-30}
WORK=$(mktemp -d)
KEY_FILE=/dev/shm/age-identity
trap 'rm -rf "$WORK" "$KEY_FILE"' EXIT

log() { echo "[backup] $(date -u +%FT%TZ) $*"; }
die() { log "ERROR: $*"; exit 1; }

require_config() {
  local missing=()
  for v in R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY PGPASSWORD; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
  done
  if [[ "${1:-}" == encrypt ]]; then [[ -n "${AGE_RECIPIENT:-}" ]] || missing+=(AGE_RECIPIENT); fi
  [[ ${#missing[@]} -eq 0 ]] || die "missing configuration: ${missing[*]}"
}

read_identity() {
  [[ -t 0 ]] && die "pipe the age private key on stdin (and use 'run -T')"
  # Strip CR: keys piped from Windows PowerShell arrive with CRLF line endings.
  (umask 077; tr -d '\r' > "$KEY_FILE")
  grep -q '^AGE-SECRET-KEY-' "$KEY_FILE" || die "stdin is not an age private key"
}

# Resolves "latest" or a stamp (e.g. 20260917T033000Z) to the object paths of a backup set.
resolve_set() {
  local stamp=${1:-latest} db
  if [[ $stamp == latest ]]; then
    db=$(rclone lsf -R --files-only "$R2/postgres" | sort | tail -n 1)
    [[ -n $db ]] || die "no backups found in $R2/postgres"
    stamp=$(basename "$db" | sed -E 's/^puzzlelove-(.*)\.dump\.age$/\1/')
  fi
  local ym="${stamp:0:4}/${stamp:4:2}"
  DB_OBJECT="postgres/$ym/puzzlelove-$stamp.dump.age"
  IMAGES_OBJECT="garage/$ym/images-$stamp.tar.age"
  STAMP=$stamp
}

fetch_set() {
  log "downloading backup set $STAMP"
  rclone copyto "$R2/$DB_OBJECT" "$WORK/db.dump.age"
  rclone copyto "$R2/$IMAGES_OBJECT" "$WORK/images.tar.age"
  age -d -i "$KEY_FILE" -o "$WORK/db.dump" "$WORK/db.dump.age"
  age -d -i "$KEY_FILE" -o "$WORK/images.tar" "$WORK/images.tar.age"
}

cmd_run() {
  require_config encrypt
  local stamp ym start
  start=$(date +%s)
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  ym="${stamp:0:4}/${stamp:4:2}"

  log "dumping Postgres"
  pg_dump -Fc -f "$WORK/db.dump"
  age -r "$AGE_RECIPIENT" -o "$WORK/db.dump.age" "$WORK/db.dump"

  log "archiving Garage bucket ${GARAGE_BUCKET:-puzzlelove}"
  mkdir -p "$WORK/images"
  rclone copy "garage:${GARAGE_BUCKET:-puzzlelove}" "$WORK/images"
  tar -C "$WORK/images" -cf "$WORK/images.tar" .
  age -r "$AGE_RECIPIENT" -o "$WORK/images.tar.age" "$WORK/images.tar"

  log "uploading to R2"
  rclone copyto "$WORK/db.dump.age" "$R2/postgres/$ym/puzzlelove-$stamp.dump.age"
  rclone copyto "$WORK/images.tar.age" "$R2/garage/$ym/images-$stamp.tar.age"

  log "removing backups older than ${RETENTION_DAYS} days"
  rclone delete --min-age "${RETENTION_DAYS}d" "$R2/postgres"
  rclone delete --min-age "${RETENTION_DAYS}d" "$R2/garage"

  log "done $stamp: db $(stat -c %s "$WORK/db.dump.age") bytes, images $(stat -c %s "$WORK/images.tar.age") bytes, $(( $(date +%s) - start ))s"
  if [[ -n "${BACKUP_PING_URL:-}" ]]; then wget -q -O /dev/null "$BACKUP_PING_URL" || log "ping failed"; fi
}

cmd_list() {
  require_config
  rclone lsl "$R2" | sort -k4
}

cmd_test_restore() {
  require_config
  read_identity
  resolve_set "${1:-latest}"
  fetch_set

  log "starting throwaway Postgres"
  local pgdata="$WORK/pgdata"
  mkdir -p "$pgdata" && chown postgres:postgres "$WORK" "$pgdata"
  chmod 755 "$WORK"
  gosu postgres initdb -D "$pgdata" -U restore --auth=trust --no-locale >/dev/null
  gosu postgres pg_ctl -D "$pgdata" -o "-p 5499 -k $WORK -c listen_addresses=''" -w start >/dev/null
  # Stop the throwaway server even if the restore fails.
  trap 'gosu postgres pg_ctl -D "$WORK/pgdata" -m fast stop >/dev/null 2>&1 || true; rm -rf "$WORK" "$KEY_FILE"' EXIT

  local conn=(-h "$WORK" -p 5499 -U restore)
  createdb "${conn[@]}" puzzlelove
  chmod 644 "$WORK/db.dump"
  pg_restore "${conn[@]}" -d puzzlelove --no-owner --exit-on-error "$WORK/db.dump"

  log "restored set $STAMP"
  psql "${conn[@]}" -d puzzlelove -v ON_ERROR_STOP=1 -c "
    select 'migrations' as item, count(*) from _prisma_migrations
    union all select 'rooms', count(*) from \"Room\"
    union all select 'global_queue', count(*) from \"GlobalQueueItem\";"
  echo "images in archive: $(tar -tf "$WORK/images.tar" | grep -c '\.webp$' || true)"
  log "test restore OK"
}

cmd_restore() {
  require_config
  [[ "${CONFIRM:-}" == yes ]] || die "this overwrites production data; set CONFIRM=yes"
  [[ -n "${1:-}" ]] || die "usage: backup.sh restore STAMP|latest"
  read_identity
  resolve_set "$1"
  fetch_set

  log "restoring Postgres from $STAMP (clean)"
  pg_restore --clean --if-exists --no-owner --exit-on-error -d "${PGDATABASE}" "$WORK/db.dump"

  log "restoring images to Garage"
  mkdir -p "$WORK/images"
  tar -C "$WORK/images" -xf "$WORK/images.tar"
  rclone copy "$WORK/images" "garage:${GARAGE_BUCKET:-puzzlelove}"
  log "restore of $STAMP finished"
}

case "${1:-}" in
  run) cmd_run ;;
  list) cmd_list ;;
  test-restore) shift; cmd_test_restore "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  *) echo "usage: backup.sh run | list | test-restore [STAMP] | restore STAMP|latest" >&2; exit 2 ;;
esac
