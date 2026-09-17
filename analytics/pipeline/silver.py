"""Silver: typed, deduplicated events plus two derived entities, moves (grab -> drop) and room sessions (join -> leave)."""

from __future__ import annotations

from delta.tables import DeltaTable
from pyspark.sql import DataFrame, SparkSession, Window
from pyspark.sql import functions as F

from .config import TIME_ZONE, Config

MOVE_EVENTS = ["piece_grabbed", "piece_dropped", "piece_abandoned"]


def json_field(json_col, field: str, cast: str | None = None):
    col = F.get_json_object(json_col, f"$.{field}")
    if cast in ("int", "long"):
        # Producers may serialize whole numbers as floats (e.g. 1500.0); go through double instead of failing.
        return F.round(col.cast("double")).cast(cast)
    return col.cast(cast) if cast else col


def payload(field: str, cast: str | None = None):
    return json_field("payload", field, cast)


def traffic_type(is_synthetic, is_bot):
    return F.when(is_synthetic, "synthetic").when(is_bot, "bot").otherwise("human")


def to_silver_events(bronze: DataFrame) -> DataFrame:
    """Keeps the first copy of each event_id and adds the local calendar fields used everywhere downstream."""
    first = Window.partitionBy("event_id").orderBy("id")
    local_ts = F.from_utc_timestamp("occurred_at", TIME_ZONE)
    return (
        bronze.withColumn("_rank", F.row_number().over(first))
        .filter(F.col("_rank") == 1)
        .select(
            "event_id",
            F.col("id").alias("source_id"),
            "event_type",
            F.col("schema_version").cast("short").alias("schema_version"),
            "occurred_at",
            "ingested_at",
            "session_id",
            "client_id",
            "room_slug",
            "room_type",
            "puzzle_id",
            "payload",
            F.coalesce("is_synthetic", F.lit(False)).alias("is_synthetic"),
            F.coalesce(F.col("client_id").startswith("bot-"), F.lit(False)).alias("is_bot"),
            F.to_date(local_ts).alias("event_date"),
            F.hour(local_ts).alias("hour_local"),
            # 1 = Monday ... 7 = Sunday
            ((F.dayofweek(local_ts) + 5) % 7 + 1).alias("weekday"),
        )
    )


def merge_events(spark: SparkSession, cfg: Config, new_events: DataFrame, full_refresh: bool = False) -> None:
    path = cfg.table_path("silver", "events")
    if full_refresh or not DeltaTable.isDeltaTable(spark, path):
        new_events.write.format("delta").mode("overwrite").option("overwriteSchema", "true").partitionBy("event_date").save(path)
        return
    (
        DeltaTable.forPath(spark, path)
        .alias("t")
        .merge(new_events.alias("s"), "t.event_id = s.event_id")
        .whenNotMatchedInsertAll()
        .execute()
    )


