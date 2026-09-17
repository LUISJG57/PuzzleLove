# PuzzleLove data pipeline: PySpark 4.2 + Delta Lake 4.4 on Java 21.
# JVM dependencies are resolved at build time so the pipeline never downloads anything in production.
FROM python:3.13-slim-trixie AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-21-jre-headless procps tzdata \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.15 /uv /usr/local/bin/uv
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    PATH=/opt/venv/bin:$PATH \
    SPARK_JARS_DIR=/opt/spark-jars \
    PYTHONUNBUFFERED=1
WORKDIR /pipeline

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# Resolve Delta, S3A (Garage) and the Postgres JDBC driver once, then keep only the jar files.
COPY pipeline/jars.py pipeline/jars.py
RUN python pipeline/jars.py

COPY pipeline pipeline

# ---------------------------------------------------------------- tests
FROM base AS test
RUN uv sync --frozen --no-install-project
COPY tests tests
CMD ["pytest"]

# ---------------------------------------------------------------- runtime (daily cron)
FROM base AS runtime
ARG SUPERCRONIC_URL=https://github.com/aptible/supercronic/releases/download/v0.2.49/supercronic-linux-amd64
ARG SUPERCRONIC_SHA1SUM=e63c11a9726b775a6a11801e81af4f3fb926aa68
RUN python -c "import hashlib, sys, urllib.request; \
data = urllib.request.urlopen('${SUPERCRONIC_URL}').read(); \
sys.exit('supercronic checksum mismatch') if hashlib.sha1(data).hexdigest() != '${SUPERCRONIC_SHA1SUM}' else None; \
open('/usr/local/bin/supercronic', 'wb').write(data)" \
  && chmod +x /usr/local/bin/supercronic
COPY crontab /etc/pipeline.crontab
ENV TZ=America/Mexico_City
CMD ["supercronic", "-passthrough-logs", "/etc/pipeline.crontab"]
