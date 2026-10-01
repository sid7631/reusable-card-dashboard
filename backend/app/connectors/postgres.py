"""Postgres connector: pooled, read-only, time- and row-bounded execution of compiled SQL."""

import asyncio
import os
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import asyncpg

from app.core.config import get_settings
from app.governance.specs import DataSourceSpec


class QueryError(Exception):
    """A query failed at the source — reported to the user as a 400, not a server error."""


def resolve(value: Any) -> Any:
    if isinstance(value, str) and value.startswith("env:"):
        name = value[4:]
        if name in os.environ:
            return os.environ[name]
        resolved = getattr(get_settings(), name.lower(), None)
        if resolved is None:
            raise QueryError(f"Data source setting {name} is not configured.")
        return resolved
    return value


_pools: dict[tuple[Any, ...], asyncpg.Pool] = {}
_pool_lock = asyncio.Lock()


async def _pool(spec: DataSourceSpec) -> asyncpg.Pool:
    c = spec.connection
    params = dict(host=resolve(c.host), port=int(resolve(c.port)), database=resolve(c.database),
                  user=resolve(c.user), password=resolve(c.secret_ref))
    key = (*params.values(), spec.execution.max_concurrency)
    async with _pool_lock:
        if key not in _pools:
            # Pool size doubles as this process's concurrency cap for the source
            _pools[key] = await asyncpg.create_pool(
                **params, min_size=0, max_size=spec.execution.max_concurrency, command_timeout=spec.execution.timeout_s,
            )
    return _pools[key]


async def close_pools() -> None:
    for pool in _pools.values():
        await pool.close()
    _pools.clear()


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


async def execute(spec: DataSourceSpec, sql: str, params: list[Any], *, max_rows: int | None = None) -> list[dict[str, Any]]:
    max_rows = max_rows or get_settings().query_max_rows
    timeout_ms = int(min(spec.execution.timeout_s, get_settings().query_timeout_s) * 1000)
    try:
        pool = await _pool(spec)
        async with pool.acquire() as conn, conn.transaction(readonly=True, isolation="repeatable_read"):
            await conn.execute(f"SET LOCAL statement_timeout = {timeout_ms}")
            # Server-side cursor: stop after max_rows instead of materialising the full result
            cursor = await conn.cursor(sql, *params)
            records = await cursor.fetch(max_rows)
    except (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, asyncio.TimeoutError) as exc:
        raise QueryError(_friendly(exc)) from exc
    return [{k: _jsonable(v) for k, v in r.items()} for r in records]


def _friendly(exc: BaseException) -> str:
    if isinstance(exc, asyncpg.QueryCanceledError):
        return "Query timed out."
    if isinstance(exc, (OSError, asyncpg.InterfaceError)):
        return "Could not connect to the data source."
    return str(exc).strip() or exc.__class__.__name__
