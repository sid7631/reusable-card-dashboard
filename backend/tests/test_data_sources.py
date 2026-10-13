import io
import json

import httpx
import pytest
from openpyxl import Workbook

from app.connectors import rest
from app.core.config import get_settings
from tests.test_change_requests import submit

CSV = b"region,product,sold_on,revenue\nEMEA,Gold,2026-01-03,120.5\nEMEA,Green,2026-01-04,80\nAPAC,Gold,2026-02-01,200\n"


async def upload_source(actor, filename="sales.csv", content=CSV, name="Sales CSV") -> dict:
    up = await actor.upload("/api/files", filename, content)
    assert up.status_code == 201, up.text
    meta = up.json()
    res = await actor.post("/api/data-sources", {
        "name": name, "spec": {"type": "file", "file": {"file_id": meta["id"]}, "model": meta["suggested_model"]}})
    assert res.status_code == 201, res.text
    return {**res.json(), "upload": meta}


async def test_csv_upload_becomes_queryable_source(user):
    source = await upload_source(user)
    table = source["upload"]["tables"][0]
    assert table["name"] == "sales" and table["row_count"] == 3
    assert {c["name"] for c in table["columns"]} == {"region", "product", "sold_on", "revenue"}

    model = source["upload"]["suggested_model"]["datasets"][0]
    assert model["time_dimension"] == "sold_on"
    assert {m["name"] for m in model["measures"]} == {"row_count", "total_revenue"}

    card = (await user.post("/api/cards", {
        "name": "Revenue by region", "chart_type": "bar", "data_source_id": source["id"],
        "sql_text": "SELECT region AS label, SUM(revenue) AS value FROM sales GROUP BY label ORDER BY value DESC"})).json()
    rows = (await user.get(f"/api/cards/{card['id']}/data")).json()["rows"]
    assert rows == [{"label": "EMEA", "value": 200.5}, {"label": "APAC", "value": 200.0}]

    datasets = {d["id"]: d for d in (await user.get("/api/datasets")).json()}
    assert datasets[source["id"]]["dialect"] == "duckdb" and datasets[source["id"]]["dimensionValues"]["region"] == ["APAC", "EMEA"]


async def test_excel_sheets_become_tables(user):
    wb = Workbook()
    wb.active.title = "Orders"
    wb.active.append(["Order ID", "Amount"])
    wb.active.append([1, 9.5])
    returns = wb.create_sheet("Returns 2026")
    returns.append(["order_id", "reason"])
    returns.append([1, "damaged"])
    buf = io.BytesIO()
    wb.save(buf)
    up = (await user.upload("/api/files", "book.xlsx", buf.getvalue())).json()
    assert {t["name"]: t["row_count"] for t in up["tables"]} == {"orders": 1, "returns_2026": 1}
    assert [c["name"] for c in up["tables"][0]["columns"]] == ["order_id", "amount"]


async def test_nested_json_is_flattened(user):
    payload = {"data": [{"id": 1, "geo": {"country": "US"}, "tags": ["a"]}, {"id": 2, "geo": {"country": "UK"}, "tags": []}]}
    up = (await user.upload("/api/files", "events.json", json.dumps(payload).encode())).json()
    assert {c["name"] for c in up["tables"][0]["columns"]} == {"id", "geo_country", "tags"}


async def test_bad_upload_is_rejected(user):
    assert (await user.upload("/api/files", "notes.txt", b"hi")).status_code == 400
    assert (await user.upload("/api/files", "broken.json", b"{not json")).status_code == 400


async def test_files_are_private_to_the_uploader(user, other_user):
    up = (await user.upload("/api/files", "mine.csv", CSV)).json()
    spec = {"type": "file", "file": {"file_id": up["id"]}}
    assert (await other_user.post("/api/data-sources", {"name": "x", "spec": spec})).status_code == 422
    assert (await other_user.post("/api/data-sources/test", {"spec": spec})).status_code == 404


async def test_file_sql_cannot_touch_the_filesystem(user):
    source = await upload_source(user)
    for sql in ["SELECT * FROM read_csv('/etc/passwd')", "COPY sales TO '/tmp/x.csv'", "ATTACH '/tmp/x.db'"]:
        res = await user.post("/api/query", {"sql": sql, "data_source_id": source["id"]})
        assert res.status_code == 400, sql


