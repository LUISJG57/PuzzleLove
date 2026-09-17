"""
Dashboards as code: the warehouse connection, virtual datasets, charts and the public dashboard are declared here and
created or updated through Superset's REST API (in-process test client, no running server needed). Idempotent.
"""

from __future__ import annotations

import json
import os

DATABASE_NAME = "PuzzleLove warehouse"
DASHBOARD_SLUG = "puzzlelove"
DASHBOARD_TITLE = "PuzzleLove · Actividad del juego"

WEEKDAY = "CASE weekday WHEN 1 THEN '1 lun' WHEN 2 THEN '2 mar' WHEN 3 THEN '3 mié' WHEN 4 THEN '4 jue' WHEN 5 THEN '5 vie' WHEN 6 THEN '6 sáb' ELSE '7 dom' END"
TRAFFIC = "CASE traffic_type WHEN 'human' THEN 'Humanos' WHEN 'bot' THEN 'Bots' WHEN 'synthetic' THEN 'Sintético' WHEN 'mixed' THEN 'Humanos' ELSE 'Sin jugadas' END"

# Only aggregates are public: no player names or ids leave the warehouse through these datasets.
DATASETS = {
    "v_daily_activity": f"""
        SELECT d.date, a.room_type, {TRAFFIC} AS traffic, a.sessions, a.active_players, a.moves, a.snaps, a.median_session_min
        FROM warehouse.agg_daily_activity a JOIN warehouse.dim_date d USING (date_key)""",
    "v_daily_puzzles": f"""
        SELECT d.date, CASE p.room_type WHEN 'global' THEN 'Sala global' ELSE 'Salas privadas' END AS room,
               {TRAFFIC} AS traffic, p.puzzles_started, p.puzzles_played, p.puzzles_completed, p.median_duration_min
        FROM warehouse.agg_daily_puzzles p JOIN warehouse.dim_date d USING (date_key)""",
    "v_heatmap": f"""
        SELECT {WEEKDAY} AS day, lpad(hour_local::text, 2, '0') AS hour, {TRAFFIC} AS traffic, sessions, moves
        FROM warehouse.agg_hourly_heatmap""",
    "v_difficulty": f"""
        SELECT CASE WHEN room_type = 'global' THEN '0 · Global 5×5'
                    WHEN pieces <= 36 THEN '1 · 24 piezas' WHEN pieces <= 72 THEN '2 · 48 piezas'
                    WHEN pieces <= 120 THEN '3 · 96 piezas' ELSE '4 · 150 piezas' END AS size,
               {TRAFFIC} AS traffic, started, played, completed, median_duration_min
        FROM warehouse.agg_difficulty""",
}

REQUIRED_TABLES = ["agg_daily_activity", "agg_daily_puzzles", "agg_hourly_heatmap", "agg_difficulty", "dim_date"]


def metric(sql: str, label: str) -> dict:
    return {"expressionType": "SQL", "sqlExpression": sql, "label": label}


def last(period: str) -> list[dict]:
    return [{"clause": "WHERE", "subject": "date", "operator": "TEMPORAL_RANGE", "comparator": period, "expressionType": "SIMPLE"}]


