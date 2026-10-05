import asyncio
import json
import time

import pytest

from app.core.redis import redis
from app.execution.jobs import source_slot
from tests.test_data_sources import upload_source


async def ops(admin) -> dict:
    return (await admin.get("/api/ops/stats")).json()


def kpi(source_id, sql, name="KPI"):
    return {"name": name, "chart_type": "kpi", "data_source_id": source_id, "sql_text": sql, "created_via": "sql"}


async def test_second_request_is_served_from_cache(user, seeded):
    card = (await user.post("/api/cards", kpi(seeded["source_id"], "SELECT COUNT(*) AS value FROM transactions WHERE 1=1 {{filters}}"))).json()
    first = (await user.get(f"/api/cards/{card['id']}/data", params={"filters": json.dumps({"product": ["Gold"]})})).json()
    second = (await user.get(f"/api/cards/{card['id']}/data", params={"filters": json.dumps({"product": ["Gold"]})})).json()
    assert (first["cached"], second["cached"]) == (False, True)
    assert first["rows"] == second["rows"] and first["as_of"] == second["as_of"] and not second["stale"]


async def test_concurrent_requests_share_one_computation(user, admin, seeded):
    card = (await user.post("/api/cards", kpi(seeded["source_id"],
                                              "SELECT SUM(amount) AS value FROM transactions WHERE 1=1 {{filters}}"))).json()
    before = (await ops(admin)).get("computed", 0)
    params = {"filters": json.dumps({"country": ["Japan"]}), "from": "2025-01-01", "to": "2025-12-31"}
    results = await asyncio.gather(*[user.get(f"/api/cards/{card['id']}/data", params=params) for _ in range(25)])
    assert {r.status_code for r in results} == {200}
    assert len({json.dumps(r.json()["rows"]) for r in results}) == 1
    assert (await ops(admin))["computed"] - before == 1   # 25 viewers, one query (YoY runs inside it)


async def test_stale_results_are_served_then_refreshed(user, seeded):
    card = (await user.post("/api/cards", kpi(seeded["source_id"], "SELECT COUNT(*) AS value FROM transactions WHERE 1=1 {{filters}}"))).json()
    url = f"/api/cards/{card['id']}/data"
    first = (await user.get(url)).json()
    r = redis()
    [key] = [k async for k in r.scan_iter(f"res:{card['version_id']}:*")]
    entry = json.loads(await r.get(key))
    await r.set(key, json.dumps({**entry, "fresh_until": time.time() - 1}))

    stale = (await user.get(url)).json()
    assert stale["stale"] and stale["as_of"] == first["as_of"]
    for _ in range(50):  # the background refresh replaces the entry
        await asyncio.sleep(0.05)
        refreshed = (await user.get(url)).json()
        if not refreshed["stale"]:
            break
    assert not refreshed["stale"] and refreshed["as_of"] > first["as_of"]


async def test_query_errors_reach_every_waiter_and_trip_the_breaker(user, admin):
    source = await upload_source(user)
    bad = (await user.post("/api/cards", kpi(source["id"], "SELECT CAST(region AS INTEGER) AS value FROM sales"))).json()
    results = await asyncio.gather(*[user.get(f"/api/cards/{bad['id']}/data", params={"filters": json.dumps({"n": [str(i)]})})
                                     for i in range(5)])
    assert {r.status_code for r in results} == {400}
    assert "Could not convert" in results[0].json()["detail"] or "Conversion" in results[0].json()["detail"]

    # Five failures against the same source opened the breaker: even a valid card is paused
    good = (await user.post("/api/cards", kpi(source["id"], "SELECT COUNT(*) AS value FROM sales"))).json()
    res = await user.get(f"/api/cards/{good['id']}/data")
    assert res.status_code == 400 and "paused briefly" in res.json()["detail"]


