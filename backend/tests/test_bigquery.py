"""BigQuery: dialect-exact SQL (unit) and end-to-end behaviour against the BigQuery emulator.

The end-to-end tests need the emulator:
    docker run -d -p 9050:9050 ghcr.io/goccy/bigquery-emulator --project=spendboard-demo --dataset=analytics
They are skipped when it isn't reachable.
"""

import datetime as dt
import json
import os
import time

import httpx
import pytest

from app.core.config import get_settings
from app.execution.sql import SqlValidationError, bind_filters, validate_sql
from app.governance.specs import DataSourceSpec
from app.semantic.filters import Filters
from app.semantic.query import SemanticQuery, compile_query

EMULATOR = os.environ.get("TEST_BIGQUERY_EMULATOR", "http://localhost:9050")
PROJECT, DATASET = "spendboard-demo", "analytics"

MODEL = {"datasets": [{
    "name": "orders", "time_dimension": "ordered_at",
    "dimensions": [{"name": "region", "column": "region"}, {"name": "channel", "column": "channel"},
                   {"name": "ordered_at", "column": "ordered_at", "type": "timestamp"}],
    "measures": [{"name": "revenue", "expr": "SUM(amount)", "label": "Revenue"}, {"name": "orders", "expr": "COUNT(*)"}],
}]}


def bq_spec(**model) -> DataSourceSpec:
    return DataSourceSpec.model_validate({"type": "bigquery", "bigquery": {"project": PROJECT, "dataset": DATASET,
                                                                             "auth": "adc"}, "model": model or MODEL})


# ---------------------------------------------------------------- dialect-exact SQL
def test_semantic_query_compiles_to_bigquery_sql():
    q = SemanticQuery(dataset="orders", measures=[{"name": "revenue"}], dimensions=[{"name": "ordered_at", "grain": "month"}],
                      filters=[{"dimension": "channel", "values": ["web"]}])
    sql, params, meta = compile_query(bq_spec(), q, Filters.parse(filters_json={"region": ["EMEA"]},
                                                                  date_from="2026-01-01", date_to="2026-03-31"))
    assert sql == ("SELECT FORMAT_DATE('%Y-%m', DATE(`ordered_at`)) AS label, SUM(amount) AS `value`\n"
                   "FROM `orders`\n"
                   "WHERE 1=1 AND CAST(`channel` AS STRING) IN UNNEST(@p1) AND CAST(`region` AS STRING) IN UNNEST(@p2) "
                   "AND `ordered_at` >= TIMESTAMP(@p3) AND `ordered_at` < TIMESTAMP(@p4)\n"
                   "GROUP BY 1\nORDER BY 1 ASC")
    # Timestamp column: the upper bound is the day after the window, exclusive — the whole last day counts
    assert params == [["web"], ["EMEA"], dt.date(2026, 1, 1), dt.date(2026, 4, 1)]
    assert meta == {"applied": ["region", "period"], "ignored": []}


def test_qualified_tables_and_escaping_follow_bigquery_rules():
    model = {"datasets": [{"name": "sales_eu.orders", "dimensions": [{"name": "merchant", "column": "merchant"}],
                           "measures": [{"name": "n", "expr": "COUNT(*)"}]}]}
    q = SemanticQuery(dataset="sales_eu.orders", measures=[{"name": "n"}], filters=[{"dimension": "merchant", "values": ["O'Brien"]}])
    sql, _, _ = compile_query(bq_spec(**model), q, Filters(), editable=True)
    assert "FROM `sales_eu`.`orders`" in sql and "IN ('O\\'Brien')" in sql and "{{filters}}" in sql


def test_raw_sql_cards_bind_filters_with_named_parameters():
    sql, params, meta = bind_filters("SELECT region, SUM(amount) AS v FROM orders WHERE 1=1 {{filters}} GROUP BY 1",
                                     Filters.parse(filters_json={"region": ["APAC"]}), bq_spec())
    assert "CAST(`region` AS STRING) IN UNNEST(@p1)" in sql and params == [["APAC"]] and meta["applied"] == ["region"]


