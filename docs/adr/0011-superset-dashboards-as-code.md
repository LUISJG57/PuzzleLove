# ADR-0011: Superset with a public dashboard defined as code

**Status:** accepted

## Context
Besides the in-app admin dashboard, a shareable BI view is wanted without exposing personal data or admin tooling.

## Decision
Apache Superset 6.1 with Redis caching. `superset-init` runs on every deploy and:
- creates the metadata database and the read-only warehouse role;
- creates the admin user;
- creates, through the REST API:
  - the warehouse connection;
  - aggregate-only virtual datasets;
  - seven charts;
  - a dashboard assigned to the **Public** role, using `DASHBOARD_RBAC` and minimal permissions.

## Alternatives
- **Build dashboards by hand and export them:** not reproducible on a fresh host without manual steps.
- **Superset without public access:** every viewer would need an account.
- **Metabase:** simpler to set up, less common in data-engineering roles.

## Consequences
- A new VPS gets the same dashboard automatically once the warehouse exists.
- Manual edits to managed charts are overwritten on the next deploy.
- About 450 MB of RAM for Superset, plus a small Redis.
