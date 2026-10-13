"""Deleting assets that are in use, restoring them, and moving a card to another data source."""

from tests.test_change_requests import global_card, submit
from tests.test_governance import KPI_SQL, card_body


async def _used_everywhere(user, admin, seeded):
    """A global card on a global dashboard, on the user's own dashboard and on their copy of the global
    dashboard; the user also has an edited copy of the card in review."""
    g = await global_card(admin, seeded, name="Doomed")
    other = seeded["cards"]["Total AXP Spend"]["id"]
    gd = (await admin.post("/api/dashboards", {"name": "Global dash", "scope": "global"})).json()
    await admin.put(f"/api/dashboards/{gd['id']}/items", {"items": [{"card_id": g["id"]}, {"card_id": other}]})
    mine = (await user.post("/api/dashboards", {"name": "Mine"})).json()
    await user.put(f"/api/dashboards/{mine['id']}/items", {"items": [{"card_id": g["id"]}]})
    dash_copy = (await user.post(f"/api/dashboards/{gd['id']}/fork")).json()["id"]
    card_copy = (await user.post(f"/api/cards/{g['id']}/fork")).json()["id"]
    await user.put(f"/api/cards/{card_copy}", card_body(seeded["source_id"], name="Doomed", description="mine"))
    req = await submit(user, "cards", card_copy)
    return g, gd, mine, dash_copy, card_copy, req


async def test_usage_before_deleting(user, admin, seeded):
    g, gd, mine, dash_copy, _, req = await _used_everywhere(user, admin, seeded)
    usage = (await admin.get(f"/api/cards/{g['id']}/usage")).json()
    assert [d["name"] for d in usage["used_by"]] == ["Global dash"]   # the user's dashboards are counted, not named
    assert usage["used_by_others"] == 2 and usage["copies"] == 1
    assert [r["id"] for r in usage["open_requests"]] == [req["id"]]
    # The owner sees their own dashboards by name
    assert {d["name"] for d in (await user.get(f"/api/cards/{g['id']}/usage")).json()["used_by"]} == {
        "Global dash", "Mine", "Global dash"}


async def test_deleted_card_keeps_working_where_it_is(user, admin, seeded):
    g, gd, mine, dash_copy, card_copy, req = await _used_everywhere(user, admin, seeded)
    assert (await admin.delete(f"/api/cards/{g['id']}")).status_code == 204

    for dash_id in (gd["id"], mine["id"], dash_copy):
        detail = (await user.get(f"/api/dashboards/{dash_id}")).json()
        [item] = [i for i in detail["items"] if i["id"] == g["id"]]
        assert item["deleted"] and not item["update_available"]
        assert (await user.get(f"/api/cards/{g['id']}/data", params={"dashboard_id": dash_id})).status_code == 200

    # The dashboard can still be edited with the deleted card on it…
    mine_items = (await user.get(f"/api/dashboards/{mine['id']}")).json()["items"]
    moved = await user.put(f"/api/dashboards/{mine['id']}/items", {"items": [
        {"item_id": mine_items[0]["item_id"], "card_id": g["id"], "w": 6}]})
    assert moved.status_code == 200, moved.text
    # …but it can't be added anywhere new
    fresh = (await user.post("/api/dashboards", {"name": "Fresh"})).json()
    added = await user.put(f"/api/dashboards/{fresh['id']}/items", {"items": [{"card_id": g["id"]}]})
    assert added.status_code == 404
    # Copying a dashboard that has it keeps it
    assert (await admin.post(f"/api/dashboards/{gd['id']}/fork")).status_code in (200, 201)


async def test_copy_of_a_deleted_card_and_its_open_request(user, admin, seeded):
    g, *_, card_copy, req = await _used_everywhere(user, admin, seeded)
    await admin.delete(f"/api/cards/{g['id']}")

    copy = (await user.get(f"/api/cards/{card_copy}")).json()
    assert copy["fork"]["deleted"] and copy["fork"]["name"] == "Doomed" and not copy["fork"]["stale"]

    # The open request can't publish into the deleted card
    detail = (await admin.get(f"/api/change-requests/{req['id']}")).json()
    assert detail["items"][0]["target_deleted"] and not detail["can_approve"]
    assert (await admin.post(f"/api/change-requests/{req['id']}/approve", {})).status_code == 409

    # Sent again, it proposes a new global card
    await user.post(f"/api/change-requests/{req['id']}/withdraw")
    again = await submit(user, "cards", card_copy)
    assert again["items"][0]["type"] == "publish_new"