@pytest.mark.parametrize("sql", [
    "EXPORT DATA OPTIONS(uri='gs://bucket/*.csv', format='CSV') AS SELECT 1",
    "SELECT * FROM orders WHERE region = @mine",
    "DECLARE x INT64 DEFAULT 1; SELECT x",
    "CREATE TEMP FUNCTION f() AS (1); SELECT f()",
    "INSERT INTO orders (region) VALUES ('x')",
])
def test_bigquery_writes_scripts_and_parameters_are_rejected(sql):
    with pytest.raises(SqlValidationError):
        validate_sql(sql, "bigquery")


def test_date_columns_keep_an_inclusive_upper_bound():
    model = {"datasets": [{"name": "t", "time_dimension": "d", "dimensions": [{"name": "d", "column": "d", "type": "date"}],
                           "measures": [{"name": "n", "expr": "COUNT(*)"}]}]}
    sql, params, _ = compile_query(bq_spec(**model), SemanticQuery(dataset="t", measures=[{"name": "n"}]),
                                   Filters.parse(date_from="2026-01-01", date_to="2026-01-31"))
    assert "`d` >= @p1 AND `d` <= @p2" in sql and params == [dt.date(2026, 1, 1), dt.date(2026, 1, 31)]


# ---------------------------------------------------------------- end to end (emulator)
def _emulator_up() -> bool:
    try:
        return httpx.get(f"{EMULATOR}/bigquery/v2/projects/{PROJECT}/datasets", timeout=2).status_code < 500
    except httpx.HTTPError:
        return False


emulator = pytest.mark.skipif(not _emulator_up(), reason="BigQuery emulator not running")


@pytest.fixture
def bq(monkeypatch):
    """Point BigQuery sources at the emulator and load a small orders table."""
    from google.api_core.client_options import ClientOptions
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import bigquery

    from app.connectors import bigquery as connector

    monkeypatch.setattr(get_settings(), "bigquery_emulator_host", EMULATOR)
    connector._clients.clear()
    client = bigquery.Client(project=PROJECT, credentials=AnonymousCredentials(), client_options=ClientOptions(api_endpoint=EMULATOR))
    table = bigquery.Table(f"{PROJECT}.{DATASET}.orders", schema=[
        bigquery.SchemaField("region", "STRING"), bigquery.SchemaField("channel", "STRING"),
        bigquery.SchemaField("ordered_at", "TIMESTAMP"), bigquery.SchemaField("amount", "NUMERIC"),
        bigquery.SchemaField("tags", "STRING", mode="REPEATED")])
    client.delete_table(table, not_found_ok=True)
    client.create_table(table)
    rows = [("EMEA", "web", "2025-01-10T09:00:00Z", "100"), ("EMEA", "store", "2026-01-03T10:00:00Z", "120.5"),
            ("APAC", "web", "2026-02-01T23:30:00Z", "200"), ("EMEA", "web", "2026-03-31T22:00:00Z", "80"),
            ("APAC", "store", "2025-02-11T08:00:00Z", "150")]
    assert client.insert_rows_json(table, [{"region": r, "channel": c, "ordered_at": t, "amount": a, "tags": []}
                                           for r, c, t, a in rows]) == []
    yield client
    connector._clients.clear()


def bq_body(**extra):
    return {"type": "bigquery", "bigquery": {"project": PROJECT, "dataset": DATASET, **extra}}


