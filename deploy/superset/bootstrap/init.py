"""
One-shot Superset initialization, safe to run on every deploy:
  1. Postgres: `superset` metadata database and a read-only `warehouse_reader` role (SELECT on schema warehouse).
  2. Superset: metadata migrations, admin user, roles and permissions.
  3. Dashboards as code (dashboards.py), skipped until the pipeline has published the warehouse.
"""

from __future__ import annotations

import os
import subprocess
import sys

import psycopg2
from psycopg2 import sql


def log(msg: str) -> None:
    print(f"[superset-init] {msg}", flush=True)


def setup_postgres() -> None:
    admin = psycopg2.connect(
        host=os.environ.get("PGHOST", "postgres"),
        dbname=os.environ.get("PGDATABASE", "puzzlelove"),
        user=os.environ["PGUSER"],
        password=os.environ["PGPASSWORD"],
    )
    admin.autocommit = True
    cur = admin.cursor()

    def ensure_role(name: str, password: str) -> None:
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (name,))
        verb = "ALTER" if cur.fetchone() else "CREATE"
        # Re-applying the password keeps .env the single source of truth.
        cur.execute(sql.SQL(verb + " ROLE {} LOGIN PASSWORD %s").format(sql.Identifier(name)), (password,))

    ensure_role("superset", os.environ["SUPERSET_DB_PASSWORD"])
    cur.execute("SELECT 1 FROM pg_database WHERE datname = 'superset'")
    if not cur.fetchone():
        cur.execute("CREATE DATABASE superset OWNER superset")
        log("created database superset")

    ensure_role("warehouse_reader", os.environ["WAREHOUSE_READER_PASSWORD"])
    owner = sql.Identifier(os.environ["PGUSER"])
    for statement in [
        "CREATE SCHEMA IF NOT EXISTS warehouse",
        "GRANT USAGE ON SCHEMA warehouse TO warehouse_reader",
        "GRANT SELECT ON ALL TABLES IN SCHEMA warehouse TO warehouse_reader",
        # The pipeline recreates warehouse tables every run; new tables inherit SELECT for the reader.
        "ALTER DEFAULT PRIVILEGES FOR ROLE {owner} IN SCHEMA warehouse GRANT SELECT ON TABLES TO warehouse_reader",
    ]:
        cur.execute(sql.SQL(statement).format(owner=owner))
    # Run bookkeeping stays private: errors can contain internals.
    cur.execute("SELECT to_regclass('warehouse.pipeline_runs') IS NOT NULL")
    if cur.fetchone()[0]:
        cur.execute("REVOKE ALL ON warehouse.pipeline_runs FROM warehouse_reader")
    admin.close()
    log("postgres roles and grants ready")


def superset(*args: str) -> None:
    log("superset " + " ".join(a if "password" not in a.lower() else "***" for a in args[:3]))
    subprocess.run(["superset", *args], check=True)


def main() -> None:
    setup_postgres()
    superset("db", "upgrade")
    existing = subprocess.run(["superset", "fab", "list-users"], capture_output=True, text=True, check=True).stdout
    if "username:admin" not in existing.replace(" ", ""):
        superset(
            "fab", "create-admin",
            "--username", "admin",
            "--firstname", "PuzzleLove",
            "--lastname", "Admin",
            "--email", os.environ.get("SUPERSET_ADMIN_EMAIL", "admin@example.com"),
            "--password", os.environ["SUPERSET_ADMIN_PASSWORD"],
        )
    else:
        subprocess.run(
            ["superset", "fab", "reset-password", "--username", "admin", "--password", os.environ["SUPERSET_ADMIN_PASSWORD"]],
            check=True,
            capture_output=True,
        )
    superset("init")

    from dashboards import build  # noqa: E402  (imported after migrations so the app starts cleanly)

    build()


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(__file__))
    main()
