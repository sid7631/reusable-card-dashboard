from tests.conftest import Actor
from tests.test_governance import card_body


async def user_id(actor: Actor) -> int:
    return (await actor.get("/api/me")).json()["id"]


async def test_history_diff_and_restore(user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    base = f"/api/cards/{card['id']}"
    await user.put(base, card_body(seeded["source_id"], name="Renamed",
                                   sql="SELECT COUNT(*) AS value\nFROM transactions\nWHERE 1=1 {{filters}}"))

    diff = (await user.get(f"{base}/diff", params={"from_no": 1})).json()
    paths = {c["path"]: c for c in diff["changes"]}
    assert (diff["from"], diff["to"]) == (1, 2)
    assert paths["name"]["before"] == "My card" and paths["name"]["after"] == "Renamed"
    assert "spec.query.sql" in paths

    restored = (await user.post(f"{base}/restore/1")).json()
    assert restored["version_no"] == 3 and restored["change_note"] == "Restored v1"
    head = (await user.get(base)).json()
    assert head["name"] == "My card" and head["version_no"] == 3
    v1 = (await user.get(f"{base}/versions/1")).json()
    assert head["sql_text"] == v1["spec"]["query"]["sql"]
    assert [v["version_no"] for v in (await user.get(f"{base}/versions")).json()] == [3, 2, 1]


async def test_restoring_head_is_rejected(user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    assert (await user.post(f"/api/cards/{card['id']}/restore/1")).status_code == 409


async def test_view_share_grants_read_and_render_only(user, other_user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    base = f"/api/cards/{card['id']}"
    other = await user_id(other_user)
    assert (await user.put(f"{base}/shares/{other}", {"permission": "view"})).status_code == 200

    shared = (await other_user.get("/api/cards", params={"scope": "shared"})).json()
    assert [c["id"] for c in shared] == [card["id"]] and shared[0]["access"] == "view"
    assert (await other_user.get(f"{base}/data")).json()["rows"][0]["value"] == 60000
    assert (await other_user.put(base, card_body(seeded["source_id"]))).status_code == 403
    assert (await other_user.post(f"{base}/restore/1")).status_code == 403


async def test_edit_share_allows_new_versions_but_not_resharing(user, other_user, client, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    base = f"/api/cards/{card['id']}"
    other = await user_id(other_user)
    await user.put(f"{base}/shares/{other}", {"permission": "edit"})

    v2 = (await other_user.put(base, card_body(seeded["source_id"], name="Edited by collaborator"))).json()
    assert v2["version_no"] == 2
    history = (await user.get(f"{base}/versions")).json()
    assert history[0]["created_by"] == other

    third = Actor(client)
    assert (await other_user.put(f"{base}/shares/{await user_id(third)}", {"permission": "view"})).status_code == 403
    assert (await other_user.delete(base)).status_code == 403


async def test_revoking_share_removes_access_immediately(user, other_user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    base = f"/api/cards/{card['id']}"
    other = await user_id(other_user)
    await user.put(f"{base}/shares/{other}", {"permission": "view"})
    assert [s["user_id"] for s in (await user.get(f"{base}/shares")).json()] == [other]

    assert (await user.delete(f"{base}/shares/{other}")).status_code == 204
    assert (await other_user.get(base)).status_code == 404


async def test_shared_dashboard_renders_owners_private_cards(user, other_user, seeded):
    card = (await user.post("/api/cards", card_body(seeded["source_id"]))).json()
    dash = (await user.post("/api/dashboards", {"name": "Team view"})).json()
    await user.put(f"/api/dashboards/{dash['id']}/items", {"items": [{"card_id": card["id"]}]})
    await user.put(f"/api/dashboards/{dash['id']}/shares/{await user_id(other_user)}", {"permission": "view"})

    # The viewer can't open the card on its own, but can render it through the shared dashboard
    assert (await other_user.get(f"/api/cards/{card['id']}")).status_code == 404
    res = await other_user.get(f"/api/cards/{card['id']}/data", params={"dashboard_id": dash["id"]})
    assert res.status_code == 200


async def test_global_assets_cannot_be_shared(admin, user, seeded):
    res = await admin.put(f"/api/dashboards/{seeded['dashboard_id']}/shares/{await user_id(user)}", {"permission": "view"})
    assert res.status_code == 409


async def test_user_directory_excludes_self(user, other_user):
    me = await user_id(user)
    other = await user_id(other_user)
    ids = [u["id"] for u in (await user.get("/api/users", params={"q": other_user.sub})).json()]
    assert ids == [other] and me not in ids
