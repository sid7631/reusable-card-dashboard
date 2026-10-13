"""Three-way merge of asset versions (architecture §4.6).

base   = the global version a private copy was forked from
ours   = the proposed private version
theirs = the current global head

Works on the same structure the diff uses: dicts merge per key, lists of objects merge per stable id
(`item_id`, `id`, `name`), multi-line text merges per line hunk. A path changed differently on both
sides is a conflict; `resolutions` ({path: "ours" | "theirs"}) settles conflicts explicitly.
"""

from difflib import SequenceMatcher
from typing import Any

from app.governance.diff import line_diff, list_key


class _Missing:
    def __repr__(self) -> str:
        return "MISSING"


MISSING: Any = _Missing()


def _plain(value: Any) -> Any:
    return None if value is MISSING else value


class Merge:
    def __init__(self, resolutions: dict[str, str] | None = None):
        self.resolutions = resolutions or {}
        self.conflicts: list[dict[str, Any]] = []

    def run(self, base: Any, ours: Any, theirs: Any, path: str = "") -> Any:
        if ours == theirs:
            return ours
        if ours == base:
            return theirs
        if theirs == base:
            return ours
        containers = [v for v in (base, ours, theirs) if v is not MISSING]
        if all(isinstance(v, dict) for v in containers):
            return self._dicts(base if base is not MISSING else {}, ours, theirs, path)
        if all(isinstance(v, list) for v in containers) and ours is not MISSING and theirs is not MISSING:
            key = list_key([*(base if base is not MISSING else []), *ours, *theirs])
            if key:
                return self._keyed_lists(base if base is not MISSING else [], ours, theirs, key, path)
        if all(isinstance(v, str) for v in containers) and len(containers) == 3 and any("\n" in v for v in containers):
            merged = merge_text(base, ours, theirs)
            if merged is not None:
                return merged
        return self._conflict(base, ours, theirs, path)

    def _conflict(self, base: Any, ours: Any, theirs: Any, path: str) -> Any:
        choice = self.resolutions.get(path)
        if choice == "theirs":
            return theirs
        if choice != "ours":
            conflict = {"path": path, "base": _plain(base), "ours": _plain(ours), "theirs": _plain(theirs)}
            if all(isinstance(v, str) for v in (base, ours, theirs)) and "\n" in base + ours + theirs:
                # Multi-line text (SQL): what each side changed, so people see the line, not the whole query
                conflict["ours_lines"], conflict["theirs_lines"] = line_diff(base, ours), line_diff(base, theirs)
            self.conflicts.append(conflict)
        return ours

    def _dicts(self, base: dict, ours: Any, theirs: Any, path: str) -> Any:
        if ours is MISSING or theirs is MISSING:  # deleted on one side, edited on the other
            return self._conflict(base, ours, theirs, path)
        out = {}
        for k in [*ours, *(k for k in theirs if k not in ours)]:
            sub = f"{path}.{k}" if path else k
            v = self.run(base.get(k, MISSING), ours.get(k, MISSING), theirs.get(k, MISSING), sub)
            if v is not MISSING:
                out[k] = v
        return out

    def _keyed_lists(self, base: list, ours: list, theirs: list, key: str, path: str) -> list:
        b = {i[key]: i for i in base}
        o = {i[key]: i for i in ours}
        t = {i[key]: i for i in theirs}
        out = []
        for k in [*o, *(k for k in t if k not in o)]:
            v = self.run(b.get(k, MISSING), o.get(k, MISSING), t.get(k, MISSING), f"{path}[{k}]")
            if v is not MISSING:
                out.append(v)
        return out


def _hunks(base: list[str], other: list[str]) -> list[tuple[int, int, list[str]]]:
    return [(i1, i2, other[j1:j2])
            for tag, i1, i2, j1, j2 in SequenceMatcher(None, base, other, autojunk=False).get_opcodes() if tag != "equal"]


def merge_text(base: str, ours: str, theirs: str) -> str | None:
    """Line-level merge; None when both sides touched the same region differently."""
    bl = base.splitlines()
    ho, ht = _hunks(bl, ours.splitlines()), _hunks(bl, theirs.splitlines())
    for a in ho:
        for b in ht:
            if a == b:
                continue
            if max(a[0], b[0]) < min(a[1], b[1]) or a[0] == b[0]:
                return None
    out: list[str] = []
    pos = 0
    for i1, i2, lines in sorted({(h[0], h[1], tuple(h[2])) for h in ho + ht}):
        out += bl[pos:i1] + list(lines)
        pos = i2
    out += bl[pos:]
    return "\n".join(out) + ("\n" if ours.endswith("\n") else "")


def merge3(base: Any, ours: Any, theirs: Any, resolutions: dict[str, str] | None = None) -> tuple[Any, list[dict[str, Any]]]:
    m = Merge(resolutions)
    return m.run(base, ours, theirs), m.conflicts
