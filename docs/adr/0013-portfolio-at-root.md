# ADR-0013: The portfolio owns the domain root; the game moves to /puzzlelove/

**Status:** accepted (supersedes the assumption in ADR-0001 that the VPS hosts one application)

## Context
`luisjgl.cloud` served only PuzzleLove: the `app` router rule was a bare ``Host(`${DOMAIN}`)`` with no path
component, so the game claimed the entire apex. The domain should lead with the personal portfolio, the game should
become one project inside it, and more applications will follow on the same 8 GB VPS.

The portfolio already existed as a separate Next.js repository deployed on Vercel.

## Decision
Three decisions, taken together:

1. **A real subpath, not a subdomain.** The game lives at `https://luisjgl.cloud/puzzlelove/`. The existing
   `superset.`, `status.` and `traefik.` subdomains stay as they are.
2. **Strip the prefix at the proxy, do not re-prefix the application.** Traefik matches
   ``Host(`${DOMAIN}`) && PathPrefix(`/puzzlelove`)`` and strips `/puzzlelove` before the request reaches the
   container. Every Express route stays at `/api/...` and Socket.IO keeps its default `/socket.io` path, so the
   container healthcheck and the bots — which connect to `http://app:3001` over the internal network — need no
   changes at all. Only the browser ever sees the prefix, through Vite's `base` and one `apiUrl()` helper.
3. **Each application deploys itself.** PuzzleLove keeps `deploy/` and owns the shared infrastructure (Traefik,
   Postgres, Garage, Superset, monitoring, backups). Traefik's network is renamed `edge` and declared
   `external: true`, so every other application brings its own compose project, its own directory under `/opt` and
   its own pipeline, and joins that network. Adding application N+1 does not touch any existing repository.

## Alternatives
- **`puzzlelove.luisjgl.cloud`:** free — one Traefik label and a DNS record, zero application changes, and
  consistent with the existing subdomains. Rejected because the subpath is the URL structure we actually want.
- **Re-prefixing every Express route** instead of stripping at the proxy: would have broken the container
  healthcheck and the bots, and spread the prefix through server code that has no business knowing about it.
- **A separate platform repository** owning Traefik and the shared services: cleaner long term, but a large
  migration (three repositories, three pipelines, a rewritten `deploy.sh`) for no benefit today. The `edge`
  network gets most of the decoupling at a fraction of the cost.
- **Keeping the portfolio on Vercel** and only linking to it: leaves the domain root unused, which is the problem.

## Consequences
- The browser's prefix is **build-time** (`base` in `client/vite.config.ts`) and the admin cookie's scope is
  **runtime** (`BASE_PATH` for the server). They must match; both are documented in `docs/platform.md`.
- Room links shared before the move keep working: an `app-legacy` router 301s `/r/<slug>`, `/new` and `/admin`
  into the prefix.
- `/puzzlelove` without a trailing slash would leave an empty path after the strip, so a redirect adds the slash
  before the strip runs.
- The admin cookie is scoped to `/puzzlelove` so it is never sent to the portfolio at the root. Server tests keep
  `basePath: '/'`, because that is what Express sees once Traefik has stripped the prefix.
- `deploy.sh`'s health gate and the external monitors moved to `/puzzlelove/api/health`. Forgetting either makes
  every deploy roll itself back.
- Renaming the Traefik network from `puzzlelove_proxy` to `edge` recreated every container once.
- The local rehearsal (`docker-compose.local.yml`) has no portfolio, so `https://puzzlelove.localhost/` returns
  404 and the game is at `/puzzlelove/`.
