"""Applied filters and how they bind to a source through its semantic model.

Dashboard (and card-level) filters are expressed in business terms — a dimension name and values,
plus a time window. Each card binds them through its own source's semantic model: the dimension's
column, and the dataset's time dimension. Filters a source can't bind are reported as ignored
instead of being silently dropped (architecture §7.2).
"""

import json
import re
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any

from app.governance.specs import SemanticDataset

DIMENSION_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
PERIOD = "period"  # pseudo-dimension reported for the time window


class FilterError(ValueError):
    pass


@dataclass(frozen=True)
class Filters:
    dims: dict[str, tuple[str, ...]] = field(default_factory=dict)
    date_from: date | None = None
    date_to: date | None = None

    @classmethod
    def parse(cls, segment: str | None = None, sub_segments: str | None = None, date_from: str | None = None,
              date_to: str | None = None, filters_json: str | dict | None = None) -> "Filters":
        """From query parameters: `filters` JSON ({dimension: value | [values]}) plus the older
        segment / sub_segments parameters, which map onto those dimensions."""
        raw: dict[str, Any] = {}
        if filters_json:
            try:
                raw = json.loads(filters_json) if isinstance(filters_json, str) else dict(filters_json)
            except json.JSONDecodeError as exc:
                raise FilterError("`filters` must be a JSON object.") from exc
            if not isinstance(raw, dict):
                raise FilterError("`filters` must be a JSON object.")
        if segment and segment != "ALL":
            raw.setdefault("segment", [segment])
        if sub_segments:
            raw.setdefault("sub_segment", [s.strip() for s in sub_segments.split(",") if s.strip()])
        if len(raw) > 30:
            raise FilterError("Too many filters.")
        dims: dict[str, tuple[str, ...]] = {}
        for name, values in raw.items():
            if not DIMENSION_NAME.match(name):
                raise FilterError(f"Invalid filter dimension “{name}”.")
            vals = values if isinstance(values, list) else [values]
            if len(vals) > 500:
                raise FilterError(f"Too many values for “{name}”.")
            cleaned = tuple(str(v) for v in vals if v is not None and str(v) != "")
            if cleaned:
                dims[name] = cleaned
        try:
            return cls(dims, date.fromisoformat(date_from) if date_from else None,
                       date.fromisoformat(date_to) if date_to else None)
        except ValueError as exc:
            raise FilterError("Invalid date — expected YYYY-MM-DD.") from exc

    def shifted_one_year_back(self) -> "Filters":
        def back(d: date | None) -> date | None:
            if d is None:
                return None
            try:
                return d.replace(year=d.year - 1)
            except ValueError:  # 29 Feb
                return d.replace(year=d.year - 1, day=28)
        return replace(self, date_from=back(self.date_from), date_to=back(self.date_to))

    def cache_key(self) -> str:
        return json.dumps({"d": sorted((k, sorted(v)) for k, v in self.dims.items()),
                           "f": str(self.date_from), "t": str(self.date_to)}, separators=(",", ":"))


def quote(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


@dataclass
class Bound:
    """SQL conditions (each starting with AND) with their bound parameters."""
    sql: list[str] = field(default_factory=list)
    params: list[Any] = field(default_factory=list)
    applied: list[str] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)

    def param(self, value: Any, offset: int) -> str:
        self.params.append(value)
        return f"${offset + len(self.params)}"

    def text(self) -> str:
        return " ".join(self.sql)


def membership(column_sql: str, placeholder: str, dialect: str) -> str:
    """`column IN (values)` with the values bound as one text-array parameter."""
    if dialect == "postgres":
        return f"CAST({column_sql} AS TEXT) = ANY({placeholder}::text[])"
    return f"list_contains(CAST({placeholder} AS VARCHAR[]), CAST({column_sql} AS VARCHAR))"


def bind(filters: Filters, dataset: SemanticDataset | None, dialect: str, *, offset: int = 0,
         static: dict[str, tuple[str, ...]] | None = None) -> Bound:
    """Conditions for `dataset`. `static` filters are part of the card's own definition."""
    out = Bound()
    columns = {d.name: d.column for d in dataset.dimensions} if dataset else {}

    for name, values in (static or {}).items():
        if name not in columns:
            raise FilterError(f"Unknown dimension “{name}”.")
        out.sql.append(f"AND {membership(quote(columns[name]), out.param(list(values), offset), dialect)}")

    for name, values in filters.dims.items():
        if name in columns:
            out.sql.append(f"AND {membership(quote(columns[name]), out.param(list(values), offset), dialect)}")
            out.applied.append(name)
        else:
            out.ignored.append(name)

    if filters.date_from or filters.date_to:
        time_col = dataset.time_dimension if dataset else None
        time_dim = next((d for d in dataset.dimensions if d.name == time_col or d.column == time_col), None) if dataset else None
        if time_col:
            column = quote(time_dim.column if time_dim else time_col)
            if filters.date_from:
                out.sql.append(f"AND {column} >= {out.param(filters.date_from, offset)}")
            if filters.date_to:
                out.sql.append(f"AND {column} <= {out.param(filters.date_to, offset)}")
            out.applied.append(PERIOD)
        else:
            out.ignored.append(PERIOD)
    return out
