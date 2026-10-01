from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.auth import CurrentUser, Session
from app.execution.cards import run_card
from app.execution.sql import Filters
from app.governance import requests as cr
from app.governance.service import get_asset
from app.governance.specs import CardSpec, DataSourceSpec
from app.models import Asset, AssetVersion, ChangeRequest, ChangeRequestItem, User

router = APIRouter(prefix="/api/change-requests", tags=["change requests"])

KIND_PATHS = {"cards": "card", "dashboards": "dashboard", "data-sources": "data_source"}


class SubmitIn(BaseModel):
    kind: Literal["cards", "dashboards", "data-sources"]
    asset_id: int
    title: str = Field(min_length=1, max_length=200)
    description: str = ""


class DecisionIn(BaseModel):
    comment: str = ""


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins can review change requests.")


async def _load(session: AsyncSession, user: User, request_id: int) -> ChangeRequest:
    request = await session.get(ChangeRequest, request_id)
    if request is None or (user.role != "admin" and request.requested_by != user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Change request not found.")
    return request


async def _detail(session: AsyncSession, user: User, request: ChangeRequest) -> dict[str, Any]:
    items = await session.scalars(select(ChangeRequestItem).where(ChangeRequestItem.request_id == request.id)
                                  .order_by(ChangeRequestItem.position))
    evaluated = [{k: v for k, v in (await cr.evaluate(session, i)).items() if k != "merged"} for i in items]
    if request.status != "pending":
        # Staleness and conflicts only matter while a request is open
        for e in evaluated:
            e.update(stale=False, conflicts=[])
    names = dict((await session.execute(select(User.id, User.name).where(
        User.id.in_({request.requested_by, request.reviewed_by} - {None})))).all())
    has_conflicts = any(e["conflicts"] for e in evaluated)
    pending = request.status == "pending"
    return {
        **_summary(request, names),
        "items": evaluated,
        "has_conflicts": has_conflicts,
        "can_approve": pending and user.role == "admin" and not has_conflicts,
        "can_reject": pending and user.role == "admin",
        "can_withdraw": pending and request.requested_by == user.id,
        "can_update": pending and request.requested_by == user.id,
    }


def _summary(request: ChangeRequest, names: dict[int, str], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": request.id, "status": request.status, "title": request.title, "description": request.description,
        "requested_by": request.requested_by, "requested_by_name": names.get(request.requested_by),
        "reviewed_by": request.reviewed_by, "reviewed_by_name": names.get(request.reviewed_by),
        "review_comment": request.review_comment, "root_asset_id": request.root_asset_id,
        "created_at": request.created_at.isoformat(),
        "decided_at": request.decided_at.isoformat() if request.decided_at else None,
        **(extra or {}),
    }


@router.get("")
async def list_requests(user: CurrentUser, session: Session,
                        status_: Literal["pending", "approved", "rejected", "withdrawn", "all"] = Query("all", alias="status"),
                        mine: bool = False) -> list[dict[str, Any]]:
    """Admins see every request (the approval queue); users see their own."""
    requester, reviewer = aliased(User), aliased(User)
    root = aliased(Asset)
    item_count = (select(func.count()).where(ChangeRequestItem.request_id == ChangeRequest.id)
                  .correlate(ChangeRequest).scalar_subquery())
    query = (select(ChangeRequest, requester.name, reviewer.name, root.kind, root.name, item_count)
             .join(requester, requester.id == ChangeRequest.requested_by)
             .outerjoin(reviewer, reviewer.id == ChangeRequest.reviewed_by)
             .join(root, root.id == ChangeRequest.root_asset_id)
             .order_by(ChangeRequest.created_at.desc()).limit(200))
    if status_ != "all":
        query = query.where(ChangeRequest.status == status_)
    if mine or user.role != "admin":
        query = query.where(ChangeRequest.requested_by == user.id)
    return [
        _summary(r, {r.requested_by: req_name, r.reviewed_by: rev_name},
                 {"root_kind": kind, "root_name": name, "item_count": n})
        for r, req_name, rev_name, kind, name, n in (await session.execute(query)).all()
    ]


@router.get("/summary")
async def summary(user: CurrentUser, session: Session) -> dict[str, int]:
    """Pending count for the sidebar badge: the whole queue for admins, own requests for users."""
    query = select(func.count()).select_from(ChangeRequest).where(ChangeRequest.status == "pending")
    if user.role != "admin":
        query = query.where(ChangeRequest.requested_by == user.id)
    return {"pending": await session.scalar(query)}


@router.post("", status_code=status.HTTP_201_CREATED)
async def submit(body: SubmitIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    asset, level = await get_asset(session, user, KIND_PATHS[body.kind], body.asset_id)
    request = await cr.submit(session, user, asset, level, body.title, body.description)
    await session.commit()
    return await _detail(session, user, request)


@router.get("/{request_id}")
async def get_request(request_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
    return await _detail(session, user, await _load(session, user, request_id))


@router.post("/{request_id}/update")
async def update_request(request_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
    request = await _load(session, user, request_id)
    await cr.resync(session, user, request)
    await session.commit()
    return await _detail(session, user, request)


@router.post("/{request_id}/approve")
async def approve(request_id: int, body: DecisionIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    _require_admin(user)
    request = await _load(session, user, request_id)
    await cr.approve(session, user, request, body.comment)
    await session.commit()
    return await _detail(session, user, request)


@router.post("/{request_id}/reject")
async def reject(request_id: int, body: DecisionIn, user: CurrentUser, session: Session) -> dict[str, Any]:
    _require_admin(user)
    request = await _load(session, user, request_id)
    await cr.reject(session, user, request, body.comment)
    await session.commit()
    return await _detail(session, user, request)


@router.post("/{request_id}/withdraw")
async def withdraw(request_id: int, user: CurrentUser, session: Session) -> dict[str, Any]:
    request = await _load(session, user, request_id)
    await cr.withdraw(session, user, request)
    await session.commit()
    return await _detail(session, user, request)


@router.get("/{request_id}/items/{item_id}/data")
async def preview_item(request_id: int, item_id: int, user: CurrentUser, session: Session,
                       segment: str | None = None, sub_segments: str | None = None,
                       date_from: str | None = Query(None, alias="from"),
                       date_to: str | None = Query(None, alias="to")) -> dict[str, Any]:
    """Render a proposed card version for review (the reviewer may not otherwise see the private card)."""
    request = await _load(session, user, request_id)
    item = await session.get(ChangeRequestItem, item_id)
    if item is None or item.request_id != request.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    version = await session.get(AssetVersion, item.source_version_id)
    if (await session.get(Asset, item.source_asset_id)).kind != "card":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Only card items can be previewed.")
    card = CardSpec.model_validate(version.spec)
    source = DataSourceSpec.model_validate((await session.get(AssetVersion, card.data_source.version_id)).spec)
    return {"chart_type": card.chart_type, "config": card.config,
            **await run_card(card, source, Filters.parse(segment, sub_segments, date_from, date_to))}