async def test_source_slots_cap_concurrency():
    active, peak = 0, 0

    async def hold():
        nonlocal active, peak
        async with source_slot("test-endpoint", 2):
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.1)
            active -= 1

    await asyncio.gather(*[hold() for _ in range(6)])
    assert peak == 2


def parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((lines["event"], json.loads(lines["data"])))
    return events


async def test_dashboard_renders_in_one_streamed_request(user, seeded):
    dash = (await user.get(f"/api/dashboards/{seeded['dashboard_id']}")).json()
    items = [{"item_id": i["item_id"], "filters": {"segment": ["GCS"]}, "date_from": "2026-01-01", "date_to": "2026-06-11"}
             for i in dash["items"]]
    res = await user.post(f"/api/dashboards/{seeded['dashboard_id']}/render", {"items": items})
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(res.text)
    cards = [d for e, d in events if e == "card"]
    assert events[-1] == ("done", {"count": len(items)})
    assert {c["item_id"] for c in cards} == {i["item_id"] for i in items}
    assert all("rows" in c and "as_of" in c for c in cards)
    total = next(c for c in cards if c["item_id"] == dash["items"][0]["item_id"])
    assert total["rows"][0]["value"] == pytest.approx(120.9e6, rel=0.01) and "deltaPct" in total["meta"]


async def test_render_rejects_items_not_on_the_dashboard(user, other_user, seeded):
    res = await user.post(f"/api/dashboards/{seeded['dashboard_id']}/render", {"items": [{"item_id": "nope"}]})
    assert res.status_code == 422
    mine = (await user.post("/api/dashboards", {"name": "private"})).json()
    assert (await other_user.post(f"/api/dashboards/{mine['id']}/render", {"items": []})).status_code == 404


async def test_ops_stats_are_admin_only(user, admin):
    assert (await user.get("/api/ops/stats")).status_code == 403
    body = await ops(admin)
    assert {"hit_ratio", "compute_ms_p50", "compute_ms_p95"} <= set(body)


async def test_duckdb_lockdown_holds_under_concurrency(user):
    source = await upload_source(user)
    queries = ["SELECT COUNT(*) AS n FROM sales"] * 8 + ["SELECT * FROM read_csv('/etc/hosts')"] * 4
    results = await asyncio.gather(*[user.post("/api/query", {"sql": q, "data_source_id": source["id"]}) for q in queries])
    assert [r.status_code for r in results] == [200] * 8 + [400] * 4


async def test_waiters_recover_from_a_lost_job(user, seeded, monkeypatch):
    from app.execution import jobs

    card = (await user.post("/api/cards", kpi(seeded["source_id"], "SELECT MAX(amount) AS value FROM transactions WHERE 1=1 {{filters}}"))).json()
    real_dispatch, lost = jobs.dispatch, []

    async def lose_first(job, **kwargs):
        if not lost:            # the first dispatch never runs (e.g. a worker died holding it)…
            lost.append(job.key)
            await redis().expire(f"lock:{job.key}", 1)   # …and its lock expires
            return
        await real_dispatch(job, **kwargs)

    monkeypatch.setattr(jobs, "dispatch", lose_first)
    res = await user.get(f"/api/cards/{card['id']}/data")
    assert res.status_code == 200 and res.json()["rows"][0]["value"] > 0 and lost


async def test_a_hung_source_fails_the_job_instead_of_holding_a_worker(user, seeded, monkeypatch):
    from app.execution import jobs

    async def hang(*_args, **_kwargs):
        await asyncio.sleep(3600)

    monkeypatch.setattr(jobs, "run_card", hang)
    monkeypatch.setattr(jobs, "job_deadline_s", lambda _source: 0.5)
    card = (await user.post("/api/cards", kpi(seeded["source_id"], "SELECT 1 AS value"))).json()
    t0 = time.monotonic()
    res = await user.get(f"/api/cards/{card['id']}/data", params={"filters": json.dumps({"n": ["hung"]})})
    assert res.status_code == 400 and res.json()["detail"] == "Query timed out."
    assert time.monotonic() - t0 < 5
