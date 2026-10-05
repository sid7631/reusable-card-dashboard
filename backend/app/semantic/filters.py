"""Applied filters and how they bind to a source through its semantic model.

Dashboard (and card-level) filters are expressed in business terms — a dimension name and values,
plus a time window. Each card binds them through its own source's semantic model: the dimension's
column, and the dataset's time dimension. Filters a source can't bind are reported as ignored
instead of being silently dropped (architecture §7.2).
"""

import json
import re
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from typing import Any

from app.governance.specs import SemanticDataset
from app.semantic.dialects import TEMPORAL_TYPES, membership, placeholder, quote, time_bounds

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


@dataclass
class Bound:
    """SQL conditions (each starting with AND) with their bound parameters."""
    dialect: str = "postgres"
    sql: list[str] = field(default_factory=list)
    params: list[Any] = field(default_factory=list)
    applied: list[str] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)

    def param(self, value: Any, offset: int = 0) -> str:
        self.params.append(value)
        return placeholder(offset + len(self.params), self.dialect)

    def text(self) -> str:
        return " ".join(self.sql)


def bind(filters: Filters, dataset: SemanticDataset | None, dialect: str, *, offset: int = 0,
         static: dict[str, tuple[str, ...]] | None = None) -> Bound:
    """Conditions for `dataset`. `static` filters are part of the card's own definition."""
    out = Bound(dialect)
    columns = {d.name: d.column for d in dataset.dimensions} if dataset else {}

    for name, values in (static or {}).items():
        if name not in columns:
            raise FilterError(f"Unknown dimension “{name}”.")
        out.sql.append(f"AND {membership(quote(columns[name], dialect), out.param(list(values), offset), dialect)}")

    for name, values in filters.dims.items():
        if name in columns:
            out.sql.append(f"AND {membership(quote(columns[name], dialect), out.param(list(values), offset), dialect)}")
            out.applied.append(name)
        else:
            out.ignored.append(name)

    if filters.date_from or filters.date_to:
        time_col = dataset.time_dimension if dataset else None
        time_dim = next((d for d in dataset.dimensions if d.name == time_col or d.column == time_col), None) if dataset else None
        if time_col:
            column_type = time_dim.type if time_dim and time_dim.type in TEMPORAL_TYPES else "date"
            # DATETIME/TIMESTAMP: exclusive upper bound on the next day, so the whole last day counts
            upper = filters.date_to + timedelta(days=1) if filters.date_to and column_type != "date" else filters.date_to
            out.sql += [f"AND {c}" for c in time_bounds(
                quote(time_dim.column if time_dim else time_col, dialect), column_type,
                out.param(filters.date_from, offset) if filters.date_from else None,
                out.param(upper, offset) if upper else None, dialect)]
            out.applied.append(PERIOD)
        else:
            out.ignored.append(PERIOD)
    return out
