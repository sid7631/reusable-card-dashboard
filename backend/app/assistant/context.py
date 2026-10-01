"""What the assistant knows about a dashboard: the cards as currently shown, the semantic catalog of
their sources, and the dashboard's filters. Only already-aggregated card results go in — never raw
source data (architecture §9)."""

import asyncio
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.execution.jobs import USER_ERRORS, Job, get_result, make_job
from app.governance.specs import DashboardSpec, DataSourceSpec
from app.models import Asset, AssetVersion
from app.semantic.filters import Filters

MAX_ROWS_PER_CARD = 25


@dataclass
class CardView:
    item_id: str
    name: str
    description: str
    chart_type: str
    source_key: str
    dimension: str | None          # what the card breaks down by, when it has one
    filters: dict[str, Any]
    rows: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    job: Job | None = None

    def prompt_view(self) -> dict[str, Any]:
        yoy = {k: self.meta[k] for k in ("prevValue", "deltaAbs", "deltaPct") if k in self.meta}
        prev = self.meta.get("prevRows")
        return {
            "item_id": self.item_id, "name": self.name, "description": self.description, "chart": self.chart_type,
            "source": self.source_key, "breakdown_by": self.dimension, "filters_applied": self.meta.get("applied", []),
            "filters_not_applicable": self.meta.get("ignored", []),
            "rows": self.rows[:MAX_ROWS_PER_CARD], "rows_truncated": len(self.rows) > MAX_ROWS_PER_CARD,
            **({"year_over_year": yoy} if yoy else {}),
            **({"prior_year_rows": prev[:MAX_ROWS_PER_CARD]} if prev else {}),
            **({"error": self.error} if self.error else {}),
        }


@dataclass
class SourceView:
    key: str                       # "s1", "s2", ... — what the model uses to refer to a source
    asset_id: int
    version_id: int
    name: str
    spec: DataSourceSpec

    def catalog(self) -> dict[str, Any]:
        return {"source": self.key, "name": self.name, "datasets": [
            {"dataset": d.name, "label": d.label, "description": d.description, "time_dimension": d.time_dimension,
             "dimensions": [{"name": x.name, "label": x.label, "type": x.type, "description": x.description} for x in d.dimensions],
             "measures": [{"name": m.name, "label": m.label, "description": m.description, "format": m.format} for m in d.measures]}
            for d in self.spec.model.datasets]}


@dataclass
class DashboardContext:
    dashboard_id: int
    name: str
    description: str
    filter_defs: list[dict[str, Any]]
    filter_summary: str
    cards: list[CardView]
    sources: dict[str, SourceView]

    def card(self, item_id: str) -> CardView | None:
        return next((c for c in self.cards if c.item_id == item_id), None)


async def build_context(session: AsyncSession, dashboard: Asset, items: list[dict[str, Any]],
                        filter_summary: str) -> DashboardContext:
    """`items` are the cards as shown: [{item_id, filters, date_from, date_to}] (same as /render)."""
    head = await session.get(AssetVersion, dashboard.head_version_id)
    spec = DashboardSpec.model_validate(head.spec)
    requested = {i["item_id"]: i for i in items}

    card_versions = {v.id: v for v in await session.scalars(
        select(AssetVersion).where(AssetVersion.id.in_([p.card.version_id for p in spec.items])))} if spec.items else {}
    source_ids = {v.spec["data_source"]["version_id"] for v in card_versions.values()}
    source_versions = {v.id: v for v in await session.scalars(
        select(AssetVersion).where(AssetVersion.id.in_(source_ids)))} if source_ids else {}

    sources: dict[str, SourceView] = {}
    by_version: dict[int, str] = {}
    for vid, v in source_versions.items():
        key = f"s{len(sources) + 1}"
        by_version[vid] = key
        sources[key] = SourceView(key, v.asset_id, vid, v.name, DataSourceSpec.model_validate(v.spec))

    cards: list[CardView] = []
    for placement in spec.items:
        cv = card_versions.get(placement.card.version_id)
        if cv is None:
            continue
        query = cv.spec["query"]
        dimension = (query.get("dimensions") or [{}])[0].get("name") if query.get("mode") == "semantic" \
            else cv.spec.get("config", {}).get("dimension")
        req = requested.get(placement.item_id, {})
        try:
            filters = Filters.parse(None, None, req.get("date_from"), req.get("date_to"), req.get("filters") or {})
        except USER_ERRORS:
            filters = Filters()
        src_vid = cv.spec["data_source"]["version_id"]
        card = CardView(placement.item_id, cv.name, cv.description, cv.spec["chart_type"], by_version.get(src_vid, "?"),
                        dimension if dimension and dimension != "txn_date" else None,
                        {"dims": {k: list(v) for k, v in filters.dims.items()},
                         "from": str(filters.date_from) if filters.date_from else None,
                         "to": str(filters.date_to) if filters.date_to else None})
        card.job = make_job(cv.id, cv.spec, src_vid, source_versions[src_vid].spec, filters)
        cards.append(card)

    async def load(card: CardView) -> None:
        try:
            result = await get_result(card.job)  # the same cached result the dashboard is showing
            card.rows, card.meta = result.rows, result.meta
        except USER_ERRORS as exc:
            card.error = str(exc)

    await asyncio.gather(*(load(c) for c in cards))
    return DashboardContext(dashboard.id, head.name, head.description,
                            [f.model_dump() for f in spec.filters], filter_summary, cards, sources)
