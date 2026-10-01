"""Postgres connector: pooled, read-only, time- and row-bounded execution of compiled SQL."""

import asyncio
from typing import Any

import asyncpg

from app.connectors.common import QueryError, jsonable
from app.core import secrets
from app.core.config import get_settings
from app.governance.specs import DataSourceSpec

_pools: dict[tuple[Any, ...], asyncpg.Pool] = {}
_pool_lock = asyncio.Lock()


async def connection_params(spec: DataSourceSpec) -> dict[str, Any]:
    c = spec.connection
    try:
        return dict(host=await secrets.resolve(c.host), port=int(await secrets.resolve(c.port)),
                    database=await secrets.resolve(c.database), user=await secrets.resolve(c.user),
                    password=await secrets.resolve(c.secret_ref) if c.secret_ref else None)
    except secrets.SecretError as exc:
        raise QueryError(str(exc)) from exc


async def _pool(spec: DataSourceSpec) -> asyncpg.Pool:
    params = await connection_params(spec)
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
    return [{k: jsonable(v) for k, v in r.items()} for r in records]


async def test(spec: DataSourceSpec) -> None:
    """Connect without the pool so a bad config never gets cached."""
    try:
        conn = await asyncio.wait_for(asyncpg.connect(**await connection_params(spec)), timeout=10)
        await conn.close()
    except (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, asyncio.TimeoutError) as exc:
        raise QueryError(_friendly(exc)) from exc


async def introspect(spec: DataSourceSpec) -> list[dict[str, Any]]:
    """Tables in the public schema with columns and estimated row counts."""
    rows = await execute(spec, """
        SELECT c.table_name AS table, c.column_name AS name, c.data_type AS type,
               COALESCE(s.n_live_tup, 0) AS row_estimate
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        LEFT JOIN pg_stat_user_tables s ON s.schemaname = c.table_schema AND s.relname = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type IN ('BASE TABLE', 'VIEW')
        ORDER BY c.table_name, c.ordinal_position""", [], max_rows=5000)
    tables: dict[str, dict[str, Any]] = {}
    for r in rows:
        t = tables.setdefault(r["table"], {"name": r["table"], "row_count": r["row_estimate"], "columns": []})
        t["columns"].append({"name": r["name"], "type": r["type"]})
    return list(tables.values())


def _friendly(exc: BaseException) -> str:
    if isinstance(exc, asyncpg.QueryCanceledError):
        return "Query timed out."
    if isinstance(exc, asyncpg.InvalidPasswordError):
        return "Authentication failed — check the user and password."
    if isinstance(exc, (OSError, asyncpg.InterfaceError, asyncio.TimeoutError)):
        return "Could not connect to the data source."
    return str(exc).strip() or exc.__class__.__name__
