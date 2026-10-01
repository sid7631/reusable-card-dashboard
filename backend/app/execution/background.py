"""Scheduled work: keep REST extracts fresh and pre-compute global dashboards' default views,
so the first viewer of the day doesn't pay for cold queries."""

import logging

from sqlalchemy import select

from app.connectors import QueryError, rest
from app.core.db import SessionLocal
from app.execution.jobs import get_result, make_job
from app.governance.specs import DashboardSpec, DataSourceSpec
from app.models import Asset, AssetVersion
from app.semantic.filters import Filters
from app.semantic.periods import preset_window

log = logging.getLogger("spendboard.background")


async def refresh_rest_extracts() -> int:
    """Re-fetch REST extracts past their TTL (extract_path is a no-op while fresh)."""
    async with SessionLocal() as session:
        rows = (await session.execute(
            select(AssetVersion).join(Asset, Asset.head_version_id == AssetVersion.id)
            .where(Asset.kind == "data_source", Asset.archived_at.is_(None)))).scalars().all()
    refreshed = 0
    for version in rows:
        spec = DataSourceSpec.model_validate(version.spec)
        if spec.type != "rest":
            continue
        try:
            await rest.extract_path(spec, version.id)
            refreshed += 1
        except QueryError as exc:
            log.warning("REST refresh failed for version %s: %s", version.id, exc)
    return refreshed


async def warm_global_dashboards() -> int:
    """Trigger (not wait for) every card of every global dashboard at its default filters."""
    async with SessionLocal() as session:
        heads = (await session.execute(
            select(AssetVersion).join(Asset, Asset.head_version_id == AssetVersion.id)
            .where(Asset.kind == "dashboard", Asset.scope == "global", Asset.archived_at.is_(None)))).scalars().all()
        triggered = 0
        for head in heads:
            spec = DashboardSpec.model_validate(head.spec)
            dims = {f.dimension: f.default for f in spec.filters if f.kind != "period" and f.default}
            period = next((f for f in spec.filters if f.kind == "period"), None)
            date_from, date_to = preset_window(period.default[0] if period and period.default else None) if period else (None, None)
            filters = Filters.parse(None, None, date_from, date_to, dims)
            for item in spec.items:
                card_v = await session.get(AssetVersion, item.card.version_id)
                src_v = await session.get(AssetVersion, card_v.spec["data_source"]["version_id"])
                await get_result(make_job(card_v.id, card_v.spec, src_v.id, src_v.spec, filters), wait=False)
                triggered += 1
    return triggered
