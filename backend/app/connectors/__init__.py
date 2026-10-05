"""One interface over every source type, so cards, filters and (later) LLM tools stay source-agnostic."""

import asyncio
from pathlib import Path
from typing import Any

from app.connectors import bigquery, duck, postgres, rest
from app.connectors.common import QueryError
from app.core.db import SessionLocal
from app.core.storage import StorageError, get_storage
from app.governance.specs import DataSourceSpec
from app.models import FileObject

__all__ = ["QueryError", "execute", "introspect", "test"]


async def _duck_path(spec: DataSourceSpec, version_id: int | None) -> Path:
    if spec.type == "file":
        async with SessionLocal() as session:
            file = await session.get(FileObject, spec.file.file_id)
        if file is None:
            raise QueryError("The uploaded file for this source no longer exists.")
        try:
            return await asyncio.to_thread(get_storage().local_path, file.db_key)
        except StorageError as exc:
            raise QueryError("The uploaded file's data is missing from storage.") from exc
    if version_id is None:
        raise QueryError("REST sources are queried through a saved data-source version.")
    return await rest.extract_path(spec, version_id)


async def execute(spec: DataSourceSpec, sql: str, params: list[Any], *, version_id: int | None = None,
                  max_rows: int | None = None) -> list[dict[str, Any]]:
    if spec.type == "postgres":
        return await postgres.execute(spec, sql, params, max_rows=max_rows)
    if spec.type == "bigquery":
        return await bigquery.execute(spec, sql, params, max_rows=max_rows)
    return await duck.query(await _duck_path(spec, version_id), sql, params,
                            timeout_s=spec.execution.timeout_s, max_rows=max_rows)


async def introspect(spec: DataSourceSpec, *, version_id: int | None = None) -> list[dict[str, Any]]:
    if spec.type == "postgres":
        return await postgres.introspect(spec)
    if spec.type == "bigquery":
        return await bigquery.introspect(spec)
    return await asyncio.to_thread(duck.describe, await _duck_path(spec, version_id))


async def test(spec: DataSourceSpec) -> dict[str, Any]:
    """Check connectivity before saving; returns what the source exposes (+ sample rows for REST)."""
    if spec.type == "postgres":
        await postgres.test(spec)
        return {"tables": await postgres.introspect(spec)}
    if spec.type == "bigquery":
        return {"tables": await bigquery.test(spec)}
    if spec.type == "rest":
        from app.connectors.files import arrow_table
        records = await rest.fetch_records(spec, max_pages=1)
        table = arrow_table(records)
        columns = [{"name": f.name, "type": str(f.type)} for f in table.schema]
        return {"tables": [{"name": spec.rest.table, "row_count": len(records), "columns": columns}],
                "sample": records[:20]}
    return {"tables": await introspect(spec)}
