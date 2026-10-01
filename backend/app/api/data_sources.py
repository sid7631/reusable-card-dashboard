import time
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.listing import list_visible
from app.connectors import postgres
from app.core.auth import CurrentUser, Session
from app.execution.cards import run_sql
from app.execution.sql import Filters
from app.governance.service import get_asset
from app.governance.specs import DataSourceSpec
from app.models import AssetVersion

router = APIRouter(prefix="/api", tags=["data sources"])

# Catalog metadata changes only with a new data-source version; moves to Redis in phase 5
_catalog_cache: dict[int, tuple[float, dict[str, Any]]] = {}
_CATALOG_TTL_S = 300


async def _catalog(version: AssetVersion) -> dict[str, Any]:
    hit = _catalog_cache.get(version.id)
    if hit and time.monotonic() - hit[0] < _CATALOG_TTL_S:
        return hit[1]
    spec = DataSourceSpec.model_validate(version.spec)
    table = spec.tables[0] if spec.tables else "transactions"
    columns = await postgres.execute(spec, """
        SELECT column_name AS name, data_type AS type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position""", [table])
    count = await postgres.execute(spec, f'SELECT COUNT(*) AS n FROM "{table}"', [])
    values = {}
    for dim in spec.dimensions:
        rows = await postgres.execute(spec, f'SELECT DISTINCT "{dim}" AS v FROM "{table}" ORDER BY v', [])
        values[dim] = [str(r["v"]) for r in rows]
    catalog = {"table": table, "rowCount": count[0]["n"], "columns": columns, "dimensionValues": values}
    _catalog_cache[version.id] = (time.monotonic(), catalog)
    return catalog


@router.get("/data-sources")
async def list_data_sources(user: CurrentUser, session: Session) -> list[dict[str, Any]]:
    return [
        {"id": a.id, "name": v.name, "description": v.description, "scope": a.scope, "owner_name": owner,
         "access": access, "version_id": v.id, "version_no": v.version_no, "type": v.spec["type"]}
        for a, v, owner, access in await list_visible(session, user, "data_source")
    ]


@router.get("/datasets")
async def list_datasets(user: CurrentUser, session: Session) -> list[dict[str, Any]]:
    """Builder metadata (columns, row count, dimension values) for every visible data source."""
    out = []
    for asset, version, _owner, _access in await list_visible(session, user, "data_source"):
        catalog = await _catalog(version)
        out.append({"id": asset.id, "version_id": version.id, "name": catalog["table"], "label": version.name,
                    "rowCount": catalog["rowCount"], "columns": catalog["columns"],
                    "dimensionValues": catalog["dimensionValues"]})
    return out


class QueryIn(BaseModel):
    sql: str
    data_source_id: int
    filters: dict[str, str] = {}


@router.post("/query")
async def preview_query(body: QueryIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    """Studio preview: ad-hoc SELECT against a data source the user can see (row-capped)."""
    asset, _ = await get_asset(session, user, "data_source", body.data_source_id)
    version = await session.get(AssetVersion, asset.head_version_id)
    spec = DataSourceSpec.model_validate(version.spec)
    f = body.filters
    t0 = time.perf_counter()
    rows = await run_sql(spec, body.sql, Filters.parse(f.get("segment"), f.get("sub_segments"), f.get("from"), f.get("to")))
    return {"rows": rows, "ms": round((time.perf_counter() - t0) * 1000)}
