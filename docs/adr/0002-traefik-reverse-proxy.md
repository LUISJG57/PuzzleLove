# ADR-0002: Traefik as reverse proxy

**Status:** accepted (supersedes the initial plan to use Nginx)

## Context
Several hostnames (game, Superset, status page, proxy dashboard) need HTTPS with automatic renewal, WebSocket support
for Socket.IO and routing to containers.

## Decision
Use Traefik v3 with Docker labels for routing and its built-in ACME client (HTTP-01). Traefik reads Docker through a
read-only socket proxy. Shared middlewares (security headers, rate limit, basic auth) live in a file provider.

## Alternatives
- **Nginx + certbot:** mature, but routes and renewal hooks are managed separately from the containers.
- **Caddy:** similar automation, less common in container-label workflows.

## Consequences
- Adding a service is a few labels, and certificates appear automatically.
- Traefik versions before 3.6 break against the Docker 29 API, so the version is pinned.
- Let's Encrypt staging was used first to avoid production rate limits.
