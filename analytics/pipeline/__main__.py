"""
PuzzleLove data pipeline.

    python -m pipeline run                 incremental: new events -> bronze -> silver -> gold -> warehouse
    python -m pipeline run --full-refresh  rebuild every layer from the whole analytics_events table
"""

from __future__ import annotations

import argparse
import sys
import time
import traceback

from . import bronze, gold, silver
from .config import load
from .load import publish
from .quality import run_checks
from .runs import RunLog
from .spark import create_session


def log(msg: str) -> None:
    print(f"[pipeline] {time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}", flush=True)


def run(full_refresh: bool) -> int:
    cfg = load()
    runs = RunLog(cfg.psycopg_dsn, cfg.warehouse_schema)
    watermark = 0 if full_refresh else runs.last_watermark()
    run_id = runs.start(watermark, full_refresh)
    counts: dict[str, int] = {}
    checks: list[dict] = []
    started = time.time()
    spark = None
    try:
        spark = create_session(cfg)
        log(f"run {run_id}: extracting ids > {watermark}{' (full refresh)' if full_refresh else ''}")
        new_watermark, counts["bronze_new_rows"] = bronze.extract(spark, cfg, watermark, run_id, full_refresh)

        bronze_all = spark.read.format("delta").load(cfg.table_path("bronze", "events"))
        new_rows = bronze_all if full_refresh else bronze_all.filter(bronze_all["_run_id"] == run_id)
        silver.merge_events(spark, cfg, silver.to_silver_events(new_rows), full_refresh)
        events = spark.read.format("delta").load(cfg.table_path("silver", "events"))
        counts["silver_events"] = events.count()
        log(f"bronze +{counts['bronze_new_rows']} rows, silver events {counts['silver_events']}")

        counts["silver_moves"] = silver.write_table(silver.build_moves(events), cfg, "silver", "moves", "event_date")
        moves = spark.read.format("delta").load(cfg.table_path("silver", "moves"))
        counts["silver_sessions"] = silver.write_table(silver.build_sessions(events, moves), cfg, "silver", "sessions")
        sessions = spark.read.format("delta").load(cfg.table_path("silver", "sessions"))

        builders = {
            "dim_date": lambda: gold.dim_date(events),
            "dim_player": lambda: gold.dim_player(events, sessions),
            "dim_room": lambda: gold.dim_room(events),
            "fact_puzzle": lambda: gold.fact_puzzle(events, moves),
            "fact_session": lambda: gold.fact_session(sessions),
            "fact_move": lambda: gold.fact_move(moves),
        }
        tables = {}
        for name, build in builders.items():
            counts[f"gold_{name}"] = silver.write_table(build(), cfg, "gold", name)
            tables[name] = spark.read.format("delta").load(cfg.table_path("gold", name))

        aggregates = {
            "agg_daily_activity": lambda: gold.agg_daily_activity(tables["fact_session"], tables["fact_move"]),
            "agg_daily_puzzles": lambda: gold.agg_daily_puzzles(tables["fact_puzzle"]),
            "agg_hourly_heatmap": lambda: gold.agg_hourly_heatmap(tables["fact_session"], tables["fact_move"]),
            "agg_difficulty": lambda: gold.agg_difficulty(tables["fact_puzzle"]),
        }
        for name, build in aggregates.items():
            counts[f"gold_{name}"] = silver.write_table(build(), cfg, "gold", name)
            tables[name] = spark.read.format("delta").load(cfg.table_path("gold", name))
        log("gold tables written: " + ", ".join(f"{k.removeprefix('gold_')}={v}" for k, v in counts.items() if k.startswith("gold_")))

        results = run_checks(bronze_all, events, moves, sessions, tables["fact_puzzle"])
        checks = [c.as_dict() for c in results]
        for c in results:
            log(f"check {'PASS' if c.passed else 'FAIL'} [{c.severity}] {c.name} = {c.value}")
        failed = [c.name for c in results if c.severity == "error" and not c.passed]
        if failed:
            raise RuntimeError(f"quality checks failed: {', '.join(failed)}")

        warehouse_counts = publish(cfg, tables)
        mismatched = [n for n, c in warehouse_counts.items() if c != counts[f"gold_{n}"]]
        checks.append(
            {"name": "warehouse_row_counts_match_gold", "severity": "error", "passed": not mismatched, "value": len(mismatched), "detail": ", ".join(mismatched)}
        )
        if mismatched:
            raise RuntimeError(f"warehouse row counts differ from gold: {', '.join(mismatched)}")

        counts["duration_s"] = round(time.time() - started)
        runs.finish(run_id, "success", new_watermark, counts, checks)
        log(f"run {run_id} succeeded in {counts['duration_s']} s; watermark {watermark} -> {new_watermark}")
        return 0
    except Exception as err:
        counts["duration_s"] = round(time.time() - started)
        runs.finish(run_id, "failed", None, counts, checks, f"{err}\n{traceback.format_exc()}"[:8000])
        summary = next((line for line in str(err).splitlines() if line.strip()), type(err).__name__)
        log(f"run {run_id} FAILED: {summary}")
        return 1
    finally:
        if spark:
            spark.stop()
        runs.close()


def main() -> None:
    parser = argparse.ArgumentParser(prog="pipeline")
    sub = parser.add_subparsers(dest="command", required=True)
    run_cmd = sub.add_parser("run", help="run the pipeline")
    run_cmd.add_argument("--full-refresh", action="store_true", help="rebuild all layers from scratch")
    args = parser.parse_args()
    if args.command == "run":
        sys.exit(run(args.full_refresh))


if __name__ == "__main__":
    main()
