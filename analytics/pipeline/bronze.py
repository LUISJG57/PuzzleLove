"""Bronze: raw analytics_events copied incrementally from Postgres into Delta, one row per source row."""

from __future__ import annotations

from delta.tables import DeltaTable
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from .config import TIME_ZONE, Config

SOURCE_COLUMNS = """
    id, event_id::text AS event_id, event_type, schema_version, occurred_at, ingested_at, session_id, client_id,
    room_slug, room_type, puzzle_id, payload::text AS payload, is_synthetic
"""


def source_max_id(spark: SparkSession, cfg: Config) -> int:
    df = spark.read.jdbc(cfg.jdbc_url, "(SELECT coalesce(max(id), 0) AS max_id FROM analytics_events) t", properties=cfg.jdbc_props)
    return int(df.first()["max_id"])


def read_source(spark: SparkSession, cfg: Config, after_id: int, up_to_id: int) -> DataFrame:
    query = f"(SELECT {SOURCE_COLUMNS} FROM analytics_events WHERE id > {after_id} AND id <= {up_to_id}) src"
    return spark.read.jdbc(
        cfg.jdbc_url,
        query,
        column="id",
        lowerBound=after_id + 1,
        upperBound=up_to_id + 1,
        numPartitions=4,
        properties={**cfg.jdbc_props, "fetchsize": "10000"},
    )


def with_bronze_metadata(df: DataFrame, run_id: int) -> DataFrame:
    return (
        df.withColumn("_run_id", F.lit(run_id))
        .withColumn("_extracted_at", F.current_timestamp())
        .withColumn("ingest_date", F.to_date(F.from_utc_timestamp("ingested_at", TIME_ZONE)))
    )


def extract(spark: SparkSession, cfg: Config, watermark: int, run_id: int, full_refresh: bool = False) -> tuple[int, int]:
    """Appends rows with id in (watermark, current max] and returns (new watermark, rows copied)."""
    path = cfg.table_path("bronze", "events")
    upper = source_max_id(spark, cfg)
    exists = DeltaTable.isDeltaTable(spark, path)

    if exists and not full_refresh:
        # A previous run may have appended these ids and then failed; remove them so re-extracting is idempotent.
        DeltaTable.forPath(spark, path).delete(F.col("id") > watermark)

    if upper <= watermark:
        return watermark, 0

    df = with_bronze_metadata(read_source(spark, cfg, watermark, upper), run_id)
    mode = "overwrite" if full_refresh or not exists else "append"
    (
        df.write.format("delta")
        .mode(mode)
        .option("overwriteSchema", str(full_refresh).lower())
        .partitionBy("ingest_date")
        .save(path)
    )
    copied = spark.read.format("delta").load(path).filter(F.col("_run_id") == run_id).count()
    return upper, copied