CHARTS = [
    {
        "key": "kpi_sessions",
        "name": "Sesiones (últimos 30 días)",
        "dataset": "v_daily_activity",
        "viz": "big_number_total",
        "size": (4, 30),
        "params": {"metric": metric("SUM(sessions)", "Sesiones"), "adhoc_filters": last("Last month"), "y_axis_format": "SMART_NUMBER"},
    },
    {
        "key": "kpi_completed",
        "name": "Puzzles completados (últimos 30 días)",
        "dataset": "v_daily_puzzles",
        "viz": "big_number_total",
        "size": (4, 30),
        "params": {"metric": metric("SUM(puzzles_completed)", "Completados"), "adhoc_filters": last("Last month"), "y_axis_format": "SMART_NUMBER"},
    },
    {
        "key": "kpi_completion",
        "name": "Tasa de finalización (últimos 30 días)",
        "dataset": "v_daily_puzzles",
        "viz": "big_number_total",
        "size": (4, 30),
        "params": {
            "metric": metric("SUM(puzzles_completed) * 1.0 / NULLIF(SUM(puzzles_played), 0)", "Finalización"),
            "adhoc_filters": last("Last month"),
            "y_axis_format": ".0%",
        },
    },
    {
        "key": "sessions_by_day",
        "name": "Sesiones por día",
        "dataset": "v_daily_activity",
        "viz": "echarts_timeseries_line",
        "size": (6, 50),
        "params": {
            "x_axis": "date",
            "time_grain_sqla": "P1D",
            "metrics": [metric("SUM(sessions)", "Sesiones")],
            "groupby": ["traffic"],
            "adhoc_filters": last("Last quarter"),
            "row_limit": 10000,
            "show_legend": True,
            "legendOrientation": "top",
            "rich_tooltip": True,
            "x_axis_time_format": "smart_date",
            "y_axis_format": "SMART_NUMBER",
            "markerEnabled": False,
        },
    },
    {
        "key": "puzzles_by_day",
        "name": "Puzzles completados por día",
        "dataset": "v_daily_puzzles",
        "viz": "echarts_timeseries_bar",
        "size": (6, 50),
        "params": {
            "x_axis": "date",
            "time_grain_sqla": "P1D",
            "metrics": [metric("SUM(puzzles_completed)", "Completados")],
            "groupby": ["room"],
            "stack": "Stack",
            "adhoc_filters": last("Last quarter"),
            "row_limit": 10000,
            "show_legend": True,
            "legendOrientation": "top",
            "rich_tooltip": True,
            "x_axis_time_format": "smart_date",
            "y_axis_format": "SMART_NUMBER",
        },
    },
    {
        "key": "heatmap",
        "name": "Sesiones por día de la semana y hora (México)",
        "dataset": "v_heatmap",
        "viz": "heatmap_v2",
        "size": (8, 60),
        "params": {
            "x_axis": "hour",
            "groupby": "day",
            "metric": metric("SUM(sessions)", "Sesiones"),
            "sort_x_axis": "alpha_asc",
            "sort_y_axis": "alpha_desc",
            "normalize_across": "heatmap",
            "linear_color_scheme": "schemeBlues",  # one hue, light -> dark: magnitude, not polarity
            "legend_type": "continuous",
            "show_legend": True,
            "show_values": False,
            "xscale_interval": 2,
            "yscale_interval": 1,
            "row_limit": 10000,
        },
    },
    {
        "key": "difficulty",
        "name": "Finalización por tamaño de puzzle",
        "dataset": "v_difficulty",
        "viz": "echarts_timeseries_bar",
        "size": (4, 60),
        "params": {
            "x_axis": "size",
            "x_axis_sort_asc": False,
            "metrics": [metric("SUM(completed) * 1.0 / NULLIF(SUM(played), 0)", "Finalización")],
            "groupby": [],
            "orientation": "horizontal",
            "y_axis_format": ".0%",
            "show_value": True,
            "row_limit": 100,
            "show_legend": False,
            "adhoc_filters": [],
        },
    },
]

INTRO = """### Actividad de PuzzleLove
Datos del warehouse que publica el pipeline diario (Postgres → Delta Lake → PySpark → Postgres).
**Humanos** son jugadores reales; **Bots** juegan en la sala global para mantenerla viva; **Sintético** es historia simulada
con el motor real del juego para demostrar el pipeline mientras llega tráfico real. Usa el filtro *Tráfico* para separarlos."""


class Api:
    def __init__(self, client, token: str):
        self.client = client
        self.headers = {"Authorization": f"Bearer {token}"}

    def call(self, method: str, path: str, body: dict | None = None, ok=(200, 201)):
        res = getattr(self.client, method)(path, json=body, headers=self.headers)
        if res.status_code not in ok:
            raise RuntimeError(f"{method.upper()} {path} -> {res.status_code}: {res.get_data(as_text=True)[:500]}")
        return res.get_json()

    def find(self, resource: str, column: str, value) -> dict | None:
        q = json.dumps({"filters": [{"col": column, "opr": "eq", "value": value}], "page_size": 1})
        rows = self.call("get", f"/api/v1/{resource}/?q={q}")["result"]
        return rows[0] if rows else None

    def upsert(self, resource: str, column: str, value, body: dict) -> int:
        found = self.find(resource, column, value)
        if found:
            self.call("put", f"/api/v1/{resource}/{found['id']}", body)
            return found["id"]
        return self.call("post", f"/api/v1/{resource}/", body)["id"]


