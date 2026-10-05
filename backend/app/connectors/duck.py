"""DuckDB engine for file uploads and REST extracts.

Each source's data lives in its own DuckDB database file, kept in storage (app/core/storage.py) and
opened from a local path — the file itself, or a worker's cached copy of an S3 object. Queries open it read-only with external
access disabled, so user SQL can only see that source's tables — not the filesystem or the network.
"""

import asyncio
import re
from pathlib import Path
from typing import Any

import duckdb

from app.connectors.common import QueryError, jsonable
from app.core.config import get_settings


def safe_table_name(raw: str, fallback: str = "data") -> str:
    name = re.sub(r"[^a-z0-9_]+", "_", raw.lower()).strip("_")[:63] or fallback
    return f"t_{name}" if name[0].isdigit() else name


def _locked_connection(db_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        con.execute("SET enable_external_access = false")
        con.execute("SET lock_configuration = true")
    except duckdb.InvalidInputException:
        # DuckDB shares one database instance per file within a process: a concurrent query already
        # locked it. Confirm the lockdown is in place rather than trusting the error.
        if con.execute("SELECT current_setting('enable_external_access')").fetchone()[0] is not False:
            con.close()
            raise
    return con


def _run(db_path: Path, sql: str, params: list[Any], max_rows: int, holder: dict) -> list[dict[str, Any]]:
    con = _locked_connection(db_path)
    holder["con"] = con
    try:
        cur = con.execute(sql, params)
        cols = [d[0] for d in cur.description]
        return [{c: jsonable(v) for c, v in zip(cols, row, strict=True)} for row in cur.fetchmany(max_rows)]
    finally:
        con.close()


async def query(db_path: Path, sql: str, params: list[Any], *, timeout_s: float, max_rows: int | None = None) -> list[dict[str, Any]]:
    if not db_path.exists():
        raise QueryError("The source's data has not been loaded yet.")
    holder: dict[str, Any] = {}
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_run, db_path, sql, params, max_rows or get_settings().query_max_rows, holder),
            timeout=min(timeout_s, get_settings().query_timeout_s))
    except TimeoutError as exc:
        if "con" in holder:
            holder["con"].interrupt()
        raise QueryError("Query timed out.") from exc
    except duckdb.Error as exc:
        raise QueryError(str(exc).split("\n")[0]) from exc


def describe(db_path: Path) -> list[dict[str, Any]]:
    con = _locked_connection(db_path)
    try:
        tables = []
        for (name,) in con.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' "
                                   "AND table_name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY table_name").fetchall():
            columns = [{"name": c, "type": t} for c, t, *_ in con.execute(f'DESCRIBE "{name}"').fetchall()]
            count = con.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
            tables.append({"name": name, "row_count": count, "columns": columns})
        return tables
    finally:
        con.close()


def build_database(db_path: Path, build) -> None:
    """Create a new DuckDB file at `db_path` (a fresh scratch path); the caller stores it under a key."""
    db_path.unlink(missing_ok=True)
    con = duckdb.connect(str(db_path))
    try:
        build(con)
        con.execute("CHECKPOINT")
    finally:
        con.close()
