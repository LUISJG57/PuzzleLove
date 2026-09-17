# ADR-0004: Push-based CI/CD instead of Watchtower

**Status:** accepted

## Context
The plan considered Watchtower to pull new images automatically. Deploys also need database migrations and a way back
when a release is broken.

## Decision
GitHub Actions runs tests, builds all images with one `sha-xxxxxxx` tag, pushes them to GHCR, syncs `deploy/` over rsync
and runs `deploy.sh` over SSH. The script pulls, runs migrations, waits for health through Traefik and redeploys the
previous tag if anything fails.

## Alternatives
- **Watchtower:** unmaintained upstream; it updates any labeled container (databases included) and cannot run migrations
  or gate on health.

## Consequences
- Every deploy is traceable to a commit and visible in Actions.
- Rollback swaps images only. Migrations must stay backward compatible with the previous release.
- The deploy SSH key is dedicated, and the host key is pinned through a secret.