@emulator
async def test_bigquery_source_end_to_end(user, bq):
    key = json.dumps({"type": "service_account", "project_id": PROJECT})  # unused by the emulator, stored encrypted
    test = (await user.post("/api/data-sources/test", {"spec": bq_body(), "credentials": {"secret": key}})).json()
    orders = next(t for t in test["tables"] if t["name"] == "orders")
    assert orders["row_count"] == 5 and "tags" not in {c["name"] for c in orders["columns"]}  # REPEATED skipped
    suggested = next(d for d in test["suggested_model"]["datasets"] if d["name"] == "orders")
    assert suggested["time_dimension"] == "ordered_at"
    assert next(d for d in suggested["dimensions"] if d["name"] == "ordered_at")["type"] == "timestamp"

    created = (await user.post("/api/data-sources", {"name": "Orders (BigQuery)", "spec": {**bq_body(), "model": MODEL},
                                                     "credentials": {"secret": key}})).json()
    assert created["type"] == "bigquery" and created["spec"]["bigquery"]["secret_ref"].startswith("sec:")
    assert key not in json.dumps(created)

    card = (await user.post("/api/cards", {"name": "Revenue by month", "chart_type": "line", "data_source_id": created["id"],
                                           "query": {"dataset": "orders", "measures": [{"name": "revenue"}],
                                                     "dimensions": [{"name": "ordered_at", "grain": "month"}]}})).json()
    data = (await user.get(f"/api/cards/{card['id']}/data", params={
        "filters": json.dumps({"region": ["EMEA"]}), "from": "2026-01-01", "to": "2026-03-31"})).json()
    # 31 March 22:00 is included: the timestamp window runs to the start of 1 April
    assert data["rows"] == [{"label": "2026-01", "value": 120.5}, {"label": "2026-03", "value": 80.0}]
    assert data["meta"]["applied"] == ["region", "period"] and "prevRows" in data["meta"]

    raw = (await user.post("/api/cards", {"name": "By channel", "chart_type": "bar", "data_source_id": created["id"],
                                          "created_via": "sql",
                                          "sql_text": "SELECT channel AS label, SUM(amount) AS value FROM orders WHERE 1=1 {{filters}} GROUP BY 1 ORDER BY 1"})).json()
    rows = (await user.get(f"/api/cards/{raw['id']}/data", params={"filters": json.dumps({"region": ["APAC"]})})).json()["rows"]
    assert rows == [{"label": "store", "value": 150.0}, {"label": "web", "value": 200.0}]

    options = (await user.get(f"/api/cards/{card['id']}/filter-options", params={"dimension": "channel",
                                                                                 "filters": json.dumps({"region": ["APAC"]})})).json()
    assert options["values"] == ["store", "web"]


@emulator
async def test_only_admins_may_use_the_servers_google_identity(user, admin, bq):
    res = await user.post("/api/data-sources", {"name": "x", "spec": {**bq_body(auth="adc"), "model": MODEL}})
    assert res.status_code == 422 and "admins" in res.json()["detail"]
    assert (await user.post("/api/data-sources/test", {"spec": bq_body(auth="adc")})).status_code == 422
    assert (await admin.post("/api/data-sources", {"name": "x", "spec": {**bq_body(auth="adc"), "model": MODEL}})).status_code == 201


@emulator
async def test_key_stays_bound_to_its_project(user, other_user, admin, bq):
    from tests.test_change_requests import submit
    key = json.dumps({"type": "service_account", "project_id": PROJECT})
    mine = (await user.post("/api/data-sources", {"name": "Shared BQ", "spec": {**bq_body(), "model": MODEL},
                                                  "credentials": {"secret": key}})).json()
    req = await submit(user, "data-sources", mine["id"])
    await admin.post(f"/api/change-requests/{req['id']}/approve", {})
    global_id = (await user.get(f"/api/data-sources/{mine['id']}")).json()["fork"]["asset_id"]
    copy_id = (await other_user.post(f"/api/data-sources/{global_id}/fork")).json()["id"]
    moved = await other_user.put(f"/api/data-sources/{copy_id}", {"name": "Elsewhere",
                                                                  "spec": {**bq_body(project="attacker-project"), "model": MODEL}})
    assert moved.status_code == 200 and not moved.json()["has_credentials"]   # the key did not follow


async def test_unreachable_bigquery_fails_within_the_source_timeout(monkeypatch):
    # The client library's default retries would keep a worker busy for ~10 minutes
    from app.connectors import bigquery as bq_connector
    from app.connectors.common import QueryError
    monkeypatch.setattr(get_settings(), "bigquery_emulator_host", "http://127.0.0.1:9")   # nothing listens
    monkeypatch.setattr(get_settings(), "query_timeout_s", 2.0)
    bq_connector._clients.clear()
    t0 = time.monotonic()
    with pytest.raises(QueryError):
        await bq_connector.execute(bq_spec(), "SELECT 1", [])
    assert time.monotonic() - t0 < 15
    bq_connector._clients.clear()
