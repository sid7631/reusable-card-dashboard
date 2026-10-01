import pytest
from sqlalchemy.exc import DBAPIError

from tests.conftest import run_sql

KPI_SQL = "SELECT COUNT(*) AS value FROM transactions WHERE 1=1 {{filters}}"


def card_body(source_id, name="My card", sql=KPI_SQL, **extra):
    return {"name": name, "chart_type": "kpi", "data_source_id": source_id, "sql_text": sql, **extra}


async def test_new_card_is_private_v1(user, seeded):
    res = await user.post("/api/cards", card_body(seeded["source_id"]))
    assert res.status_code == 201
    card = res.json()
    assert (card["scope"], card["access"], card["version_no"]) == ("private", "owner", 1)


async def test_saving_appends_versions_and_keeps_history(user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    v2 = (await user.put(f"/api/cards/{card['id']}", card_body(seeded["source_id"], name="Renamed",
                                                               change_note="rename"))).json()
    assert v2["version_no"] == 2 and v2["name"] == "Renamed"

    history = (await user.get(f"/api/cards/{card['id']}/versions")).json()
    assert [(v["version_no"], v["name"]) for v in history] == [(2, "Renamed"), (1, "My card")]
    v1 = (await user.get(f"/api/cards/{card['id']}", params={"version_id": history[1]["id"]})).json()
    assert v1["name"] == "My card"


async def test_private_cards_are_invisible_to_other_users(user, other_user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    assert card["id"] not in [c["id"] for c in (await other_user.get("/api/cards")).json()]
    assert (await other_user.get(f"/api/cards/{card['id']}")).status_code == 404
    assert (await other_user.get(f"/api/cards/{card['id']}/data")).status_code == 404


async def test_users_cannot_edit_global_cards_but_admins_can(user, admin, seeded):
    target = seeded["cards"]["Product Spend"]
    body = card_body(seeded["source_id"], name=target["name"], sql=target["sql_text"])
    body["chart_type"] = target["chart_type"]
    assert (await user.put(f"/api/cards/{target['id']}", body)).status_code == 403

    updated = (await admin.put(f"/api/cards/{target['id']}", {**body, "change_note": "admin edit"})).json()
    assert updated["version_no"] == target["version_no"] + 1


async def test_only_admins_create_global_assets(user, admin, seeded):
    assert (await user.post("/api/cards", card_body(seeded["source_id"], scope="global"))).status_code == 403
    assert (await admin.post("/api/cards", card_body(seeded["source_id"], scope="global"))).json()["scope"] == "global"


async def test_global_dashboard_cannot_pin_private_card(admin, seeded):
    private_card = (await admin.post("/api/cards", card_body(seeded["source_id"]))).json()
    res = await admin.put(f"/api/dashboards/{seeded['dashboard_id']}/items",
                          {"items": [{"card_id": private_card["id"], "x": 0, "y": 0, "w": 3, "h": 2}]})
    assert res.status_code == 409


async def test_dashboard_pins_card_versions(user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    dash = (await user.post("/api/dashboards", {"name": "Mine"})).json()
    detail = (await user.put(f"/api/dashboards/{dash['id']}/items",
                             {"items": [{"card_id": card["id"], "x": 0, "y": 0, "w": 3, "h": 2}]})).json()
    item = detail["items"][0]
    assert detail["version_no"] == 2 and item["card_version_id"] == card["version_id"]

    # A new card version does not change the dashboard — it is flagged as an available update
    await user.put(f"/api/cards/{card['id']}", card_body(seeded["source_id"], name="Changed"))
    detail = (await user.get(f"/api/dashboards/{dash['id']}")).json()
    assert detail["items"][0]["name"] == "My card"
    assert detail["items"][0]["update_available"] is True

    # Re-saving the layout keeps the existing pin
    moved = (await user.put(f"/api/dashboards/{dash['id']}/items",
                            {"items": [{**{k: item[k] for k in ("item_id", "x", "y", "w", "h")},
                                        "card_id": card["id"], "x": 3}]})).json()
    assert moved["items"][0]["card_version_id"] == card["version_id"] and moved["items"][0]["x"] == 3


async def test_dashboard_viewers_can_render_pinned_cards(user, seeded):
    card = seeded["cards"]["Total AXP Spend"]
    res = await user.get(f"/api/cards/{card['id']}/data", params={
        "dashboard_id": seeded["dashboard_id"], "version_id": card["version_id"],
        "from": "2026-01-01", "to": "2026-06-11"})
    body = res.json()
    assert res.status_code == 200
    assert body["rows"][0]["value"] == pytest.approx(355251661.86)
    assert body["meta"]["deltaPct"] == pytest.approx(13.938, abs=0.01)


async def test_archived_card_hidden_but_dashboards_keep_rendering(user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    dash = (await user.post("/api/dashboards", {"name": "Keeps rendering"})).json()
    await user.put(f"/api/dashboards/{dash['id']}/items", {"items": [{"card_id": card["id"]}]})
    assert (await user.delete(f"/api/cards/{card['id']}")).status_code == 204
    assert card["id"] not in [c["id"] for c in (await user.get("/api/cards")).json()]
    data = await user.get(f"/api/cards/{card['id']}/data", params={"dashboard_id": dash["id"]})
    assert data.status_code == 200 and data.json()["rows"][0]["value"] == 60000


async def test_versions_are_immutable_in_the_database(user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    with pytest.raises(DBAPIError, match="immutable"):
        await run_sql(f"UPDATE asset_versions SET name = 'tampered' WHERE id = {card['version_id']}")


async def test_bad_sql_is_rejected_on_save(user, seeded):
    res = await user.post("/api/cards", card_body(seeded["source_id"], sql="DELETE FROM transactions"))
    assert res.status_code == 400
