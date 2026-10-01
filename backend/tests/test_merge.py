from app.governance.merge import merge3, merge_text


def test_non_overlapping_changes_merge():
    base = {"name": "A", "spec": {"config": {"x": 1, "y": 1}}}
    ours = {"name": "B", "spec": {"config": {"x": 1, "y": 2}}}
    theirs = {"name": "A", "spec": {"config": {"x": 5, "y": 1}}}
    merged, conflicts = merge3(base, ours, theirs)
    assert merged == {"name": "B", "spec": {"config": {"x": 5, "y": 2}}} and conflicts == []


def test_same_path_changed_differently_conflicts_until_resolved():
    base, ours, theirs = {"name": "A"}, {"name": "B"}, {"name": "C"}
    _, conflicts = merge3(base, ours, theirs)
    assert conflicts == [{"path": "name", "base": "A", "ours": "B", "theirs": "C"}]
    assert merge3(base, ours, theirs, {"name": "theirs"}) == ({"name": "C"}, [])
    assert merge3(base, ours, theirs, {"name": "ours"}) == ({"name": "B"}, [])


def test_keyed_items_merge_adds_removes_and_edits():
    base = {"items": [{"item_id": "a", "w": 1}, {"item_id": "b", "w": 1}]}
    ours = {"items": [{"item_id": "a", "w": 2}, {"item_id": "b", "w": 1}, {"item_id": "c", "w": 1}]}
    theirs = {"items": [{"item_id": "a", "w": 1}, {"item_id": "d", "w": 1}]}
    merged, conflicts = merge3(base, ours, theirs)
    assert [(i["item_id"], i["w"]) for i in merged["items"]] == [("a", 2), ("c", 1), ("d", 1)] and not conflicts


def test_delete_versus_edit_conflicts():
    base = {"items": [{"item_id": "a", "w": 1}]}
    _, conflicts = merge3(base, {"items": [{"item_id": "a", "w": 3}]}, {"items": []})
    assert [c["path"] for c in conflicts] == ["items[a]"]


def test_text_merges_separate_hunks_and_flags_overlaps():
    base = "SELECT a\nFROM t\nWHERE 1=1\nLIMIT 5"
    assert merge_text(base, base.replace("SELECT a", "SELECT a, b"), base.replace("5", "10")) == \
        "SELECT a, b\nFROM t\nWHERE 1=1\nLIMIT 10"
    assert merge_text(base, base.replace("5", "7"), base.replace("5", "10")) is None
