# ADR-0014: Resource tiers as cgroup slices, not per-container limits alone

**Status:** accepted

## Context
Every service carried a hand-written `deploy.resources.limits.memory`, and the sum had reached ~6.9 GB of the
host's 8 GB. Those limits are ceilings only: there was no guaranteed floor, no CPU control and no OOM priority, so
under pressure the kernel was free to reclaim from Postgres and to kill whatever it liked.

ADR-0013 then made each application deploy itself from its own repository. That removes the one place where all the
limits could be read together: application N+1 can declare `memory: 4G` and no existing repository would know.

## Decision
Three cgroup v2 slices, installed as systemd units by `deploy/ansible/roles/resources`, with services opting in
through `cgroup_parent:`:

| Slice | Holds | Budget | CPUWeight |
|---|---|---|---|
| `platform.slice` | Traefik, socket proxy, Postgres, Garage, Redis, Superset, Uptime Kuma, backups | `MemoryMin=2G` | 400 |
| `apps.slice` | the game, the bots, the portfolio, every future application | `MemoryHigh=2500M`, `MemoryMax=3G` | 200 |
| `batch.slice` | the PySpark pipeline | `MemoryHigh=2500M`, `MemoryMax=3G`, `IOWeight=50` | 50 |

Inside a slice, each container declares `mem_reservation` (a soft floor: `memory.low`, so the kernel reclaims from
whoever is above their floor first), `cpu_shares` (a weight, not a cap) and `oom_score_adj` (-800 Postgres and
Traefik, -500 the game and Garage, 0 the portfolio, Superset and monitoring, +500 the bots, +800 the pipeline). The
pipeline also gets the one hard CPU cap, `cpus: '2.0'`, because Spark takes every core it sees.

`deploy/backup/resources.sh` runs daily, sums the declared limits per slice through the read-only Docker socket
proxy, and pings an Uptime Kuma push monitor only when everything fits. Over-allocation means no ping, which Kuma
turns into a Discord alert through the webhook that already existed.

## Alternatives
- **Per-container limits only (the status quo):** no floor, no CPU control, and nothing stopping the total from
  exceeding the host once more than one repository sets limits.
- **A shared budget table in the docs plus a CI check:** a convention, and conventions are not enforcement. Kept
  the table (`docs/platform.md`) *and* added the kernel-level ceiling.
- **Swarm mode or Kubernetes** for real scheduling: rejected for the same reasons as ADR-0001.
- **Deriving the guard's budget from each slice's `MemoryHigh`:** would raise a permanent false alarm for `batch`,
  whose pipeline is deliberately sized to run at its ceiling. The guard's budget per slice is therefore an explicit
  number rather than read from the unit file.

## Consequences
- **CPU genuinely self-balances.** `cpu_shares` maps to `cpu.weight`, which is proportional and work-conserving:
  idle capacity is used, and under contention each tier gets its share.
- **Memory does not, and cannot.** Memory is not time-shared, so there is no "balancing" to be had. What the slices
  provide is a floor for the platform, a shared ceiling for all applications together, graceful reclaim through
  `MemoryHigh` (which throttles rather than kills), and a deliberate order of death if it still goes bad.
- The slice budgets over-commit the 8 GB on purpose (2 G floor + 2.5 G + 2.5 G, with a 4 GB swapfile at
  `swappiness=10`): `batch` runs at 04:30, when `apps.slice` is nearly idle. If two applications ever become heavy
  during the day, the number to lower is `batch` in `group_vars/vps.yml`.
- A container that declares no `cgroup_parent` escapes the group ceiling entirely, so the guard reports any
  container it finds outside the slices.
- `SLICE_BUDGETS` in the compose file duplicates the Ansible budgets and can drift; both sides carry a comment
  pointing at the other.
- In non-swarm Compose, `deploy.resources.reservations` is ignored, so the soft floor has to be the service-level
  `mem_reservation` key. Easy to "implement" and have it do nothing.
- This does nothing for Postgres versus Spark disk contention beyond `IOWeight=50`. If that ever hurts, move the
  pipeline's window rather than touching cgroups.
