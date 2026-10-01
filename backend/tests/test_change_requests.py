import pytest

from tests.conftest import Actor
from tests.test_governance import KPI_SQL, card_body


async def global_card(admin: Actor, seeded, **extra) -> dict:
    res = await admin.post("/api/cards", card_body(seeded["source_id"], name=extra.pop("name", "Global KPI"),
                                                   scope="global", **extra))
    assert res.status_code == 201
    return res.json()


async def submit(actor: Actor, kind: str, asset_id: int, title="Please publish") -> dict:
    res = await actor.post("/api/change-requests", {"kind": kind, "asset_id": asset_id, "title": title})
    assert res.status_code == 201, res.text
    return res.json()


async def test_fork_creates_one_private_copy_with_lineage(user, admin, seeded):
    g = await global_card(admin, seeded)
    first = await user.post(f"/api/cards/{g['id']}/fork")
    again = await user.post(f"/api/cards/{g['id']}/fork")
    assert first.status_code == 201 and again.status_code == 200 and first.json()["id"] == again.json()["id"]
    copy = (await user.get(f"/api/cards/{first.json()['id']}")).json()
    assert copy["scope"] == "private" and copy["access"] == "owner"
    assert copy["fork"] == {"asset_id": g["id"], "name": g["name"], "base_version_no": 1,
                            "global_version_no": 1, "stale": False}