def warehouse_ready(uri: str) -> bool:
    import sqlalchemy as sa

    engine = sa.create_engine(uri)
    with engine.connect() as conn:
        found = conn.execute(
            sa.text("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'warehouse' AND table_name = ANY(:names)"),
            {"names": REQUIRED_TABLES},
        ).scalar()
    engine.dispose()
    return found == len(REQUIRED_TABLES)


def grant_public_access(app, dataset_ids: list[int]) -> None:
    """Public (anonymous) users may view the dashboard and query only its datasets."""
    from superset import db, security_manager as sm
    from superset.connectors.sqla.models import SqlaTable

    public = sm.find_role("Public")
    view_perms = [
        ("can_read", "Dashboard"),
        ("can_read", "Chart"),
        ("can_dashboard", "Superset"),
        ("can_explore_json", "Superset"),
        ("can_log", "Superset"),
        ("can_read", "DashboardFilterStateRestApi"),
        ("can_write", "DashboardFilterStateRestApi"),
        ("can_read", "DashboardPermalinkRestApi"),
        ("can_read", "ExploreFormDataRestApi"),
        ("can_time_range", "Api"),
        ("can_query", "Api"),
        ("can_query_form_data", "Api"),
        ("can_read", "Dataset"),
        ("can_read", "CssTemplate"),
        ("can_read", "Annotation"),
    ]
    wanted = [sm.find_permission_view_menu(p, v) for p, v in view_perms]
    for ds in db.session.query(SqlaTable).filter(SqlaTable.id.in_(dataset_ids)):
        wanted.append(sm.add_permission_view_menu("datasource_access", ds.perm))
    public.permissions = [pv for pv in wanted if pv is not None]
    db.session.commit()


def build() -> None:
    from superset.app import create_app

    app = create_app()
    # This app instance only serves the in-process API calls below; the real server keeps CSRF protection.
    app.config["WTF_CSRF_ENABLED"] = False

    @app.before_request
    def _act_as_admin():
        # JWT authenticates the API layer, but table-access checks read Flask-Login's user; make both the admin.
        from flask_login import login_user
        from superset import security_manager

        login_user(security_manager.find_user(username="admin"))

    with app.app_context():
        reader_uri = (
            f"postgresql+psycopg2://warehouse_reader:{os.environ['WAREHOUSE_READER_PASSWORD']}"
            f"@{os.environ.get('PGHOST', 'postgres')}:5432/{os.environ.get('PGDATABASE', 'puzzlelove')}"
        )
        if not warehouse_ready(reader_uri):
            print("[superset-init] warehouse tables not published yet; dashboards will be created on a later deploy", flush=True)
            return

        client = app.test_client()
        login = client.post(
            "/api/v1/security/login",
            json={"username": "admin", "password": os.environ["SUPERSET_ADMIN_PASSWORD"], "provider": "db", "refresh": False},
        )
        api = Api(client, login.get_json()["access_token"])

        database_id = api.upsert(
            "database",
            "database_name",
            DATABASE_NAME,
            {"database_name": DATABASE_NAME, "sqlalchemy_uri": reader_uri, "expose_in_sqllab": True, "allow_run_async": False},
        )

        dataset_ids: dict[str, int] = {}
        for name, query in DATASETS.items():
            found = api.find("dataset", "table_name", name)
            if found:
                api.call("put", f"/api/v1/dataset/{found['id']}?override_columns=true", {"sql": query.strip()})
                api.call("put", f"/api/v1/dataset/{found['id']}/refresh")
                dataset_ids[name] = found["id"]
            else:
                dataset_ids[name] = api.call(
                    "post", "/api/v1/dataset/", {"database": database_id, "schema": "warehouse", "table_name": name, "sql": query.strip()}
                )["id"]

        chart_ids: dict[str, int] = {}
        for c in CHARTS:
            params = {"viz_type": c["viz"], "datasource": f"{dataset_ids[c['dataset']]}__table", **c["params"]}
            chart_ids[c["key"]] = api.upsert(
                "chart",
                "slice_name",
                c["name"],
                {
                    "slice_name": c["name"],
                    "viz_type": c["viz"],
                    "datasource_id": dataset_ids[c["dataset"]],
                    "datasource_type": "table",
                    "params": json.dumps(params),
                },
            )

        dashboard_id = api.upsert(
            "dashboard",
            "slug",
            DASHBOARD_SLUG,
            {
                "dashboard_title": DASHBOARD_TITLE,
                "slug": DASHBOARD_SLUG,
                "published": True,
                "position_json": json.dumps(layout(chart_ids)),
                "json_metadata": json.dumps(metadata(dataset_ids, chart_ids)),
            },
        )
        for chart_id in chart_ids.values():
            api.call("put", f"/api/v1/chart/{chart_id}", {"dashboards": [dashboard_id]})

        grant_public_access(app, list(dataset_ids.values()))
        from superset import db, security_manager as sm
        from superset.models.dashboard import Dashboard

        dash = db.session.query(Dashboard).get(dashboard_id)
        dash.roles = [sm.find_role("Public")]
        db.session.commit()
        print(f"[superset-init] dashboard ready at /superset/dashboard/{DASHBOARD_SLUG}/ with {len(chart_ids)} charts", flush=True)


