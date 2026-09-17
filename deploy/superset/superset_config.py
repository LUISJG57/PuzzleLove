"""Superset configuration for PuzzleLove (loaded from /app/pythonpath)."""

import os

SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]
SQLALCHEMY_DATABASE_URI = (
    f"postgresql+psycopg2://superset:{os.environ['SUPERSET_DB_PASSWORD']}@{os.environ.get('PGHOST', 'postgres')}:5432/superset"
)

REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379")


def _redis_cache(prefix: str, db: int, timeout: int) -> dict:
    return {
        "CACHE_TYPE": "RedisCache",
        "CACHE_DEFAULT_TIMEOUT": timeout,
        "CACHE_KEY_PREFIX": prefix,
        "CACHE_REDIS_URL": f"{REDIS_URL}/{db}",
    }


CACHE_CONFIG = _redis_cache("superset_", 0, 300)
# The warehouse is published once a day, so query results can be cached for an hour.
DATA_CACHE_CONFIG = _redis_cache("superset_data_", 1, 3600)
FILTER_STATE_CACHE_CONFIG = _redis_cache("superset_filter_", 2, 86400)
EXPLORE_FORM_DATA_CACHE_CONFIG = _redis_cache("superset_explore_", 3, 86400)
RATELIMIT_STORAGE_URI = f"{REDIS_URL}/4"

# Dashboards are shared per role; the Public role only gets the public dashboard (granted by the bootstrap).
FEATURE_FLAGS = {"DASHBOARD_RBAC": True}
PUBLIC_ROLE_LIKE = None

# Behind Traefik: trust X-Forwarded-* for scheme and client IP.
ENABLE_PROXY_FIX = True
SESSION_COOKIE_SECURE = os.environ.get("SUPERSET_INSECURE_COOKIES") != "1"
SESSION_COOKIE_SAMESITE = "Lax"

AUTH_RATE_LIMITED = True
AUTH_RATE_LIMIT = "5 per 40 second"

BABEL_DEFAULT_LOCALE = "es"
LANGUAGES = {"es": {"flag": "mx", "name": "Español"}, "en": {"flag": "us", "name": "English"}}

SQLLAB_TIMEOUT = 60
ROW_LIMIT = 10000
