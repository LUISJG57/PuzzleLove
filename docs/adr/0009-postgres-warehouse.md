# ADR-0009: Postgres schema as the warehouse

**Status:** accepted

## Context
Dashboards need fast, simple SQL over modeled data. Postgres is already running.

## Decision
Publish gold to a `warehouse` schema as a star schema. Loads write `_stg_*` tables over JDBC and swap them in within one
transaction (rename, convert to `timestamptz`, primary keys, indexes). A read-only `warehouse_reader` role serves
Superset.

## Alternatives
- **ClickHouse or a DuckDB server:** faster columnar scans, at the cost of another service and its memory.
- **Querying Delta directly from dashboards:** needs a query engine running all the time.

## Consequences
- Row counts are small enough that Postgres answers dashboard queries in milliseconds.
- The swap replaces tables, so reader grants come from default privileges, and any views on warehouse tables would be
  dropped (none are used).
