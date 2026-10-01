"""Semantic layer endpoints: compile and run measure × dimension queries against a source's model.

These are the shapes LLM tools will call later (architecture §9): business names in, bounded
aggregated rows out, executed with the caller's permissions.
"""

import time
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.core.auth import CurrentUser, Session
from app.execution.cards import run_query
from app.governance.service import get_asset
from app.governance.specs import DataSourceSpec
from app.models import AssetVersion
from app.semantic.filters import Filters
from app.semantic.query import CompileError, SemanticQuery, compile_query

router = APIRouter(prefix="/api/semantic", tags=["semantic layer"])


class SemanticIn(BaseModel):
    data_source_id: int
    query: SemanticQuery
    filters: dict[str, Any] = {}
    date_from: str | None = None
    date_to: str | None = None
    # SQL for the editor: static filters inlined, {{filters}} token for dashboard filters
    editable: bool = False


async def _source(session, user, source_id: int) -> tuple[DataSourceSpec, int]:
    asset, _ = await get_asset(session, user, "data_source", source_id)
    version = await session.get(AssetVersion, asset.head_version_id)
    return DataSourceSpec.model_validate(version.spec), version.id


@router.get("/catalog/{source_id}")
async def catalog(source_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
    """Datasets, dimensions and measures with business labels and descriptions."""
    spec, _ = await _source(session, user, source_id)
    return spec.model.model_dump()


@router.post("/compile")
async def compile_(body: SemanticIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    spec, _ = await _source(session, user, body.data_source_id)
    try:
        sql, params, meta = compile_query(spec, body.query, Filters.parse(None, None, body.date_from, body.date_to, body.filters),
                                          editable=body.editable)
    except CompileError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    return {"sql": sql, "params": [str(p) for p in params], **meta}


@router.post("/query")
async def run(body: SemanticIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    spec, version_id = await _source(session, user, body.data_source_id)
    t0 = time.perf_counter()
    try:
        rows, meta = await run_query(body.query, spec, Filters.parse(None, None, body.date_from, body.date_to, body.filters),
                                     version_id)
    except CompileError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    return {"rows": rows, "meta": meta, "ms": round((time.perf_counter() - t0) * 1000)}
