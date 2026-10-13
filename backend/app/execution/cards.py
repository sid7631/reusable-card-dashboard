"""Execute a card version against its pinned data-source version."""

from typing import Any

from app import connectors
from app.execution.sql import bind_filters
from app.governance.specs import CardSpec, DataSourceSpec
from app.semantic.filters import Filters
from app.semantic.query import SemanticQuery, compile_query


def compile_card(query: Any, source: DataSourceSpec, filters: Filters) -> tuple[str, list[Any], dict[str, Any]]:
    if isinstance(query, SemanticQuery):
        return compile_query(source, query, filters)
    return bind_filters(query.sql, filters, source)


async def run_query(query: Any, source: DataSourceSpec, filters: Filters,
                    source_version_id: int | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    sql, params, meta = compile_card(query, source, filters)
    return await connectors.execute(source, sql, params, version_id=source_version_id), meta


async def run_sql(source: DataSourceSpec, sql: str, filters: Filters, source_version_id: int | None = None) -> list[dict[str, Any]]:
    from app.governance.specs import SqlQuery
    rows, _ = await run_query(SqlQuery(sql=sql), source, filters, source_version_id)
    return rows


async def run_card(card: CardSpec, source: DataSourceSpec, filters: Filters) -> dict[str, Any]:
    rows, meta = await run_query(card.query, source, filters, card.data_source.version_id)
    # With a full date window, run the same query one year earlier for YoY deltas:
    # KPI cards get a single delta, other cards get prevRows to join per row.
    if filters.date_from and filters.date_to and "period" in meta["applied"]:
        try:
            prev_rows, _ = await run_query(card.query, source, filters.shifted_one_year_back(), card.data_source.version_id)
        except connectors.QueryError:
            prev_rows = None  # YoY is best-effort
        if prev_rows is not None:
            if card.chart_type == "kpi":
                cur = _first_value(rows)
                prev = _first_value(prev_rows)
                # Any non-zero prior year compares — a negative one too (a variance, a net figure): the change
                # is measured against its size, so -10 → -5 reads as +50%, an improvement
                if prev != 0:
                    meta.update(prevValue=prev, deltaAbs=cur - prev, deltaPct=(cur - prev) / abs(prev) * 100)
            else:
                meta["prevRows"] = prev_rows
    return {"rows": rows, "meta": meta}


def _first_value(rows: list[dict[str, Any]]) -> float:
    if not rows:
        return 0.0
    value = next(iter(rows[0].values()), 0)
    return float(value or 0)
