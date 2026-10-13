"""Distinct dimension values for filter dropdowns, narrowed by parent selections (cascading filters)."""

import time
from typing import Any

from app import connectors
from app.governance.specs import DataSourceSpec, SemanticDataset
from app.semantic.dialects import TEMPORAL_TYPES, quote, quote_table
from app.semantic.filters import Filters, bind

_cache: dict[tuple[int, str, str], tuple[float, list[str]]] = {}
_TTL_S = 300
MAX_OPTIONS = 500


def dataset_with(spec: DataSourceSpec, dimension: str) -> SemanticDataset | None:
    return next((d for d in spec.model.datasets if any(x.name == dimension for x in d.dimensions)), None)


async def dimension_values(spec: DataSourceSpec, version_id: int, dimension: str, narrowing: Filters) -> list[str]:
    candidates = [d for d in spec.model.datasets if any(x.name == dimension for x in d.dimensions)]
    if not candidates:
        return []
    key = (version_id, dimension, narrowing.cache_key())
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < _TTL_S:
        return hit[1]
    for i, ds in enumerate(candidates):
        column = quote(next(d.column for d in ds.dimensions if d.name == dimension), spec.dialect)
        bound = bind(narrowing, ds, spec.dialect)
        sql = (f"SELECT DISTINCT {column} AS v FROM {quote_table(ds.name, spec.dialect)} WHERE {column} IS NOT NULL {bound.text()} "
               f"ORDER BY 1 LIMIT {MAX_OPTIONS}")
        try:
            rows = await connectors.execute(spec, sql, bound.params, version_id=version_id, max_rows=MAX_OPTIONS)
            break
        except connectors.QueryError:
            # A model entry whose table is gone (left over from a rename): try the next table with this field
            if i == len(candidates) - 1:
                raise
    # Booleans as the filters compare them (lowercase), not Python's "True"/"False"
    values = [str(r["v"]).lower() if isinstance(r["v"], bool) else str(r["v"]) for r in rows]
    _cache[key] = (time.monotonic(), values)
    return values


def card_dimensions(spec: DataSourceSpec) -> dict[str, Any]:
    """What a card's source can be filtered by: dimension names (+ whether a time window applies)."""
    dims = sorted({d.name for ds in spec.model.datasets for d in ds.dimensions if d.type not in TEMPORAL_TYPES})
    return {"dimensions": dims, "time": any(ds.time_dimension for ds in spec.model.datasets)}
