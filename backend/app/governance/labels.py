"""Names for the ids that appear in diffs, so changes read in words."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Asset, AssetVersion


async def diff_labels(session: AsyncSession, *specs: dict[str, Any]) -> dict[str, str]:
    """Dashboard placements by `item_id` → card name; `source:<asset id>` → data source name."""
    items = {i["item_id"]: i["card"]["version_id"] for s in specs for i in s.get("items", [])}
    sources = {s["data_source"]["asset_id"] for s in specs if isinstance(s.get("data_source"), dict)}
    out: dict[str, str] = {}
    if items:
        names = dict((await session.execute(
            select(AssetVersion.id, AssetVersion.name).where(AssetVersion.id.in_(set(items.values()))))).all())
        out.update({item_id: names.get(version_id, "card") for item_id, version_id in items.items()})
    if sources:
        names = dict((await session.execute(select(Asset.id, Asset.name).where(Asset.id.in_(sources)))).all())
        out.update({f"source:{i}": n for i, n in names.items()})
    return out