async def test_publish_new_card(user, admin, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"], name="Fresh idea"))).json()
    req = await submit(user, "cards", card["id"])
    assert req["status"] == "pending" and [i["type"] for i in req["items"]] == ["publish_new"]
    assert (await user.get(f"/api/cards/{card['id']}")).json()["pending_request_id"] == req["id"]

    # Users can't approve; admins can
    assert (await user.post(f"/api/change-requests/{req['id']}/approve", {})).status_code == 403
    done = (await admin.post(f"/api/change-requests/{req['id']}/approve", {"comment": "Nice"})).json()
    assert done["status"] == "approved" and done["reviewed_by_name"]

    published = [c for c in (await user.get("/api/cards", params={"scope": "global"})).json() if c["name"] == "Fresh idea"]
    assert len(published) == 1 and published[0]["version_no"] == 1
    # The private card now tracks the global one, so later edits become update proposals
    mine = (await user.get(f"/api/cards/{card['id']}")).json()
    assert mine["fork"]["asset_id"] == published[0]["id"] and mine["pending_request_id"] is None


async def test_cannot_submit_while_already_in_review(user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    await submit(user, "cards", card["id"])
    res = await user.post("/api/change-requests", {"kind": "cards", "asset_id": card["id"], "title": "again"})
    assert res.status_code == 409


async def test_dashboard_bundle_publishes_private_cards_and_rewrites_refs(user, admin, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"], name="Bundled card"))).json()
    dash = (await user.post("/api/dashboards", {"name": "Bundled dash"})).json()
    await user.put(f"/api/dashboards/{dash['id']}/items", {"items": [
        {"card_id": card["id"]}, {"card_id": seeded["cards"]["Total AXP Spend"]["id"]}]})

    req = await submit(user, "dashboards", dash["id"])
    assert [(i["kind"], i["type"]) for i in req["items"]] == [("card", "publish_new"), ("dashboard", "publish_new")]
    await admin.post(f"/api/change-requests/{req['id']}/approve", {})

    g_dash = next(d for d in (await user.get("/api/dashboards", params={"scope": "global"})).json() if d["name"] == "Bundled dash")
    items = (await user.get(f"/api/dashboards/{g_dash['id']}")).json()["items"]
    assert {i["name"] for i in items} == {"Bundled card", "Total AXP Spend"}
    assert all(i["scope"] == "global" for i in items)


async def test_update_existing_via_fork(user, admin, seeded):
    g = await global_card(admin, seeded)
    copy_id = (await user.post(f"/api/cards/{g['id']}/fork")).json()["id"]
    await user.put(f"/api/cards/{copy_id}", card_body(seeded["source_id"], name="Global KPI", description="Better words"))
    req = await submit(user, "cards", copy_id, "Clarify description")
    [item] = req["items"]
    assert item["type"] == "update_existing" and item["target_asset_id"] == g["id"]
    assert [c["path"] for c in item["changes"]] == ["description"]

    await admin.post(f"/api/change-requests/{req['id']}/approve", {})
    updated = (await user.get(f"/api/cards/{g['id']}")).json()
    assert updated["version_no"] == 2 and updated["description"] == "Better words"
    history = (await user.get(f"/api/cards/{g['id']}/versions")).json()
    assert history[0]["change_note"].endswith(f"(request #{req['id']})")
    assert history[0]["created_by"] == (await user.get("/api/me")).json()["id"]  # requester is the author


async def test_stale_request_merges_non_conflicting_changes(user, admin, seeded):
    g = await global_card(admin, seeded, sql="SELECT COUNT(*) AS value\nFROM transactions\nWHERE 1=1 {{filters}}")
    copy_id = (await user.post(f"/api/cards/{g['id']}/fork")).json()["id"]
    await user.put(f"/api/cards/{copy_id}", card_body(
        seeded["source_id"], name="Global KPI", sql="SELECT COUNT(*) AS value\nFROM transactions\nWHERE amount > 0 {{filters}}"))
    req = await submit(user, "cards", copy_id)

    # Meanwhile an admin changes something else on the global card
    await admin.put(f"/api/cards/{g['id']}", card_body(seeded["source_id"], name="Global KPI", description="Admin note",
                                                       sql=g["sql_text"]))
    detail = (await admin.get(f"/api/change-requests/{req['id']}")).json()
    assert detail["items"][0]["stale"] and not detail["has_conflicts"] and detail["can_approve"]

    await admin.post(f"/api/change-requests/{req['id']}/approve", {})
    merged = (await user.get(f"/api/cards/{g['id']}")).json()
    assert merged["version_no"] == 3 and merged["description"] == "Admin note" and "amount > 0" in merged["sql_text"]


async def test_conflict_blocks_approval_until_requester_updates_from_global(user, admin, seeded):
    g = await global_card(admin, seeded)
    copy_id = (await user.post(f"/api/cards/{g['id']}/fork")).json()["id"]
    await user.put(f"/api/cards/{copy_id}", card_body(seeded["source_id"], name="User title"))
    req = await submit(user, "cards", copy_id)
    await admin.put(f"/api/cards/{g['id']}", card_body(seeded["source_id"], name="Admin title"))

    detail = (await admin.get(f"/api/change-requests/{req['id']}")).json()
    assert detail["has_conflicts"] and not detail["can_approve"]
    assert (await admin.post(f"/api/change-requests/{req['id']}/approve", {})).status_code == 409

    preview = (await user.get(f"/api/cards/{copy_id}/rebase")).json()
    assert preview["stale"] and [c["path"] for c in preview["conflicts"]] == ["name"]
    assert (await user.post(f"/api/cards/{copy_id}/rebase", {})).status_code == 409   # unresolved
    res = await user.post(f"/api/cards/{copy_id}/rebase", {"resolutions": {"name": "ours"}})
    assert res.status_code == 200

    # The open request now proposes the rebased version and merges cleanly
    detail = (await admin.get(f"/api/change-requests/{req['id']}")).json()
    assert not detail["items"][0]["stale"] and detail["can_approve"]
    await admin.post(f"/api/change-requests/{req['id']}/approve", {})
    assert (await user.get(f"/api/cards/{g['id']}")).json()["name"] == "User title"


async def test_request_visibility_reject_and_withdraw(user, other_user, admin, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    req = await submit(user, "cards", card["id"])
    assert (await other_user.get(f"/api/change-requests/{req['id']}")).status_code == 404
    assert req["id"] not in [r["id"] for r in (await other_user.get("/api/change-requests")).json()]
    assert req["id"] in [r["id"] for r in (await admin.get("/api/change-requests", params={"status": "pending"})).json()]

    assert (await admin.post(f"/api/change-requests/{req['id']}/reject", {"comment": ""})).status_code == 422
    rejected = (await admin.post(f"/api/change-requests/{req['id']}/reject", {"comment": "Duplicate"})).json()
    assert rejected["status"] == "rejected" and rejected["review_comment"] == "Duplicate"

    # After a rejection the user can resubmit, and withdraw
    again = await submit(user, "cards", card["id"])
    assert (await other_user.post(f"/api/change-requests/{again['id']}/withdraw")).status_code == 404
    assert (await user.post(f"/api/change-requests/{again['id']}/withdraw")).json()["status"] == "withdrawn"


async def test_updating_an_open_request_picks_up_new_versions(user, admin, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"], name="Draft"))).json()
    req = await submit(user, "cards", card["id"])
    await user.put(f"/api/cards/{card['id']}", card_body(seeded["source_id"], name="Draft v2"))
    assert req["items"][0]["source_version_no"] == 1
    updated = (await user.post(f"/api/change-requests/{req['id']}/update")).json()
    assert updated["items"][0]["source_version_no"] == 2 and updated["items"][0]["name"] == "Draft v2"


async def test_cannot_bundle_someone_elses_private_card(user, other_user, seeded):
    theirs = (await other_user.post("/api/cards", card_body(seeded["source_id"]))).json()
    await other_user.put(f"/api/cards/{theirs['id']}/shares/{(await user.get('/api/me')).json()['id']}", {"permission": "view"})
    dash = (await user.post("/api/dashboards", {"name": "Borrowed"})).json()
    await user.put(f"/api/dashboards/{dash['id']}/items", {"items": [{"card_id": theirs["id"]}]})
    res = await user.post("/api/change-requests", {"kind": "dashboards", "asset_id": dash["id"], "title": "x"})
    assert res.status_code == 422


async def test_reviewer_can_preview_proposed_card(user, admin, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    req = await submit(user, "cards", card["id"])
    res = await admin.get(f"/api/change-requests/{req['id']}/items/{req['items'][0]['id']}/data")
    assert res.status_code == 200 and res.json()["rows"][0]["value"] == 60000
    assert (await admin.get(f"/api/cards/{card['id']}")).status_code == 404  # still private outside the request


async def test_apply_card_updates_on_dashboard(user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"], name="Pinned"))).json()
    dash = (await user.post("/api/dashboards", {"name": "Pins"})).json()
    await user.put(f"/api/dashboards/{dash['id']}/items", {"items": [{"card_id": card["id"]}]})
    assert (await user.post(f"/api/dashboards/{dash['id']}/apply-updates", {})).status_code == 409

    await user.put(f"/api/cards/{card['id']}", card_body(seeded["source_id"], name="Pinned v2", sql=KPI_SQL))
    detail = (await user.post(f"/api/dashboards/{dash['id']}/apply-updates", {})).json()
    assert detail["items"][0]["name"] == "Pinned v2" and not detail["items"][0]["update_available"]
    assert detail["version_no"] == 3


@pytest.mark.parametrize("path", ["/api/change-requests/summary"])
async def test_summary_counts(path, user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    await submit(user, "cards", card["id"])
    assert (await user.get(path)).json()["pending"] == 1
