"""Run bookkeeping in Postgres: warehouse.pipeline_runs holds status, row counts, checks and the extract watermark."""

from __future__ import annotations

import json
from typing import Any

import psycopg

DDL = """
CREATE SCHEMA IF NOT EXISTS {schema};
CREATE TABLE IF NOT EXISTS {schema}.pipeline_runs (
    run_id          bigserial PRIMARY KEY,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    status          text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    full_refresh    boolean NOT NULL DEFAULT false,
    watermark_from  bigint NOT NULL,
    watermark_to    bigint,
    row_counts      jsonb,
    checks          jsonb,
    error           text
);
"""


class RunLog:
    def __init__(self, dsn: str, schema: str = "warehouse"):
        self.conn = psycopg.connect(dsn, autocommit=True)
        self.schema = schema
        self.conn.execute(DDL.format(schema=schema))

    def last_watermark(self) -> int:
        row = self.conn.execute(
            f"SELECT coalesce(max(watermark_to), 0) FROM {self.schema}.pipeline_runs WHERE status = 'success'"
        ).fetchone()
        return int(row[0])

    def start(self, watermark_from: int, full_refresh: bool) -> int:
        # A run that died without finishing (container killed, OOM) is marked failed so it cannot look alive.
        self.conn.execute(
            f"UPDATE {self.schema}.pipeline_runs SET status = 'failed', finished_at = now(), error = 'abandoned' "
            "WHERE status = 'running'"
        )
        row = self.conn.execute(
            f"INSERT INTO {self.schema}.pipeline_runs (status, watermark_from, full_refresh) VALUES ('running', %s, %s) RETURNING run_id",
            (watermark_from, full_refresh),
        ).fetchone()
        return int(row[0])

    def finish(
        self,
        run_id: int,
        status: str,
        watermark_to: int | None,
        row_counts: dict[str, Any],
        checks: list[dict[str, Any]],
        error: str | None = None,
    ) -> None:
        self.conn.execute(
            f"UPDATE {self.schema}.pipeline_runs SET status = %s, finished_at = now(), watermark_to = %s, "
            "row_counts = %s, checks = %s, error = %s WHERE run_id = %s",
            (status, watermark_to, json.dumps(row_counts), json.dumps(checks, default=str), error, run_id),
        )

    def close(self) -> None:
        self.conn.close()