def build_moves(events: DataFrame) -> DataFrame:
    """Pairs every piece_grabbed with the next move event of the same session; a drop or abandon of the same group closes it."""
    move_events = events.filter(F.col("event_type").isin(MOVE_EVENTS) & F.col("session_id").isNotNull()).withColumn(
        "group_id", payload("group_id", "int")
    )
    order = Window.partitionBy("session_id").orderBy("occurred_at", "source_id")
    nxt = move_events.withColumn(
        "next",
        F.lead(F.struct("event_type", "occurred_at", "group_id", "payload")).over(order),
    )
    grabs = nxt.filter(F.col("event_type") == "piece_grabbed")
    closed = F.col("next.event_type").isin("piece_dropped", "piece_abandoned") & (F.col("next.group_id") == F.col("group_id"))
    end_payload = F.col("next.payload")

    return grabs.select(
        F.col("event_id").alias("move_id"),
        "session_id",
        "client_id",
        "room_slug",
        "room_type",
        "puzzle_id",
        "group_id",
        payload("group_size", "int").alias("group_size_before"),
        F.col("occurred_at").alias("grabbed_at"),
        F.when(closed, F.col("next.occurred_at")).alias("ended_at"),
        F.when(closed & (F.col("next.event_type") == "piece_dropped"), "dropped")
        .when(closed, "abandoned")
        .otherwise("open")
        .alias("outcome"),
        F.when(closed, json_field(end_payload, "hold_ms", "long")).alias("hold_ms"),
        F.when(closed, json_field(end_payload, "reason")).alias("abandon_reason"),
        F.coalesce(F.when(closed, json_field(end_payload, "snapped", "boolean")), F.lit(False)).alias("snapped"),
        F.coalesce(F.when(closed, json_field(end_payload, "frame", "boolean")), F.lit(False)).alias("frame"),
        F.coalesce(F.when(closed, json_field(end_payload, "merged_groups", "int")), F.lit(0)).alias("merged_groups"),
        F.when(closed, json_field(end_payload, "group_size", "int")).alias("group_size_after"),
        "event_date",
        "hour_local",
        "weekday",
        "is_bot",
        "is_synthetic",
        traffic_type(F.col("is_synthetic"), F.col("is_bot")).alias("traffic_type"),
    )


def build_sessions(events: DataFrame, moves: DataFrame) -> DataFrame:
    """One row per room visit: a player_joined and the next player_left of the same socket in the same room."""
    presence = events.filter(F.col("event_type").isin("player_joined", "player_left") & F.col("session_id").isNotNull())
    order = Window.partitionBy("session_id", "room_slug").orderBy("occurred_at", "source_id")
    nxt = presence.withColumn("next", F.lead(F.struct("event_type", "occurred_at", "payload")).over(order))
    joins = nxt.filter(F.col("event_type") == "player_joined")
    left = F.col("next.event_type") == "player_left"

    sessions = joins.select(
        F.col("event_id").alias("session_key"),
        "session_id",
        "client_id",
        payload("name").alias("player_name"),
        "room_slug",
        "room_type",
        F.col("occurred_at").alias("joined_at"),
        F.when(left, F.col("next.occurred_at")).alias("left_at"),
        F.when(left, json_field("next.payload", "reason")).alias("left_reason"),
        F.when(left, json_field("next.payload", "duration_ms", "long")).alias("duration_ms"),
        payload("players_in_room", "int").alias("players_at_join"),
        "event_date",
        "hour_local",
        "weekday",
        "is_bot",
        "is_synthetic",
        traffic_type(F.col("is_synthetic"), F.col("is_bot")).alias("traffic_type"),
    )

    m = moves.alias("m")
    s = sessions.alias("s")
    in_session = (
        (F.col("m.session_id") == F.col("s.session_id"))
        & (F.col("m.room_slug") == F.col("s.room_slug"))
        & (F.col("m.grabbed_at") >= F.col("s.joined_at"))
        & (F.col("m.grabbed_at") <= F.coalesce(F.col("s.left_at"), F.lit("9999-12-31").cast("timestamp")))
    )
    stats = (
        s.join(m, in_session, "left")
        .groupBy("s.session_key")
        .agg(
            F.count("m.move_id").alias("moves"),
            F.sum(F.col("m.snapped").cast("int")).alias("snaps"),
            F.sum("m.merged_groups").alias("groups_merged"),
            F.countDistinct("m.puzzle_id").alias("puzzles_played"),
        )
    )
    return sessions.join(stats, "session_key", "left").fillna({"moves": 0, "snaps": 0, "groups_merged": 0, "puzzles_played": 0})


def write_table(df: DataFrame, cfg: Config, layer: str, name: str, partition_by: str | None = None) -> int:
    writer = df.write.format("delta").mode("overwrite").option("overwriteSchema", "true")
    if partition_by:
        writer = writer.partitionBy(partition_by)
    path = cfg.table_path(layer, name)
    writer.save(path)
    return df.sparkSession.read.format("delta").load(path).count()
