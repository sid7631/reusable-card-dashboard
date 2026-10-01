"""Execute a card version against its pinned data-source version."""

from typing import Any

from app.connectors import postgres
from app.execution.sql import Filters, bind_filters
from app.governance.specs import CardSpec, DataSourceSpec


async def run_sql(source: DataSourceSpec, sql: str, filters: Filters) -> list[dict[str, Any]]:
    text, params = bind_filters(sql, filters)
    return await postgres.execute(source, text, params)


async def run_card(card: CardSpec, source: DataSourceSpec, filters: Filters) -> dict[str, Any]:
    rows = await run_sql(source, card.query.sql, filters)
    meta: dict[str, Any] = {}
    # With a full date window, run the same query one year earlier for YoY deltas:
    # KPI cards get a single delta, other cards get prevRows to join per row.
    if filters.date_from and filters.date_to:
        try:
            prev_rows = await run_sql(source, card.query.sql, filters.shifted_one_year_back())
        except postgres.QueryError:
            prev_rows = None  # YoY is best-effort
        if prev_rows is not None:
            if card.chart_type == "kpi":
                cur = _first_value(rows)
                prev = _first_value(prev_rows)
                if prev > 0:
                    meta.update(prevValue=prev, deltaAbs=cur - prev, deltaPct=(cur - prev) / prev * 100)
            else:
                meta["prevRows"] = prev_rows
    return {"rows": rows, "meta": meta}


def _first_value(rows: list[dict[str, Any]]) -> float:
    if not rows:
        return 0.0
    value = next(iter(rows[0].values()), 0)
    return float(value or 0)
