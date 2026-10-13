"""REST connector: fetch JSON records into a DuckDB extract, refreshed after the cache TTL."""

import asyncio
import base64
import hashlib
import json
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
from app.core.redis import redis
from app.core.storage import StorageError, get_storage, scratch_path
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
    previous: list[dict[str, Any]] = []
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
            if page > 1 and batch == previous:
                break  # the API ignores paging and sent the same page again: don't load it twice
            previous = batch
            records += batch
            if len(records) > settings.rest_max_records:
                raise QueryError(f"More than {settings.rest_max_records:,} records — narrow the request.")
            if cfg.pagination.type == "page" and len(batch) < (cfg.pagination.page_size if cfg.pagination.size_param else 1):
                break
    return records


def host_of(spec: DataSourceSpec) -> str:
    return urlsplit(spec.rest.url).hostname or ""


# REST extracts are immutable objects: each refresh writes a new key and moves a Redis pointer to it,
# so every API and worker process agrees on the current extract and S3-cached copies never go stale.
#     rest:extract:<version>-<config digest>  →  {"key": "rest/…/<ms>.duckdb", "at": <unix s>, "prev": <older key>}
_POINTER_TTL_S = 30 * 86400
_REFRESH_LOCK_TTL_S = 300


async def _materialise(key: str) -> Path | None:
    try:
        return await asyncio.to_thread(get_storage().local_path, key)
    except StorageError:
        return None  # pointer survived but the object didn't (e.g. storage wiped) — rebuild


async def _refresh(spec: DataSourceSpec, name: str, pointer: str, previous: dict | None) -> Path:
    data = arrow_table(await fetch_records(spec))

    def build(con):
        con.register("_records", data)
        con.execute(f'CREATE TABLE "{spec.rest.table}" AS SELECT * FROM _records')

    scratch = scratch_path(".duckdb")
    key = f"rest/{name}/{time.time_ns() // 1_000_000}.duckdb"
    store = get_storage()
    try:
        await asyncio.to_thread(duck.build_database, scratch, build)
        await asyncio.to_thread(store.put_file, key, scratch)
    finally:
        scratch.unlink(missing_ok=True)
    await redis().set(pointer, json.dumps({"key": key, "at": time.time(), "prev": previous and previous["key"]}),
                      ex=_POINTER_TTL_S)
    # Keep the previous extract (a reader may have just picked it up); drop the one before it
    if previous and previous.get("prev"):
        await asyncio.to_thread(store.delete, previous["prev"])
    return await asyncio.to_thread(store.local_path, key)


async def extract_path(spec: DataSourceSpec, version_id: int) -> Path:
    """Local path of this data-source version's extract, re-fetched (once, cluster-wide) after cache_ttl_s."""
    # Keyed by version *and* request config, so a recycled id (e.g. a reset database) never reuses
    # another source's extract
    digest = hashlib.sha256(spec.rest.model_dump_json().encode()).hexdigest()[:16]
    name = f"{version_id}-{digest}"
    pointer, lock = f"rest:extract:{name}", f"lock:rest:{name}"
    r = redis()
    ttl = max(spec.execution.cache_ttl_s, 1)
    deadline = time.monotonic() + get_settings().result_wait_s
    while True:
        raw = await r.get(pointer)
        current = json.loads(raw) if raw else None
        path = await _materialise(current["key"]) if current else None
        if path and time.time() - current["at"] < ttl:
            return path
        if await r.set(lock, "1", nx=True, ex=_REFRESH_LOCK_TTL_S):
            try:
                return await _refresh(spec, name, pointer, current)
            finally:
                await r.delete(lock)
        if path:
            return path  # stale, but another process is already refreshing it
        if time.monotonic() > deadline:
            raise QueryError("The API extract is still loading — try again shortly.")
        await asyncio.sleep(0.2)