# ---------------------------------------------------------------- postgres with stored credentials
def pg_spec(**overrides) -> dict:
    s = get_settings()
    return {"type": "postgres", "connection": {"host": s.demo_warehouse_host, "port": s.demo_warehouse_port,
                                               "database": "demo_warehouse", "user": "warehouse_reader", **overrides}}


async def test_postgres_source_with_encrypted_credentials(user):
    bad = await user.post("/api/data-sources/test", {"spec": pg_spec(), "credentials": {"secret": "wrong"}})
    assert bad.status_code == 400 and "Authentication failed" in bad.json()["detail"]
    ok = (await user.post("/api/data-sources/test", {"spec": pg_spec(), "credentials": {"secret": "reader"}})).json()
    assert "transactions" in [t["name"] for t in ok["tables"]]

    created = await user.post("/api/data-sources", {"name": "My warehouse", "spec": {
        **pg_spec(), "model": ok["suggested_model"]}, "credentials": {"secret": "reader"}})
    body = created.json()
    assert created.status_code == 201 and '"reader"' not in created.text
    assert body["spec"]["connection"]["secret_ref"].startswith("sec:") and body["has_credentials"]

    # Updating without re-entering the password keeps the stored credential
    updated = (await user.put(f"/api/data-sources/{body['id']}", {"name": "Renamed", "spec": {**pg_spec()}})).json()
    assert updated["version_no"] == 2 and updated["spec"]["connection"]["secret_ref"] == body["spec"]["connection"]["secret_ref"]
    rows = (await user.post("/api/query", {"sql": "SELECT COUNT(*) AS n FROM transactions",
                                           "data_source_id": body["id"]})).json()["rows"]
    assert rows == [{"n": 60000}]


async def test_users_cannot_reference_server_settings(user):
    res = await user.post("/api/data-sources", {"name": "sneaky", "spec": pg_spec(host="env:DATABASE_URL")})
    assert res.status_code == 422


async def test_copy_of_published_source_cannot_redirect_its_credentials(user, other_user, admin):
    mine = (await user.post("/api/data-sources", {"name": "Shared warehouse", "spec": pg_spec(),
                                                  "credentials": {"secret": "reader"}})).json()
    req = await submit(user, "data-sources", mine["id"])
    await admin.post(f"/api/change-requests/{req['id']}/approve", {})
    global_id = (await user.get(f"/api/data-sources/{mine['id']}")).json()["fork"]["asset_id"]

    forked = await other_user.post(f"/api/data-sources/{global_id}/fork")
    assert forked.status_code == 201, forked.text
    copy_id = forked.json()["id"]
    copy = (await other_user.get(f"/api/data-sources/{copy_id}")).json()
    # Same endpoint: the inherited credential may be kept
    same = await other_user.put(f"/api/data-sources/{copy_id}", {"name": "Tweaked", "spec": {**pg_spec(), "model": copy["spec"]["model"]}})
    assert same.status_code == 200
    # Different endpoint without new credentials: the stored password must not follow
    moved = await other_user.put(f"/api/data-sources/{copy_id}", {"name": "Evil", "spec": pg_spec(host="attacker.example.com")})
    assert moved.status_code == 200 and not moved.json()["has_credentials"]
    smuggled = dict(pg_spec(host="attacker.example.com"))
    smuggled["connection"]["secret_ref"] = copy["spec"]["connection"]["secret_ref"]
    res = await other_user.put(f"/api/data-sources/{copy_id}", {"name": "Evil", "spec": smuggled})
    assert not res.json().get("has_credentials", False)  # client-sent refs are ignored


async def test_ssrf_guard_blocks_private_hosts_for_users(user, admin, monkeypatch):
    monkeypatch.setattr(get_settings(), "allow_private_network_sources", False)
    res = await user.post("/api/data-sources/test", {"spec": pg_spec(host="127.0.0.1"), "credentials": {"secret": "reader"}})
    assert res.status_code == 400 and "private network" in res.json()["detail"]
    res = await user.post("/api/data-sources/test", {"spec": {"type": "rest", "rest": {"url": "http://169.254.169.254/latest"}}})
    assert res.status_code == 400
    assert (await admin.post("/api/data-sources/test", {"spec": pg_spec(host="127.0.0.1"),
                                                        "credentials": {"secret": "reader"}})).status_code == 200


