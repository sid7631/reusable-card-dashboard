"""Conversations on change requests, "request changes", and who else is changing the same asset."""

from tests.conftest import Actor
from tests.test_change_requests import global_card, submit
from tests.test_governance import card_body


async def _proposal(user: Actor, admin: Actor, seeded, description="Mine") -> tuple[dict, int]:
    g = await global_card(admin, seeded)
    copy_id = (await user.post(f"/api/cards/{g['id']}/fork")).json()["id"]
    await user.put(f"/api/cards/{copy_id}", card_body(seeded["source_id"], name="Global KPI", description=description))
    return g, copy_id


def _unread(rows: list[dict], request_id: int) -> int:
    return next(r["unread"] for r in rows if r["id"] == request_id)


async def test_comments_and_unread_counts(user, admin, seeded):
    _, copy_id = await _proposal(user, admin, seeded)
    req = await submit(user, "cards", copy_id)

    detail = (await admin.post(f"/api/change-requests/{req['id']}/comments", {"body": "Why this wording?"})).json()
    assert [(c["kind"], c["body"], c["author_role"]) for c in detail["comments"]] == [("comment", "Why this wording?", "admin")]
    assert detail["status"] == "pending"  # talking doesn't decide anything

    # The requester has one unread message until they open the request
    assert _unread((await user.get("/api/change-requests")).json(), req["id"]) == 1
    assert (await user.get("/api/change-requests/summary")).json()["unread"] == 1
    await user.get(f"/api/change-requests/{req['id']}")
    assert _unread((await user.get("/api/change-requests")).json(), req["id"]) == 0

    # Their reply is unread for the admin, not for themselves
    await user.post(f"/api/change-requests/{req['id']}/comments", {"body": "It matches the finance glossary."})
    assert _unread((await user.get("/api/change-requests")).json(), req["id"]) == 0
    assert _unread((await admin.get("/api/change-requests")).json(), req["id"]) == 1


async def test_only_the_people_on_a_request_can_talk(user, other_user, admin, seeded):
    _, copy_id = await _proposal(user, admin, seeded)
    req = await submit(user, "cards", copy_id)
    assert (await other_user.post(f"/api/change-requests/{req['id']}/comments", {"body": "hi"})).status_code == 404
    assert (await user.post(f"/api/change-requests/{req['id']}/comments", {"body": ""})).status_code == 422


async def test_request_changes_then_resubmit(user, admin, seeded):
    _, copy_id = await _proposal(user, admin, seeded)
    req = await submit(user, "cards", copy_id)

    assert (await user.post(f"/api/change-requests/{req['id']}/request-changes", {"comment": "x"})).status_code == 403
    assert (await admin.post(f"/api/change-requests/{req['id']}/request-changes", {"comment": ""})).status_code == 422
    sent_back = (await admin.post(f"/api/change-requests/{req['id']}/request-changes",
                                  {"comment": "Please shorten the description"})).json()
    assert sent_back["status"] == "changes_requested"
    assert not sent_back["can_approve"] and not sent_back["can_request_changes"]

    # Still open: the copy stays in review, it can't go into another request, and it can't be approved yet
    assert (await user.get(f"/api/cards/{copy_id}")).json()["pending_request_id"] == req["id"]
    assert (await admin.post(f"/api/change-requests/{req['id']}/approve", {})).status_code == 409
    assert (await user.get("/api/change-requests/summary")).json()["action_needed"] == 1
    mine = (await user.get(f"/api/change-requests/{req['id']}")).json()
    assert mine["can_resubmit"] and mine["can_withdraw"]

    # The requester edits and sends it back: the request picks up the new version
    edited = (await user.put(f"/api/cards/{copy_id}", card_body(seeded["source_id"], name="Global KPI",
                                                                 description="Short"))).json()
    back = (await user.post(f"/api/change-requests/{req['id']}/resubmit", {"comment": "Shortened."})).json()
    assert back["status"] == "pending" and back["items"][0]["source_version"] == edited["version"]
    assert [c["kind"] for c in back["comments"]] == ["changes_requested", "resubmitted"]
    assert (await user.post(f"/api/change-requests/{req['id']}/resubmit", {})).status_code == 409

    done = (await admin.post(f"/api/change-requests/{req['id']}/approve", {"comment": "Thanks"})).json()
    assert done["status"] == "approved" and done["comments"][-1]["kind"] == "approved"


