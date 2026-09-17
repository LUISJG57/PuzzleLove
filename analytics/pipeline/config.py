"""Pipeline settings, all from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass

TIME_ZONE = "America/Mexico_City"


@dataclass(frozen=True)
class Config:
    pg_host: str
    pg_port: int
    pg_db: str
    pg_user: str
    pg_password: str
    lake_path: str
    s3_endpoint: str | None
    s3_access_key: str | None
    s3_secret_key: str | None
    s3_region: str
    driver_memory: str
    warehouse_schema: str = "warehouse"

    @property
    def jdbc_url(self) -> str:
        return f"jdbc:postgresql://{self.pg_host}:{self.pg_port}/{self.pg_db}"

    @property
    def jdbc_props(self) -> dict[str, str]:
        return {"user": self.pg_user, "password": self.pg_password, "driver": "org.postgresql.Driver"}

    @property
    def psycopg_dsn(self) -> str:
        return f"host={self.pg_host} port={self.pg_port} dbname={self.pg_db} user={self.pg_user} password={self.pg_password}"

    def table_path(self, layer: str, name: str) -> str:
        return f"{self.lake_path.rstrip('/')}/{layer}/{name}"


def load() -> Config:
    env = os.environ
    return Config(
        pg_host=env.get("PGHOST", "postgres"),
        pg_port=int(env.get("PGPORT", "5432")),
        pg_db=env.get("PGDATABASE", "puzzlelove"),
        pg_user=env.get("PGUSER", "puzzlelove"),
        pg_password=env["PGPASSWORD"],
        # s3a://lake in production; a local directory works for development.
        lake_path=env.get("LAKE_PATH", "s3a://lake"),
        s3_endpoint=env.get("LAKE_S3_ENDPOINT"),
        s3_access_key=env.get("LAKE_ACCESS_KEY_ID"),
        s3_secret_key=env.get("LAKE_SECRET_ACCESS_KEY"),
        s3_region=env.get("LAKE_S3_REGION", "garage"),
        driver_memory=env.get("SPARK_DRIVER_MEMORY", "2g"),
    )
