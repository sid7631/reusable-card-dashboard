import asyncio
import hashlib
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app import connectors
from app.api.listing import list_visible, owner_name
from app.api.serializers import asset_meta
from app.connectors import duck, files
from app.connectors.common import QueryError, check_public_host
from app.connectors.model import suggest_model
from app.core import secrets
from app.core.auth import CurrentUser, Session
from app.core.config import get_settings
from app.core.storage import get_storage, scratch_path
from app.execution.cards import run_sql
from app.semantic.dialects import TEMPORAL_TYPES, quote_table
from app.semantic.filters import Filters
from app.semantic.options import dimension_values
from app.governance.requests import governance_info
from app.governance.service import archive_asset, create_asset, get_asset, parse_spec, save_version
from app.governance.specs import DataSourceSpec
from app.models import Asset, AssetVersion, FileObject, User

router = APIRouter(prefix="/api", tags=["data sources"])


class Credentials(BaseModel):
    # Password / token / API key. Stored encrypted; never returned.
    secret: str = Field(min_length=1)


class DataSourceIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    spec: dict[str, Any]
    credentials: Credentials | None = None
    change_note: str = ""
    scope: Literal["private", "global"] = "private"


class TestIn(BaseModel):
    spec: dict[str, Any]
    credentials: Credentials | None = None
    # Editing an existing source: reuse its stored credential if the endpoint is unchanged
    data_source_id: int | None = None


def _set_secret(spec: dict[str, Any], ref: str | None) -> None:
    if spec.get("type") == "postgres" and spec.get("connection") is not None:
        spec["connection"]["secret_ref"] = ref
    elif spec.get("type") == "bigquery" and spec.get("bigquery") is not None:
        spec["bigquery"]["secret_ref"] = ref
    elif spec.get("type") == "rest" and spec.get("rest") is not None:
        spec["rest"].setdefault("auth", {})["secret_ref"] = ref


def _head_secret(head: DataSourceSpec | None, spec: DataSourceSpec) -> str | None:
    if head is None or head.endpoint() != spec.endpoint():
        return None
    refs = head.secret_refs()
    return refs[0] if refs else None


async def _head_spec(session: AsyncSession, asset: Asset) -> DataSourceSpec:
    return DataSourceSpec.model_validate((await session.get(AssetVersion, asset.head_version_id)).spec)


def _out(asset: Asset, version: AssetVersion, access: str | None, owner: str | None, gov=None) -> dict[str, Any]:
    spec = DataSourceSpec.model_validate(version.spec)
    # Always the current spec shape — older versions (e.g. pre-semantic-model) are upgraded on read
    return {**asset_meta(asset, version, access, owner, gov), "type": spec.type, "spec": spec.model_dump(mode="json"),
            "has_credentials": bool(spec.secret_refs())}


# ---------------------------------------------------------------- CRUD
@router.get("/data-sources")
async def list_data_sources(user: CurrentUser, session: Session,
                            scope: Literal["global", "private", "shared"] | None = None) -> list[dict[str, Any]]:
    rows = await list_visible(session, user, "data_source", scope)
    gov = await governance_info(session, [a for a, *_ in rows])
    return [_out(a, v, access, owner, gov[a.id]) for a, v, owner, access in rows]