async def test_reject_works_while_changes_are_requested(user, admin, seeded):
    _, copy_id = await _proposal(user, admin, seeded)
    req = await submit(user, "cards", copy_id)
    await admin.post(f"/api/change-requests/{req['id']}/request-changes", {"comment": "Rework"})
    res = await admin.post(f"/api/change-requests/{req['id']}/reject", {"comment": "Not needed after all"})
    assert res.json()["status"] == "rejected" and res.json()["comments"][-1]["body"] == "Not needed after all"


async def test_open_requests_on_the_same_global_asset(user, other_user, admin, seeded):
    g = await global_card(admin, seeded)
    reqs = []
    for actor, text in ((user, "One"), (other_user, "Two")):
        copy_id = (await actor.post(f"/api/cards/{g['id']}/fork")).json()["id"]
        await actor.put(f"/api/cards/{copy_id}", card_body(seeded["source_id"], name="Global KPI", description=text))
        reqs.append(await submit(actor, "cards", copy_id))

    # The global card lists both; each request knows about the other
    open_on_global = (await admin.get(f"/api/cards/{g['id']}")).json()["open_requests"]
    assert [r["id"] for r in open_on_global] == [r["id"] for r in reqs]
    first = (await admin.get(f"/api/change-requests/{reqs[0]['id']}")).json()
    assert [r["id"] for r in first["items"][0]["also_affects"]] == [reqs[1]["id"]]

    # Approving the first makes the second conflict (both changed the description)
    await admin.post(f"/api/change-requests/{reqs[0]['id']}/approve", {})
    second = (await other_user.get(f"/api/change-requests/{reqs[1]['id']}")).json()
    assert second["has_conflicts"] and second["items"][0]["also_affects"] == []
    assert [r["id"] for r in (await admin.get(f"/api/cards/{g['id']}")).json()["open_requests"]] == [reqs[1]["id"]]


async def test_sql_conflicts_show_each_sides_changed_lines(user, admin, seeded):
    sql = "SELECT segment AS label, SUM(amount) AS value\nFROM transactions\nGROUP BY label\nORDER BY value DESC\nLIMIT 7"
    g = (await admin.post("/api/cards", {**card_body(seeded["source_id"], name="Geo", scope="global"),
                                         "chart_type": "barlist", "sql_text": sql})).json()
    copy_id = (await user.post(f"/api/cards/{g['id']}/fork")).json()["id"]
    await user.put(f"/api/cards/{copy_id}", {**card_body(seeded["source_id"], name="Geo"), "chart_type": "barlist",
                                             "sql_text": sql.replace("LIMIT 7", "LIMIT 10")})
    await admin.put(f"/api/cards/{g['id']}", {**card_body(seeded["source_id"], name="Geo"), "chart_type": "barlist",
                                              "sql_text": sql.replace("LIMIT 7", "LIMIT 8")})
    [conflict] = [c for c in (await user.get(f"/api/cards/{copy_id}/rebase")).json()["conflicts"]
                  if c["path"] == "spec.query.sql"]
    assert "+LIMIT 10" in conflict["ours_lines"] and "-LIMIT 7" in conflict["ours_lines"]
    assert "+LIMIT 8" in conflict["theirs_lines"]
    assert not any("SELECT" in line for line in conflict["ours_lines"])  # only the region that changed


async def test_simultaneous_approvals_publish_once(client, user, admin, seeded):
    """Two admins approving the same request at the same moment: one wins, the other is told it's done."""
    import asyncio
    from tests.conftest import Actor
    card = (await user.post("/api/cards", card_body(seeded["source_id"], name="Approved once"))).json()
    req = await submit(user, "cards", card["id"])
    other_admin = Actor(client, role="admin")
    r1, r2 = await asyncio.gather(admin.post(f"/api/change-requests/{req['id']}/approve", {}),
                                  other_admin.post(f"/api/change-requests/{req['id']}/approve", {}))
    assert sorted([r1.status_code, r2.status_code]) == [200, 409]
    published = [c for c in (await user.get("/api/cards", params={"scope": "global"})).json() if c["name"] == "Approved once"]
    assert len(published) == 1
    detail = (await admin.get(f"/api/change-requests/{req['id']}")).json()
    assert [c["kind"] for c in detail["comments"]] == ["approved"]
