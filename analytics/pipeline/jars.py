"""Resolves the pipeline's JVM dependencies with Ivy and copies the jars to SPARK_JARS_DIR (run at image build)."""

import os
import shutil
from pathlib import Path

PACKAGES = [
    "io.delta:delta-spark_2.13:4.4.0",
    # Spark 4.2 ships Hadoop 3.5.0; hadoop-aws must match it exactly.
    "org.apache.hadoop:hadoop-aws:3.5.0",
    "org.postgresql:postgresql:42.7.13",
]


def main() -> None:
    from pyspark.sql import SparkSession

    ivy = Path("/tmp/ivy")
    spark = (
        SparkSession.builder.master("local[1]")
        .config("spark.jars.packages", ",".join(PACKAGES))
        .config("spark.jars.ivy", str(ivy))
        .getOrCreate()
    )
    spark.stop()

    target = Path(os.environ.get("SPARK_JARS_DIR", "/opt/spark-jars"))
    target.mkdir(parents=True, exist_ok=True)
    jars = sorted((ivy / "jars").glob("*.jar"))
    for jar in jars:
        shutil.copy2(jar, target / jar.name)
    shutil.rmtree(ivy)
    print(f"copied {len(jars)} jars to {target}")


if __name__ == "__main__":
    main()