# ---------------------------------------------------------------- REST
@pytest.fixture
def fake_api(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        page = int(request.url.params.get("page", "1"))
        items = [{"id": i, "team": {"name": "A" if i % 2 else "B"}, "score": i * 10}
                 for i in range(1 + (page - 1) * 2, min(page * 2, 5) + 1)]
        return httpx.Response(200, json={"result": {"items": items}})

    real = httpx.AsyncClient
    monkeypatch.setattr(rest.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    return seen


def rest_spec(**auth) -> dict:
    return {"type": "rest", "rest": {"url": "https://api.example.com/scores", "records_path": "result.items",
                                     "table": "scores", "auth": auth or {"type": "none"},
                                     "pagination": {"type": "page", "page_param": "page", "size_param": "per_page",
                                                    "page_size": 2, "max_pages": 10}}}


async def test_rest_source_paginates_authenticates_and_queries(user, fake_api):
    test = (await user.post("/api/data-sources/test", {"spec": rest_spec(type="bearer"),
                                                       "credentials": {"secret": "tok-123"}})).json()
    assert {c["name"] for c in test["tables"][0]["columns"]} == {"id", "team_name", "score"}
    assert fake_api[0].headers["Authorization"] == "Bearer tok-123"

    source = (await user.post("/api/data-sources", {"name": "Scores API", "spec": rest_spec(type="bearer"),
                                                    "credentials": {"secret": "tok-123"}})).json()
    assert "tok-123" not in json.dumps(source)
    fake_api.clear()
    rows = (await user.post("/api/query", {"sql": "SELECT team_name, SUM(score) AS total FROM scores GROUP BY 1 ORDER BY 1",
                                           "data_source_id": source["id"]})).json()["rows"]
    assert rows == [{"team_name": "A", "total": 90}, {"team_name": "B", "total": 60}]
    assert [r.url.params["page"] for r in fake_api] == ["1", "2", "3"]   # stops at the short page
    assert all(r.headers["Authorization"] == "Bearer tok-123" for r in fake_api)

    # Within the cache TTL the extract is reused, not re-fetched
    fake_api.clear()
    await user.post("/api/query", {"sql": "SELECT COUNT(*) AS n FROM scores", "data_source_id": source["id"]})
    assert fake_api == []


async def test_legacy_specs_are_served_in_the_current_shape(user, seeded):
    # The seeded demo source may predate the semantic model; clients always get `model`
    for source in (await user.get("/api/data-sources")).json():
        assert "datasets" in source["spec"]["model"]
        assert "tables" not in source["spec"] and "dimensions" not in source["spec"]
    demo_id = next(s["id"] for s in (await user.get("/api/data-sources")).json() if s["name"] == "Demo Warehouse")
    demo = (await user.get(f"/api/data-sources/{demo_id}")).json()
    assert demo["spec"]["model"]["datasets"][0]["name"] == "transactions"


async def test_viewers_can_test_a_saved_source_as_it_is(user, other_user, seeded):
    """An analyst opening a global source sees its connection status; edits they send are ignored, so the
    stored credential can't be pointed elsewhere. Strangers still can't test someone's private source."""
    source = (await user.get(f"/api/data-sources/{seeded['source_id']}")).json()
    ok = await user.post("/api/data-sources/test", {"spec": source["spec"], "data_source_id": seeded["source_id"]})
    assert ok.status_code == 200, ok.text
    assert "transactions" in {t["name"] for t in ok.json()["tables"]}

    redirected = {**source["spec"], "connection": {**source["spec"]["connection"], "host": "attacker.example.com"}}
    still_saved = await user.post("/api/data-sources/test", {"spec": redirected, "data_source_id": seeded["source_id"]})
    assert still_saved.status_code == 200 and "transactions" in {t["name"] for t in still_saved.json()["tables"]}

    mine = (await user.post(f"/api/data-sources/{seeded['source_id']}/fork")).json()   # a private copy
    assert (await other_user.post("/api/data-sources/test", {"spec": source["spec"], "data_source_id": mine["id"]})).status_code == 404


async def test_true_false_columns_filter_with_the_values_offered(user):
    csv = b"campaign,channel,is_active,spend\nA,Email,true,10\nB,Email,false,20\nC,Search,false,30\n"
    source = await upload_source(user, "flags.csv", csv, "Flags")
    query = {"mode": "semantic", "dataset": "flags", "measures": [{"name": "total_spend"}], "dimensions": [], "filters": []}
    card = (await user.post("/api/cards", {"name": "Spend", "chart_type": "kpi", "data_source_id": source["id"],
                                           "query": query, "config": {}})).json()

    offered = (await user.get(f"/api/cards/{card['id']}/filter-options", params={"dimension": "is_active"})).json()["values"]
    assert offered == ["false", "true"]
    for value, total in (("false", 50), ("False", 50), ("TRUE", 10)):
        # as a dashboard / on-card filter …
        res = (await user.get(f"/api/cards/{card['id']}/data", params={"filters": json.dumps({"is_active": [value]})})).json()
        assert res["rows"][0]["value"] == total, value
        # … and as the card's own filter
        own = {**query, "filters": [{"dimension": "is_active", "values": [value]}]}
        res = (await user.post("/api/semantic/query", {"data_source_id": source["id"], "query": own})).json()
        assert res["rows"][0]["value"] == total, value


async def test_a_slow_source_does_not_hold_up_the_source_list(user, seeded, monkeypatch):
    """A source that takes long to read comes back as `loading` within the wait limit, keeps building,
    and is complete on a later call — the other sources aren't held up."""
    import asyncio
    import time
    from app.api import data_sources as ds

    real = ds._catalog

    async def slow(version_id, raw_spec):
        await asyncio.sleep(1.0)
        return await real(version_id, raw_spec)

    monkeypatch.setattr(ds, "_catalog", slow)
    monkeypatch.setattr(ds, "CATALOG_WAIT_S", 0.2)
    ds._catalog_cache.clear()
    started = time.perf_counter()
    first = (await user.get("/api/datasets")).json()
    assert time.perf_counter() - started < 0.9          # sources read side by side, each waited on ≤ 0.2 s
    assert first and all(d.get("loading") for d in first)
    # The builds carry on after the request stopped waiting: a later call finds the warehouse complete
    # (other tests leave many sources on the same warehouse behind, so give it a few seconds)
    for _ in range(50):
        await asyncio.sleep(0.2)
        warehouse = next(d for d in (await user.get("/api/datasets")).json() if d["id"] == seeded["source_id"])
        if not warehouse.get("loading"):
            break
    assert not warehouse.get("loading") and warehouse["tables"]


async def test_kpi_year_on_year_works_when_last_year_was_negative(user):
    csv = b"day,variance\n2025-03-01,-10\n2026-03-01,-5\n"
    source = await upload_source(user, "variance.csv", csv, "Variance")
    query = {"mode": "semantic", "dataset": "variance", "measures": [{"name": "total_variance"}], "dimensions": [], "filters": []}
    card = (await user.post("/api/cards", {"name": "Variance", "chart_type": "kpi", "data_source_id": source["id"],
                                           "query": query, "config": {}})).json()
    meta = (await user.get(f"/api/cards/{card['id']}/data", params={"from": "2026-01-01", "to": "2026-06-30"})).json()["meta"]
    assert meta["prevValue"] == -10 and meta["deltaAbs"] == 5 and meta["deltaPct"] == 50


async def test_seed_skips_bigquery_on_any_emulator_error(monkeypatch, capsys):
    """An emulator that errors mid-load (not just one that isn't running) must not stop the whole seed."""
    from app.seed import __main__ as seed

    def broken(_host):
        raise ValueError("json: string unexpected end of JSON input")

    monkeypatch.setattr(seed.get_settings(), "bigquery_emulator_host", "http://localhost:1", raising=False)
    monkeypatch.setattr(seed, "_load_bigquery_emulator", broken)
    await seed.seed_bigquery_demo()                     # returns instead of raising
    assert "BigQuery demo: skipped" in capsys.readouterr().out
