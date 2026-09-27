# The platform: adding another app to the VPS

One 8 GB Hostinger VPS hosts several independent applications behind one Traefik. Each app is its own repository,
its own compose project, its own directory under `/opt` and its own pipeline. Adding one does not require a change
to any existing repository — this page is the whole contract.

Decisions behind it: [ADR-0013](adr/0013-portfolio-at-root.md) (routing and per-app deploys) and
[ADR-0014](adr/0014-resource-tiers.md) (resource tiers).

## Who owns what

| Owner | What |
|---|---|
| This repository (`PuzzleLove`) | Traefik, Postgres, Garage, Redis, Superset, Uptime Kuma, backups, the resource slices, the `edge` network — plus the game itself |
| Each app repository | Its own image, its own `deploy/` and its own deploy script |
| Ansible (`deploy/ansible`, run by hand) | The host: hardening, Docker, swap, the slices, the `edge` network, `/opt/<app>` directories |

## Routing today

| URL | App | Notes |
|---|---|---|
| `luisjgl.cloud/` | portfolio | Static Next.js export behind nginx; router `priority: 1` so longer rules win |
| `luisjgl.cloud/puzzlelove/` | game | `PathPrefix` + `StripPrefix`; `/r/…`, `/new`, `/admin` 301 into the prefix |
| `superset.luisjgl.cloud` | Superset | Public dashboard only; everything else behind its login |
| `status.luisjgl.cloud` | Uptime Kuma | Public status page; admin behind Traefik basic auth **and** Kuma's login |
| `traefik.luisjgl.cloud` | Traefik dashboard | Basic auth |

No new DNS record is needed for a subpath. A new subdomain needs an A record at Hostinger pointing at the VPS;
Traefik then issues the certificate by itself, because TLS is configured on the `websecure` entrypoint.

## The checklist for a new app

1. **Join the shared network.** In your compose file:
   ```yaml
   networks:
     edge:
       external: true
   ```
   It is created once by `deploy/ansible/roles/resources`, so it outlives every individual compose project.
2. **Publish no ports.** Docker bypasses UFW; only Traefik may use `ports:`. Traefik reaches you over `edge`.
   Join `edge` **only** with the containers Traefik has to reach; keep the rest on your own internal network.
   Everything on `edge` can reach everything else on it — that is why the game's bots and databases are not there.
3. **Route with labels**, and set an explicit `priority` if your rule is a bare `Host()`:
   ```yaml
   labels:
     traefik.enable: 'true'
     traefik.http.routers.<app>.rule: Host(`${DOMAIN}`) && PathPrefix(`/<app>`)
     traefik.http.routers.<app>.entrypoints: websecure
     traefik.http.routers.<app>.middlewares: ratelimit@file,<app>-strip@docker
     traefik.http.middlewares.<app>-strip.stripprefix.prefixes: /<app>
     traefik.http.services.<app>.loadbalancer.server.port: 80
   ```
   Define your own middlewares as Docker labels. The file provider
   (`deploy/traefik/dynamic/middlewares.yml`) belongs to this repository; `ratelimit@file` and
   `secure-headers@file` are shared and safe to reference.
4. **Declare your resource tier** (see below).
5. **Ask for a directory and a budget:** add `/opt/<app>` to `app_dirs_extra` and your memory to the table, both
   in `deploy/ansible/group_vars/vps.yml`, and re-run the playbook.
6. **Make the GHCR package public** after the first push, or the VPS cannot pull it without logging in.

## Resource tiers

The kernel enforces the ceiling per slice, so an app that declares too much for itself still cannot crowd out
Postgres or Traefik. Your per-container keys only decide who gives ground first *inside* your slice.

```yaml
    cgroup_parent: apps.slice     # every user-facing app goes here
    mem_reservation: 32m          # soft floor (memory.low) — NOT deploy.resources.reservations
    cpu_shares: 256               # a weight, not a cap: idle CPU is never wasted
    oom_score_adj: 0              # who the kernel kills first under real pressure
    deploy:
      resources:
        limits: { memory: 64M }   # your hard ceiling
```

| Slice | For | Kernel budget |
|---|---|---|
| `platform.slice` | shared infrastructure | `MemoryMin=2G`, `CPUWeight=400` |
| `apps.slice` | **your app** | `MemoryHigh=2500M`, `MemoryMax=3G`, `CPUWeight=200` |
| `batch.slice` | nightly batch work | `MemoryHigh=2500M`, `MemoryMax=3G`, `CPUWeight=50`, `IOWeight=50` |

Current `apps.slice` allocation: the game 400M, the bots 128M, the portfolio 64M — 592M of 2500M.

Two traps worth repeating:

- **`deploy.resources.reservations` is ignored** in non-swarm Compose. The soft floor must be the service-level
  `mem_reservation` key, or you have written a no-op.
- **A container with no `cgroup_parent` escapes the ceiling entirely.** The resource guard reports any it finds.

## The resource guard

`deploy/backup/resources.sh` runs daily at 06:00 inside the `backup` container (which is the host's ops container,
despite the name). It sums each slice's declared limits through the read-only Docker socket proxy, checks the disk,
and pings an Uptime Kuma push monitor **only** when everything fits — so over-allocation becomes a Discord alert.

Run it by hand, or against a fixture, to see what it sees:

```bash
cd /opt/puzzlelove
docker compose -f docker-compose.prod.yml --env-file .env exec backup resources.sh
```

Its budgets live in `SLICE_BUDGETS` in `deploy/docker-compose.prod.yml` and must be kept in step with
`resource_slices` in `deploy/ansible/group_vars/vps.yml`. They are not always a slice's `MemoryHigh`: `batch`'s
budget is its `MemoryMax`, because the pipeline is meant to run at its ceiling.

## If your app serves from a subpath

The game does, and its shape is worth copying: **strip the prefix at Traefik** instead of teaching the app about
it. Then every server route stays at the root and container healthchecks and internal clients need no changes.
Only the browser sees the prefix:

- the bundler's `base` (`client/vite.config.ts`), which feeds one `apiUrl()` helper (`client/src/lib/urls.ts`);
- the router's `basename`;
- Socket.IO's `path`, if you use it;
- any cookie's `path` — the server reads `BASE_PATH` for this, so the game's admin cookie is never sent to the
  portfolio at the root.

The bundler's prefix is build-time and the cookie's scope is runtime. **They must match.**

Also note `frameDeny: true` in `secure-headers@file`, applied globally at the entrypoint: apps on this host cannot
be embedded in each other's iframes.
