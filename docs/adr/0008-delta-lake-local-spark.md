# ADR-0008: Delta Lake on PySpark local mode, daily batch

**Status:** accepted

## Context
The goal includes practising a lakehouse flow (bronze/silver/gold, Spark, data quality) on hardware that also runs the
game.

## Decision
- **Engine:** PySpark 4.2 in `local[2]` mode with a 2 GB driver.
- **Storage:** Delta Lake 4.4 tables in the Garage `lake` bucket, accessed via S3A.
- **Schedule:** supercronic runs it daily at 04:30, after the backup.
- **Loading:** bronze is incremental by id watermark; silver events use MERGE; derived silver and gold are rebuilt on every run.
- **Dependencies:** JVM jars are resolved at image build time, so nothing is downloaded at run time.

## Alternatives
- **Plain Parquet:** no transactions, no MERGE, no schema enforcement.
- **Hourly runs:** fresher data, but 24 JVM start-ups a day on the game host.
- **dbt on Postgres only:** simpler, but skips Spark and a real object-store lake.

## Consequences
- The image is large (≈5.8 GB uncompressed: JDK, PySpark, AWS SDK bundle).
- About 100 s for 600k events. Dashboards lag by up to a day.
- A full rebuild of gold is simple and correct now; incremental gold is the scaling path.
