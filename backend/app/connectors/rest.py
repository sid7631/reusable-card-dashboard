"""REST connector: fetch JSON records into a DuckDB extract, refreshed after the cache TTL."""

import asyncio
import base64
import hashlib
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.connectors import duck
from app.connectors.common import QueryError
from app.connectors.files import arrow_table, records_at
from app.core import secrets
from app.core.config import get_settings
from app.governance.specs import DataSourceSpec


async def _auth_headers(spec: DataSourceSpec) -> dict[str, str]:
    auth = spec.rest.auth
    if auth.type == "none":
        return {}
    try:
        secret = await secrets.resolve(auth.secret_ref) if auth.secret_ref else ""
    except secrets.SecretError as exc:
        raise QueryError(str(exc)) from exc
    if auth.type == "bearer":
        return {"Authorization": f"Bearer {secret}"}
    if auth.type == "api_key":
        return {auth.header: secret}
    return {"Authorization": "Basic " + base64.b64encode(f"{auth.username}:{secret}".encode()).decode()}


async def fetch_records(spec: DataSourceSpec, *, max_pages: int | None = None) -> list[dict[str, Any]]:
    cfg, settings = spec.rest, get_settings()
    headers = {"Accept": "application/json", **cfg.headers, **await _auth_headers(spec)}
    limit_bytes = settings.rest_max_response_mb * 1024 * 1024
    records: list[dict[str, Any]] = []
    pages = 1 if cfg.pagination.type == "none" else (max_pages or cfg.pagination.max_pages)
    # Redirects are not followed: they could bounce a request (and its credentials) to another host
    async with httpx.AsyncClient(timeout=spec.execution.timeout_s, follow_redirects=False) as client:
        for page in range(1, pages + 1):
            params = dict(cfg.query)
            if cfg.pagination.type == "page":
                params[cfg.pagination.page_param] = str(page)
                if cfg.pagination.size_param:
                    params[cfg.pagination.size_param] = str(cfg.pagination.page_size)
            try:
                res = await client.get(cfg.url, params=params, headers=headers)
            except httpx.HTTPError as exc:
                raise QueryError(f"Request failed: {exc.__class__.__name__}") from exc
            if res.status_code >= 300:
                raise QueryError(f"The API answered HTTP {res.status_code}.")
            if len(res.content) > limit_bytes:
                raise QueryError(f"Response larger than {settings.rest_max_response_mb} MB.")
            try:
                batch = records_at(res.json(), cfg.records_path)
            except ValueError as exc:
                raise QueryError("The API did not return JSON.") from exc
            records += batch
            if len(records) > settings.rest_max_records:
                raise QueryError(f"More than {settings.rest_max_records:,} records — narrow the request.")
            if cfg.pagination.type == "page" and len(batch) < (cfg.pagination.page_size if cfg.pagination.size_param else 1):
                break
    return records


def host_of(spec: DataSourceSpec) -> str:
    return urlsplit(spec.rest.url).hostname or ""


_refresh_locks: dict[str, asyncio.Lock] = {}


async def extract_path(spec: DataSourceSpec, version_id: int) -> Path:
    """DuckDB extract for this data-source version, re-fetched once older than cache_ttl_s."""
    # Keyed by version *and* request config, so a recycled id (e.g. a reset database) never reuses
    # another source's extract
    digest = hashlib.sha256(spec.rest.model_dump_json().encode()).hexdigest()[:16]
    path = duck.storage("rest", f"{version_id}-{digest}.duckdb")
    lock = _refresh_locks.setdefault(str(path), asyncio.Lock())
    async with lock:
        fresh = path.exists() and time.time() - path.stat().st_mtime < max(spec.execution.cache_ttl_s, 1)
        if not fresh:
            data = arrow_table(await fetch_records(spec))

            def build(con):
                con.register("_records", data)
                con.execute(f'CREATE TABLE "{spec.rest.table}" AS SELECT * FROM _records')

            await asyncio.to_thread(duck.replace_database, path, build)
    return path
