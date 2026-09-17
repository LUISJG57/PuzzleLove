from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from itertools import count

import pytest
from pyspark.sql import SparkSession

from pipeline.spark import create_session

BASE = datetime(2026, 9, 10, 18, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="session")
def spark() -> SparkSession:
    session = create_session(master="local[1]", app_name="pipeline-tests")
    yield session
    session.stop()


class EventFactory:
    """Builds bronze-shaped rows; `at` is seconds after BASE."""

    def __init__(self) -> None:
        self.ids = count(1)
        self.rows: list[dict] = []

    def add(self, event_type: str, at: float, *, session=None, client=None, room="global", room_type="global", puzzle="global:1", synthetic=False, event_id=None, **payload):
        source_id = next(self.ids)
        ts = (BASE + timedelta(seconds=at)).replace(tzinfo=None)
        self.rows.append(
            {
                "id": source_id,
                "event_id": event_id or f"00000000-0000-4000-8000-{source_id:012d}",
                "event_type": event_type,
                "schema_version": 1,
                "occurred_at": ts,
                "ingested_at": ts + timedelta(milliseconds=300),
                "session_id": session,
                "client_id": client,
                "room_slug": room,
                "room_type": room_type,
                "puzzle_id": puzzle,
                "payload": json.dumps(payload),
                "is_synthetic": synthetic,
            }
        )
        return self

    def df(self, spark: SparkSession):
        schema = (
            "id long, event_id string, event_type string, schema_version int, occurred_at timestamp, ingested_at timestamp, "
            "session_id string, client_id string, room_slug string, room_type string, puzzle_id string, payload string, is_synthetic boolean"
        )
        return spark.createDataFrame(self.rows, schema)


@pytest.fixture
def events() -> EventFactory:
    return EventFactory()