async def test_restore_brings_it_back(user, admin, seeded):
    g, *_ = await _used_everywhere(user, admin, seeded)
    await admin.delete(f"/api/cards/{g['id']}")
    assert g["id"] in {c["id"] for c in (await admin.get("/api/cards", params={"scope": "deleted"})).json()}
    assert g["id"] not in {c["id"] for c in (await user.get("/api/cards", params={"scope": "deleted"})).json()}
    assert (await user.post(f"/api/cards/{g['id']}/undelete")).status_code == 404   # only admins restore global

    assert (await admin.post(f"/api/cards/{g['id']}/undelete")).status_code == 200
    assert (await user.get(f"/api/cards/{g['id']}")).status_code == 200
    assert g["id"] not in {c["id"] for c in (await admin.get("/api/cards", params={"scope": "deleted"})).json()}


async def test_owner_restores_their_own(user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"], name="Oops"))).json()
    await user.delete(f"/api/cards/{card['id']}")
    deleted = (await user.get("/api/cards", params={"scope": "deleted"})).json()
    assert [c["id"] for c in deleted if c["id"] == card["id"]] and deleted[0]["deleted_at"]
    assert (await user.post(f"/api/cards/{card['id']}/undelete")).status_code == 200


async def test_card_moves_to_another_data_source(user, admin, seeded):
    source = (await admin.get(f"/api/data-sources/{seeded['source_id']}")).json()
    other = (await admin.post("/api/data-sources", {"name": "Second warehouse", "spec": source["spec"],
                                                    "scope": "global"})).json()
    card = (await user.post("/api/cards", card_body(seeded["source_id"], name="Mover"))).json()
    moved = (await user.put(f"/api/cards/{card['id']}", card_body(other["id"], name="Mover", sql=KPI_SQL))).json()
    assert moved["data_source_id"] == other["id"]
    diff = (await user.get(f"/api/cards/{card['id']}/diff", params={"from_no": 1})).json()
    assert "spec.data_source.asset_id" in {c["path"] for c in diff["changes"]}
    assert diff["labels"][f"source:{other['id']}"] == "Second warehouse"


async def test_deleted_data_source_cards_keep_working_but_must_move_to_save(user, admin, seeded):
    # The seeded source (copies made through the API have no stored password); restored afterwards
    source_id = seeded["source_id"]
    card = (await user.post("/api/cards", card_body(source_id, name="On retiring source"))).json()
    assert (await admin.get(f"/api/data-sources/{source_id}/usage")).json()["used_by_others"] >= 1
    await admin.delete(f"/api/data-sources/{source_id}")
    try:
        res = await user.get(f"/api/cards/{card['id']}/data")
        assert res.status_code == 200, res.text        # pinned source version keeps working
        stay = await user.put(f"/api/cards/{card['id']}", card_body(source_id, name="On retiring source", description="x"))
        assert stay.status_code == 404                  # can't save onto it again — choose another source
    finally:
        await admin.post(f"/api/data-sources/{source_id}/undelete")
    assert (await user.put(f"/api/cards/{card['id']}", card_body(source_id, name="On retiring source",
                                                                  description="x"))).status_code == 200


async def test_deleting_a_copy_in_review_withdraws_its_request(user, admin, seeded):
    g = await global_card(admin, seeded, name="Withdrawn with copy")
    copy = (await user.post(f"/api/cards/{g['id']}/fork")).json()["id"]
    await user.put(f"/api/cards/{copy}", card_body(seeded["source_id"], name="Withdrawn with copy", description="x"))
    req = await submit(user, "cards", copy)
    assert (await user.delete(f"/api/cards/{copy}")).status_code == 204

    detail = (await admin.get(f"/api/change-requests/{req['id']}")).json()
    assert detail["status"] == "withdrawn" and not detail["can_approve"]
    assert detail["comments"][-1]["kind"] == "withdrawn" and "was deleted" in detail["comments"][-1]["body"]
    assert (await admin.post(f"/api/change-requests/{req['id']}/approve", {})).status_code == 409
    assert (await user.get(f"/api/cards/{g['id']}")).json()["version"] == "1"     # nothing published


async def test_deleting_a_private_card_bundled_in_a_dashboard_request_withdraws_it(user, admin, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"], name="Bundled"))).json()
    dash = (await user.post("/api/dashboards", {"name": "Bundle"})).json()
    await user.put(f"/api/dashboards/{dash['id']}/items", {"items": [{"card_id": card["id"]}]})
    req = await submit(user, "dashboards", dash["id"])
    await user.delete(f"/api/cards/{card['id']}")
    assert (await admin.get(f"/api/change-requests/{req['id']}")).json()["status"] == "withdrawn"
