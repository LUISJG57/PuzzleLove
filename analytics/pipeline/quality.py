"""Data quality checks. `error` failures fail the run before anything is published to the warehouse."""

from __future__ import annotations

from dataclasses import asdict, dataclass

from pyspark.sql import DataFrame
from pyspark.sql import functions as F


@dataclass
class Check:
    name: str
    severity: str  # "error" | "warn"
    passed: bool
    value: float | int | None
    detail: str

    def as_dict(self) -> dict:
        return asdict(self)


def _duplicates(df: DataFrame, key: str) -> int:
    return df.groupBy(key).count().filter(F.col("count") > 1).count()


def run_checks(bronze: DataFrame, events: DataFrame, moves: DataFrame, sessions: DataFrame, f_puzzle: DataFrame) -> list[Check]:
    checks: list[Check] = []

    dup = _duplicates(events, "event_id")
    checks.append(Check("silver_events_unique_event_id", "error", dup == 0, dup, "event_id values appearing more than once"))

    nulls = events.filter(F.col("event_type").isNull() | F.col("occurred_at").isNull() | F.col("event_id").isNull()).count()
    checks.append(Check("silver_events_required_fields", "error", nulls == 0, nulls, "rows missing event_id, event_type or occurred_at"))

    future = events.filter(F.col("occurred_at") > F.current_timestamp() + F.expr("INTERVAL 10 MINUTES")).count()
    checks.append(Check("silver_events_not_in_future", "error", future == 0, future, "events more than 10 minutes in the future"))

    bronze_ids = bronze.select("event_id").distinct().count()
    silver_rows = events.count()
    checks.append(
        Check("bronze_silver_reconciliation", "error", bronze_ids == silver_rows, silver_rows - bronze_ids, "silver rows minus distinct bronze event_ids")
    )

    dup_puzzles = _duplicates(f_puzzle, "puzzle_id")
    checks.append(Check("fact_puzzle_unique_puzzle_id", "error", dup_puzzles == 0, dup_puzzles, "duplicate puzzle_id in fact_puzzle"))

    # A grab can only stay open if the player is still connected; in finished sessions every grab must be resolved.
    finished = sessions.filter(F.col("left_at").isNotNull()).select("session_id", "room_slug", "joined_at", "left_at")
    open_in_finished = (
        moves.filter(F.col("outcome") == "open")
        .join(finished, ["session_id", "room_slug"])
        .filter(F.col("grabbed_at").between(F.col("joined_at"), F.col("left_at")))
        .count()
    )
    total_moves = max(moves.count(), 1)
    ratio = open_in_finished / total_moves
    checks.append(Check("moves_resolved_in_finished_sessions", "warn", ratio <= 0.01, round(ratio, 5), "share of grabs never dropped although the player left"))

    # Merging N pieces into one group takes exactly N-1 merges, if the whole puzzle was tracked.
    tracked = f_puzzle.filter(F.col("is_completed") & F.col("started_at").isNotNull() & (F.col("source") != "unknown"))
    tracked_count = tracked.count()
    inconsistent = tracked.filter(F.col("groups_merged") != F.col("pieces") - 1).count()
    share = inconsistent / tracked_count if tracked_count else 0.0
    checks.append(Check("completed_puzzles_merge_count", "warn", share <= 0.02, round(share, 5), "completed puzzles whose merges != pieces - 1"))

    return checks
