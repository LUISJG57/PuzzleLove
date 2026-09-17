# Architecture decision records

Each record states the context, the decision, the alternatives considered and the consequences, including the costs
we accepted. All decisions were made in September 2026 for a single 8 GB VPS operated by one person.

| # | Decision |
|---|---|
| [0001](0001-single-vps-docker-compose.md) | One VPS with Docker Compose instead of a managed cloud or Kubernetes |
| [0002](0002-traefik-reverse-proxy.md) | Traefik instead of Nginx as reverse proxy and TLS terminator |
| [0003](0003-single-game-instance.md) | A single game server instance, no load balancing |
| [0004](0004-push-based-cicd.md) | Push-based CI/CD with rollback instead of Watchtower |
| [0005](0005-garage-object-storage.md) | Garage instead of MinIO for S3-compatible storage |
| [0006](0006-encrypted-offsite-backups.md) | age-encrypted backups to Cloudflare R2 |
| [0007](0007-event-tracking-design.md) | Append-only event table with a non-blocking buffered sink |
| [0008](0008-delta-lake-local-spark.md) | Delta Lake on PySpark local mode, batch once a day |
| [0009](0009-postgres-warehouse.md) | Postgres schema as the warehouse, published with a transactional swap |
| [0010](0010-bots-and-synthetic-data.md) | Live bots and synthetic history, always labeled |
| [0011](0011-superset-dashboards-as-code.md) | Superset with a public, aggregate-only dashboard defined as code |
| [0012](0012-ansible-after-manual-hardening.md) | Harden by hand first, then codify with Ansible |
