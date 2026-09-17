"""SparkSession with Delta Lake and S3A (Garage) configured for a small single-node run."""

from __future__ import annotations

import os
from pathlib import Path

from pyspark.sql import SparkSession

from .config import Config


def _jars() -> str:
    jars_dir = Path(os.environ.get("SPARK_JARS_DIR", "/opt/spark-jars"))
    return ",".join(str(p) for p in sorted(jars_dir.glob("*.jar")))


def create_session(cfg: Config | None = None, app_name: str = "puzzlelove-pipeline", master: str = "local[2]") -> SparkSession:
    builder = (
        SparkSession.builder.appName(app_name)
        .master(master)
        .config("spark.jars", _jars())
        .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
        .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
        # All timestamps are handled in UTC; local dates are derived explicitly.
        .config("spark.sql.session.timeZone", "UTC")
        .config("spark.sql.shuffle.partitions", "8")
        .config("spark.ui.enabled", "false")
        .config("spark.ui.showConsoleProgress", "false")
        # JDBC converts timestamps with the JVM zone; keep it UTC so timestamptz columns are exact.
        .config("spark.driver.extraJavaOptions", "-Duser.timezone=UTC")
        .config("spark.databricks.delta.schema.autoMerge.enabled", "false")
        .config("spark.driver.memory", cfg.driver_memory if cfg else "1g")
    )
    if cfg and cfg.lake_path.startswith("s3a://"):
        builder = (
            builder.config("spark.hadoop.fs.s3a.endpoint", cfg.s3_endpoint or "")
            .config("spark.hadoop.fs.s3a.endpoint.region", cfg.s3_region)
            .config("spark.hadoop.fs.s3a.access.key", cfg.s3_access_key or "")
            .config("spark.hadoop.fs.s3a.secret.key", cfg.s3_secret_key or "")
            .config("spark.hadoop.fs.s3a.path.style.access", "true")
            .config("spark.hadoop.fs.s3a.connection.ssl.enabled", str((cfg.s3_endpoint or "").startswith("https")).lower())
            .config("spark.hadoop.fs.s3a.aws.credentials.provider", "org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider")
            # Garage has no multi-object delete checksums like AWS; keep requests simple.
            .config("spark.hadoop.fs.s3a.checksum.validation", "false")
        )
    spark = builder.getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    return spark
