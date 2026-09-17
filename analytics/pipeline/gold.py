"""Gold: star schema (dimensions and facts) plus the aggregates the dashboards read."""

from __future__ import annotations

from pyspark.sql import DataFrame
from pyspark.sql import functions as F

from .config import TIME_ZONE
from .silver import payload


def date_key(col) -> F.Column:
    return F.date_format(col, "yyyyMMdd").cast("int")


def dim_date(events: DataFrame) -> DataFrame:
    bounds = events.agg(F.min("event_date").alias("lo"), F.max("event_date").alias("hi"))
    days = bounds.select(F.explode(F.sequence("lo", "hi")).alias("date"))
    return days.select(
        date_key("date").alias("date_key"),
        "date",
        F.year("date").alias("year"),
        F.month("date").alias("month"),
        F.dayofmonth("date").alias("day"),
        ((F.dayofweek("date") + 5) % 7 + 1).alias("weekday"),
        F.date_format("date", "EEEE").alias("weekday_name"),
        F.weekofyear("date").alias("iso_week"),
        F.dayofweek("date").isin(1, 7).alias("is_weekend"),
    )


def dim_player(events: DataFrame, sessions: DataFrame) -> DataFrame:
    seen = events.filter(F.col("client_id").isNotNull()).groupBy("client_id").agg(
        F.min("occurred_at").alias("first_seen_at"),
        F.max("occurred_at").alias("last_seen_at"),
        F.max("is_bot").alias("is_bot"),
        F.max("is_synthetic").alias("is_synthetic"),
    )
    visits = sessions.groupBy("client_id").agg(
        F.max_by("player_name", "joined_at").alias("latest_name"),
        F.count("*").alias("sessions"),
        F.sum("moves").alias("moves"),
        F.countDistinct("event_date").alias("active_days"),
    )
    return (
        seen.join(visits, "client_id", "left")
        .fillna({"sessions": 0, "moves": 0, "active_days": 0})
        .withColumn("traffic_type", F.when(F.col("is_synthetic"), "synthetic").when(F.col("is_bot"), "bot").otherwise("human"))
    )


def dim_room(events: DataFrame) -> DataFrame:
    created = events.filter(F.col("event_type") == "room_created").groupBy("room_slug").agg(
        F.min("occurred_at").alias("created_at"),
        F.first(payload("pieces_requested", "int")).alias("pieces_requested"),
        F.first(payload("image_width", "int")).alias("image_width"),
        F.first(payload("image_height", "int")).alias("image_height"),
    )
    expired = events.filter(F.col("event_type") == "room_expired").groupBy("room_slug").agg(F.max("occurred_at").alias("expired_at"))
    rooms = events.filter(F.col("room_slug").isNotNull() & F.col("room_type").isNotNull()).groupBy("room_slug").agg(
        F.first("room_type").alias("room_type"),
        F.min("occurred_at").alias("first_event_at"),
        F.countDistinct("puzzle_id").alias("puzzles"),
        F.max("is_synthetic").alias("is_synthetic"),
    )
    return (
        rooms.join(created, "room_slug", "left")
        .join(expired, "room_slug", "left")
        .withColumn("created_at", F.coalesce("created_at", "first_event_at"))
        .drop("first_event_at")
    )


def fact_puzzle(events: DataFrame, moves: DataFrame) -> DataFrame:
    started = events.filter(F.col("event_type") == "puzzle_started").groupBy("puzzle_id").agg(
        F.first("room_slug").alias("room_slug_s"),
        F.first("room_type").alias("room_type_s"),
        F.min("occurred_at").alias("started_at"),
        F.first(payload("source")).alias("source"),
        F.first(payload("pieces", "int")).alias("pieces_s"),
        F.max("is_synthetic").alias("synthetic_s"),
    )
    completed = events.filter(F.col("event_type") == "puzzle_completed").groupBy("puzzle_id").agg(
        F.first("room_slug").alias("room_slug_c"),
        F.first("room_type").alias("room_type_c"),
        F.min("occurred_at").alias("completed_at"),
        F.first(payload("duration_ms", "long")).alias("duration_ms"),
        F.first(payload("pieces", "int")).alias("pieces_c"),
        F.first(F.size(F.from_json(payload("contributors"), "array<struct<client_id:string,name:string,count:int>>"))).alias("contributors"),
        F.max("is_synthetic").alias("synthetic_c"),
    )
    played = moves.groupBy("puzzle_id").agg(
        F.count("*").alias("moves"),
        F.sum(F.col("snapped").cast("int")).alias("snaps"),
        F.sum((F.col("outcome") == "abandoned").cast("int")).alias("abandoned_moves"),
        F.sum("merged_groups").alias("groups_merged"),
        F.countDistinct("client_id").alias("players"),
        F.sum(F.col("is_bot").cast("int")).alias("bot_moves"),
        F.min("grabbed_at").alias("first_move_at"),
        F.max(F.coalesce("ended_at", "grabbed_at")).alias("last_move_at"),
    )
    puzzles = started.join(completed, "puzzle_id", "full_outer").join(played, "puzzle_id", "left")
    moves_col = F.coalesce("moves", F.lit(0))
    bot_moves = F.coalesce("bot_moves", F.lit(0))
    return puzzles.select(
        "puzzle_id",
        F.coalesce("room_slug_s", "room_slug_c").alias("room_slug"),
        F.coalesce("room_type_s", "room_type_c").alias("room_type"),
        date_key(F.to_date(F.from_utc_timestamp(F.coalesce("started_at", "first_move_at", "completed_at"), TIME_ZONE))).alias(
            "date_key"
        ),
        F.coalesce("source", F.lit("unknown")).alias("source"),
        F.coalesce("pieces_s", "pieces_c").alias("pieces"),
        "started_at",
        "first_move_at",
        "completed_at",
        F.col("completed_at").isNotNull().alias("is_completed"),
        "duration_ms",
        moves_col.alias("moves"),
        F.coalesce("snaps", F.lit(0)).alias("snaps"),
        F.coalesce("abandoned_moves", F.lit(0)).alias("abandoned_moves"),
        F.coalesce("groups_merged", F.lit(0)).alias("groups_merged"),
        F.coalesce("players", F.lit(0)).alias("players"),
        "contributors",
        F.when(moves_col > 0, F.round(F.col("snaps") / moves_col, 4)).alias("snap_rate"),
        F.when(F.coalesce("synthetic_s", "synthetic_c", F.lit(False)), "synthetic")
        .when(moves_col == 0, "none")
        .when(bot_moves == moves_col, "bot")
        .when(bot_moves > 0, "mixed")
        .otherwise("human")
        .alias("traffic_type"),
    )