@router.get("/data-sources/{source_id}")
async def get_data_source(source_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
    asset, access = await get_asset(session, user, "data_source", source_id)
    version = await session.get(AssetVersion, asset.head_version_id)
    gov = (await governance_info(session, [asset]))[asset.id]
    return _out(asset, version, access, await owner_name(session, asset), gov)


async def _prepare_spec(session: AsyncSession, user: User, body: DataSourceIn, head: DataSourceSpec | None) -> dict[str, Any]:
    raw = dict(body.spec)
    for section in ("connection", "rest", "bigquery"):
        if raw.get(section) is not None:
            raw[section] = {**raw[section]}
            if section == "rest" and raw[section].get("auth") is not None:
                raw[section]["auth"] = {**raw[section]["auth"]}
    _set_secret(raw, None)  # clients never set refs directly
    parsed = parse_spec("data_source", raw)
    if body.credentials:
        _set_secret(raw, await secrets.create_secret(session, user, body.credentials.secret))
    else:
        _set_secret(raw, _head_secret(head, parsed))
    return raw


@router.post("/data-sources", status_code=status.HTTP_201_CREATED)
async def create_data_source(body: DataSourceIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    spec = await _prepare_spec(session, user, body, None)
    asset, version = await create_asset(session, user, "data_source", name=body.name, description=body.description,
                                        spec=spec, scope=body.scope)
    await session.commit()
    return _out(asset, version, "owner" if asset.scope == "private" else "admin", user.name)


@router.put("/data-sources/{source_id}")
async def update_data_source(source_id: int, body: DataSourceIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    asset, access = await get_asset(session, user, "data_source", source_id, write=True)
    spec = await _prepare_spec(session, user, body, await _head_spec(session, asset))
    version = await save_version(session, user, asset, name=body.name, description=body.description, spec=spec,
                                 change_note=body.change_note)
    await session.commit()
    gov = (await governance_info(session, [asset]))[asset.id]
    return _out(asset, version, access, await owner_name(session, asset), gov)


@router.delete("/data-sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_data_source(source_id: int, user: CurrentUser, session: Session) -> Response:
    asset, access = await get_asset(session, user, "data_source", source_id)
    await archive_asset(session, user, asset, access)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------- onboarding helpers
@router.post("/data-sources/test")
async def test_data_source(body: TestIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    """Try a connection before saving. Returns tables, sample rows (REST) and a suggested semantic model."""
    raw = dict(body.spec)
    for section in ("connection", "rest", "bigquery"):
        if raw.get(section) is not None:
            raw[section] = {**raw[section], **({"auth": {**raw[section].get("auth", {})}} if section == "rest" else {})}
    _set_secret(raw, None)
    spec = parse_spec("data_source", raw)
    is_admin = user.role == "admin"

    inherited = None
    if body.data_source_id is not None and not body.credentials:
        asset, _ = await get_asset(session, user, "data_source", body.data_source_id, write=True)
        inherited = _head_secret(await _head_spec(session, asset), spec)
    if not is_admin and inherited is None:
        fields = [*(spec.connection.model_dump().values() if spec.connection else [])]
        if any(isinstance(v, str) and v.startswith("env:") for v in fields):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Only admins can reference server settings (env:).")
        if spec.bigquery and spec.bigquery.auth == "adc":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT,
                                "Only admins can use the server's own Google identity — upload a service-account key.")
    if spec.file:
        file = await session.get(FileObject, spec.file.file_id)
        if file is None or (file.uploaded_by != user.id and not is_admin):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Uploaded file not found.")

    host = spec.connection.host if spec.connection else connectors.rest.host_of(spec) if spec.rest else None
    if host and not host.startswith("env:"):
        await check_public_host(host, is_admin=is_admin or inherited is not None)

    transient = secrets.transient_ref(body.credentials.secret) if body.credentials else None
    _set_secret(raw, transient or inherited)
    try:
        result = await connectors.test(DataSourceSpec.model_validate(raw))
    finally:
        secrets.drop_transient(transient)
    return {"ok": True, **result, "suggested_model": suggest_model(result["tables"])}


@router.post("/files", status_code=status.HTTP_201_CREATED)
async def upload_file(file: UploadFile, user: CurrentUser, session: Session) -> dict[str, Any]:
    """Upload CSV / Excel / JSON. The file is ingested into its own DuckDB database right away."""
    fmt = files.detect_format(file.filename or "")
    limit = get_settings().max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"Files are limited to {get_settings().max_upload_mb} MB.")
    checksum = hashlib.sha256(data).hexdigest()

    record = FileObject(uploaded_by=user.id, filename=Path(file.filename).name[:255], format=fmt, size=len(data),
                        checksum=checksum, storage_key="", db_key="")
    session.add(record)
    await session.flush()
    suffix = Path(file.filename).suffix.lower()
    raw_path, db_path = scratch_path(suffix), scratch_path(".duckdb")
    try:
        raw_path.write_bytes(data)
        tables = await asyncio.to_thread(files.ingest, raw_path, fmt, db_path,
                                         duck.safe_table_name(Path(file.filename).stem, "upload"))
        # Storage keys, not paths: the same rows work on local disk or S3 (app/core/storage.py)
        record.storage_key, record.db_key = f"uploads/{record.id}{suffix}", f"files/{record.id}.duckdb"
        store = get_storage()
        await asyncio.to_thread(store.put_file, record.storage_key, raw_path)
        await asyncio.to_thread(store.put_file, record.db_key, db_path)
    finally:
        raw_path.unlink(missing_ok=True)
        db_path.unlink(missing_ok=True)
    record.tables = tables
    await session.commit()
    return {"id": record.id, "filename": record.filename, "format": fmt, "size": record.size, "tables": tables,
            "suggested_model": suggest_model(tables)}


# ---------------------------------------------------------------- builder catalog
# Changes only with a new data-source version (or REST refresh); moves to Redis in phase 5
_catalog_cache: dict[int, tuple[float, dict[str, Any]]] = {}
_CATALOG_TTL_S = 300


async def _catalog(version: AssetVersion) -> dict[str, Any]:
    hit = _catalog_cache.get(version.id)
    if hit and time.monotonic() - hit[0] < _CATALOG_TTL_S:
        return hit[1]
    spec = DataSourceSpec.model_validate(version.spec)
    tables = await connectors.introspect(spec, version_id=version.id)
    if spec.type in ("postgres", "bigquery") and spec.model.datasets:
        modelled = {d.name for d in spec.model.datasets}
        tables = [t for t in tables if t["name"] in modelled]
    if spec.type == "postgres":
        for t in tables:  # exact counts for modelled tables (estimates can be stale; BigQuery metadata is exact)
            rows = await connectors.execute(spec, f'SELECT COUNT(*) AS n FROM {quote_table(t["name"], spec.dialect)}', [])
            t["row_count"] = rows[0]["n"]
    values: dict[str, list[str]] = {}
    primary = spec.model.datasets[0] if spec.model.datasets else None
    for dim in (primary.dimensions if primary else []):
        if dim.type in TEMPORAL_TYPES:
            continue
        # Same cached, capped lookup as filter dropdowns — on BigQuery every distinct-value query is a billed scan
        values[dim.name] = (await dimension_values(spec, version.id, dim.name, Filters()))[:200]
    catalog = {"tables": tables, "dimensionValues": values}
    _catalog_cache[version.id] = (time.monotonic(), catalog)
    return catalog


@router.get("/datasets")
async def list_datasets(user: CurrentUser, session: Session) -> list[dict[str, Any]]:
    """Builder metadata for every visible data source: tables, semantic model, dimension values."""
    out = []
    for asset, version, _owner, _access in await list_visible(session, user, "data_source"):
        spec = DataSourceSpec.model_validate(version.spec)
        try:
            catalog = await _catalog(version)
        except QueryError as exc:
            out.append({"id": asset.id, "version_id": version.id, "label": version.name, "type": spec.type,
                        "dialect": spec.dialect, "error": str(exc), "tables": [], "model": spec.model.model_dump(),
                        "name": "", "rowCount": 0, "columns": [], "dimensionValues": {}})
            continue
        first = catalog["tables"][0] if catalog["tables"] else {"name": "", "row_count": 0, "columns": []}
        out.append({"id": asset.id, "version_id": version.id, "label": version.name, "type": spec.type,
                    "dialect": spec.dialect, "tables": catalog["tables"], "model": spec.model.model_dump(),
                    # primary table, for the builder
                    "name": spec.model.datasets[0].name if spec.model.datasets else first["name"],
                    "rowCount": first["row_count"], "columns": first["columns"],
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
    rows = await run_sql(spec, body.sql, Filters.parse(f.get("segment"), f.get("sub_segments"), f.get("from"), f.get("to"),
                                                       f.get("filters")), version.id)
    return {"rows": rows, "ms": round((time.perf_counter() - t0) * 1000)}
