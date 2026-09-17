#!/usr/bin/env bash
# Idempotently creates the `lake` bucket and the pipeline's access key in Garage from LAKE_ACCESS_KEY_ID and
# LAKE_SECRET_ACCESS_KEY in .env. The pipeline key can only reach the lake; the app key only reaches images.
# Called by deploy.sh after Garage is healthy. Does nothing when the lake keys are not configured.
set -euo pipefail
cd "$(dirname "$0")/.."

key_id=$(grep -E '^LAKE_ACCESS_KEY_ID=' .env | cut -d= -f2- || true)
secret=$(grep -E '^LAKE_SECRET_ACCESS_KEY=' .env | cut -d= -f2- || true)
if [[ -z $key_id || -z $secret ]]; then
  echo "==> lake keys not set in .env; skipping Garage lake setup"
  exit 0
fi

garage() { docker exec puzzlelove-garage-1 /garage "$@"; }

if ! garage bucket info lake >/dev/null 2>&1; then
  garage bucket create lake >/dev/null
  echo "==> created Garage bucket lake"
fi
if ! garage key info "$key_id" >/dev/null 2>&1; then
  garage key import --yes -n lake-pipeline "$key_id" "$secret" >/dev/null
  echo "==> imported Garage key lake-pipeline"
fi
garage bucket allow --read --write --owner lake --key "$key_id" >/dev/null