def fact_session(sessions: DataFrame) -> DataFrame:
    return sessions.select(
        "session_key",
        "session_id",
        "client_id",
        "room_slug",
        "room_type",
        date_key("event_date").alias("date_key"),
        "hour_local",
        "weekday",
        "joined_at",
        "left_at",
        "left_reason",
        "duration_ms",
        "players_at_join",
        "moves",
        "snaps",
        "groups_merged",
        "puzzles_played",
        "traffic_type",
    )


def fact_move(moves: DataFrame) -> DataFrame:
    return moves.select(
        "move_id",
        "session_id",
        "client_id",
        "room_slug",
        "room_type",
        "puzzle_id",
        date_key("event_date").alias("date_key"),
        "hour_local",
        "weekday",
        "group_id",
        "group_size_before",
        "group_size_after",
        "grabbed_at",
        "ended_at",
        "outcome",
        "abandon_reason",
        "hold_ms",
        "snapped",
        "frame",
        "merged_groups",
        "traffic_type",
    )


def agg_daily_activity(f_session: DataFrame, f_move: DataFrame) -> DataFrame:
    sessions = f_session.groupBy("date_key", "room_type", "traffic_type").agg(
        F.count("*").alias("sessions"),
        F.countDistinct("client_id").alias("active_players"),
        F.round(F.expr("percentile_approx(duration_ms, 0.5)") / 60000, 2).alias("median_session_min"),
    )
    moves = f_move.groupBy("date_key", "room_type", "traffic_type").agg(
        F.count("*").alias("moves"),
        F.sum(F.col("snapped").cast("int")).alias("snaps"),
        F.round(F.expr("percentile_approx(hold_ms, 0.5)"), 0).alias("median_hold_ms"),
    )
    return (
        sessions.join(moves, ["date_key", "room_type", "traffic_type"], "full_outer")
        .fillna({"sessions": 0, "active_players": 0, "moves": 0, "snaps": 0})
        .withColumn("snap_rate", F.when(F.col("moves") > 0, F.round(F.col("snaps") / F.col("moves"), 4)))
    )


def agg_daily_puzzles(f_puzzle: DataFrame) -> DataFrame:
    return (
        f_puzzle.groupBy("date_key", "room_type", "traffic_type")
        .agg(
            F.count("*").alias("puzzles_started"),
            F.sum((F.col("moves") > 0).cast("int")).alias("puzzles_played"),
            F.sum(F.col("is_completed").cast("int")).alias("puzzles_completed"),
            F.round(F.expr("percentile_approx(duration_ms, 0.5)") / 60000, 2).alias("median_duration_min"),
        )
        .withColumn(
            "completion_rate",
            F.when(F.col("puzzles_played") > 0, F.round(F.col("puzzles_completed") / F.col("puzzles_played"), 4)),
        )
    )


def agg_hourly_heatmap(f_session: DataFrame, f_move: DataFrame) -> DataFrame:
    sessions = f_session.groupBy("weekday", "hour_local", "traffic_type").agg(
        F.count("*").alias("sessions"), F.countDistinct("client_id").alias("players")
    )
    moves = f_move.groupBy("weekday", "hour_local", "traffic_type").agg(F.count("*").alias("moves"))
    return sessions.join(moves, ["weekday", "hour_local", "traffic_type"], "full_outer").fillna(
        {"sessions": 0, "players": 0, "moves": 0}
    )


def agg_difficulty(f_puzzle: DataFrame) -> DataFrame:
    """Completion funnel by puzzle size: started -> played (at least one move) -> completed."""
    return (
        f_puzzle.filter(F.col("pieces").isNotNull())
        .groupBy("pieces", "room_type", "traffic_type")
        .agg(
            F.count("*").alias("started"),
            F.sum((F.col("moves") > 0).cast("int")).alias("played"),
            F.sum(F.col("is_completed").cast("int")).alias("completed"),
            F.round(F.expr("percentile_approx(duration_ms, 0.5)") / 60000, 2).alias("median_duration_min"),
            F.round(F.avg(F.when(F.col("is_completed"), F.col("moves") / F.col("pieces"))), 2).alias("moves_per_piece"),
            F.round(F.avg("snap_rate"), 4).alias("avg_snap_rate"),
        )
        .withColumn("play_rate", F.round(F.col("played") / F.col("started"), 4))
        .withColumn("completion_rate", F.when(F.col("played") > 0, F.round(F.col("completed") / F.col("played"), 4)))
    )
