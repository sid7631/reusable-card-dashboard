from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.listing import list_visible, owner_name
from app.api.serializers import card_out
from app.core.auth import CurrentUser, Session
from app.execution.cards import compile_card
from app.execution.jobs import get_result, make_job
from app.semantic.filters import Filters
from app.semantic.options import dimension_values
from app.semantic.query import CompileError, SemanticQuery
from app.governance.requests import governance_info
from app.governance.service import archive_asset, create_asset, get_asset, save_version
from app.governance.specs import CardSpec, ChartType, DashboardSpec, DataSourceSpec, SqlQuery
from app.models import AssetVersion, User

router = APIRouter(prefix="/api/cards", tags=["cards"])


class CardIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    chart_type: ChartType
    data_source_id: int
    config: dict[str, Any] = {}
    # Raw SQL (with an optional {{filters}} token) — or a semantic `query` instead
    sql_text: str = ""
    query: dict[str, Any] | None = None
    created_via: Literal["builder", "sql", "copilot"] = "builder"
    change_note: str = ""
    scope: Literal["private", "global"] = "private"


async def _card_spec(session: AsyncSession, user: User, body: CardIn) -> dict[str, Any]:
    source, _ = await get_asset(session, user, "data_source", body.data_source_id)
    source_spec = DataSourceSpec.model_validate((await session.get(AssetVersion, source.head_version_id)).spec)
    if body.query is not None:
        try:
            query: Any = SemanticQuery.model_validate(body.query)
        except ValueError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    else:
        query = SqlQuery(sql=body.sql_text)
    try:
        compile_card(query, source_spec, Filters())  # validates SQL / model references before saving
    except CompileError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    return {
        "chart_type": body.chart_type,
        "data_source": {"asset_id": source.id, "version_id": source.head_version_id},
        "query": query.model_dump(mode="json", exclude_none=True),
        "created_via": body.created_via,
        "config": body.config,
    }


@router.get("")
async def list_cards(user: CurrentUser, session: Session,
                     scope: Literal["global", "private", "shared", "deleted"] | None = None) -> list[dict[str, Any]]:
    rows = await list_visible(session, user, "card", scope)
    gov = await governance_info(session, [a for a, *_ in rows])
    return [card_out(a, v, access, owner, gov[a.id]) for a, v, owner, access in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_card(body: CardIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    spec = await _card_spec(session, user, body)
    asset, version = await create_asset(session, user, "card", name=body.name, description=body.description,
                                        spec=spec, scope=body.scope)
    await session.commit()
    return card_out(asset, version, "owner" if asset.scope == "private" else "admin", user.name)


@router.get("/{card_id}")
async def get_card(card_id: int, user: CurrentUser, session: Session, version_id: int | None = None) -> dict[str, Any]:
    asset, access = await get_asset(session, user, "card", card_id)
    version = await _version(session, asset.id, version_id or asset.head_version_id)
    gov = (await governance_info(session, [asset]))[asset.id]
    return card_out(asset, version, access, await owner_name(session, asset), gov)


@router.put("/{card_id}")
async def update_card(card_id: int, body: CardIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    asset, access = await get_asset(session, user, "card", card_id, write=True)
    spec = await _card_spec(session, user, body)
    version = await save_version(session, user, asset, name=body.name, description=body.description, spec=spec,
                                 change_note=body.change_note)
    await session.commit()
    gov = (await governance_info(session, [asset]))[asset.id]
    return card_out(asset, version, access, await owner_name(session, asset), gov)


@router.delete("/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_card(card_id: int, user: CurrentUser, session: Session) -> Response:
    asset, access = await get_asset(session, user, "card", card_id)
    await archive_asset(session, user, asset, access)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{card_id}/data")
async def card_data(
    card_id: int, user: CurrentUser, session: Session,
    version_id: int | None = None,
    dashboard_id: int | None = Query(None, description="Render through a dashboard the user can view"),
    segment: str | None = None, sub_segments: str | None = None,
    date_from: str | None = Query(None, alias="from"), date_to: str | None = Query(None, alias="to"),
    filters: str | None = Query(None, description='JSON {dimension: [values]}'),
) -> dict[str, Any]:
    version = await _authorised_card_version(session, user, card_id, version_id, dashboard_id)
    source_version = await session.get(AssetVersion, version.spec["data_source"]["version_id"])
    job = make_job(version.id, version.spec, source_version.id, source_version.spec,
                   Filters.parse(segment, sub_segments, date_from, date_to, filters))
    return (await get_result(job)).payload()


@router.get("/{card_id}/filter-options")
async def card_filter_options(
    card_id: int, dimension: str, user: CurrentUser, session: Session,
    version_id: int | None = None, dashboard_id: int | None = None,
    filters: str | None = Query(None, description="JSON {dimension: [values]} narrowing the options"),
) -> dict[str, Any]:
    """Values for a card-level filter control, from the card's own source."""
    version = await _authorised_card_version(session, user, card_id, version_id, dashboard_id)
    card = CardSpec.model_validate(version.spec)
    source = DataSourceSpec.model_validate((await session.get(AssetVersion, card.data_source.version_id)).spec)
    values = await dimension_values(source, card.data_source.version_id, dimension, Filters.parse(filters_json=filters))
    return {"dimension": dimension, "values": values}


async def _authorised_card_version(session: AsyncSession, user: User, card_id: int, version_id: int | None,
                                   dashboard_id: int | None) -> AssetVersion:
    """A viewer of a dashboard may render the card versions it pins, even without direct access to the card."""
    if dashboard_id is not None:
        dashboard, _ = await get_asset(session, user, "dashboard", dashboard_id)
        head = await session.get(AssetVersion, dashboard.head_version_id)
        pinned = {i.card.version_id for i in DashboardSpec.model_validate(head.spec).items if i.card.asset_id == card_id}
        if not pinned or (version_id is not None and version_id not in pinned):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card is not on this dashboard.")
        return await _version(session, card_id, version_id or next(iter(pinned)))
    asset, _ = await get_asset(session, user, "card", card_id)
    return await _version(session, asset.id, version_id or asset.head_version_id)


async def _version(session: AsyncSession, asset_id: int, version_id: int | None) -> AssetVersion:
    version = await session.get(AssetVersion, version_id) if version_id else None
    if version is None or version.asset_id != asset_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version not found.")
    return version
