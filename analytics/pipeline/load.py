"""Publishes gold tables to the Postgres warehouse schema without leaving readers with a half-loaded table."""

from __future__ import annotations

import psycopg
from psycopg import sql
from pyspark.sql import DataFrame
from pyspark.sql.types import TimestampType

from .config import Config

INDEXES = {
    "fact_move": ["date_key", "puzzle_id", "client_id"],
    "fact_session": ["date_key", "client_id"],
    "fact_puzzle": ["date_key", "room_slug"],
    "agg_daily_activity": ["date_key"],
    "agg_daily_puzzles": ["date_key"],
}

PRIMARY_KEYS = {
    "dim_date": "date_key",
    "dim_player": "client_id",
    "dim_room": "room_slug",
    "fact_puzzle": "puzzle_id",
    "fact_session": "session_key",
    "fact_move": "move_id",
}


def publish(cfg: Config, tables: dict[str, DataFrame]) -> dict[str, int]:
    """Writes each table to warehouse._stg_<name> over JDBC, then swaps it in within one transaction."""
    schema = cfg.warehouse_schema
    timestamp_columns: dict[str, list[str]] = {}
    for name, df in tables.items():
        timestamp_columns[name] = [f.name for f in df.schema.fields if isinstance(f.dataType, TimestampType)]
        df.write.mode("overwrite").option("batchsize", "5000").jdbc(cfg.jdbc_url, f"{schema}._stg_{name}", properties=cfg.jdbc_props)

    counts: dict[str, int] = {}
    with psycopg.connect(cfg.psycopg_dsn) as conn, conn.transaction():
        for name in tables:
            target = sql.Identifier(schema, name)
            staging = sql.Identifier(schema, f"_stg_{name}")
            conn.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(target))
            conn.execute(sql.SQL("ALTER TABLE {} RENAME TO {}").format(staging, sql.Identifier(name)))
            # Spark writes naive timestamps; the JVM runs in UTC, so declare them as UTC instants.
            for column in timestamp_columns[name]:
                conn.execute(
                    sql.SQL("ALTER TABLE {} ALTER COLUMN {} TYPE timestamptz USING {} AT TIME ZONE 'UTC'").format(
                        target, sql.Identifier(column), sql.Identifier(column)
                    )
                )
            if name in PRIMARY_KEYS:
                conn.execute(sql.SQL("ALTER TABLE {} ADD PRIMARY KEY ({})").format(target, sql.Identifier(PRIMARY_KEYS[name])))
            for column in INDEXES.get(name, []):
                conn.execute(
                    sql.SQL("CREATE INDEX {} ON {} ({})").format(sql.Identifier(f"{name}_{column}_idx"), target, sql.Identifier(column))
                )
            counts[name] = conn.execute(sql.SQL("SELECT count(*) FROM {}").format(target)).fetchone()[0]
    return counts
