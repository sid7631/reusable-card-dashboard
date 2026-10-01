"""Structural diff between two asset versions.

Specs are JSON, so changes are reported per JSON path. Lists of objects are matched by a stable key
(dashboard items by `item_id`, filters by `id`, model entries by `name`) so moving or editing one
item shows as a change to that item rather than a cascade of index shifts. Multi-line strings (SQL)
also carry a line diff. The same path-level view is the basis for three-way merges (architecture §4.6).
"""

import difflib
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

LIST_KEYS = ("item_id", "id", "name")


@dataclass
class Change:
    path: str
    op: Literal["added", "removed", "changed"]
    before: Any = None
    after: Any = None
    lines: list[str] = field(default_factory=list)  # unified line diff for multi-line text


def _list_key(items: list[Any]) -> str | None:
    if not items or not all(isinstance(i, dict) for i in items):
        return None
    return next((k for k in LIST_KEYS if all(k in i for i in items)), None)


def diff_values(before: Any, after: Any, path: str = "") -> list[Change]:
    if before == after:
        return []
    if isinstance(before, dict) and isinstance(after, dict):
        changes: list[Change] = []
        for key in list(before) + [k for k in after if k not in before]:
            sub = f"{path}.{key}" if path else key
            if key not in after:
                changes.append(Change(sub, "removed", before=before[key]))
            elif key not in before:
                changes.append(Change(sub, "added", after=after[key]))
            else:
                changes += diff_values(before[key], after[key], sub)
        return changes
    if isinstance(before, list) and isinstance(after, list):
        key = _list_key(before + after)
        if key:
            old = {i[key]: i for i in before}
            new = {i[key]: i for i in after}
            changes = []
            for k in list(old) + [k for k in new if k not in old]:
                sub = f"{path}[{k}]"
                if k not in new:
                    changes.append(Change(sub, "removed", before=old[k]))
                elif k not in old:
                    changes.append(Change(sub, "added", after=new[k]))
                else:
                    changes += diff_values(old[k], new[k], sub)
            return changes
        return [Change(path, "changed", before, after)]
    change = Change(path, "changed", before, after)
    if isinstance(before, str) and isinstance(after, str) and ("\n" in before or "\n" in after):
        change.lines = list(difflib.unified_diff(before.splitlines(), after.splitlines(), lineterm="", n=2))[2:]
    return [change]


def diff_versions(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Any]]:
    """Diff two versions given as {name, description, spec}."""
    return [asdict(c) for c in diff_values(before, after)]
