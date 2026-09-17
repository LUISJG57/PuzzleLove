#!/usr/bin/env bash
# Deploys a PuzzleLove release on the VPS. Run from the deploy directory (/opt/puzzlelove):
#   IMAGE_REPO=ghcr.io/<owner>/ ./deploy.sh sha-abc1234   # deploy that tag of every image
#   ./deploy.sh                                            # re-apply the current release (e.g. after editing .env)
# Images: <IMAGE_REPO>puzzlelove, -migrate, -backup, -pipeline and -superset, all with the same tag.
# On failure it redeploys the previous release and exits non-zero.
# Migrations are not rolled back: they must stay backward compatible with the previous release.
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_FILES=(-f docker-compose.prod.yml)
# Set COMPOSE_EXTRA=docker-compose.local.yml to rehearse a deploy on Docker Desktop.
if [[ -n "${COMPOSE_EXTRA:-}" ]]; then COMPOSE_FILES+=(-f "$COMPOSE_EXTRA"); fi
compose() { docker compose "${COMPOSE_FILES[@]}" --env-file .env "$@"; }

STATE_FILE=.deployed-release
LEGACY_STATE_FILE=.deployed-images

# Prints "<repo or -> <tag>" for the current release, if any.
current_release() {
  if [[ -f $STATE_FILE ]]; then
    cat "$STATE_FILE"
  elif [[ -f $LEGACY_STATE_FILE ]]; then
    # Older deploys stored full image references: ghcr.io/owner/puzzlelove:sha-abc ...
    local app
    read -r app _ < "$LEGACY_STATE_FILE"
    local repo=${app%puzzlelove:*}
    echo "${repo:--} ${app##*:}"
  fi
}

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [tag]" >&2
  exit 2
fi
previous_repo="" previous_tag=""
read -r previous_repo previous_tag <<< "$(current_release)" || true
[[ $previous_repo == "-" ]] && previous_repo=""
if [[ $# -eq 1 ]]; then
  repo=${IMAGE_REPO:-}
  tag=$1
elif [[ -n $previous_tag ]]; then
  repo=$previous_repo
  tag=$previous_tag
else
  echo "no release deployed yet; pass a tag" >&2
  exit 2
fi

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
  local r=$1 t=$2
  export APP_IMAGE="${r}puzzlelove:$t" MIGRATE_IMAGE="${r}puzzlelove-migrate:$t" \
    BACKUP_IMAGE="${r}puzzlelove-backup:$t" PIPELINE_IMAGE="${r}puzzlelove-pipeline:$t"     SUPERSET_IMAGE="${r}puzzlelove-superset:$t"
  echo "==> deploying $APP_IMAGE"
  if [[ -z "${COMPOSE_EXTRA:-}" ]]; then compose pull app migrate backup pipeline superset-init; fi
  compose up -d --wait --wait-timeout 120 garage && bash garage/init-lake.sh
  compose up -d --remove-orphans --wait --wait-timeout 180 && health_check
}

if release "$repo" "$tag"; then
  echo "${repo:--} $tag" > "$STATE_FILE"
  rm -f "$LEGACY_STATE_FILE"
  docker image prune -f >/dev/null
  echo "==> deployed $tag"
  exit 0
fi

echo "==> deploy of $tag failed" >&2
compose logs --tail 50 app migrate >&2 || true
if [[ -n $previous_tag && "$previous_repo$previous_tag" != "$repo$tag" ]]; then
  echo "==> rolling back to $previous_tag" >&2
  if release "$previous_repo" "$previous_tag"; then
    echo "==> rollback succeeded" >&2
  else
    echo "==> ROLLBACK FAILED, manual intervention needed" >&2
  fi
else
  echo "==> no previous release to roll back to" >&2
fi
exit 1
