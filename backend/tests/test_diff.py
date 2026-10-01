from app.governance.diff import diff_values


def test_identical_values_have_no_changes():
    assert diff_values({"a": [1, 2]}, {"a": [1, 2]}) == []


def test_reports_changed_added_and_removed_keys():
    changes = {(c.path, c.op) for c in diff_values({"a": 1, "b": 2}, {"a": 9, "c": 3})}
    assert changes == {("a", "changed"), ("b", "removed"), ("c", "added")}


def test_list_items_matched_by_stable_id():
    before = {"items": [{"item_id": "x", "w": 3}, {"item_id": "y", "w": 4}]}
    after = {"items": [{"item_id": "y", "w": 6}, {"item_id": "z", "w": 2}]}
    changes = {(c.path, c.op) for c in diff_values(before, after)}
    assert changes == {("items[x]", "removed"), ("items[y].w", "changed"), ("items[z]", "added")}


def test_multiline_text_includes_line_diff():
    [change] = diff_values({"sql": "SELECT a\nFROM t\nLIMIT 5"}, {"sql": "SELECT a\nFROM t\nLIMIT 10"})
    assert "-LIMIT 5" in change.lines and "+LIMIT 10" in change.lines
