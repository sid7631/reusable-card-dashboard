import json

import pytest

from tests.test_data_sources import upload_source

YTD = {"from": "2026-01-01", "to": "2026-06-11"}


async def demo(user):
    return next(s for s in (await user.get("/api/data-sources")).json() if s["name"] == "Demo Warehouse")


def semantic_card(source_id, query, chart="kpi", name="Semantic card"):
    return {"name": name, "chart_type": chart, "data_source_id": source_id, "query": query, "created_via": "builder"}


async def test_semantic_kpi_matches_sql_card_and_has_yoy(user):
    src = await demo(user)
    card = (await user.post("/api/cards", semantic_card(src["id"], {
        "dataset": "transactions", "measures": [{"name": "total_spend"}]}))).json()
    assert card["query"]["mode"] == "semantic" and card["sql_text"] == ""
    data = (await user.get(f"/api/cards/{card['id']}/data", params=YTD)).json()
    assert data["rows"][0]["value"] == pytest.approx(355251661.86)
    assert data["meta"]["deltaPct"] == pytest.approx(13.938, abs=0.01)
    assert data["meta"]["applied"] == ["period"]


async def test_semantic_time_grain_two_measures_and_static_filter(user):
    src = await demo(user)
    res = await user.post("/api/semantic/query", {"data_source_id": src["id"], "date_from": "2026-01-01", "date_to": "2026-03-31",
                                                  "query": {"dataset": "transactions",
                                                            "measures": [{"name": "total_spend"}, {"agg": "COUNT"}],
                                                            "dimensions": [{"name": "txn_date", "grain": "month"}],
                                                            "filters": [{"dimension": "product", "values": ["Gold"]}]}})
    rows = res.json()["rows"]
    assert [r["label"] for r in rows] == ["2026-01", "2026-02", "2026-03"]
    assert set(rows[0]) == {"label", "Total spend", "count_rows"}


async def test_unknown_names_are_rejected_on_save(user):
    src = await demo(user)
    for query in ({"dataset": "transactions", "measures": [{"name": "nope"}]},
                  {"dataset": "transactions", "measures": [{"name": "total_spend"}], "dimensions": [{"name": "nope"}]},
                  {"dataset": "nope", "measures": [{"agg": "COUNT"}]},
                  {"dataset": "transactions", "measures": [{"name": "total_spend"}], "dimensions": [{"name": "segment", "grain": "month"}]}):
        assert (await user.post("/api/cards", semantic_card(src["id"], query))).status_code == 422, query


async def test_measure_expressions_must_be_plain_aggregates(user):
    source = await upload_source(user)
    model = source["spec"]["model"]
    model["datasets"][0]["measures"].append({"name": "evil", "expr": "(SELECT 1)"})
    upd = await user.put(f"/api/data-sources/{source['id']}", {"name": source["name"], "spec": {**source["spec"], "model": model}})
    assert upd.status_code == 200
    res = await user.post("/api/semantic/query", {"data_source_id": source["id"],
                                                  "query": {"dataset": "sales", "measures": [{"name": "evil"}]}})
    assert res.status_code == 422 and "aggregate" in res.json()["detail"]


async def test_filters_a_source_cannot_bind_are_reported_not_dropped(user):
    source = await upload_source(user)
    card = (await user.post("/api/cards", semantic_card(source["id"], {
        "dataset": "sales", "measures": [{"name": "total_revenue"}], "dimensions": [{"name": "region"}]}, chart="bar"))).json()
    data = (await user.get(f"/api/cards/{card['id']}/data", params={
        "filters": json.dumps({"segment": ["GCS"], "region": ["EMEA"]}), **YTD})).json()
    assert data["rows"] == [{"label": "EMEA", "value": 200.5}]
    assert data["meta"]["applied"] == ["region", "period"] and data["meta"]["ignored"] == ["segment"]


async def test_seeded_dashboard_has_cascading_filters(user, seeded):
    dash = (await user.get(f"/api/dashboards/{seeded['dashboard_id']}")).json()
    assert [(f["id"], f["kind"], f["parent"]) for f in dash["filters"]] == [
        ("segment", "select", None), ("sub_segment", "multi", "segment"), ("period", "period", None)]
    assert "segment" in dash["items"][0]["filterable"]["dimensions"] and dash["items"][0]["filterable"]["time"]

    base = f"/api/dashboards/{seeded['dashboard_id']}/filter-options"
    assert (await user.get(f"{base}/segment")).json()["values"] == ["GCS", "ICS", "USCS"]
    assert (await user.get(f"{base}/sub_segment")).json()["values"] == ["Consumer", "Corporate", "G&L", "MM", "SBS"]
    narrowed = (await user.get(f"{base}/sub_segment", params={"selections": json.dumps({"segment": ["GCS"]})})).json()
    assert narrowed["values"] == ["G&L", "MM", "SBS"]
    assert (await user.get(f"{base}/period")).status_code == 404


async def test_saving_dashboard_filters(user, seeded):
    dash = (await user.post("/api/dashboards", {"name": "Filtered"})).json()
    url = f"/api/dashboards/{dash['id']}/filters"
    ok = await user.put(url, {"filters": [{"id": "country", "dimension": "country", "kind": "multi", "locked": True}]})
    assert ok.status_code == 200 and ok.json()["filters"][0]["locked"] and ok.json()["version_no"] == 2
    cycle = [{"id": "a", "dimension": "x", "parent": "b"}, {"id": "b", "dimension": "y", "parent": "a"}]
    assert (await user.put(url, {"filters": cycle})).status_code == 422
    assert (await user.put(url, {"filters": [{"id": "a", "dimension": "x", "parent": "zzz"}]})).status_code == 422
    assert (await user.put(f"/api/dashboards/{seeded['dashboard_id']}/filters", {"filters": []})).status_code == 403


async def test_card_level_filter_options(user, seeded):
    card = seeded["cards"]["Industry Spend"]
    res = await user.get(f"/api/cards/{card['id']}/filter-options", params={
        "dimension": "sub_segment", "dashboard_id": seeded["dashboard_id"], "filters": json.dumps({"segment": ["USCS"]})})
    assert res.json()["values"] == ["Consumer", "SBS"]


async def test_editable_sql_round_trips_through_the_sql_editor(user):
    src = await demo(user)
    query = {"dataset": "transactions", "measures": [{"name": "total_spend"}], "dimensions": [{"name": "product"}],
             "filters": [{"dimension": "merchant", "values": ["O'Brien", "Amazon"]}]}
    sql = (await user.post("/api/semantic/compile", {"data_source_id": src["id"], "query": query, "editable": True})).json()["sql"]
    assert "'O''Brien'" in sql and "{{filters}}" in sql and "$1" not in sql
    card = await user.post("/api/cards", {"name": "From editor", "chart_type": "bar", "data_source_id": src["id"],
                                          "sql_text": sql, "created_via": "sql"})
    data = (await user.get(f"/api/cards/{card.json()['id']}/data", params={"filters": json.dumps({"segment": ["GCS"]})})).json()
    assert data["rows"] and data["meta"]["applied"] == ["segment"]
