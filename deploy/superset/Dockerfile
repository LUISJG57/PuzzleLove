# Apache Superset for the PuzzleLove warehouse: Postgres driver, config and the bootstrap that builds the dashboards.
FROM apache/superset:6.1.0
USER root
RUN uv pip install --python /app/.venv/bin/python --no-cache psycopg2-binary==2.9.13
COPY --chown=superset:superset superset_config.py /app/pythonpath/superset_config.py
COPY --chown=superset:superset bootstrap /app/bootstrap
USER superset