def layout(chart_ids: dict[str, int]) -> dict:
    by_key = {c["key"]: c for c in CHARTS}
    rows = [["intro"], ["kpi_sessions", "kpi_completed", "kpi_completion"], ["sessions_by_day", "puzzles_by_day"], ["heatmap", "difficulty"]]
    pos: dict = {
        "DASHBOARD_VERSION_KEY": "v2",
        "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
        "GRID_ID": {"type": "GRID", "id": "GRID_ID", "children": [], "parents": ["ROOT_ID"]},
        "HEADER_ID": {"id": "HEADER_ID", "type": "HEADER", "meta": {"text": DASHBOARD_TITLE}},
    }
    for i, keys in enumerate(rows):
        row_id = f"ROW-{i}"
        pos["GRID_ID"]["children"].append(row_id)
        pos[row_id] = {"type": "ROW", "id": row_id, "children": [], "parents": ["ROOT_ID", "GRID_ID"], "meta": {"background": "BACKGROUND_TRANSPARENT"}}
        parents = ["ROOT_ID", "GRID_ID", row_id]
        for key in keys:
            if key == "intro":
                pos[row_id]["children"].append("MARKDOWN-intro")
                pos["MARKDOWN-intro"] = {"type": "MARKDOWN", "id": "MARKDOWN-intro", "children": [], "parents": parents, "meta": {"width": 12, "height": 22, "code": INTRO}}
                continue
            chart = by_key[key]
            cid = f"CHART-{key}"
            pos[row_id]["children"].append(cid)
            pos[cid] = {
                "type": "CHART",
                "id": cid,
                "children": [],
                "parents": parents,
                "meta": {"chartId": chart_ids[key], "width": chart["size"][0], "height": chart["size"][1], "sliceName": chart["name"]},
            }
    return pos


def metadata(dataset_ids: dict[str, int], chart_ids: dict[str, int]) -> dict:
    return {
        "color_scheme": "supersetColors",
        "refresh_frequency": 0,
        "native_filter_configuration": [
            {
                "id": "NATIVE_FILTER-traffic",
                "name": "Tráfico",
                "filterType": "filter_select",
                "type": "NATIVE_FILTER",
                "targets": [{"datasetId": dataset_ids["v_daily_activity"], "column": {"name": "traffic"}}],
                "defaultDataMask": {"filterState": {"value": None}, "extraFormData": {}},
                "controlValues": {"enableEmptyFilter": False, "multiSelect": True, "defaultToFirstItem": False, "inverseSelection": False, "searchAllOptions": False},
                "cascadeParentIds": [],
                "scope": {"rootPath": ["ROOT_ID"], "excluded": []},
                "chartsInScope": list(chart_ids.values()),
                "description": "Humanos, bots o datos sintéticos",
            }
        ],
    }
