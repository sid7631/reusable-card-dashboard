from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.listing import access_for, list_visible, owner_name
from app.api.serializers import asset_meta, card_out
from app.core.auth import CurrentUser, Session
from app.governance.requests import governance_info
from app.governance.service import archive_asset, create_asset, get_asset, save_version
from app.governance.specs import DashboardFilter, DashboardSpec, DataSourceSpec
from app.semantic.filters import Filters
from app.semantic.options import card_dimensions, dataset_with, dimension_values
from app.models import Asset, AssetShare, AssetVersion, User

router = APIRouter(prefix="/api/dashboards", tags=["dashboards"])


class DashboardIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    scope: Literal["private", "global"] = "private"


class LayoutItemIn(BaseModel):
    item_id: str | None = None
    card_id: int
    x: int = 0
    y: int = 0
    w: int = 4
    h: int = 4


class LayoutIn(BaseModel):
    items: list[LayoutItemIn]
    change_note: str = ""


class FiltersIn(BaseModel):
    filters: list[DashboardFilter]
    change_note: str = ""


class ApplyUpdatesIn(BaseModel):
    # Placements to move to their card's latest version; omitted = all with an update
    item_ids: list[str] | None = None


@router.get("")
async def list_dashboards(user: CurrentUser, session: Session,
                          scope: Literal["global", "private", "shared"] | None = None) -> list[dict[str, Any]]:
    rows = await list_visible(session, user, "dashboard", scope)
    gov = await governance_info(session, [a for a, *_ in rows])
    return [{**asset_meta(a, v, access, owner, gov[a.id]), "card_count": len(v.spec.get("items", []))}
            for a, v, owner, access in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_dashboard(body: DashboardIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    asset, version = await create_asset(session, user, "dashboard", name=body.name, description=body.description,
                                        spec={"items": []}, scope=body.scope)
    await session.commit()
    return {**asset_meta(asset, version, "owner" if asset.scope == "private" else "admin", user.name), "card_count": 0}


@router.get("/{dashboard_id}")
async def get_dashboard(dashboard_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
    asset, access = await get_asset(session, user, "dashboard", dashboard_id)
    return await _detail(session, user, asset, access)


@router.put("/{dashboard_id}/items")
async def save_layout(dashboard_id: int, body: LayoutIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    """Replace the layout as a new dashboard version. Existing items keep their pinned card version;
    newly added cards are pinned to their current head version."""
    asset, access = await get_asset(session, user, "dashboard", dashboard_id, write=True)
    head = await session.get(AssetVersion, asset.head_version_id)
    current = {i.item_id: i for i in DashboardSpec.model_validate(head.spec).items}

    items = []
    for it in body.items:
        existing = current.get(it.item_id or "")
        if existing is not None and existing.card.asset_id == it.card_id:
            ref = existing.card.model_dump()
        else:
            card, _ = await get_asset(session, user, "card", it.card_id)
            ref = {"asset_id": card.id, "version_id": card.head_version_id}
        items.append({**({"item_id": it.item_id} if existing else {}), "card": ref,
                      "x": it.x, "y": it.y, "w": it.w, "h": it.h})

    await save_version(session, user, asset, name=asset.name, description=asset.description,
                       spec={**head.spec, "items": items}, change_note=body.change_note or "Layout updated")
    await session.commit()
    return await _detail(session, user, asset, access)


@router.post("/{dashboard_id}/apply-updates")
async def apply_updates(dashboard_id: int, body: ApplyUpdatesIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    """Re-pin placements to the latest version of their card, as a new dashboard version."""
    asset, access = await get_asset(session, user, "dashboard", dashboard_id, write=True)
    head = await session.get(AssetVersion, asset.head_version_id)
    spec = DashboardSpec.model_validate(head.spec)
    cards = {c.id: c for c in await session.scalars(select(Asset).where(Asset.id.in_({i.card.asset_id for i in spec.items})))}
    wanted = set(body.item_ids) if body.item_ids is not None else None
    updated = []
    for item in spec.items:
        card = cards.get(item.card.asset_id)
        if (card and card.archived_at is None and card.head_version_id != item.card.version_id
                and (wanted is None or item.item_id in wanted)):
            item.card.version_id = card.head_version_id
            updated.append(card.name)
    if not updated:
        raise HTTPException(status.HTTP_409_CONFLICT, "No card updates to apply.")
    await save_version(session, user, asset, name=asset.name, description=asset.description,
                       spec=spec.model_dump(mode="json"), change_note=f"Updated {', '.join(updated)} to latest")
    await session.commit()
    return await _detail(session, user, asset, access)


@router.put("/{dashboard_id}/filters")
async def save_filters(dashboard_id: int, body: FiltersIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    """Replace the dashboard's filter definitions (hierarchy, defaults, locks) as a new version."""
    asset, access = await get_asset(session, user, "dashboard", dashboard_id, write=True)
    head = await session.get(AssetVersion, asset.head_version_id)
    await save_version(session, user, asset, name=asset.name, description=asset.description,
                       spec={**head.spec, "filters": [f.model_dump() for f in body.filters]},
                       change_note=body.change_note or "Filters updated")
    await session.commit()
    return await _detail(session, user, asset, access)


async def _item_sources(session: AsyncSession, spec: DashboardSpec) -> list[tuple[int, int, DataSourceSpec]]:
    """(source asset id, source version id, spec) for every card on the dashboard, in layout order."""
    card_versions = {v.id: v for v in await session.scalars(
        select(AssetVersion).where(AssetVersion.id.in_([i.card.version_id for i in spec.items])))} if spec.items else {}
    refs = [card_versions[i.card.version_id].spec["data_source"] for i in spec.items if i.card.version_id in card_versions]
    source_versions = {v.id: v for v in await session.scalars(
        select(AssetVersion).where(AssetVersion.id.in_({r["version_id"] for r in refs})))} if refs else {}
    seen, out = set(), []
    for r in refs:
        if r["version_id"] not in seen and r["version_id"] in source_versions:
            seen.add(r["version_id"])
            out.append((r["asset_id"], r["version_id"], DataSourceSpec.model_validate(source_versions[r["version_id"]].spec)))
    return out


@router.get("/{dashboard_id}/filter-options/{filter_id}")
async def filter_options(dashboard_id: int, filter_id: str, user: CurrentUser, session: Session,
                         selections: str | None = Query(None, description="JSON {filter_id: [values]}")) -> dict[str, Any]:
    """Values for a filter, narrowed by its ancestors' current selections (cascading filters).

    Options come from the filter's source, or the first card source whose model has the dimension —
    a dashboard viewer may read them without direct access to that source."""
    asset, _ = await get_asset(session, user, "dashboard", dashboard_id)
    spec = DashboardSpec.model_validate((await session.get(AssetVersion, asset.head_version_id)).spec)
    filters = {f.id: f for f in spec.filters}
    target = filters.get(filter_id)
    if target is None or target.kind == "period":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Filter not found.")

    chosen = Filters.parse(filters_json=selections).dims if selections else {}
    narrowing: dict[str, list[str]] = {}
    parent = target.parent
    while parent is not None:  # every ancestor's selection narrows the options
        if chosen.get(parent):
            narrowing[filters[parent].dimension] = list(chosen[parent])
        parent = filters[parent].parent

    sources = await _item_sources(session, spec)
    if target.source_id is not None:
        sources = [s for s in sources if s[0] == target.source_id] or sources
    for _asset_id, version_id, source in sources:
        if dataset_with(source, target.dimension):
            values = await dimension_values(source, version_id, target.dimension, Filters.parse(filters_json=narrowing))
            return {"filter_id": filter_id, "dimension": target.dimension, "values": values}
    return {"filter_id": filter_id, "dimension": target.dimension, "values": []}


@router.get("/{dashboard_id}/filterable")
async def filterable(dashboard_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
    """Dimensions available across the dashboard's card sources — for the filter editor."""
    asset, _ = await get_asset(session, user, "dashboard", dashboard_id)
    spec = DashboardSpec.model_validate((await session.get(AssetVersion, asset.head_version_id)).spec)
    dims: dict[str, dict[str, Any]] = {}
    for asset_id, _vid, source in await _item_sources(session, spec):
        for ds in source.model.datasets:
            for d in ds.dimensions:
                if d.type == "date":
                    continue
                entry = dims.setdefault(d.name, {"name": d.name, "label": d.label or d.name, "sources": []})
                if asset_id not in entry["sources"]:
                    entry["sources"].append(asset_id)
    return {"dimensions": sorted(dims.values(), key=lambda d: d["label"].lower())}


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(dashboard_id: int, user: CurrentUser, session: Session) -> Response:
    asset, access = await get_asset(session, user, "dashboard", dashboard_id)
    await archive_asset(session, user, asset, access)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _detail(session: AsyncSession, user: User, asset: Asset, access: str) -> dict[str, Any]:
    head = await session.get(AssetVersion, asset.head_version_id)
    spec = DashboardSpec.model_validate(head.spec)

    # Load every pinned card version (plus its asset, for "update available") in one query
    pinned_ids = [i.card.version_id for i in spec.items]
    rows = (await session.execute(
        select(AssetVersion, Asset, User.name, AssetShare.permission)
        .join(Asset, AssetVersion.asset_id == Asset.id)
        .outerjoin(User, Asset.owner_id == User.id)
        .outerjoin(AssetShare, (AssetShare.asset_id == Asset.id) & (AssetShare.grantee_type == "user")
                   & (AssetShare.grantee_id == user.id))
        .where(AssetVersion.id.in_(pinned_ids))
    )).all() if pinned_ids else []
    by_version = {v.id: (v, a, owner, perm) for v, a, owner, perm in rows}

    items = []
    for item in spec.items:
        found = by_version.get(item.card.version_id)
        if found is None:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Dashboard references a missing card version.")
        v, a, owner, perm = found
        card_access = access_for(a, user, perm) if a.archived_at is None else None
        items.append({
            **card_out(a, v, card_access, owner),
            "item_id": item.item_id, "x": item.x, "y": item.y, "w": item.w, "h": item.h,
            "card_version_id": v.id,
            "latest_version_id": a.head_version_id,
            "update_available": a.archived_at is None and a.head_version_id != v.id,
        })

    gov = (await governance_info(session, [asset]))[asset.id]
    sources = {vid: card_dimensions(src) for _a, vid, src in await _item_sources(session, spec)}
    for item in items:
        # What each card's source can be filtered by — lets the UI flag filters a card won't apply
        item["filterable"] = sources.get(item["data_source_version_id"], {"dimensions": [], "time": False})
    return {**asset_meta(asset, head, access, await owner_name(session, asset), gov), "items": items,
            "filters": [f.model_dump() for f in spec.filters]}
